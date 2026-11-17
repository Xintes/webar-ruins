"""Проверки вычисления гомографии на тестовой фотографии и фейковых ракурсах."""
from pathlib import Path
import io
import json
import sys

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tracker import reference_cache, track, decode_image

HERE = Path(__file__).resolve().parents[1]
REFERENCE = cv2.imread(str(HERE / 'track_refs' / 'tower' / 'reference.png'))


def test_reference_is_detected():
    res = track(REFERENCE, 'tower')
    assert res['found'], res
    assert res['inliers'] >= 60
    H = np.array(res['homography']).reshape(3, 3)
    assert np.isfinite(H).all()


def test_scaled_reference_is_detected():
    scaled = cv2.resize(REFERENCE, (720, 560))
    res = track(scaled, 'tower')
    assert res['found'], res
    assert res['median_error_px'] < 2.0


def test_projective_view_is_detected():
    h, w = REFERENCE.shape[:2]
    src = np.float32([[0,0],[w,0],[w,h],[0,h]])
    dst = np.float32([[58,20],[w-20,36],[w-50,h-30],[18,h-20]])
    H = cv2.getPerspectiveTransform(src,dst)
    warped = cv2.warpPerspective(REFERENCE, H, (w,h))
    res = track(warped, 'tower')
    assert res['found'], res
    actual = np.array(res['homography']).reshape(3,3)
    test_pts = np.float32([[620,250],[800,410],[650,670]]).reshape(-1,1,2)
    # Сервер обрабатывает кадр шириной не более 960 px.
    S = np.diag([res["frame_width"]/w,res["frame_height"]/h,1.])
    a = cv2.perspectiveTransform(test_pts,S @ H)
    b = cv2.perspectiveTransform(test_pts,actual)
    assert np.max(np.linalg.norm(a-b,axis=2)) < 5.0


def test_background_alone_is_rejected():
    # На части снимка нет башни.
    result = track(REFERENCE[:300,:490], 'tower')
    assert not result['found']


def test_blank_frame_is_rejected():
    result=track(np.full((600,800,3),200,dtype=np.uint8), 'tower')
    assert not result['found']


def test_bad_image_is_rejected():
    try:
        decode_image(b'not an image')
    except ValueError:
        return
    raise AssertionError('Bad image accepted')
