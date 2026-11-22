# ADR-0025: 画面収録の権限を許可し、ピッカーは出さない

- **Status**: Accepted（macOS は将来対応。[設計書 25 章](../design.md#25-画面収録の権限)）
- **Date**: 2026-11-21
- **変更する ADR**: 旧 ADR-0013（許可する権限）。

## Context

画面を録画するには、画面の取得の権限が必要になる。以前は、マイク（`media`）だけを許可していた。
ピッカー（画面を選ぶダイアログ）を出すと、利用者の操作が増え、「録画を止めずに保存する」という方針にも合わない。

## Decision

- 権限の許可は `media`（マイク）と `display-capture` に限る。それ以外は拒否する（7.2 章）。
- 画面の取得は `setDisplayMediaRequestHandler` で行い、ピッカーは出さない（[ADR-0021](0021-capture-primary-display.md)）。
- 権限が拒否されたときは、F-033 のメッセージを表示し、録画も MP3 の録音も始めない。
- 対象 OS は Linux と Windows。macOS は、画面収録の OS の許可と、説明文（`NSScreenCaptureUsageDescription`）が必要になるため、将来対応とする。

## Consequences

- Linux では、環境によって OS の許可のダイアログが出ることがある。その場合の動作は、実装時に確認する。
- 権限の許可が増えるため、`electron/main.cjs` の権限の検査を、テストで確認する必要がある（[設計書 19 章](../design.md#19-テスト設計)）。
