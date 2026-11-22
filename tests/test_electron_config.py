"""electron/main.cjs と preload.cjs の設定を検査する（F-004, F-016, F-027, F-031, F-032, F-033。設計書 11、12、13、14、25 章）。

これは実際のウィンドウを開かず、ソースの記述を確認する静的な検査です。
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN = (ROOT / "electron" / "main.cjs").read_text(encoding="utf-8")
PRELOAD = (ROOT / "electron" / "preload.cjs").read_text(encoding="utf-8")


def _value(name: str) -> str:
    match = re.search(rf"const {name} = ([^;]+);", MAIN)
    assert match, f"{name} が定義されていません"
    return match.group(1).strip()


def _has(pattern: str) -> bool:
    return re.search(pattern, MAIN) is not None


# F-016: ウィンドウは 256×80 の固定サイズ（設計書 14 章）
def test_window_content_size_is_256_by_80():
    assert _value("WINDOW_WIDTH") == "256"
    assert _value("WINDOW_HEIGHT") == "80"
    assert _has(r"useContentSize:\s*true")


def test_window_cannot_be_resized_maximized_or_fullscreened():
    assert _has(r"resizable:\s*false")
    assert _has(r"maximizable:\s*false")
    assert _has(r"fullscreenable:\s*false")


# 設計書 13 章: Electron のセキュリティ設定
def test_web_preferences_are_locked_down():
    assert _has(r"contextIsolation:\s*true")
    assert _has(r"nodeIntegration:\s*false")
    assert _has(r"sandbox:\s*true")


def test_preload_script_is_configured_and_sandboxed():
    assert _has(r"preload:\s*path\.join\(__dirname, 'preload\.cjs'\)")
    assert _has(r"sandbox:\s*true")


# 設計書 12 章: preload が公開する API は録画に必要なチャンネルだけ
ALLOWED_CHANNELS = {
    "recording-saved",
    "rec:progress",
    "rec:auto-stop",
    "rec:error",
    "rec:start",
    "rec:write",
    "rec:finish",
}


def test_preload_exposes_only_the_recording_api():
    assert "contextBridge.exposeInMainWorld('recorder'" in PRELOAD
    # The page must not get the generic IPC functions or other Node.js APIs.
    assert "exposeInMainWorld('ipcRenderer'" not in PRELOAD
    assert "require('node:" not in PRELOAD and "require('fs')" not in PRELOAD
    channels = set(re.findall(r"ipcRenderer\.(?:on|invoke|send)\('([^']+)'", PRELOAD))
    channels |= set(re.findall(r"subscribe\('([^']+)'", PRELOAD))
    assert channels, "チャンネルが見つかりません"
    assert channels <= ALLOWED_CHANNELS, f"許可されていないチャンネル: {channels - ALLOWED_CHANNELS}"


def test_every_main_handler_is_a_recording_channel():
    handled = set(re.findall(r"ipcMain\.(?:handle|on)\('([^']+)'", MAIN))
    assert handled, "IPC の受け口が見つかりません"
    assert handled <= ALLOWED_CHANNELS


# F-033 / ADR-0025: 許可する権限は media（マイク）と display-capture（画面）だけ
def test_only_media_and_display_capture_permissions_are_granted():
    assert "const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture']);" in MAIN
    assert _has(r"callback\(ALLOWED_PERMISSIONS\.has\(permission\)\)")
    assert _has(r"setPermissionCheckHandler\(\(_wc, permission\) => ALLOWED_PERMISSIONS\.has\(permission\)\)")


# 設計書 23.1: 画面はピッカーなしで、プライマリ画面を返す（ADR-0021）
def test_display_capture_uses_primary_display_without_picker():
    assert _has(r"setDisplayMediaRequestHandler\(")
    assert _has(r"screen\.getPrimaryDisplay\(\)\.id")
    assert _has(r"display_id === primaryId")
    assert not _has(r"showSaveDialog|showOpenDialog"), "ダイアログを出さない方針です"


# F-027 / ADR-0021: 録画中、窓を映像から除外する（Windows と macOS）
def test_recording_window_is_excluded_from_capture_where_supported():
    assert _has(r"setContentProtection\(excluded\)")
    assert _has(r"process\.platform === 'win32' \|\| process\.platform === 'darwin'")


# F-032 / F-031: mp4 は .partial に書き、完了後に名前を変えて Downloads へ保存する
def test_mp4_is_written_to_partial_then_renamed_into_downloads():
    assert _has(r"app\.getPath\('downloads'\)")
    assert _has(r"\$\{finalPath\}\.partial")
    assert _has(r"fs\.renameSync\(partialPath, finalPath\)")
    assert _has(r"sendToWindow\('recording-saved', finalPath\)")
    assert not _has(r"will-download"), "録画の保存に will-download は使いません（ADR-0024）"


def test_page_is_loaded_from_local_dist_only():
    assert _has(r"loadFile\(path\.join\(__dirname, '\.\.', 'dist', 'index\.html'\)\)")
    assert not _has(r"loadURL\("), "外部 URL を読み込まない方針です（設計書 13 章）"
