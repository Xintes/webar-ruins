"""Определение опорного объекта без нейросетей: белый контур / ORB по фото зоны.

Здесь намеренно нет «магического» определения 3D-позы. Ответ — 2D-область
на изображении. 3D-поза требует 3D-2D соответствий и калибровки камеры.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import cv2
import numpy as np

MAX_PROCESSING_WIDTH = 960


def decode_frame(data: bytes) -> np.ndarray:
    raw = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if frame is None or frame.ndim != 3:
        raise ValueError("Не удалось прочитать JPEG/PNG")
    h, w = frame.shape[:2]
    if h < 120 or w < 120 or h > 6000 or w > 6000:
        raise ValueError("Недопустимый размер кадра")
    if w > MAX_PROCESSING_WIDTH:
        frame = cv2.resize(frame, (MAX_PROCESSING_WIDTH, round(h * MAX_PROCESSING_WIDTH / w)), interpolation=cv2.INTER_AREA)
    return frame


def _result(method: str, image: np.ndarray, contour: np.ndarray, score: float, detail: dict[str, Any] | None = None) -> dict[str, Any]:
    height, width = image.shape[:2]
    poly = contour.reshape(-1, 2).astype(float)
    x, y, w, h = cv2.boundingRect(poly.astype(np.float32))
    return {
        "found": True,
        "method": method,
        # «confidence» здесь только эвристический балл, не вероятность.
        "score": round(float(np.clip(score, 0, 1)), 3),
        "frame": {"width": width, "height": height},
        "polygon": [[round(float(px / width), 5), round(float(py / height), 5)] for px, py in poly],
        "center": [round(float((x + w / 2) / width), 5), round(float((y + h / 2) / height), 5)],
        "bounds": [round(x / width, 5), round(y / height, 5), round(w / width, 5), round(h / height, 5)],
        "note": "Обнаружена похожая область, идентичность объекта не доказана" if method == "white_cube" else "Найдены общие визуальные признаки с фотографией зоны",
        **(detail or {}),
    }


def not_found(method: str, image: np.ndarray, reason: str = "Контрастный ориентир не обнаружен") -> dict[str, Any]:
    h, w = image.shape[:2]
    return {"found": False, "method": method, "score": 0, "frame": {"width": w, "height": h}, "reason": reason}


def detect_white_cube(image: np.ndarray, zone: dict[str, Any]) -> dict[str, Any]:
    """Ищет компактный белый многоугольник на контрастном фоне.

    Это детектор КАНДИДАТА на куб, а не распознавание произвольного белого куба
    в любой сцене. Помогает ограничение зоны и контраст с фоном.
    """
    h, w = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    s_max = int(zone.get("saturation_max", 85))
    v_min = int(zone.get("brightness_min", 145))
    mask = cv2.inRange(hsv, np.array([0, 0, v_min], dtype=np.uint8), np.array([179, s_max, 255], dtype=np.uint8))
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)

    roi = zone.get("roi", [0.05, 0.10, 0.90, 0.85])
    rx, ry, rw, rh = [float(v) for v in roi]
    x1, y1 = max(0, int(rx * w)), max(0, int(ry * h))
    x2, y2 = min(w, int((rx + rw) * w)), min(h, int((ry + rh) * h))
    limited = np.zeros_like(mask)
    if x2 <= x1 or y2 <= y1:
        return not_found("white_cube", image, "Некорректная зона поиска")
    limited[y1:y2, x1:x2] = mask[y1:y2, x1:x2]

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    contours, _ = cv2.findContours(limited, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = w * h
    best: tuple[float, np.ndarray, dict[str, Any]] | None = None
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < frame_area * float(zone.get("min_area_fraction", 0.003)) or area > frame_area * float(zone.get("max_area_fraction", 0.42)):
            continue
        x, y, bw, bh = cv2.boundingRect(contour)
        if min(bw, bh) < 18 or not (0.4 <= bw / bh <= 2.8):
            continue
        # Контуры, обрезанные зоной или краем кадра, игнорируем.
        if x <= x1 + 3 or y <= y1 + 3 or x + bw >= x2 - 3 or y + bh >= y2 - 3:
            continue
        hull = cv2.convexHull(contour)
        hull_area = max(1.0, cv2.contourArea(hull))
        solidity = area / hull_area
        if solidity < 0.82:
            continue
        approx = cv2.approxPolyDP(hull, 0.025 * cv2.arcLength(hull, True), True)
        if not (4 <= len(approx) <= 9):
            continue

        filled = np.zeros_like(mask)
        cv2.drawContours(filled, [hull], -1, 255, -1)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19))
        outside = cv2.subtract(cv2.dilate(filled, k), filled)
        # Не учитывать белые пиксели от других объектов как фон.
        inside_mean = cv2.mean(gray, mask=filled)[0]
        surrounding_mean = cv2.mean(gray, mask=outside)[0] if cv2.countNonZero(outside) > 20 else 255
        contrast = inside_mean - surrounding_mean
        if contrast < float(zone.get("min_contrast", 18)):
            continue
        white_ratio = cv2.countNonZero(cv2.bitwise_and(limited, filled)) / max(1, cv2.countNonZero(filled))
        if white_ratio < 0.75:
            continue

        center_x = (x + bw / 2) / w
        center_y = (y + bh / 2) / h
        center_bias = 1 - min(1, np.hypot((center_x - 0.5) * 1.3, (center_y - 0.5) * 1.3))
        contrast_score = np.clip((contrast - 18) / 90, 0, 1)
        shape_score = 1.0 if len(approx) in (5, 6, 7) else 0.7
        score = float(0.33 * contrast_score + 0.24 * solidity + 0.19 * white_ratio + 0.14 * shape_score + 0.10 * center_bias)
        if best is None or score > best[0]:
            best = (score, approx, {"diagnostics": {"contrast": round(contrast, 1), "vertices": len(approx), "white_fraction": round(white_ratio, 3)}})

    if best is None:
        return not_found("white_cube", image, "Белый контрастный многогранник не найден")
    score, polygon, extra = best
    return _result("white_cube", image, polygon, score, extra)


@lru_cache(maxsize=16)
def _load_orb_reference(filename: str) -> tuple[np.ndarray, list[cv2.KeyPoint], np.ndarray | None, tuple[int, int]]:
    ref = cv2.imread(filename, cv2.IMREAD_GRAYSCALE)
    if ref is None:
        raise FileNotFoundError(f"Нет фотографии зоны: {filename}")
    if ref.shape[1] > MAX_PROCESSING_WIDTH:
        factor = MAX_PROCESSING_WIDTH / ref.shape[1]
        ref = cv2.resize(ref, (MAX_PROCESSING_WIDTH, round(ref.shape[0] * factor)), interpolation=cv2.INTER_AREA)
    orb = cv2.ORB_create(nfeatures=1800, scaleFactor=1.2, nlevels=8, fastThreshold=10)
    keypoints, descriptors = orb.detectAndCompute(ref, None)
    return ref, keypoints, descriptors, (ref.shape[1], ref.shape[0])


def detect_reference(image: np.ndarray, zone: dict[str, Any], reference_root: Path) -> dict[str, Any]:
    """Сопоставление естественной текстуры фасада по ORB/RANSAC; 2D-гомография."""
    name = zone.get("reference", "")
    if not name or Path(name).name != name:
        return not_found("orb_reference", image, "Для зоны не настроена фотография")
    path = reference_root / name
    if not path.exists():
        return not_found("orb_reference", image, f"Отсутствует server/references/{name}")
    try:
        _, ref_keypoints, ref_desc, (rw, rh) = _load_orb_reference(str(path.resolve()))
    except (OSError, FileNotFoundError):
        return not_found("orb_reference", image, "Не удалось прочитать фотографию зоны")
    if ref_desc is None or len(ref_keypoints) < 20:
        return not_found("orb_reference", image, "На опорной фотографии недостаточно деталей")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(nfeatures=1800, scaleFactor=1.2, nlevels=8, fastThreshold=10)
    frame_keypoints, frame_desc = orb.detectAndCompute(gray, None)
    if frame_desc is None or len(frame_keypoints) < 20:
        return not_found("orb_reference", image, "В кадре недостаточно контрастных деталей")
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    pairs = matcher.knnMatch(ref_desc, frame_desc, k=2)
    good = [first for pair in pairs if len(pair) == 2 for first, second in [pair] if first.distance < 0.74 * second.distance]
    min_matches = max(12, int(zone.get("min_matches", 16)))
    if len(good) < min_matches:
        return not_found("orb_reference", image, f"Совпадений {len(good)} из {min_matches} необходимых")

    src = np.float32([ref_keypoints[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([frame_keypoints[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    homography, inlier_mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    if homography is None or inlier_mask is None:
        return not_found("orb_reference", image, "Недостаточно согласованных точек")
    inliers = int(inlier_mask.sum())
    if inliers < min_matches or inliers / len(good) < 0.45:
        return not_found("orb_reference", image, "Геометрия совпадений противоречива")

    rectangle = np.float32([[0, 0], [rw, 0], [rw, rh], [0, rh]]).reshape(-1, 1, 2)
    polygon = cv2.perspectiveTransform(rectangle, homography)
    poly = polygon.reshape(-1, 2)
    if not np.isfinite(poly).all():
        return not_found("orb_reference", image, "Неустойчивая перспектива")
    area = abs(cv2.contourArea(poly.astype(np.float32)))
    h, w = image.shape[:2]
    if area < w * h * 0.002 or area > w * h * 2.5 or not cv2.isContourConvex(poly.astype(np.float32)):
        return not_found("orb_reference", image, "Неверная геометрия опорной области")
    if np.any(poly[:, 0] < -w * 0.5) or np.any(poly[:, 0] > w * 1.5) or np.any(poly[:, 1] < -h * 0.5) or np.any(poly[:, 1] > h * 1.5):
        return not_found("orb_reference", image, "Опорная область слишком далеко от кадра")

    score = float(min(1, (inliers / max(20, min_matches * 2)) * (inliers / len(good))))
    return _result("orb_reference", image, polygon, score, {"diagnostics": {"matches": len(good), "inliers": inliers}})


def detect(image: np.ndarray, zone: dict[str, Any], references: Path) -> dict[str, Any]:
    method = zone.get("method", "")
    if method == "white_cube":
        return detect_white_cube(image, zone)
    if method == "orb_reference":
        return detect_reference(image, zone, references)
    raise ValueError(f"Неподдерживаемый метод зоны: {method}")
