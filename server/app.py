"""Локальный FastAPI сервер распознавания для WebAR, без обучения и нейросетей."""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from detector import decode_frame, detect

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
    return RedirectResponse("/cv/")


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


app.mount("/cv", StaticFiles(directory=ROOT / "cv", html=True), name="cv")
