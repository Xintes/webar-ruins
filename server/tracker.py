"""Многовидовая markerless-привязка по естественным признакам (SIFT/ORB + RANSAC).

Возвращает проектное преобразование опорной ФОТОГРАФИИ в текущий кадр.
Это НЕ 6DoF pose и не метрическая регистрация 3D-объекта: на объёмной сцене
точность справедлива в окрестности опорного ракурса.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import json
import math
import re
import threading

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
REF_ROOT = ROOT / "track_refs"
MANIFEST_PATH = ROOT / "track_zones.json"
_MAX_FRAME_WIDTH = 960
_MAX_REFERENCE_WIDTH = 1600
_LOCK = threading.Lock()


def decode_image(content: bytes, limit_bytes: int = 3_000_000) -> np.ndarray:
    if len(content) > limit_bytes:
        raise ValueError("Изображение слишком большое")
    if not content:
        raise ValueError("Пустое изображение")
    arr = np.frombuffer(content, np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None or image.ndim != 3:
        raise ValueError("Ожидался JPEG или PNG")
    h, w = image.shape[:2]
    if min(h, w) < 120 or max(h, w) > 5000:
        raise ValueError("Недопустимый размер изображения")
    return image


def _limit_width(img: np.ndarray, width: int) -> np.ndarray:
    h, w = img.shape[:2]
    if w <= width:
        return img
    return cv2.resize(img, (width, round(h * width / w)), interpolation=cv2.INTER_AREA)


def _features():
    # SIFT есть в обычном opencv-python-headless 4.x, CNN здесь нет.
    if hasattr(cv2, "SIFT_create"):
        return cv2.SIFT_create(nfeatures=1600, contrastThreshold=0.035), cv2.NORM_L2, "SIFT"
    return cv2.ORB_create(nfeatures=2600, scaleFactor=1.2, nlevels=8, fastThreshold=12), cv2.NORM_HAMMING, "ORB"


def get_zones() -> dict:
    with _LOCK:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _safe_filename(filename: str) -> bool:
    return bool(re.fullmatch(r"[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg)", filename))


@dataclass
class View:
    zone: str
    view_id: str
    label: str
    image_size: tuple[int, int]  # width, height of original reference
    region: tuple[int, int, int, int]
    points: np.ndarray  # coordinates in original reference image
    descriptors: np.ndarray
    overlay: str
    norm: int
    algorithm: str


@lru_cache(maxsize=1)
def reference_cache() -> dict[str, list[View]]:
    zones = get_zones()
    result: dict[str, list[View]] = {}
    for zone, cfg in zones.items():
        result[zone] = []
        for item in cfg.get("views", []):
            fn = item.get("image", "")
            overlay = item.get("overlay", "")
            if not (_safe_filename(fn) and _safe_filename(overlay)):
                continue
            path = REF_ROOT / zone / fn
            if not path.exists():
                continue
            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if image is None:
                continue
            orig_h, orig_w = image.shape[:2]
            if min(orig_h, orig_w) < 120:
                continue
            resized = _limit_width(image, _MAX_REFERENCE_WIDTH)
            rh, rw = resized.shape[:2]
            # ROI можно задавать для каждой обзорной зоны. Не включать небо!
            roi = item.get("roi", cfg.get("roi", [0.42, 0.17, 0.32, 0.66]))
            x, y, w, h = [float(i) for i in roi]
            x0 = max(0, min(rw - 1, round(x * rw)))
            y0 = max(0, min(rh - 1, round(y * rh)))
            x1 = max(x0 + 1, min(rw, round((x + w) * rw)))
            y1 = max(y0 + 1, min(rh, round((y + h) * rh)))
            gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
            feature, norm, alg = _features()
            kps, desc = feature.detectAndCompute(gray[y0:y1, x0:x1], None)
            if desc is None or len(kps) < 14:
                continue
            points = np.float32([((kp.pt[0] + x0) * orig_w / rw,
                                  (kp.pt[1] + y0) * orig_h / rh) for kp in kps])
            result[zone].append(View(zone, item["id"], item.get("label", item["id"]),
                                     (orig_w, orig_h),
                                     (round(x * orig_w), round(y * orig_h),
                                      round(w * orig_w), round(h * orig_h)),
                                     points, desc, overlay, norm, alg))
    return result


def _try_view(view: View, gray: np.ndarray, keypoints, descriptors) -> dict | None:
    matcher = cv2.BFMatcher(view.norm)
    # взаимная проверка соседства дескрипторов (ratio test)
    try:
        pairs = matcher.knnMatch(view.descriptors, descriptors, k=2)
    except cv2.error:
        return None
    matches = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.72 * p[1].distance]
    if len(matches) < 15:
        return None
    src = np.float32([view.points[m.queryIdx] for m in matches])
    dst = np.float32([keypoints[m.trainIdx].pt for m in matches])
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.5,
                                maxIters=2500, confidence=0.997)
    if H is None or mask is None or not np.isfinite(H).all():
        return None
    inliers = mask.reshape(-1).astype(bool)
    count = int(inliers.sum())
    ratio = count / len(matches)
    if count < 15 or ratio < 0.48:
        return None
    predicted = cv2.perspectiveTransform(src[inliers].reshape(-1, 1, 2), H).reshape(-1, 2)
    error = np.linalg.norm(predicted - dst[inliers], axis=1)
    med_error = float(np.median(error))
    if med_error > 4.5:
        return None
    # Область совпадений должна быть распределена, а не собрана на одном кирпиче.
    src_in = src[inliers]
    bb = np.ptp(src_in, axis=0)
    region_area = max(1, view.region[2] * view.region[3])
    coverage = float(bb[0] * bb[1] / region_area)
    if coverage < 0.045:
        return None
    frame_h, frame_w = gray.shape[:2]
    x, y, w, h = view.region
    roi_corners = np.float32([[x, y], [x+w, y], [x+w, y+h], [x, y+h]]).reshape(-1, 1, 2)
    transformed = cv2.perspectiveTransform(roi_corners, H).reshape(-1, 2)
    area = float(abs(cv2.contourArea(transformed.astype(np.float32))))
    if not np.isfinite(transformed).all() or not cv2.isContourConvex(transformed.astype(np.float32)):
        return None
    if area < frame_w * frame_h * 0.005 or area > frame_w * frame_h * 2.0:
        return None
    # Устранение явно вывернутых/некорректных перспектив.
    edge_a = np.linalg.norm(np.roll(transformed, -1, axis=0) - transformed, axis=1)
    if np.min(edge_a) < 8 or max(edge_a) / max(1, min(edge_a)) > 22:
        return None
    visible = np.any((transformed[:, 0] >= -0.5*frame_w) &
                     (transformed[:, 0] <= 1.5*frame_w) &
                     (transformed[:, 1] >= -0.5*frame_h) &
                     (transformed[:, 1] <= 1.5*frame_h))
    if not visible:
        return None
    if abs(float(H[2, 2])) < 1e-9:
        return None
    H = H / H[2, 2]
    score = count * ratio * min(1., coverage * 6) / (1. + med_error / 5.)
    return {
        "found": True, "view": view.view_id, "view_label": view.label,
        "image_width": view.image_size[0], "image_height": view.image_size[1],
        "frame_width": frame_w, "frame_height": frame_h,
        "homography": [round(float(v), 8) for v in H.reshape(-1)],
        "roi_polygon": [[round(float(px), 1), round(float(py), 1)] for px, py in transformed],
        "overlay_url": f"/api/track/assets/{view.zone}/{view.overlay}",
        "matched": len(matches), "inliers": count,
        "inlier_ratio": round(ratio, 3), "median_error_px": round(med_error, 2),
        "coverage": round(coverage, 3),
        "algorithm": view.algorithm, "_score": score,
    }


def track(frame: np.ndarray, zone: str) -> dict:
    views = reference_cache().get(zone)
    if not views:
        return {"found": False, "reason": "Для зоны нет подготовленных эталонных кадров"}
    frame = _limit_width(frame, _MAX_FRAME_WIDTH)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    feature, norm, alg = _features()
    kp, desc = feature.detectAndCompute(gray, None)
    if desc is None or len(kp) < 15:
        return {"found": False, "reason": "В кадре недостаточно характерных деталей"}
    best = None
    for view in views:
        if view.norm != norm:
            continue
        candidate = _try_view(view, gray, kp, desc)
        if candidate is not None and (best is None or candidate["_score"] > best["_score"]):
            best = candidate
    if best is None:
        return {"found": False, "reason": "Ракурс не распознан — наведите камеру ближе к опорной фотографии", "algorithm": alg}
    best.pop("_score")
    return best


def register_view(zone: str, reference_data: bytes, overlay_data: bytes, roi: list[float] | None = None) -> str:
    import time
    import uuid
    image = decode_image(reference_data)
    if roi is not None:
        if (len(roi) != 4 or not all(math.isfinite(v) for v in roi)
            or roi[0] < 0 or roi[1] < 0 or roi[2] < 0.06 or roi[3] < 0.06
            or roi[0] + roi[2] > 1.001 or roi[1] + roi[3] > 1.001):
            raise ValueError("ROI должен быть прямоугольником внутри изображения")
    # На этапе 1 наложение и эталон должны иметь одинаковые пиксельные размеры.
    overlay_np = cv2.imdecode(np.frombuffer(overlay_data, np.uint8), cv2.IMREAD_UNCHANGED)
    if overlay_np is None or overlay_np.ndim != 3 or overlay_np.shape[2] != 4:
        raise ValueError("Наложение должно быть прозрачным PNG (RGBA)")
    if image.shape[:2] != overlay_np.shape[:2]:
        raise ValueError("Размер PNG-наложения должен точно совпадать с фотографией")
    if overlay_np.shape[0] > 3000 or overlay_np.shape[1] > 3000 or len(overlay_data) > 7_000_000:
        raise ValueError("Наложение слишком большое")
    if int(overlay_np[:,:,3].max()) == 0:
        raise ValueError("PNG-наложение полностью прозрачное")
    with _LOCK:
        zones = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        if zone not in zones:
            raise ValueError("Неизвестная зона")
        slug = f"view-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        folder = REF_ROOT / zone
        folder.mkdir(parents=True, exist_ok=True)
        reference_name, overlay_name = f"{slug}.jpg", f"{slug}.png"
        # Перекодирование не даёт загрузить произвольные файлы под видом изображения.
        success, compressed = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 91])
        if not success:
            raise ValueError("Не удалось сохранить фотографию")
        (folder / reference_name).write_bytes(compressed.tobytes())
        (folder / overlay_name).write_bytes(overlay_data)
        view_record = {
            "id": slug, "label": f"Ракурс {len(zones[zone]['views'])+1}",
            "image": reference_name, "overlay": overlay_name,
        }
        if roi is not None:
            view_record["roi"] = roi
        zones[zone].setdefault("views", []).append(view_record)
        MANIFEST_PATH.write_text(json.dumps(zones, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        reference_cache.cache_clear()
    return slug
