# ADR-0024: 保存はメインプロセスがファイルへ書く（Blob を使わない）。preload の公開範囲を広げる

- **Status**: Accepted
- **Date**: 2026-11-21
- **変更する ADR**: 旧 ADR-0013（preload の公開範囲）。commit `37a128b` の `docs/adr/0013-electron-security-settings.md` を参照。

## Context

以前の版は、停止時に録音データを `Blob` にして、`<a download>` で保存していた。
2 時間の mp4 は約 1GB になる。これを `Blob` にすると、レンダラーのメモリを使い切るおそれがある。
また、録画中は中間データを画面からメインプロセスへ送る必要がある。以前の preload は、保存完了の通知だけを公開していた（旧 ADR-0013）。

## Decision

- 中間データと mp4 は、メインプロセスがファイルへ直接書く。画面は `Blob` を作らない。
- preload は、録画に必要な送信系 API を追加する。公開するのは次の API だけ。
  - `startRecording(options)`: 録画を始める。一時フォルダを作る。
  - `writeRecord(type, timestampUs, data)`: 符号化済みのレコードを送る（`data` は `Uint8Array`。構造化複製で送り、transfer は使わない）。
  - `finishRecording(reason, durationUs)`: 停止を通知し、多重化を依頼する。`durationUs` は録画全体の長さ（進み具合の割合に使う）。
  - `onProgress(callback)`、`onSaved(callback)`、`onAutoStop(callback)`、`onError(callback)`: メインプロセスから画面へ通知する。
- `ipcRenderer.send` や `invoke` を、そのまま公開しない。引数は、型と範囲を検査してから使う。

## Consequences

- preload の公開範囲が、ADR-0013 の「保存完了の通知だけ」から広がる。送信系 API の数は少なく、用途を限定する。
- メインプロセスが、一時ファイルと mp4 の書き込みを担当する。書き込みのエラーは、メインプロセスで処理する。
- 既存の `will-download` による保存（ADR-0006 相当）は、画面録画では使わない。
