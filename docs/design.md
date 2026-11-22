# 音声レコーダー（js-recorder）設計書

- **版**: 1.0
- **日付**: 2026-11-21
- **対応する要件**: [requirements.md](requirements.md)（機能 ID は `features.json` と一致）
- **画面録画の設計書**: [screen-recording-design.md](screen-recording-design.md)、[ADR](adr/README.md)（ADR-0016〜0025）
- **対応する実装**: `master` の `37a128b` 以降（ワーキングツリーの内容）

この文書は、旧 ADR（commit `37a128b` までの `docs/adr/`。廃棄済み）の判断を含めて、実装の仕組みを説明します。画面録画の判断は [ADR](adr/README.md)（ADR-0016〜0025）にあります。コードを読まずに、この文書だけで同じアプリを作り直せることを目標にしています。見出しの番号は、機能一覧（`features.json` の `design` 欄）から参照しています。

---

## 1. 全体構成

```
┌──────────────── Electron（Chromium + Node.js）────────────────┐
│                                                                │
│  メインプロセス: electron/main.cjs                              │
│   - 窓の生成（256×80、リサイズ不可）                            │
│   - 権限（media のみ許可）                                      │
│   - ダウンロードの保存先を Downloads に固定                     │
│   - 保存完了を画面へ通知（recording-saved）                     │
│                 │ contextBridge（preload 経由）                  │
│  プリロード: electron/preload.cjs                               │
│   - window.recorder.onSaved(callback) だけを公開                │
│                 │                                              │
│  レンダラー（画面）: src/                                        │
│   - App.jsx     : UI（状態、ボタン、表示、メッセージ）           │
│   - recorder.js : 録音、音量計算、MP3 エンコード                 │
│   - App.css     : レイアウトとテーマ                             │
│   - 録音は AudioWorklet（別スレッド）で PCM を受け取る          │
└────────────────────────────────────────────────────────────────┘
```

- 通信は、メインから画面への一方向の通知だけ。画面からメインへの送信はない。
- サーバーは使わない。MP3 への変換は画面の中で行う。
- 画面は `dist/index.html` だけを読み込む（`file://`）。外部の URL は読まない。

## 2. 技術スタックと固定バージョン

| 役割 | 採用 | バージョン（固定） | 備考 |
|---|---|---|---|
| デスクトップ | Electron | 45.4.1 | `devDependencies`（完全一致） |
| UI | React、react-dom | 19.3.1 | `dependencies`（完全一致） |
| ビルド | Vite | 8.3.8 | `devDependencies`。`base: './'` |
| React の変換 | @vitejs/plugin-react | 6.3.0 | `devDependencies` |
| MP3 エンコーダー | lamejs | 1.2.1 | `dependencies`。ブラウザ向けの `lame.min.js` を使う |
| テスト | pytest | 9.2.0 | `requirements-dev.txt`。Python 3.10 以上 |
| 実行環境 | Node.js | 22.12 以上 | Electron 45 と依存パッケージの要件。検証は 20.19.2 でもビルドとテストは成功 |

- 版の固定は `package.json`（完全一致）と `package-lock.json` で行う。`npm ci` で再現する。
- 既知の注意: Node 20 で `npm install` すると `EBADENGINE` の警告が出る。

## 3. ディレクトリ構成

```
.
├── electron/
│   ├── main.cjs        メインプロセス（窓、権限、保存先、保存完了の通知）
│   └── preload.cjs     プリロード（window.recorder.onSaved だけを公開）
├── src/
│   ├── main.jsx        React の起動（StrictMode）
│   ├── App.jsx         UI と操作の制御（Ticker を含む）
│   ├── App.css         レイアウトとテーマ（ライト・ダーク）
│   └── recorder.js     録音、音量、MP3 変換、ファイル名
├── index.html          lang="ja"、title「Video Recoder」
├── vite.config.js      base './'、outDir 'dist'、emptyOutDir true
├── package.json        scripts: dev、build、start
├── docs/
│   ├── requirements.md 要件定義書
│   ├── design.md       設計書（この文書）
│   └── features.json   機能一覧と検証状況（機械可読）
├── tests/              pytest（19 章）
├── pytest.ini          テストの設定（build マーカー）
└── requirements-dev.txt テスト用の Python パッケージ
```

## 4. 録音パイプライン

> 注意: 音声だけの MP3 録音は廃止（2026-11-21 の決定）。映像の録画は 23〜24 章による。この章は、廃止される前の実装の説明。

録音の開始（`Recorder.start(deviceId)`）は、次の順に行う。

