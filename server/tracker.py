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
import time

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
            # Reference PNG may contain an alpha mask: exclude the room/background
            # from keypoint detection without altering the pixels of the bust itself.
            # A pre-baked SIFT/ORB set avoids costly reference feature extraction
            # when a free cloud instance wakes up. The feature file is trusted
            # only when listed in our local manifest and passes sanity checks.
            cache_filename = item.get("features", "")
            if (isinstance(cache_filename, str) and
                    re.fullmatch(r"[a-zA-Z0-9_-]+\.npz", cache_filename)):
                descriptor_path = REF_ROOT / zone / cache_filename
                if descriptor_path.is_file():
                    try:
                        with np.load(str(descriptor_path), allow_pickle=False) as feature_data:
                            p = np.asarray(feature_data["points"], dtype=np.float32)
                            d = np.asarray(feature_data["descriptors"])
                            reference_region = tuple(int(v) for v in feature_data["region"])
                            original_size = tuple(int(v) for v in feature_data["image_size"])
                            algorithm = str(feature_data["algorithm"].item())
                            norm = int(feature_data["norm"].item())
                        expected_width = 128 if algorithm == "SIFT" else 32
                        expected_norm = cv2.NORM_L2 if algorithm == "SIFT" else cv2.NORM_HAMMING
                        valid = (algorithm in ("SIFT", "ORB") and
                                 (algorithm != "SIFT" or hasattr(cv2, "SIFT_create")) and
                                 norm == expected_norm and p.ndim == 2 and p.shape[1] == 2 and
                                 d.ndim == 2 and d.shape[1] == expected_width and
                                 14 <= len(p) <= 6000 and len(p) == len(d) and
                                 len(reference_region) == 4 and len(original_size) == 2 and
                                 min(original_size) >= 120 and np.isfinite(p).all())
                        if valid:
                            result[zone].append(View(zone, item["id"], item.get("label", item["id"]),
                                                     original_size, reference_region,
                                                     p, d, overlay, norm, algorithm))
                            continue
                    except (OSError, KeyError, TypeError, ValueError, IndexError):
                        # Bad/missing cache must not disable training: fall back
                        # to extracting descriptors directly from the PNG alpha.
                        pass
            source = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            if source is None:
                continue
            ref_mask = None
            if source.ndim == 3 and source.shape[2] == 4:
                ref_mask = source[:, :, 3]
                image = cv2.cvtColor(source, cv2.COLOR_BGRA2BGR)
            elif source.ndim == 3 and source.shape[2] == 3:
                image = source
            elif source.ndim == 2:
                image = cv2.cvtColor(source, cv2.COLOR_GRAY2BGR)
            else:
                continue
            orig_h, orig_w = image.shape[:2]
            if min(orig_h, orig_w) < 120:
                continue
            resized = _limit_width(image, _MAX_REFERENCE_WIDTH)
            rh, rw = resized.shape[:2]
            if ref_mask is not None:
                scaled_mask = cv2.resize(ref_mask, (rw, rh), interpolation=cv2.INTER_AREA)
                ref_mask = (scaled_mask >= 200).astype(np.uint8) * 255
                # Keep contour/alpha fringes from creating artificial SIFT features.
                ref_mask = cv2.erode(ref_mask, np.ones((5, 5), np.uint8))
            # ROI можно задавать для каждой обзорной зоны. Не включать небо!
            roi = item.get("roi", cfg.get("roi", [0.42, 0.17, 0.32, 0.66]))
            x, y, w, h = [float(i) for i in roi]
            x0 = max(0, min(rw - 1, round(x * rw)))
            y0 = max(0, min(rh - 1, round(y * rh)))
            x1 = max(x0 + 1, min(rw, round((x + w) * rw)))
            y1 = max(y0 + 1, min(rh, round((y + h) * rh)))
            gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
            feature, norm, alg = _features()
            roi_mask = ref_mask[y0:y1, x0:x1] if ref_mask is not None else None
            kps, desc = feature.detectAndCompute(gray[y0:y1, x0:x1], roi_mask)
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


