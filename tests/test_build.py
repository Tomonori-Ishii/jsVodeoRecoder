"""npm run build（vite build）の結果を検査する（F-021、F-024。設計書 18 章）。

一時フォルダへビルドするため、リポジトリの dist/ は書き換えない。
Node.js と node_modules が必要です。
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.build


@pytest.fixture(scope="module")
def built_dir(tmp_path_factory):
    npx = shutil.which("npx")
    if npx is None or not (ROOT / "node_modules" / ".bin" / "vite").exists():
        pytest.skip("node_modules/.bin/vite がありません。先に npm install を実行してください")
    out = tmp_path_factory.mktemp("dist")
    result = subprocess.run(
        [npx, "vite", "build", "--outDir", str(out), "--emptyOutDir"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return out


def test_build_produces_index_html(built_dir):
    assert (built_dir / "index.html").is_file()


def test_build_uses_relative_asset_paths_for_file_protocol(built_dir):
    html = (built_dir / "index.html").read_text(encoding="utf-8")
    assert re.search(r'(src|href)="\./assets/', html), "file:// で読めるよう相対パスにしてください（base: './'）"
    assert not re.search(r'(src|href)="/assets/', html)


def test_build_has_no_mp3_encoder_and_contains_h264_settings(built_dir):
    # MP3 is no longer produced (ADR-0017), so no MP3 encoder script is bundled.
    names = [p.name for p in (built_dir / "assets").iterdir()]
    assert not any(n.startswith("lame.min-") for n in names)
    # The H.264 codec string used by the recorder is present in the bundled script.
    scripts = "".join(p.read_text(encoding="utf-8") for p in (built_dir / "assets").glob("*.js"))
    assert "avc1.4d4028" in scripts
