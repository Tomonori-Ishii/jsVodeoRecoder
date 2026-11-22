# ADR-0026: 音声の符号化は AAC から Opus に変更する

- **Status**: Accepted
- **Date**: 2026-11-21
- **変更する ADR**: [ADR-0016](0016-screen-video-format.md)、[ADR-0017](0017-drop-mp3-audio-only.md)（音声の符号化の形式）。

## Context

音声は、当初 AAC（48kHz、モノラル、128kbps）にする決定だった（ADR-0016、ADR-0017）。
しかし、この Linux 環境の Electron 45 では、WebCodecs の AAC 符号化が対応していなかった（`AudioEncoder.isConfigSupported` が `false`）。
Linux で音声を入れる方法として、ffmpeg の同梱、Opus への変更、音声なしの 3 つを検討した。

## Decision

- 音声の符号化は **Opus**（48kHz、モノラル、128kbps、20 ms のフレーム）にする。
- Opus は、この Linux 環境の Electron で符号化できることを確認した（`isConfigSupported` が `true`）。
- mp4 への格納は、mp4-muxer の Opus 対応（`Opus` ボックス）を使う。ffmpeg は使わない。
- 録音の音声（マイク）は、Opus の中間データとして録画中に符号化し、停止時は再符号化せずに多重化する（ADR-0018 と同じ方針）。

## Consequences

- AAC の符号化に依存しなくなり、Linux でも音声が入る（マイクの音。F-022）。
- Opus の mp4 は、一部の古い再生ソフトで再生できないおそれがある。確認は実機の再生ソフトで行う。
- スピーカーの音（システム音）は、この決定の対象外。Linux での取得方法は未決（要件書 10 章）。
- ffmpeg を同梱しないため、配布サイズとライセンスの問題は増えない。