1. **エンコーダーの読み込み**: `lame.min.js` を `<script>` 要素で 1 回だけ読み込み、`globalThis.lamejs` を使う（[5 章](#5-mp3-変換)）。
2. **マイクの取得**: `navigator.mediaDevices.getUserMedia({ audio })` で次の制約を指定する。
   - `channelCount: 1`（モノラル）
   - `echoCancellation: false`、`noiseSuppression: false`、`autoGainControl: false`（録音音量を変えない。[13 章](#13-セキュリティ)とは別の判断）
   - 選択中のマイクがあれば `deviceId: { exact: <id> }`
3. **AudioContext の作成**: `new AudioContext({ sampleRate: 44100 })`。
4. **AudioWorklet の読み込み**: 次のコードを文字列で持ち、`Blob` と `URL.createObjectURL` で読み込む。読み込み後に `revokeObjectURL` する。
   ```js
   class PcmCapture extends AudioWorkletProcessor {
     process(inputs) {
       const channel = inputs[0] && inputs[0][0];
       if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
       return true;
     }
   }
   registerProcessor('pcm-capture', PcmCapture);
   ```
   - 理由: `file://` のページから外部ファイルのワークレットを読むと失敗する場合があるため（旧 ADR-0004）。
   - ワークレットは 128 サンプルごとに `Float32Array` を送る。1 秒あたり約 344 回。
5. **エンコーダーの作成**: `new Mp3Encoder(1, ctx.sampleRate, 128)`。`ctx.sampleRate` を使うので、要求値とずれても再生速度が狂わない。
6. **接続**: `MediaStreamSource → PcmCapture → GainNode(gain=0) → destination`。ワークレットは出力先に接続されていないと動かないため、音が出ないゲインを経由する。
7. **状態の設定**: `startedAt = new Date()`、`fileName = makeFileName(startedAt)`、`active = true`、`paused = false`。
8. **失敗時**: 途中で失敗したら `releaseResources()` で、トラック停止、ノード切断、`AudioContext` を閉じる。例外は呼び出し元に投げる。

### フレーム処理（`handleFrame`）

- `active` が false または `paused` が true のフレームは捨てる（一時停止の後に届いた古いフレームを無視する）。
- 音量の計算（[7 章](#7-音量メーター)）と、PCM 変換・エンコード（次の節）を行う。
- `samplesEncoded += frame.length`。経過時間の基になる（[6 章](#6-経過時間)）。

## 5. MP3 変換

> 注意: MP3 の出力は廃止（2026-11-21 の決定）。この章は、廃止される前の実装の説明。

- エンコーダー: lamejs 1.2.1 の `Mp3Encoder`。設定は **モノラル、サンプルレートは AudioContext の値（通常 44100Hz）、128kbps**。
- **npm の `import` は使わない**。パッケージの `main` は `MPEGMode is not defined` で実行時に失敗するため。代わりに `lame.min.js` を Vite の `?url` で URL として取得し、`<script>` で読む。読み込み後は `globalThis.lamejs.Mp3Encoder` を使う。
- 読み込みは 1 回だけ。結果は Promise にキャッシュする。ファイルの読み込みに失敗した場合は、キャッシュを消して次回に再試行する。
- PCM 変換: Float32 を `[-1, 1]` に丸め、`s < 0 ? s × 0x8000 : s × 0x7fff` で Int16 に変換する。
- **ブロック**: MP3 のフレーム長 **1152 サンプル**ごとに `encodeBuffer` を呼び、出力を `mp3Chunks` に積む。
- **停止時**: 余ったサンプル（1152 未満）を `encodeBuffer` し、`flush()` で残りを出力する。
- 出力は `new Blob(chunks, { type: 'audio/mpeg' })`。

## 6. 経過時間

- 経過時間は **壁時計ではなく、処理したサンプル数** から求める: `elapsed = samplesEncoded / ctx.sampleRate`。
- 理由（旧 ADR-0005）: 一時停止中はフレームが来ないので、時間が自然に止まる。表示と MP3 の長さが一致する。壁時計だと、一時停止の時間を差し引く処理が必要になり、ずれやすい。
- 一時停止は `AudioContext.suspend()`、再開は `resume()`。CPU の無駄も減る。
- 注意: 一時停止の直前に処理中だったフレーム（数十 ms）は、時間と音量に反映されることがある。
- 表示（`App.jsx`）:
  - 録音中だけ `setInterval` で **30ms** ごとに `getElapsed()` を読む。
  - 書式 `formatTime(sec)`: `tenths = floor(sec × 10)`、`t = tenths % 10`、`s = floor(tenths / 10)`、`h = floor(s / 3600)`、`m = floor((s % 3600) / 60)`、`ss = s % 60`。出力は `${h}:${mm}:${ss}.${t}`（`h` は常に表示、`mm`・`ss` は 2 桁、切り捨て）。

## 7. 音量メーター

- 音量は、受け取ったサンプルの **RMS（二乗平均平方根）** で求める。
- 約 **50ms** ごとに 1 回だけ UI に送る: `meterCount ≥ sampleRate × 0.05` になったら計算する。
- 計算:
  - `rms = sqrt(sumSquares / meterCount)`
  - `db = max(-60, 20 × log10(rms || 1e-12))`（無音の `log10(0)` を避ける）
  - `percent = (db + 60) / 60 × 100`（0〜100）
- 表示: dB は小数点以下 1 桁。バーの幅は `percent` を % で指定する。
- 理由（旧 ADR-0012）: フレームごとに描くと約 344 回/秒で重い。50ms なら約 20 回/秒で滑らかに見える。無音でも数値が出る。下限は `-60 dB`。
- 一時停止中は `handleFrame` が計算しない。UI は `{ db: -60, percent: 0 }` に戻す。

## 8. 状態遷移と一時停止

### 8.1 状態

| 状態 | 意味 |
|---|---|
| `idle` | 待機中（録音していない） |
| `recording` | 録音中 |
| `paused` | 一時停止中 |

### 8.2 操作と状態

| 操作 | 条件 | 結果 |
|---|---|---|
| 開始 | `idle` | マイクを取得して録音開始。経過時間を 0 にし、`recording` へ |
| 一時停止 | `recording` | `pause()`。音量を初期値に戻す。`paused` へ |
| 再開 | `paused` | `resume()`。`recording` へ |
| 停止 | `recording` または `paused` | `stop()` で MP3 を作り、保存。`idle` へ |

### 8.3 ボタンの有効・無効

| 状態 | 開始 | 一時停止・再開 | 停止 | マイク選択 |
|---|---|---|---|---|
| `idle` | 有効 | 無効 | 無効 | 有効（デバイスが 1 つ以上あるとき） |
| `recording` | 無効 | 有効（表示は ❚❚） | 有効 | 無効 |
| `paused` | 無効 | 有効（表示は ▶） | 有効 | 無効 |

### 8.4 二重操作

- 開始: `startingRef`（開始処理中）と `recorderRef`（録音中）で、二重の開始を無視する（F-017 を実装）。
- 一時停止・再開: 処理中の再入の防止は未実装（F-020）。`await` の間に連打されると、状態がずれる可能性がある。

## 9. マイク入力

- 起動時: `getUserMedia({ audio: true })` を 1 回呼んで許可を得る。取得したトラックは直ちに停止する。許可後にデバイス名が見える（F-011）。
- 一覧: `enumerateDevices()` のうち `kind === 'audioinput'` を使う。
  - 選択中の ID が一覧にあれば維持し、なければ先頭を選ぶ。
  - 一覧が空なら「マイクが見つかりません。マイクを接続してください。」を表示する。
- `navigator.mediaDevices` の `devicechange` で一覧を更新する（F-010）。
- 開始後にも一覧を更新する（開始直後にデバイス名が見えるようになるため）。
- プルダウン: 未選択（ID が空）のとき、先頭の無効な選択肢「Select Input」を表示する。デバイス名がないときは「マイク N」（N は 1 から）。
- 録音中と一時停止中は、プルダウンを無効にする。

## 10. エラー処理

`describeError(err)` が `err.name` で分類する。

| `err.name` | 表示するメッセージ |
|---|---|
| `NotAllowedError`、`SecurityError` | マイクの使用が許可されていません。OSやアプリのマイク設定を確認してください。 |
| `NotFoundError`、`OverconstrainedError` | マイクが見つかりません。マイクを接続してから再度お試しください。 |
| `NotReadableError`、`AbortError` | マイクを使用できません。他のアプリがマイクを使用していないか確認してください。 |
| その他 | エラーが発生しました: <`err.message`> |

- メッセージは 1 行。`white-space: nowrap`、`overflow: hidden`、`text-overflow: ellipsis`。全文は `title` 属性。
- エラーはティッカーで流さない（F-012 の仕様）。流すのは保存完了のメッセージだけ（[16 章](#16-ティッカー表示)）。
- 停止処理の失敗は未対応（F-019）。現状では、保存に失敗してもエラー表示は出ず、「保存しています…」が残る。

## 11. 保存

### 11.1 流れ

1. 停止時、`Blob` から Object URL を作る。
2. `<a download="recording_YYYYMMDD_HHMMSS.mp3">` を作って `click()` する。直後に削除し、Object URL は 10 秒後に解放する（`saveBlob`）。
3. メインプロセスの `will-download` が、保存先を決める。
   - `savePath = path.join(app.getPath('downloads'), item.getFilename())`
   - `item.setSavePath(savePath)` で、保存ダイアログを出さない。
4. `item.once('done')` で `state === 'completed'` のとき、`webContents.send('recording-saved', savePath)` で絶対パスを送る（[12 章](#12-ipc-と-preload)）。
5. 画面は、受け取った絶対パスで「保存しました: <絶対パス>」を表示する。

### 11.2 方針

- 保存先は Downloads に固定し、ダイアログを出さない（旧 ADR-0006、ADR-0001）。理由: 停止するだけで保存が終わるため。
- 同名ファイルは上書きされる。ファイル名は秒単位のため、同じ秒に録音を開始すると、重複する（F-006）。
- 注意: Linux の `XDG_DOWNLOAD_DIR` は、この Electron では効かない。保存先は `~/Downloads`。

## 12. IPC と preload

- **preload**（`electron/preload.cjs`）は、サンドボックス下で `contextBridge.exposeInMainWorld('recorder', { onSaved })` だけを公開する。
  - `onSaved(callback)` は `ipcRenderer.on('recording-saved', …)` で購読し、解除関数を返す。
  - 送信系（`send`、`invoke`、`sendSync`、`sendToHost`）は公開しない。`require` で他のモジュールも使わせない。
- **メインプロセス**（`electron/main.cjs`）は、`webPreferences.preload` で preload を読み込む。
- 画面（`App.jsx`）は、マウント時に `window.recorder?.onSaved(...)` を購読し、アンマウント時に解除する。`window.recorder` がない場合（ブラウザでの表示）は何もしない。
- 理由（旧 ADR-0015）: 保存先は画面からは分からないため、通知が必要。旧 ADR-0013 は「preload を使わない」としていたが、保存完了の通知に限って使う（[21 章](#21-設計上の判断旧-adr-の要約)の D-14）。

## 13. セキュリティ

`electron/main.cjs` で次を設定する。

- `webPreferences`: `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`preload: path.join(__dirname, 'preload.cjs')`。
- 権限: `setPermissionRequestHandler` と `setPermissionCheckHandler` は、`permission === 'media'` だけを許可する。
- 読み込み: `win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))`。外部の URL は読まない。
- 画面に公開する API は保存完了の通知だけ（12 章）。

注意: `getUserMedia` の処理（エコーキャンセル等の無効化）は録音音量の判断であり、セキュリティとは別（[21 章](#21-設計上の判断旧-adr-の要約)の D-08）。

## 14. ウィンドウ

`new BrowserWindow({...})`:

- `width: 256`、`height: 80`、`useContentSize: true`（数値は内容の領域。枠は含まない）
- `resizable: false`、`maximizable: false`、`fullscreenable: false`
- `autoHideMenuBar: true`、`title: 'Video Recoder'`

- 幅 256px は、すべての要素が収まる最小値（240px では右端がはみ出し、256px で収まることを確認）。
- 高さ 80px は、上段（20px）、下段（20px）、メッセージ（13px）と間隔、余白の合計。
- 寸法は `electron/main.cjs` の `WINDOW_WIDTH`、`WINDOW_HEIGHT` と、`src/App.css` の値を揃える。片方を変えたら両方を変える。

履歴（旧 ADR-0007、ADR-0014）: 300×260 → 300×190 → 300×80 → 256×80。ボタンは 52×28 → 40×20 → 30×20px。

## 15. UI レイアウト

### 15.1 グリッド

`.app` は CSS Grid。

- 列: `grid-template-columns: auto auto minmax(102px, 1fr)`（102px = ボタン 3 つ × 30px + 間隔 2 × 6px）
- 行: `grid-template-rows: 20px 20px auto`
- 間隔: 列 6px、行 2px。余白: 上下 4px、左右 8px。`align-content: center`。

### 15.2 配置

| 要素 | 列 | 行 | 配置 |
|---|---|---|---|
| 経過時間（`.timer`） | 1 | 1 | 左、中央揃え。12pt、太字、数字は等幅 |
| dB 表示（`.db`） | 2 | 1 | 幅 52px、右揃え。11px、数字は等幅 |
| 音量バー（`.meter`） | 3 | 1 | 幅いっぱい、高さ 8px。枠と角丸 4px |
| マイク選択（`.mic-select`） | 1〜2 | 2 | 幅 100%、高さ 20px |
| 操作ボタン（`.buttons`） | 3 | 2 | 幅いっぱい、両端揃え（`space-between`）、間隔 6px |
| メッセージ（`.message`） | 1〜3 | 3 | 高さ 13px、11px、一行 |

- 上段の右列（音量バー）と下段の右列（ボタン）は、左右の端が揃う（どちらも 3 列目）。
- 下段の左側は、経過時間の列（1 列目）とマイク選択が左端で揃う。
- 上段の dB 表示は 2 列目で、マイク選択の右端と揃う。

### 15.3 ボタン

- 大きさ 30×20px、角丸 4px、中央にアイコン（SVG、10×10px、`currentColor`）。
- 開始だけは、有効時にアクセント色（青）で塗る。
- 無効時は不透明度 0.45。
- `aria-label` と `title` を持つ（開始、一時停止、再開、停止）。

### 15.4 色とテーマ

- CSS 変数（`:root`）を定義し、`prefers-color-scheme: dark` で切り替える。
- 変数: `--bg`、`--panel`、`--text`、`--muted`、`--border`、`--accent`、`--accent-text`、`--rec`（エラー）、`--pause`、`--meter-fill`。

### 15.5 文言

- 状態を示す文字（「待機中」「録音中」「一時停止中」）は表示しない（F-015）。
- マイク選択に「マイク」のラベルは付けない。
- 日本語で表示する（F-018）。

## 16. ティッカー表示

保存完了のメッセージ（一行）が幅に収まらないとき、横に流す。

### 16.1 判定と計測（`Ticker` コンポーネント、`App.jsx`）

- 文字列の幅は `Range.selectNodeContents` の矩形（余白を含まない文字だけの幅）で測る。
- 枠（`.ticker`）の幅は `clientWidth`。
- `textWidth > boxWidth` のとき流す。`ResizeObserver` で枠の幅が変わったときも再計測する。
- 1 周の時間: `cycle = (textWidth + gap) / 30`（秒）。`gap = 3em`（文字サイズの 3 倍）。速度は **30px/秒**（`TICKER_SPEED_PX_PER_SEC`）。

### 16.2 表示

- 流さないとき: 文字を 1 つ表示する。
- 流すとき: 同じ文字を 2 つ並べた `.ticker-track` を表示する。2 つ目は `aria-hidden="true"`。
  - 各項目は右に `padding-right: 3em` を持つ。そのため、トラック全体の幅は「2 × (文字の幅 + 3em)」になる。
  - アニメーション `ticker` は `translateX(0)` から `translateX(-50%)` まで、`linear` で無限に繰り返す。`-50%` は 1 項目分の幅なので、切れ目なくつながる。
- `prefers-reduced-motion: reduce` のときは、アニメーションを止める（先頭だけが見える）。

### 16.3 適用範囲

- 保存完了のメッセージ（`!notice.isError`）だけに使う。
- エラーメッセージは、末尾の `…` 省略（F-012）。

### 16.4 確認状況

- Electron で、絶対パス（約 60 文字、幅 398px）が 240px の枠で流れることを確認（30px/秒で動くことも測定）。
- 幅に収まる場合（流さない表示）は、この環境では確認していない（パスが常に長いため）。

## 17. ファイル名

- `makeFileName(date)`: `recording_YYYYMMDD_HHMMSS.mp3`。`date` は **録音開始時** の `new Date()`（ローカル時刻）。
- 各値は 2 桁にゼロ埋めする（年は 4 桁）。
- 開始時に 1 回だけ決める。一時停止・再開では変えない（F-006）。
- 重複の対策はしない。同じ秒に開始すると上書きされる（要件に合わせた判断。旧 ADR-0009）。

## 18. ビルドと起動

- `npm run dev`: Vite の開発サーバー（ブラウザでの表示だけ。`window.recorder` はないので、保存メッセージは従来の形式になる）。
- `npm run build`: `vite build`。`dist/index.html` とアセットを出力する（`emptyOutDir: true`）。
- `npm run start`: `npm run build && electron .`。メインプロセスは `dist/index.html` を読むので、先にビルドが必要。
- `vite.config.js`: `base: './'`（`file://` で読むため）、`plugins: [react()]`。
- 生成物の確認: `dist/index.html` の参照は `./assets/...`（絶対パスの `/assets/` ではない）。テスト `test_build.py` が確認する。

## 19. テスト設計

pytest で、次の 4 つのファイルを実行する。テストは **ソースの記述と設定値を確認する静的検査**（一部は `vite build` の実行）であり、画面の操作や録音は含まない。画面の操作は 20 章の手順で確認する。

| ファイル | 検査内容 | 対象機能 |
|---|---|---|
| `tests/test_features_json.py`（10 件） | `features.json` の形式、ID の重複、`implemented` と `status` の整合、`testPath` の参照先、`design` 欄の見出しの存在、要件書（`requirements.md`）の機能 ID との一致 | 全機能 |
| `tests/test_electron_config.py`（9 件） | 窓の寸法（256×80）、リサイズ不可、`contextIsolation`、`nodeIntegration`、`sandbox`、preload の設定と公開範囲、権限、読み込み元、`will-download` と `recording-saved` | F-004、F-016 |
| `tests/test_ui_source.py`（10 件） | MP3 の設定（モノラル、44100、128）、エラーの分類と文言、保存メッセージ、ティッカーの実装、ボタンのラベル、状態ラベルの不在、日本語 | F-005、F-012〜F-015、F-018 |
| `tests/test_build.py`（`build` マーカー、3 件） | `vite build` が成功し、一時フォルダに出力されること、`./assets/` の相対パス、`lame.min` の出力 | ビルド |
| 合計 | 32 件（`pytest -m "not build"` で 29 件、ビルドを含めて 32 件） | |

- 検査の基準は、この文書の値と一致させる。値を変えたら、テストも変える。
- JS の単体テスト（`formatTime`、`makeFileName` など）はない。必要なら vitest を導入する（未実施）。

## 20. 再現手順

### 20.1 環境

- OS: Linux（検証の環境は arm64）。Electron は GUI が必要（表示がない環境では、`--disable-gpu` を付けると起動できる）。
- Node.js 22.12 以上（推奨・想定の環境）。検証では 20.19.2 でもビルドとテストが成功した。
- Python 3.10 以上（検証は 3.13.5）。

### 20.2 インストールとビルド

```bash
npm ci
```

```bash
npm run build
```

- 期待: `dist/index.html`、`dist/assets/index-*.js`、`dist/assets/lame.min-*.js`、`dist/assets/index-*.css` が生成される。警告は出ない。

### 20.3 起動

```bash
npm run start
```

- 期待: ビルドのあと Electron が起動し、256×80 の窓が開く。ターミナルに、アプリからのエラーは出ない。GPU 関連のエラーは環境による（`--disable-gpu` で消える）。

### 20.4 自動テスト

```bash
python3 -m venv .venv
```

```bash
.venv/bin/python -m pip install -r requirements-dev.txt
```

```bash
.venv/bin/python -m pytest
```

- 期待: 32 件すべて合格（`npm ci` と `npm run build` の後）。

### 20.5 Electron での確認（E2E）

フェイクマイクで起動し、DevTools のリモートデバッグ（ポート 9223）で操作する。

```bash
npx electron . --disable-gpu --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --remote-debugging-port=9223
```

1. `http://127.0.0.1:9223/json` で、ページの `webSocketDebuggerUrl` を取る。
2. 次の順に操作する（`Runtime.evaluate`）:
   - `button[aria-label="開始"]` をクリックし、3 秒待つ。
   - `button[aria-label="停止"]` をクリックし、1 秒待つ。
3. 期待される結果:
   - 経過時間の表示が約 `0:00:02.9` から `0:00:03.0` の範囲に進んでいる（操作の遅れにより変わる）。
   - `.message` の文字が「保存しました: <絶対パス>」で始まる。`<絶対パス>` は `~/Downloads/recording_YYYYMMDD_HHMMSS.mp3`。
   - `.ticker-track` があり、アニメーション時間が約 13 秒（絶対パスの長さによる）。
   - ファイルの長さが、表示の経過時間と一致する（`ffprobe` で確認）。
4. 確認後、Electron を終了する。

注意: 保存された MP3 は `~/Downloads` に残る。テスト後に必要なら削除する。

### 20.6 実機での確認

- 実際のマイクで、録音、一時停止、再開、停止、音量の動きを確認する。**未実施**。

## 21. 設計上の判断（旧 ADR の要約）

旧 ADR（`docs/adr/`）は廃棄した。主な判断と理由を、ここに残す。

| 番号 | 判断 | 理由 | 採らなかった案・トレードオフ |
|---|---|---|---|
| D-01 | デスクトップアプリは Electron | JavaScript と React をそのまま使い、窓サイズ・権限・保存先を制御できる | 配布には署名とインストーラーが必要（未対応）。容量が大きい |
| D-02 | UI は React 19 と Vite 8 | 状態は `useState`・`useRef` で足りる。起動とビルドが速い | Vite 8 は Node 20.19 以上を要求。Electron 推奨は 22.12 以上 |
| D-03 | MP3 は lamejs を `<script>` で読む | `import` は実行時に失敗する。サーバーは不要 | グローバル変数に依存する |
| D-04 | 音声取得は AudioWorklet（Blob URL で読み込む） | PCM を直接扱える。`file://` でも読める | ワークレットのコードは文字列で管理 |
| D-05 | 経過時間はサンプル数から算出 | 一時停止で自然に止まり、MP3 の長さと一致する | 数十 ms 遅れることがある |
| D-06 | 保存は Downloads へ自動保存（ダイアログなし） | 停止するだけで保存が終わる | 同名は上書き。保存先は選べない |
| D-07 | 窓は固定サイズ・リサイズ不可 | 小さく保ち、表示を単純にする | 大きい表示は選べない。寸法は 14 章の履歴のとおり縮小 |
| D-08 | マイクのエコーキャンセル・ノイズ抑制・AGC はオフ | 録音音量と音量メーターが入力に一致する | スピーカーの音も入る。環境音は抑えない |
| D-09 | ファイル名は録音開始時刻（秒まで） | 一時停止・再開をしても名前が変わらない | 同じ秒の重複は上書き |
| D-10 | 操作ボタンはアイコンのみ、状態ラベルは置かない | 窓を小さくできる。状態はボタンの有効・無効と経過時間で示す | 初めての利用者には分かりにくい場合がある |
| D-11 | 一時停止中は音量を初期値（-60 dB、0%）に戻す | 音が入っていない状態と一致する | dB の 0 は最大音量を意味するため、「0」とは表示しない |
| D-12 | 音量は 50ms の RMS、下限 -60 dB | 再描画を約 20 回/秒に抑える。無音でも数値を出せる | 短い音のピークは小さく見える |
| D-13 | Electron の安全設定（隔離、サンドボックス、権限は media のみ） | 画面から Node.js の API を使えないようにする | 将来、画面から保存先を選ぶ機能は、preload の追加が必要 |
| D-14 | 保存完了の通知に preload を使う（D-13 の例外） | 保存先の絶対パスを表示するため。公開は `onSaved` だけ | preload が 1 つ増える。送信系 API を追加する場合は、この判断を見直す |
| D-15 | 保存完了のメッセージは、幅に収まらなければ流す | 絶対パスを省略せずに全文を見せる | 常に流す場合に比べて、収まるときは静的表示 |
| D-16 | 映像は H.264・mp4・10fps の CFR | 要件の指定。H.264 は再生互換が高い | Chromium の `MediaRecorder` が mp4 を出せるかは環境依存。実装時に確認し、使えなければ WebCodecs を使う（24 章） |
| D-17 | 録画中の映像は 3 分単位で一時ファイルへ書き出す | メモリ使用量を抑える（F-030）。2 時間の録画でもメモリを圧迫しない | 中間形式は H.264（24 章） |
| D-18 | 録画ウィンドウは映像から除外する | 録画中の表示（経過時間）を残しつつ、映像には映さない（F-027） | Linux では除外の手段が限られる（23 章） |
| D-19 | 出力は mp4 だけ。MP3 は出力しない | 決定（2026-11-21）。録画の出力を 1 つにする | 既存の音声だけの MP3 録音（F-001〜F-006）を残すかは未確認（要件書 10 章） |
| D-20 | 対象画面はプライマリ画面。内部では画面 ID で扱う | 将来の画面選択（4.2）に備える | 画面の選択 UI は未実装 |
| D-21 | 映像のビットレートは約 1Mbps（可変） | 決定。720p・10fps の画面録画では、ファイルが約 1GB/2 時間に収まる | 文字の見え方が劣る可能性がある。実機で確認する |
| D-22 | 空き容量が不足したら録画を止め、中間ファイルを残す | 録画したデータを失わないため（F-035） | 途中で録画が止まる。停止後に mp4 が作れない場合がある |
| D-23 | H.264 の符号化は録画中に行い、ハードウェアを優先する。使えないときは CPU で行う | 中間データを小さくできる（JPEG の 7〜14GB に対し、約 1GB）。停止時の再符号化が不要になり、停止が速くなる | 録画中に CPU を使う。CPU 上限（7.3a）を超えるとフレームレートを下げる。ハードウェアの有無は WebCodecs から直接分からない（23.7 章） |
| D-24 | 同じ画面のフレームは保存しない | 中間データと mp4 の大きさを減らす（F-037） | スキップフレームの作り方を検証する必要がある（24.3 章） |

## 22. 既知の制約と今後の課題

- F-019（停止処理の失敗の対応）、F-020（一時停止・再開の連打防止）は未実装。
- 保存が失敗した場合、「保存しています…」が残る。通知は成功時だけ送る（D-14）。
- 実機のマイクでの確認は未実施。音量メーターの値は、フェイクマイク（ビープ音）でだけ確認した。
- macOS と Windows では未確認。macOS で配布する場合は、`NSMicrophoneUsageDescription` が必要。
- ティッカーの「収まる場合」は、この環境では確認していない。
- 同じ秒の録音は上書きされる（D-09）。
- JS の単体テストがない（19 章）。
- 配布（インストーラー、署名）は対象外。
- 画面録画（F-021〜F-037）は未実装。本設計は仮の設計で、実装時に 23〜25 章の「実装時に確認」の項目を検証して確定する。

## 23. 画面録画のパイプライン

画面録画は、既存の録音パイプライン（4 章）と同じ開始・一時停止・再開・停止の操作で動く。映像と音声を別々に取得し、停止時に 1 本の mp4 にまとめる（24 章）。

### 23.1 映像の取得

- 対象はプライマリ画面（F-028）。メインプロセスで `desktopCapturer.getSources({ types: ['screen'] })` を呼び、`screen.getPrimaryDisplay().id` と一致する画面の ID を取る。
- 画面 ID は内部の変数 `displayId` で持つ（将来の画面選択に備える。D-20）。
- 画面の取得は、メインプロセスの `session.setDisplayMediaRequestHandler` で行う。ピッカーは出さず、`displayId` の画面を返す（`callback({ video: source, audio: 'loopback' })`）。
- 画面側は `navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 10 } }, audio: true })` を呼ぶ。
- カーソルは含めない（F-025）。取得時のカーソル指定は `cursor: 'never'` とし、実装時に映らないことを確認する。

### 23.2 フレームの取り込み、縮小、同一フレームの省略（CFR 10fps）

- 10fps の時刻（100ms ごと）に、最新の画面フレームを 1 枚選ぶ。撮影が間に合わない時刻は落とす（F-023）。
- 縮小: 画面を 1280×720 に収める。縦横の比率を保ち、余白は黒にする（F-024）。縮小後のフレームを符号化の入力にする。
- **同一フレームの判定（F-037）**: 直前に処理したフレームと、縮小後のフレームを画素単位で比べる。画素がすべて一致したときだけ「同じ」とする。縮小した画像だけで比べると、小さな変化を見落とすため、比べるのは縮小後の全画素とする。比較の方法（高速なハッシュなど）と計算時間は、実装時に計測する。
- 同じフレームは符号化せず、一時ファイルにも保存しない。記録するのは、その時刻が「直前と同じ」であるという印だけ。
- 停止時の mp4 では、その時刻に直前のフレームを参照するスキップフレームを置く（24.3）。

### 23.3 録画ウィンドウの除外（F-027）

- 録画中も、窓は画面に表示したままにする（経過時間の表示を残す。D-18）。
- 映像からの除外は、OS によって手段が違う。
  - Windows と macOS: `BrowserWindow.setContentProtection(true)` で、窓を録画の映像に映さない。
  - Linux: 除外の手段が限られる。候補は、録画中だけ窓を画面の外（別のディスプレイなど）へ移す方法。実装時に確認する。

### 23.4 音声の取得と混合（F-022）

- マイク: 選択中のマイク（4 章と同じ制約）を `MediaStreamAudioSourceNode` で取る。
- スピーカー: 画面取得の `audio: 'loopback'`（システム音）を使う。取得できない OS・環境では、音声をマイクだけにし、画面に通知する（実装時に確認）。
- 2 つの音声は Web Audio の `GainNode` で混ぜ、1 つのトラックにする。
- 録画中の音量バーと dB 表示（F-008）は、この混合した音声のレベルを使う。計算は 4 章・7 章と同じ（RMS、約 50ms ごと、下限 -60 dB）。
- 録画中の音量バーと dB 表示（F-008）は、この混合した音声のレベルを使う。計算は 4 章・7 章と同じ（RMS、約 50ms ごと、下限 -60 dB）。
- 既定値（決定）: モノラル、48kHz、Opus（`AudioEncoder`）、128kbps。

### 23.5 一時停止と経過時間（F-026）

- 一時停止中は、映像のフレームと音声のサンプルを受け取らない（`recording` 中だけ符号化する）。
- 映像の時刻は、符号化したフレーム数から求める（`フレーム数 ÷ 10`）。停止時間は含まれないので、再開後は自然に詰まる。
- 経過時間の表示（F-007）は、映像の時刻（フレーム数 ÷ 10）を使う。音声だけの録音（4 章）と同じ書式（6 章 `formatTime`）。

### 23.6 上限と停止

- 録画時間が 2 時間に達したら、録画を停止する（F-029）。ここまでの映像と音声を保存する。
- 上限のタイマーは、経過時間の値（フレーム数 ÷ 10）が 7200 秒に達したときに止める。

### 23.7 符号化方式の選択（F-036）

- 符号化は H.264 とする。次の順で方式を選ぶ。
  1. ハードウェア符号化（`VideoEncoder` の `hardwareAcceleration: 'prefer-hardware'`）が使えるときは、それを使う。
  2. 使えないときは、CPU（ソフトウェア符号化）で録画中に符号化する。この場合は CPU 使用率の上限（7.3a）が効く。上限を超えそうなときは、フレームレートを下げる（F-023 の例外）。
- 使った方式を、録画ごとに記録する。
- 判定の難しさ: WebCodecs は、ハードウェアが実際に使われたかどうかを直接返さない。候補は、`hardwareAcceleration` の指定で作ったエンコーダーの応答や、短い試験符号化の速さで判定する方法。実装時に、Electron 45 の Linux と Windows で確かめる（要件書 10 章）。

## 24. 中間ファイルと mp4 の作成

### 24.1 中間形式と符号化の時期（決定）

- 録画中: 映像は **H.264** に符号化する（F-036）。ハードウェア符号化が使えるときはそれを使い、使えないときは CPU（ソフトウェア符号化）で行う。音声は Opus に符号化する（23.4）。同一フレームは符号化も保存もしない（F-037）。
- 停止時: 一時ファイルの符号化データを mp4 に多重化する。**再符号化はしない**（F-031）。

中間データの量の比較（720p、10fps、2 時間 = 72,000 フレーム。1Mbps の H.264 と Opus 128kbps を基準にする）。

| 方式 | 2 時間の中間データ（見積もり） | 採否 |
|---|---|---|
| 未圧縮（I420） | 約 100GB | 採らない（保存もメモリも不可） |
| JPEG（1 枚 100〜200KB と仮定） | 約 7〜14GB | 採らない（決定により廃止） |
| H.264（録画中に符号化） | 約 1.0GB（mp4 とほぼ同じ。同一フレームの省略で、さらに小さくなる） | 採用 |

### 24.2 3 分ごとの一時ファイル（F-030）

- 録画中に符号化した H.264 のデータと Opus のデータは、3 分（1800 フレーム）ごとに次の一時ファイルへ切り替える。
- 一時ファイルの中身: 時刻、種類（映像・音声・スキップ）、長さを書いたうえで、サンプルのデータを順に並べた単純なコンテナ。フレームごとのファイルは作らない（72,000 個のファイルは重く、ウイルス対策ソフトの走査でも遅くなる）。
- 各一時ファイルの先頭がキーフレームになるとは限らない。繰り返しフレームの省略（23.2）で、先頭が差分フレームになることがあるため。多重化は先頭から順に読むので、再生の開始点は問題にならない。キーフレームの間隔は、符号化器に任せる（30 フレームごと。23.7 章）。
- 書き出し先は `app.getPath('userData')` の下の `recording-<開始時刻>/` とする。ファイルは `seg-0001.bin`、`seg-0002.bin` の順に作る。
- 書き出しは、メインプロセスが行う。画面からは符号化済みのサンプルを IPC で送る（ArrayBuffer は transfer で送り、コピーを避ける）。
- メモリに置くのは、符号化の出力の数サンプル分と、符号化の待ち行列（有限）だけ。3 分分をまとめて溜めない。
- 停止して保存が完了したら、一時ファイルを削除する（F-030）。保存に失敗したときは残し、その場所を画面に表示する（F-019 の対応と合わせて扱う）。

### 24.3 停止時の mp4 作成（F-031）

- 停止時に、一時ファイルのサンプルを先頭から順に読み、mp4 に多重化する。H.264 と Opus は再符号化しない。
- **同一フレームの時刻**（F-037）: 直前のフレームを参照するスキップフレームを、その時刻ごとに置く。スキップフレームは、同一フレームが初めて来たときに、符号化器に同じ内容を 1 回だけ渡して作る（出力された小さな P フレーム）。以降は、そのデータを使い回す。この方式が再生で正しく一致することは、実装時に検証する。
  - 採らない案: 同一フレームの時間を、前のサンプルの長さに足す（stts）。映像の内容は同じになるが、ffprobe の平均フレームレートが 10 にならないため、F-023 の確認が通らない。
- 多重化の出力は、メインプロセスへ 1 チャンクずつ送って、ファイルへ逐次書き出す（ArrayBuffer に全体を溜めない）。
- 書き込み先は Downloads の `screen_<時刻>.mp4.partial`。完了したら `.mp4` に名前を変える。途中で失敗したら（容量不足、書き込みエラーなど）`.partial` を削除する（決定）。中間ファイルは残す。
- 書き込みを始める前に、`state.json` の `partialPath` に `.partial` のパスを書く。異常終了のときに、起動時の掃除で削除できるようにするため（26 章）。
- 録画時間が 2 時間に達して自動で止まった場合も、同じ手順で作る（F-029）。
- 停止時の多重化は、ディスクの読み書きが中心になる。CPU 上限（7.3a）の対象外。
- 進み具合（F-038）: 多重化したサンプルの時間を、録画全体の時間で割って割合を求める。約 0.5 秒ごとに、画面へ送って「保存しています… NN%」と表示する。

### 24.4 保存（メモリ使用量の注意）

- 2 時間の録画は、mp4 が約 1.0GB になる（映像 1Mbps、音声 128kbps で見積もる）。中間データも、ほぼ同じ大きさになる。レンダラーで 1 つの `Blob` にすると、メモリを使い切る。
- そのため、保存はメインプロセスがファイルへ直接書き出す。画面からは「保存するセグメントの一覧」を渡すだけにする。
- これは、既存の `will-download` による保存（11 章）を変える判断。preload に、映像の保存を依頼する API を 1 つ追加する（D-14 の見直し。送信系 API は、この 1 つだけ）。
- 保存先は `app.getPath('downloads')/screen_YYYYMMDD_HHMMSS.mp4`（F-032）。保存完了は既存の `recording-saved` と同じ方法で通知する。

### 24.5 音声の形式（決定）

- 映像の音声（23.4）: モノラル、48kHz、Opus、128kbps。
- MP3 は出力しない（決定）。

### 24.6 空き容量の確認（F-035）

- 見積もり（720p・10fps・2 時間。H.264 の 1Mbps と Opus 128kbps、仮）:
  - 中間データ: 約 1.0GB（1 時間あたり約 0.5GB）。同一フレームの省略で、さらに小さくなる。
  - mp4: 約 1.0GB（中間データとほぼ同じ）。
  - 停止時のピーク（中間データ＋mp4）: 約 2.0GB。
- 録画の開始前: 空き容量が 3GB 以上であることを確認する（仮）。
- 録画中: 10 秒ごとに、メインプロセスで空き容量を取得する（`fs.promises.statfs`）。空き容量が「現在の中間データの大きさ ＋ 0.5GB」を下回ったら録画を止め、中間ファイルを残す（仮）。
- 通常の停止後: 空き容量が「中間データの大きさ ＋ 0.2GB」以上あるときだけ mp4 を作る（仮）。足りないときは mp4 を作らず、中間ファイルの場所を画面に表示する。
- 空き容量不足による停止（録画中の判定）: mp4 は作らない。ディスクへの追加の書き込みを行わず、システムの安定性を優先する（決定）。状態は `stopped-space` にし、場所を表示する。
- 数値はすべて仮。実測して決め直す。

## 25. 画面収録の権限

### 25.1 Electron の設定（F-033）

- `setPermissionRequestHandler` と `setPermissionCheckHandler` は、`media` と `display-capture` を許可する。それ以外は拒否する（7.2 章）。
- `setDisplayMediaRequestHandler` を設定し、ピッカーを出さずにプライマリ画面を返す（23.1）。

### 25.2 OS ごとの扱い

| OS | 権限 | 補足 |
|---|---|---|
| Windows | 専用の許可は要らない | 対応対象（7.3） |
| Linux | 環境による（ポータルの許可が出ることがある） | 対応対象（7.3）。X11 と Wayland で挙動が違う。実装時に確認 |
| macOS | 画面収録の許可が必要（OS の設定） | 将来検討（4.2）。`NSScreenCaptureUsageDescription` が必要 |

### 25.3 拒否時の処理（F-033）

- `getDisplayMedia` が `NotAllowedError` で失敗したら、F-033 のメッセージを表示する。
- 録画は始めない。MP3 の録音も始めない。
- 既存の F-012 の表示（1 行、末尾を `…` で省略、`title` で全文）に倣う。

## 26. 一時ファイルの掃除と異常終了

### 26.1 状態ファイル

- 録画の一時フォルダ（`recording-<開始時刻>/`）には、状態を書いた `state.json` を置く。状態は次のとおり。
  - `recording`: 録画中
  - `stopping`: 停止して mp4 を作っている。`partialPath`（途中の mp4 のパス）も書く
  - `stopped-space`: 空き容量の不足で止めた（F-035、F-039）
  - `saved`: mp4 の保存が完了した
  - `failed`: mp4 の作成が途中で失敗した（途中の mp4 は削除済み。中間ファイルは次回起動時に掃除する）
- 状態は、遷移するたびに書き換える。書き換えは一時ファイルに書いてから置き換える（書きかけで壊れないようにする）。

### 26.2 起動時の掃除（F-039、F-040）

起動時に、`userData` の下の `recording-*` を調べる。

| 状態 | 扱い | 根拠 |
|---|---|---|
| `recording` | 削除（異常終了） | F-040 |
| `stopping` | 削除（異常終了）。`partialPath` の途中の mp4（`.partial`）も削除する | F-040（決定） |
| `stopped-space` | 削除（次回起動時の掃除） | F-039（決定）。mp4 にならない録画は見られない |
| `saved` | 削除 | F-030 |
| 状態が読めない | 削除しない。ログに残す | 誤って消さないため |

- 掃除は、画面を出す前に行わず、起動後に非同期で行う。失敗してもアプリは起動する。

### 26.3 掃除の注意

- 空き容量不足で止めた録画は、mp4 にならず、次回起動時の掃除で消える（決定）。見られない録画になる。
- 異常終了の録画は、mp4 にならず、次回起動時に削除される（F-040、決定）。

