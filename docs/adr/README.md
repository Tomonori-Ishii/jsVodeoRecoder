# ADR（設計判断の記録）

このフォルダは、画面録画の機能（F-021〜F-040）の設計判断を記録します。

- 形式: 1 ファイルに 1 つの判断。Status、Date、Context、Decision、Consequences を書く。
- Status: `Accepted`（決定済み）、`Proposed`（決定したが、実装で確認が必要）、`Superseded`（後の ADR に置き換えた）。
- 番号: 0001〜0015 は、以前の音声レコーダーの ADR（commit `37a128b` までの `docs/adr/`）。その後、ADR を一度廃棄した（commit `9069d49`）。画面録画の ADR は 0016 から続けて番号を付ける。
- 判断の詳しい内容は、[設計書](../design.md) と [画面録画の設計書](../screen-recording-design.md) を参照する。

| ADR | タイトル | Status | 関連 |
|---|---|---|---|
| [0016](0016-screen-video-format.md) | 映像の形式: H.264、mp4、1280×720、10fps、約 1Mbps | Accepted | F-023、F-024 |
| [0017](0017-drop-mp3-audio-only.md) | 音声だけの録音（MP3）を廃止し、音声は映像の一部にする | Accepted | F-004〜F-006、F-022 |
| [0018](0018-intermediate-h264-segments.md) | 中間形式は H.264 を録画中に符号化し、3 分単位の一時ファイルに保存する | Accepted | F-029〜F-031 |
| [0019](0019-encoder-hw-first.md) | 符号化はハードウェアを優先し、使えないときは録画中に CPU で行う | Proposed | F-036、7.3a |
| [0020](0020-skip-identical-frames.md) | 同じ画面のフレームは保存せず、停止時にスキップフレームで補う | Proposed | F-037、F-023 |
| [0021](0021-capture-primary-display.md) | 録画対象はプライマリ画面とし、画面 ID で扱う | Accepted | F-027、F-028 |
| [0022](0022-disk-space-stability.md) | 空き容量を監視し、不足時は安定性を優先して mp4 を作らずに止める | Accepted | F-035、F-039 |
| [0023](0023-temp-files-cleanup.md) | 一時ファイル、途中の mp4、起動時の掃除の方針 | Accepted | F-030、F-031、F-039、F-040 |
| [0024](0024-save-from-main-process.md) | 保存はメインプロセスがファイルへ書く（Blob を使わない）。preload の公開範囲を広げる | Accepted | F-031、ADR-0013 を一部変更 |
| [0025](0025-screen-capture-permission.md) | 画面収録の権限を許可し、ピッカーは出さない | Accepted | F-033、ADR-0013 を一部変更 |
| [0026](0026-audio-opus.md) | 音声の符号化は AAC から Opus に変更する | Accepted | F-022、ADR-0016、ADR-0017 を一部変更 |
