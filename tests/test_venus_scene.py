"""Tests for the isolated original-photo bust tracking scene. Run: python -m pytest -q tests/test_venus_scene.py"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from app import app  # noqa: E402
from tracker import reference_cache, get_zones, track  # noqa: E402

REFS = ROOT / "server" / "track_refs" / "venus_head"


def test_bust_zone_does_not_replace_tower():
    zones = get_zones()
    assert "tower" in zones and "venus_head" in zones
    assert len(zones["venus_head"]["views"]) == 7
    assert len(reference_cache()["venus_head"]) == 7


def test_original_photo_pixels_and_alpha_masks():
    for view in get_zones()["venus_head"]["views"]:
        img = cv2.imread(str(REFS / view["image"]), cv2.IMREAD_UNCHANGED)
        overlay = cv2.imread(str(REFS / view["overlay"]), cv2.IMREAD_UNCHANGED)
        assert img is not None and overlay is not None
        assert img.ndim == 3 and img.shape[2] == 4
        assert overlay.shape == img.shape
        assert np.any(img[:, :, 3] == 0) and np.any(img[:, :, 3] >= 200)
        assert np.any(overlay[:, :, 3] > 0)


def test_each_training_view_reacquired_on_composite_background():
    for view in get_zones()["venus_head"]["views"]:
        rgba = cv2.imread(str(REFS / view["image"]), cv2.IMREAD_UNCHANGED)
        alpha = rgba[:, :, 3:4].astype(np.float32) / 255
        background = np.full_like(rgba[:, :, :3], 125)
        img = (rgba[:, :, :3] * alpha + background * (1 - alpha)).astype(np.uint8)
        result = track(img, "venus_head", preferred_view=view["id"])
        assert result["found"], (view["id"], result)
        assert result["inliers"] >= 15, (view["id"], result)


def test_empty_and_ordinary_room_not_detected():
    assert track(np.full((720, 960, 3), 145, np.uint8), "venus_head")["found"] is False
    # A small crop of the original office photo containing no sculpture.
    # No dependence on a specific external file or scene.
    grid = np.tile(np.arange(960, dtype=np.uint8)[None, :, None], (720, 1, 3))
    assert track(grid, "venus_head")["found"] is False


def test_api_accepts_bust_frame_and_delivers_overlay():
    client = TestClient(app)
    zones = client.get('/api/track/zones')
    assert zones.status_code == 200
    assert any(z['id'] == 'venus_head' for z in zones.json()['zones'])
    rgba = cv2.imread(str(REFS / 'front.png'), cv2.IMREAD_UNCHANGED)
    alpha = rgba[:,:,3:4].astype(np.float32)/255.
    image=(rgba[:,:,:3]*alpha + 127*(1-alpha)).astype(np.uint8)
    ok,jpg=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,82]);assert ok
    resp=client.post('/api/track/frame',data={'zone':'venus_head'},files={'frame':('frame.jpg',jpg.tobytes(),'image/jpeg')})
    assert resp.status_code==200,resp.text
    pose=resp.json();assert pose['found'],pose
    assert pose['view']=='front'
    url=pose['overlay_url'];assert url.endswith('front-anchors.png')
    asset=client.get(url)
    assert asset.status_code==200 and asset.headers['content-type'].startswith('image/png')
    overlay=cv2.imdecode(np.frombuffer(asset.content,np.uint8),cv2.IMREAD_UNCHANGED)
    assert overlay.shape[1]==pose['image_width'] and overlay.shape[0]==pose['image_height']


def test_prebaked_descriptors_available():
    all_views = get_zones()
    for zone, views in (("tower", all_views["tower"]["views"]),
                        ("venus_head", all_views["venus_head"]["views"])):
        for view in views:
            feature_file = view.get("features")
            assert feature_file and feature_file.endswith(".npz")
            p = ROOT / "server" / "track_refs" / zone / feature_file
            assert p.is_file()
            with np.load(p, allow_pickle=False) as cache:
                assert cache["points"].shape[0] == cache["descriptors"].shape[0]
                assert cache["points"].shape[1] == 2
                assert cache["descriptors"].shape[1] == 128
