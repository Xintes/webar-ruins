import * as THREE from "three";
import { CV_CONFIG } from "./config.js";
import { createObjectArrays } from "./objects.js";

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const video = $("video");
const photo = $("photo");
const capture = $("capture");
const outline = $("outline");
const status = $("status");
const result = $("result");
const network = $("network");
const startButton = $("start");
const stopButton = $("stop");
const zoneSelect = $("zone");
const photoInput = $("photo-input");

let mediaStream = null;
let active = false;
let pendingController = null;
let loopTimer = null;
let lastDetection = null;
let sourceSize = [640, 480];
let photoURL = null;
let sceneGroup = null;
let smooth = null;

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
$("three-layer").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera();
camera.position.set(0, 0, 1000);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x788291, 2.2));
const directional = new THREE.DirectionalLight(0xffffff, 1.6);
directional.position.set(5, 8, 10);
scene.add(directional);

function setStatus(text) { status.textContent = text; }
function apiBase() { return CV_CONFIG.API_BASE.replace(/\/$/, ""); }
function isPagesWithoutBackend() { return location.hostname.endsWith("github.io") && !apiBase(); }
function measure() { return [stage.clientWidth, stage.clientHeight]; }
function viewportCoords(nx, ny) {
  const [w, h] = measure();
  const [sw, sh] = sourceSize;
  const factor = Math.min(w / sw, h / sh); // video / img: object-fit contain
  return [(w - sw * factor) / 2 + nx * sw * factor, (h - sh * factor) / 2 + ny * sh * factor];
}
function resize() {
  const [w, h] = measure();
  if (!w || !h) return;
  outline.width = Math.max(1, Math.floor(w * Math.min(devicePixelRatio || 1, 1.5)));
  outline.height = Math.max(1, Math.floor(h * Math.min(devicePixelRatio || 1, 1.5)));
  renderer.setSize(w, h, false);
  camera.left = -w / 2;
  camera.right = w / 2;
  camera.top = h / 2;
  camera.bottom = -h / 2;
  camera.near = 0.1;
  camera.far = 2000;
  camera.updateProjectionMatrix();
  paint();
}
function paint() {
  const [w, h] = measure();
  if (!w || !h) return;
  const ctx = outline.getContext("2d");
  const ratio = outline.width / w;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (lastDetection?.found) {
    const poly = lastDetection.polygon;
    if (poly?.length >= 3) {
      ctx.beginPath();
      const [x0, y0] = viewportCoords(poly[0][0], poly[0][1]);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < poly.length; i++) {
        const [x, y] = viewportCoords(poly[i][0], poly[i][1]);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#64f1c3";
      ctx.stroke();
    }
  }

  if (sceneGroup) {
    if (!lastDetection?.found) {
      sceneGroup.visible = false;
    } else {
      const [px, py] = viewportCoords(...lastDetection.center);
      const [x1] = viewportCoords(lastDetection.bounds[0], 0);
      const [x2] = viewportCoords(lastDetection.bounds[0] + lastDetection.bounds[2], 0);
      // Экранное масштабирование — НЕ вычисление истинного 3D положения.
      const sizePx = Math.max(12, Math.abs(x2 - x1));
      if (!smooth) smooth = { x: px, y: py, size: sizePx };
      const factor = 0.35;
      smooth.x += (px - smooth.x) * factor;
      smooth.y += (py - smooth.y) * factor;
      smooth.size += (sizePx - smooth.size) * factor;
      sceneGroup.position.set(smooth.x - w / 2, h / 2 - smooth.y, 0);
      sceneGroup.scale.setScalar(smooth.size);
      sceneGroup.visible = true;
    }
  }
  renderer.render(scene, camera);
}
async function prepareScene() {
  if (sceneGroup) return;
  sceneGroup = await createObjectArrays(CV_CONFIG.arrays);
  scene.add(sceneGroup);
  sceneGroup.visible = false;
  paint();
}
function stopCamera() {
  active = false;
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  if (pendingController) pendingController.abort();
  pendingController = null;
  mediaStream?.getTracks().forEach(track => track.stop());
  mediaStream = null;
  video.srcObject = null;
  startButton.hidden = false;
  stopButton.hidden = true;
}
function showPhoto(file) {
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = URL.createObjectURL(file);
  photo.src = photoURL;
  photo.hidden = false;
  video.hidden = true;
  sourceSize = [photo.naturalWidth || 640, photo.naturalHeight || 480];
}
async function blobFromVideo() {
  const w = Math.min(CV_CONFIG.frameWidth, video.videoWidth);
  const h = Math.max(120, Math.round(w * video.videoHeight / video.videoWidth));
  capture.width = w;
  capture.height = h;
  const ctx = capture.getContext("2d", { willReadFrequently: false });
  ctx.drawImage(video, 0, 0, w, h);
  return new Promise(resolve => capture.toBlob(resolve, "image/jpeg", CV_CONFIG.jpegQuality));
}
async function inspect(blob) {
  if (!blob) throw new Error("Не удалось подготовить кадр");
  if (isPagesWithoutBackend()) throw new Error("На GitHub Pages укажи HTTPS API_BASE в cv/config.js. GitHub Pages не исполняет Python.");
  const form = new FormData();
  form.append("zone", zoneSelect.value);
  form.append("frame", blob, "frame.jpg");
  const controller = new AbortController();
  pendingController = controller;
  const timeout = setTimeout(() => controller.abort(), CV_CONFIG.requestTimeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(`${apiBase()}/api/detect`, { method: "POST", body: form, signal: controller.signal });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { const data = await response.json(); message = data.detail || message; } catch { /* ignore */ }
      throw new Error(message);
    }
    const data = await response.json();
    network.textContent = `API ${Math.round(performance.now() - start)} мс`;
    return data;
  } finally {
    clearTimeout(timeout);
    if (pendingController === controller) pendingController = null;
  }
}
function applyDetection(data) {
  lastDetection = data;
  smooth ??= null;
  if (data.found) {
    result.textContent = `Найдено · балл ${Math.round(data.score * 100)} / 100`;
    setStatus(`${data.method === "white_cube" ? "Белый контрастный контур" : "Совпадение с фотографией зоны"} · это ещё не точная 3D-поза`);
  } else {
    smooth = null;
    result.textContent = "Ориентир не найден";
    setStatus(data.reason || "Ориентир не найден");
  }
  paint();
}
async function cameraLoop() {
  if (!active) return;
  const started = performance.now();
  try {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth) {
      sourceSize = [video.videoWidth, video.videoHeight];
      const blob = await blobFromVideo();
      if (!active) return;
      const data = await inspect(blob);
      if (active) applyDetection(data);
    }
  } catch (error) {
    if (active) {
      network.textContent = "API недоступен";
      setStatus(`Ошибка связи: ${error.message}`);
      lastDetection = null;
      paint();
    }
  } finally {
    if (active) loopTimer = setTimeout(cameraLoop, Math.max(100, CV_CONFIG.intervalMs - (performance.now() - started)));
  }
}
async function startCamera() {
  startButton.disabled = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Для камеры нужен HTTPS или localhost и современный браузер");
    }
    await prepareScene();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    if (photoURL) { URL.revokeObjectURL(photoURL); photoURL = null; }
    photo.hidden = true;
    video.hidden = false;
    video.srcObject = mediaStream;
    await video.play();
    active = true;
    smooth = null;
    lastDetection = null;
    startButton.hidden = true;
    stopButton.hidden = false;
    setStatus("Камера работает, выполняется поиск...");
    cameraLoop();
  } catch (error) {
    stopCamera();
    setStatus(`Не удалось запустить: ${error.message}`);
  } finally { startButton.disabled = false; }
}
startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", () => {
  stopCamera();
  lastDetection = null;
  smooth = null;
  paint();
  setStatus("Камера выключена");
});
zoneSelect.value = CV_CONFIG.zone;
zoneSelect.addEventListener("change", () => { lastDetection = null; smooth = null; paint(); });
photoInput.addEventListener("change", async () => {
  const file = photoInput.files?.[0];
  if (!file) return;
  stopCamera();
  try {
    await prepareScene();
    showPhoto(file);
    await new Promise((resolve, reject) => { photo.onload = resolve; photo.onerror = reject; });
    sourceSize = [photo.naturalWidth, photo.naturalHeight];
    const data = await inspect(file);
    applyDetection(data);
  } catch (error) { setStatus(`Не получилось проверить фото: ${error.message}`); }
  finally { photoInput.value = ""; }
});
window.addEventListener("resize", resize);
resize();
if (isPagesWithoutBackend()) network.textContent = "Нужен HTTPS API_BASE";
