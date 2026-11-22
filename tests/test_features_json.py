"""docs/features.json の形式と整合性を検査する。"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

REQUIRED_KEYS = {
    "id",
    "title",
    "description",
    "category",
    "priority",
    "status",
    "implemented",
    "testPath",
    "acceptance",
    "design",
    "verification",
}
ALLOWED_STATUS = {"implemented", "planned", "superseded"}
ALLOWED_PRIORITY = {"must", "should"}
ALLOWED_E2E = {"passed", "failed", "not-run"}
ALLOWED_REAL_MIC = {"passed", "failed", "not-run", "not-verified"}


def test_feature_ids_are_unique_and_well_formed(features):
    ids = [f["id"] for f in features["features"]]
    assert len(ids) == len(set(ids)), "機能 ID が重複しています"
    for feature_id in ids:
        assert re.fullmatch(r"F-\d{3}", feature_id), f"ID の形式が不正: {feature_id}"


def test_each_feature_has_required_keys(features):
    for feature in features["features"]:
        missing = REQUIRED_KEYS - feature.keys()
        assert not missing, f"{feature['id']} に項目がありません: {sorted(missing)}"


def test_status_and_priority_values_are_allowed(features):
    for feature in features["features"]:
        assert feature["status"] in ALLOWED_STATUS, feature["id"]
        assert feature["priority"] in ALLOWED_PRIORITY, feature["id"]


def test_implemented_flag_matches_status(features):
    for feature in features["features"]:
        expected = feature["status"] == "implemented"
        assert feature["implemented"] is expected, (
            f"{feature['id']}: status={feature['status']} なのに implemented={feature['implemented']}"
        )


def test_each_feature_has_acceptance_criteria(features):
    for feature in features["features"]:
        assert feature["acceptance"], f"{feature['id']} に受け入れ条件がありません"


def test_verification_values_are_allowed(features):
    for feature in features["features"]:
        verification = feature["verification"]
        assert verification["automatedE2E"] in ALLOWED_E2E, feature["id"]
        assert verification["realMicrophone"] in ALLOWED_REAL_MIC, feature["id"]


def _design_headings():
    text = (ROOT / "docs" / "design.md").read_text(encoding="utf-8")
    return {m.group(1).strip() for m in re.finditer(r"^## (.+)$", text, re.MULTILINE)}


def test_design_references_point_to_existing_sections(features):
    headings = _design_headings()
    for feature in features["features"]:
        for ref in feature["design"]:
            assert ref in headings, f"{feature['id']}: docs/design.md に見出し「{ref}」がありません"


def test_requirements_document_lists_the_same_feature_ids(features):
    text = (ROOT / "docs" / "requirements.md").read_text(encoding="utf-8")
    documented = set(re.findall(r"^### (F-\d{3}) ", text, re.MULTILINE))
    registered = {f["id"] for f in features["features"]}
    assert documented == registered, (
        f"要件書だけにあるもの: {sorted(documented - registered)} / "
        f"機能一覧だけにあるもの: {sorted(registered - documented)}"
    )


def test_test_paths_are_null_or_existing_files(features):
    for feature in features["features"]:
        test_path = feature["testPath"]
        if test_path is None:
            continue
        assert (ROOT / test_path).is_file(), (
            f"{feature['id']} の testPath が存在しません: {test_path}"
        )


def test_planned_features_have_no_test_path_yet(features):
    # 実装前の機能はテストがまだ存在しないため、testPath は null のまま。
    for feature in features["features"]:
        if feature["status"] == "planned":
            assert feature["testPath"] is None, feature["id"]
