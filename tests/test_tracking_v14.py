"""Checks for fast reacquisition and the existing tracking API. Run: python -m pytest -q tests/test_tracking_v14.py"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from app import app  # noqa: E402
from tracker import track, reference_cache  # noqa: E402

REFERENCE = cv2.imread(str(ROOT / "wall-lab" / "reference.png"))


def test_reference_is_detected():
    assert REFERENCE is not None
    assert reference_cache()["tower"]
    result = track(REFERENCE, "tower")
    assert result["found"] is True
    assert result["inliers"] >= 100
    assert result["search_mode"] == "global"
    assert result["median_error_px"] < 2
    assert result["processing_ms"] >= 0


def test_hint_roi_reacquires_and_matches_global():
    resized = cv2.resize(REFERENCE, (960, 747))
    base = track(resized, "tower")
    hinted = track(resized, "tower", preferred_view="demo", hint_roi=[.34, .11, .53, .80])
    assert base["found"] and hinted["found"]
    assert hinted["search_mode"] == "hint"
    assert hinted["inliers"] >= 40
    assert np.allclose(np.asarray(base["roi_polygon"]), np.asarray(hinted["roi_polygon"]), atol=3)


def test_rotated_view_is_still_recognized():
    h, w = REFERENCE.shape[:2]
    transform = cv2.getRotationMatrix2D((w / 2, h / 2), 4, .91)
    rotated = cv2.warpAffine(REFERENCE, transform, (w, h), borderValue=(120, 120, 120))
    result = track(rotated, "tower")
    assert result["found"] is True
    assert result["inliers"] >= 35


def test_wrong_hint_fails_then_global_reacquires():
    missing = track(REFERENCE, "tower", hint_roi=[0, .01, .23, .35])
    assert missing["found"] is False
    assert missing["search_mode"] == "hint"
    assert missing["reason_code"] == "hint_miss"
    again = track(REFERENCE, "tower")
    assert again["found"] is True


def test_empty_frame_not_detected():
    empty = np.full_like(REFERENCE, 120)
    for mode in (None, [.34, .11, .53, .8]):
        result = track(empty, "tower", hint_roi=mode)
        assert result["found"] is False


def test_api_works_with_legacy_and_new_optional_fields():
    client = TestClient(app)
    zones = client.get("/api/track/zones")
    assert zones.status_code == 200
    assert zones.json()["zones"][0]["id"] == "tower"
    ok, jpg = cv2.imencode(".jpg", REFERENCE, [cv2.IMWRITE_JPEG_QUALITY, 82])
    assert ok
    files = {"frame": ("test.jpg", jpg.tobytes(), "image/jpeg")}
    basic = client.post("/api/track/frame", data={"zone": "tower"}, files=files)
    assert basic.status_code == 200 and basic.json()["found"]
    hinted = client.post("/api/track/frame", data={"zone": "tower", "preferred_view": "demo", "hint_roi": "[0.34, 0.11, 0.53, 0.80]"}, files=files)
    assert hinted.status_code == 200 and hinted.json()["found"]
    assert hinted.json()["search_mode"] == "hint"
    invalid = client.post("/api/track/frame", data={"zone": "tower", "hint_roi": "{not-json"}, files=files)
    assert invalid.status_code == 400


def test_missing_reference_zone():
    result = track(REFERENCE, "does-not-exist")
    assert result["found"] is False
    assert result["reason_code"] == "no_reference"
