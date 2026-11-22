"""pytest の共通設定。プロジェクトのファイルを読むための基準パスを用意する。"""

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session")
def root() -> Path:
    """リポジトリのルートフォルダ。"""
    return ROOT


def read_text(relative_path: str) -> str:
    """リポジトリ内のテキストファイルを読む。"""
    return (ROOT / relative_path).read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def features() -> dict:
    """docs/features.json を読み込んだ内容。"""
    return json.loads(read_text("docs/features.json"))
