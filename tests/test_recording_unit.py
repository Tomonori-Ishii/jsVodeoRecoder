"""録画処理の単体テスト（Node.js の node:test）を実行する（F-030、F-031、F-039、F-040。設計書 19 章）。

テスト本体は electron/recording/recording.test.cjs にある。Node.js が無い環境ではスキップする。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def test_recording_unit_tests_pass():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node が見つかりません")
    result = subprocess.run(
        [node, "--test", "electron/recording/"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