# Пороги проверки геометрии сохраняем строгими, чтобы не распознавать чужую кладку.
_REASON_TEXT = {
    "no_reference": "Для зоны нет подготовленных эталонных кадров",
    "low_texture": "В кадре недостаточно характерных деталей",
    "few_matches": "Недостаточно согласованных характерных точек",
    "ransac_failure": "Не удалось подтвердить геометрию совпадений",
    "few_inliers": "Недостаточно геометрически подтверждённых совпадений",
    "reprojection_error": "Слишком велика ошибка сопоставления",
    "low_coverage": "Совпадения сосредоточены на слишком маленьком участке",
    "invalid_geometry": "Недостоверная перспектива найденного объекта",
    "hint_miss": "Не удалось подтвердить прежнее положение — переходим к поиску по всему кадру",
}


def _try_view(view: View, frame_shape: tuple[int, int], keypoints, descriptors,
              offset: tuple[int, int] = (0, 0)) -> tuple[dict | None, dict]:
    info = {"reason_code": "few_matches", "matched": 0, "inliers": 0}
    matcher = cv2.BFMatcher(view.norm)
    try:
        pairs = matcher.knnMatch(view.descriptors, descriptors, k=2)
    except cv2.error:
        return None, info
    matches = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.72 * p[1].distance]
    info["matched"] = len(matches)
    if len(matches) < 15:
        return None, info
    src = np.float32([view.points[m.queryIdx] for m in matches])
    dst = np.float32([(keypoints[m.trainIdx].pt[0] + offset[0],
                       keypoints[m.trainIdx].pt[1] + offset[1]) for m in matches])
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.5,
                                maxIters=2500, confidence=0.997)
    info["reason_code"] = "ransac_failure"
    if H is None or mask is None or not np.isfinite(H).all():
        return None, info
    inliers = mask.reshape(-1).astype(bool)
    count = int(inliers.sum())
    info["inliers"] = count
    info["reason_code"] = "few_inliers"
    ratio = count / len(matches)
    if count < 15 or ratio < 0.48:
        return None, info
    predicted = cv2.perspectiveTransform(src[inliers].reshape(-1, 1, 2), H).reshape(-1, 2)
    error = np.linalg.norm(predicted - dst[inliers], axis=1)
    med_error = float(np.median(error))
    info["reason_code"] = "reprojection_error"
    if med_error > 4.5:
        return None, info
    src_in = src[inliers]
    bb = np.ptp(src_in, axis=0)
    region_area = max(1, view.region[2] * view.region[3])
    coverage = float(bb[0] * bb[1] / region_area)
    info["reason_code"] = "low_coverage"
    if coverage < 0.045:
        return None, info
    frame_h, frame_w = frame_shape
    x, y, w, h = view.region
    roi_corners = np.float32([[x, y], [x+w, y], [x+w, y+h], [x, y+h]]).reshape(-1, 1, 2)
    transformed = cv2.perspectiveTransform(roi_corners, H).reshape(-1, 2)
    info["reason_code"] = "invalid_geometry"
    area = float(abs(cv2.contourArea(transformed.astype(np.float32))))
    if not np.isfinite(transformed).all() or not cv2.isContourConvex(transformed.astype(np.float32)):
        return None, info
    if area < frame_w * frame_h * 0.005 or area > frame_w * frame_h * 2.0:
        return None, info
    edge_a = np.linalg.norm(np.roll(transformed, -1, axis=0) - transformed, axis=1)
    if np.min(edge_a) < 8 or max(edge_a) / max(1, min(edge_a)) > 22:
        return None, info
    visible = np.any((transformed[:, 0] >= -0.5*frame_w) &
                     (transformed[:, 0] <= 1.5*frame_w) &
                     (transformed[:, 1] >= -0.5*frame_h) &
                     (transformed[:, 1] <= 1.5*frame_h))
    if not visible or abs(float(H[2, 2])) < 1e-9:
        return None, info
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
    }, info


