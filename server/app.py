"""Локальный FastAPI сервер распознавания для WebAR, без обучения и нейросетей."""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from detector import decode_frame, detect
from tracker import decode_image, get_zones, track, register_view, REF_ROOT, _safe_filename

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REFERENCES = HERE / "references"
ZONES = json.loads((HERE / "zones.json").read_text(encoding="utf-8"))

app = FastAPI(title="WebAR CV API", version="0.1.0", docs_url=None, redoc_url=None)
allowed_origins = os.getenv("CV_ALLOWED_ORIGINS", "https://xintes.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[x.strip() for x in allowed_origins if x.strip()],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/")
def home():
    return RedirectResponse("/track/")


@app.get("/api/health")
def health():
    return {"ok": True, "engine": "opencv", "neural_network": False, "zones": list(ZONES)}


@app.get("/api/zones")
def zones():
    return {"zones": [{"id": name, "label": cfg["label"], "method": cfg["method"]} for name, cfg in ZONES.items()]}


@app.post("/api/detect")
def detect_frame(zone: str = Form("desk_cube"), frame: UploadFile = File(...)):
    config = ZONES.get(zone)
    if config is None:
        raise HTTPException(status_code=404, detail="Неизвестная зона обзора")
    # Никакие кадры на диск не записываются.
    data = frame.file.read(1_500_001)
    if len(data) > 1_500_000:
        raise HTTPException(status_code=413, detail="Кадр слишком большой (лимит 1,5 МБ)")
    if not data:
        raise HTTPException(status_code=400, detail="Пустое изображение")
    try:
        image = decode_frame(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return {"zone": zone, **detect(image, config, REFERENCES)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


app.mount("/wall-lab", StaticFiles(directory=ROOT / "wall-lab", html=True), name="wall-lab")
app.mount("/cv", StaticFiles(directory=ROOT / "cv", html=True), name="cv")


# Markerless AR: SIFT/ORB + RANSAC, без искусственных маркеров.
@app.get("/api/track/zones")
def track_zones():
    zones = get_zones()
    return {"zones": [
        {"id": name, "label": cfg.get("label", name),
         "views": len(cfg.get("views", []))}
        for name, cfg in zones.items()
    ]}


@app.post("/api/track/frame")
def track_frame(zone: str = Form("tower"), frame: UploadFile = File(...)):
    if zone not in get_zones():
        raise HTTPException(status_code=404, detail="Неизвестная зона обзора")
    raw = frame.file.read(3_000_001)
    try:
        return {"zone": zone, **track(decode_image(raw), zone)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/track/assets/{zone}/{filename}")
def track_asset(zone: str, filename: str):
    manifest = get_zones()
    if not _safe_filename(filename) or zone not in manifest:
        raise HTTPException(status_code=404)
    if not any(filename == view.get("overlay") or filename == view.get("image")
               for view in manifest[zone].get("views", [])):
        raise HTTPException(status_code=404)
    filepath = REF_ROOT / zone / filename
    if not filepath.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(filepath)


@app.post("/api/track/train")
def add_training_view(request: Request, zone: str = Form("tower"), roi: str = Form(""),
                      reference: UploadFile = File(...), overlay: UploadFile = File(...),
                      x_admin_key: str | None = Header(default=None)):
    # По умолчанию запись новых образцов разрешена только с ЭТОГО ПК.
    # При развёртывании за публичным HTTPS reverse proxy следует вообще отключить
    # маршрут снаружи или защитить CV_ADMIN_KEY. Не доверяем X-Forwarded-For.
    key = os.getenv("CV_ADMIN_KEY")
    if key:
        import secrets
        if not x_admin_key or not secrets.compare_digest(x_admin_key, key):
            raise HTTPException(status_code=403, detail="Нужен ключ администратора")
    elif not request.client or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="Обучение доступно только с локального компьютера")
    ref_data = reference.file.read(3_000_001)
    overlay_data = overlay.file.read(7_000_001)
    try:
        roi_values = None
        if roi.strip():
            try:
                roi_values = [float(v) for v in json.loads(roi)]
            except (ValueError, TypeError) as exc:
                raise ValueError("Некорректные координаты области башни") from exc
        view_id = register_view(zone, ref_data, overlay_data, roi=roi_values)
        return {"ok": True, "id": view_id, "zone": zone}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


app.mount("/track", StaticFiles(directory=ROOT / "track", html=True), name="track")
