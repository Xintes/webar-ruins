"""Небольшие независимые тесты серверного OpenCV: python -m unittest discover -s server/tests -v."""
import importlib.util
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))
from detector import decode_frame, detect_white_cube, detect_reference  # noqa: E402


class DetectorTests(unittest.TestCase):
    def test_white_cube_on_dark_background(self):
        image = np.full((480, 640, 3), 45, dtype=np.uint8)
        polygon = np.array([[265, 120], [368, 120], [415, 162], [415, 280], [305, 309], [265, 259]], dtype=np.int32)
        cv2.fillPoly(image, [polygon], (237, 237, 237))
        result = detect_white_cube(image, {"roi": [0.05, 0.05, 0.9, 0.9]})
        self.assertTrue(result["found"], result)
        self.assertAlmostEqual(result["center"][0], 340 / 640, delta=0.07)
        self.assertGreater(result["score"], 0.6)

    def test_no_cube_dark_background(self):
        image = np.full((480, 640, 3), 50, dtype=np.uint8)
        self.assertFalse(detect_white_cube(image, {})["found"])

    def test_white_background_rejected(self):
        image = np.full((480, 640, 3), 245, dtype=np.uint8)
        self.assertFalse(detect_white_cube(image, {})["found"])

    def test_decode_invalid_frame(self):
        with self.assertRaises(ValueError):
            decode_frame(b"bad bytes")

    def test_orb_reference_missing_fails_gently(self):
        image = np.full((480, 640, 3), 45, dtype=np.uint8)
        result = detect_reference(image, {"reference": "missing.jpg"}, SERVER_DIR / "references")
        self.assertFalse(result["found"])


if __name__ == "__main__":
    unittest.main()


class FeatureMatchingTests(unittest.TestCase):
    def test_orb_matches_textured_reference(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test_ref.jpg"
            reference = np.full((400, 600, 3), 190, dtype=np.uint8)
            rng = np.random.default_rng(42)
            for _ in range(240):
                x, y = rng.integers(25, 575), rng.integers(25, 375)
                color = int(rng.integers(20, 160))
                cv2.circle(reference, (int(x), int(y)), int(rng.integers(2, 9)), (color, color, color), -1)
            cv2.putText(reference, "RUINS 2026", (75, 190), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (30, 30, 30), 3)
            self.assertTrue(cv2.imwrite(str(path), reference))
            M = cv2.getRotationMatrix2D((300, 200), 7, 0.92)
            M[:, 2] += [25, 18]
            test_image = cv2.warpAffine(reference, M, (640, 480), borderValue=(80, 80, 80))
            outcome = detect_reference(test_image, {"reference": "test_ref.jpg", "min_matches": 16}, Path(tmp))
            self.assertTrue(outcome["found"], outcome)
            self.assertGreaterEqual(outcome["diagnostics"]["inliers"], 16)

    def test_white_cube_low_resolution(self):
        image = np.full((240, 320, 3), 45, dtype=np.uint8)
        poly = np.array([[126, 65], [180, 65], [204, 89], [204, 149], [152, 155], [126, 137]], np.int32)
        cv2.fillPoly(image, [poly], (230, 230, 230))
        blurred = cv2.GaussianBlur(image, (5, 5), 1.2)
        result = detect_white_cube(blurred, {})
        self.assertTrue(result["found"], result)