def _hint_region(image_shape: tuple[int, int], hint_roi: list[float] | None):
    """Validated normalized rectangle (x, y, width, height) of expected location."""
    if hint_roi is None:
        return None
    if len(hint_roi) != 4 or not all(math.isfinite(n) for n in hint_roi):
        return None
    x, y, w, h = hint_roi
    if not (0 <= x < 1 and 0 <= y < 1 and 0.12 <= w <= 1 and 0.12 <= h <= 1):
        return None
    height, width = image_shape
    x0, y0 = round(x * width), round(y * height)
    x1, y1 = min(width, round((x + w) * width)), min(height, round((y + h) * height))
    if x1 - x0 < 80 or y1 - y0 < 80:
        return None
    # Tiny hint crops are untrustworthy for a spatial match.
    if (x1 - x0) * (y1 - y0) < width * height * 0.07:
        return None
    return (x0, y0, x1, y1)


def track(frame: np.ndarray, zone: str, preferred_view: str | None = None,
          hint_roi: list[float] | None = None) -> dict:
    """Find a reference feature homography, optionally starting with known region.

    Cropped search is a *single cheap attempt*, not an additional global pass.
    On crop failure the client must send the next frame without hint_roi.
    """
    started = time.perf_counter()
    def finished(result, *, mode, feature_ms=0.0, match_ms=0.0, features=0):
        result.update({
            "search_mode": mode,
            "feature_count": features,
            "feature_ms": round(feature_ms, 1),
            "match_ms": round(match_ms, 1),
            "processing_ms": round((time.perf_counter() - started) * 1000, 1),
        })
        return result

    views = reference_cache().get(zone)
    if not views:
        return finished({"found": False, "reason_code": "no_reference", "reason": _REASON_TEXT["no_reference"]}, mode="global")
    frame = _limit_width(frame, _MAX_FRAME_WIDTH)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    region = _hint_region(gray.shape[:2], hint_roi)
    mode = "hint" if region else "global"
    feature = _features()[0]
    if region:
        x0, y0, x1, y1 = region
        kps, desc = feature.detectAndCompute(gray[y0:y1, x0:x1], None)
        offset = (x0, y0)
    else:
        kps, desc = feature.detectAndCompute(gray, None)
        offset = (0, 0)
    feature_ms = (time.perf_counter() - started) * 1000
    num_features = len(kps or [])
    if desc is None or num_features < 15:
        code = "hint_miss" if region else "low_texture"
        return finished({"found": False, "reason_code": code, "reason": _REASON_TEXT[code], "matched": 0, "inliers": 0},
                        mode=mode, feature_ms=feature_ms, features=num_features)
    ordered = sorted(views, key=lambda v: v.view_id != preferred_view)
    best = None
    best_failure = {"reason_code": "few_matches", "matched": 0, "inliers": 0}
    for view in ordered:
        if view.norm != (cv2.NORM_L2 if view.algorithm == "SIFT" else cv2.NORM_HAMMING):
            continue
        candidate, info = _try_view(view, gray.shape[:2], kps, desc, offset)
        if info["inliers"] > best_failure["inliers"] or (info["inliers"] == best_failure["inliers"] and info["matched"] > best_failure["matched"]):
            best_failure = info
        if candidate is not None and (best is None or candidate["_score"] > best["_score"]):
            best = candidate
            # With many trained viewpoints, last accepted view is usually sufficient.
            if view.view_id == preferred_view and candidate["inliers"] >= 40 and candidate["inlier_ratio"] >= 0.60 and candidate["median_error_px"] <= 2.5:
                break
    match_ms = (time.perf_counter() - started) * 1000 - feature_ms
    if best is None:
        code = "hint_miss" if region else best_failure["reason_code"]
        return finished({"found": False, "reason_code": code, "reason": _REASON_TEXT[code],
                         "matched": best_failure["matched"], "inliers": best_failure["inliers"]},
                        mode=mode, feature_ms=feature_ms, match_ms=match_ms, features=num_features)
    best.pop("_score")
    return finished(best, mode=mode, feature_ms=feature_ms, match_ms=match_ms, features=num_features)


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
