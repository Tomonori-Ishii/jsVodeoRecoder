"""UI と録画処理のソースを検査する（F-005、F-012〜F-015、F-018、F-023〜F-025、F-036〜F-038）。

実際の画面や録画は動かさず、ソースの記述と定数を確認する静的な検査です。
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = (ROOT / "src" / "App.jsx").read_text(encoding="utf-8")
APP_CSS = (ROOT / "src" / "App.css").read_text(encoding="utf-8")
RECORDER = (ROOT / "src" / "recorder.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "index.html").read_text(encoding="utf-8")


def _const(source: str, name: str) -> str:
    match = re.search(rf"const {name} = ([^;]+);", source)
    assert match, f"{name} が定義されていません"
    return match.group(1).strip()


# F-023 / F-024 / ADR-0027: 1920×1080、10fps、約 3Mbps の H.264（レベル 4.0）
def test_video_is_1080p_10fps_about_3mbps_h264():
    assert _const(RECORDER, "WIDTH") == "1920"
    assert _const(RECORDER, "HEIGHT") == "1080"
    assert _const(RECORDER, "FPS") == "10"
    assert _const(RECORDER, "VIDEO_BITRATE") == "3000000"
    assert _const(RECORDER, "AVC_CODEC") == "'avc1.4d4028'"
    assert "avc: { format: 'avc' }" in RECORDER


# F-022 / ADR-0026: 音声はモノラル、48kHz、Opus、128kbps
def test_audio_is_mono_48khz_opus_128kbps():
    assert _const(RECORDER, "AUDIO_RATE") == "48000"
    assert _const(RECORDER, "AUDIO_CHANNELS") == "1"
    assert _const(RECORDER, "AUDIO_BITRATE") == "128000"
    assert _const(RECORDER, "OPUS_CODEC") == "'opus'"


# F-036 / ADR-0019: ハードウェアを優先し、使えないときは CPU（ソフトウェア）
def test_encoder_prefers_hardware_then_software():
    assert "'prefer-hardware', 'prefer-software'" in RECORDER
    assert "accel: preference" in RECORDER and "'prefer-hardware' ? 'prefer-hardware' : 'prefer-software'" not in RECORDER


# F-037 / ADR-0020: 同じ画面のフレームは符号化も保存もしない（最初の繰り返しだけ符号化）
def test_repeated_frames_are_not_encoded_again():
    assert "equalPixels(pixels, this.prevPixels)" in RECORDER
    assert "VIDEO_DUP" in RECORDER
    assert "this.skipDefined" in RECORDER


# 録画の場所: 録画の始まりは Electron の API だけを使う（ブラウザ版では録画しない）
def test_recorder_requires_electron():
    assert "画面録画は Electron アプリとしてのみ使えます" in RECORDER


# F-027 / F-033: 画面は録画対象から除外し、拒否時は F-033 の文言を使う
def test_screen_denial_uses_the_f033_message():
    assert "画面の録画が許可されていません。OSやアプリの画面収録の設定を確認してください。" in RECORDER


# 録画中に画面の音量を表示する（F-008、決定）
def test_level_meter_is_still_shown_while_recording():
    assert "onLevel?.({ db, percent })" in RECORDER
    assert "onLevel: setLevel" in APP


# MP3 は出力しない（ADR-0017）
def test_mp3_encoder_is_gone():
    assert "lamejs" not in RECORDER and "lamejs" not in APP
    assert "Mp3" not in RECORDER and "mp3" not in RECORDER.lower()


# F-012: エラーごとに案内を表示する
def test_each_microphone_error_has_a_japanese_message():
    cases = {
        "NotAllowedError": "マイクの使用が許可されていません",
        "NotFoundError": "マイクが見つかりません",
        "NotReadableError": "マイクを使用できません",
    }
    for name, message in cases.items():
        assert f"case '{name}'" in APP, f"{name} の分岐がありません"
        assert message in APP, f"{name} のメッセージがありません"


def test_error_message_is_truncated_to_one_line_with_title():
    assert re.search(r"\.message\s*\{[^}]*white-space:\s*nowrap", APP_CSS, re.DOTALL)
    assert re.search(r"\.message\s*\{[^}]*text-overflow:\s*ellipsis", APP_CSS, re.DOTALL)
    assert "title={messageText}" in APP


# F-038: 保存中は進み具合を表示する
def test_progress_is_shown_while_saving():
    assert "保存しています… ${percent}%" in APP
    assert "api.onProgress(" in APP


# F-013: 保存完了を、保存先の絶対パスで表示する（幅に収まらなければティッカーで流す）
def test_saved_path_is_shown_after_save():
    assert "保存しました: ${savedPath}" in APP
    assert "api.onSaved(" in APP


def test_saved_message_scrolls_like_a_ticker_when_it_overflows():
    assert "function Ticker" in APP
    assert re.search(r"<Ticker text=\{messageText\} />", APP)
    # Recording and paused: the message line is empty (errors excepted).
    assert "quiet && !notice.isError ? '' : notice.text" in APP
    assert "aria-hidden=\"true\"" in APP  # the repeated copy is hidden from screen readers
    assert re.search(r"\.ticker-track\s*\{[^}]*animation-name:\s*ticker", APP_CSS, re.DOTALL)
    assert re.search(r"@keyframes ticker", APP_CSS)
    assert re.search(r"@media \(prefers-reduced-motion: reduce\)", APP_CSS)


# F-014: 操作ボタンはアイコンと aria-label / title を持つ
def test_buttons_have_japanese_labels_and_titles():
    for label in ["開始", "停止", "一時停止", "再開"]:
        assert f'"{label}"' in APP or f"'{label}'" in APP, f"{label} のラベルがありません"
    assert APP.count("title=") >= 3, "各ボタンに title が必要です"
    assert APP.count("aria-label=") >= 3, "各ボタンに aria-label が必要です"


# F-015: 「待機中」「録音中」「一時停止中」の状態ラベルを表示しない
def test_no_status_label_text_is_rendered():
    for text in ["待機中", "録音中", "一時停止中"]:
        assert text not in APP, f"状態ラベル「{text}」が画面に出ています"


# F-018: 画面の文言は日本語
def test_page_language_is_japanese():
    assert '<html lang="ja">' in INDEX_HTML
    assert "<title>Video Recoder</title>" in INDEX_HTML
