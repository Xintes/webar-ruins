// WebAR Markerless Stage 1.4: OpenCV SIFT/ORB + RANSAC на сервере.
// Лёгкое локальное отслеживание смещения изображения между ответами сервера.
// НЕ является метрической 3D-локализацией и не компенсирует параллакс.
import { toGray, estimateTranslation, shiftHomography, holdDurationMs, visibilityAt } from './motion.js';

const $ = (id) => document.getElementById(id);
const video = $('camera'), scene = $('scene'), overlay = $('overlay'), debug = $('debug');
const status = $('status'), hint = $('scan-hint');
const zonePicker = $('zone'), startButton = $('start'), stopButton = $('stop');
const upload = $('file'), showOverlay = $('show-overlay'), showDebug = $('show-debug');
const apiInput = $('api');
const urlParams = new URLSearchParams(location.search);
const savedAPI = localStorage.getItem('webar-cv-api') || '';
const defaultAPI = location.hostname.endsWith('.github.io') ? 'https://webar-ruins.onrender.com' : '';
const apiOrigin = (urlParams.get('api') || savedAPI || defaultAPI).replace(/\/+$/, '');
apiInput.value = apiOrigin;

// One request at a time; immediately examine a fresh frame after a missed capture.
const RETRY_DELAY_MS = 100;
const TRACKED_DELAY_MS = 700;
const FLOW_INTERVAL_MS = 160;
const MAX_REQUEST_MS = 16000;
const MOTION_WIDTH = 256;
const JPEG_WIDTH = 840;
const SEARCH_JPEG_WIDTH = 960;
let stream = null, running = false, busy = false, timer = null;
let currentPose = null, targetPose = null, currentImage = null, currentImageUrl = '';
const imageCanvas = document.createElement('canvas');
const imageCtx = imageCanvas.getContext('2d', { willReadFrequently: false });
const motionCanvas = document.createElement('canvas');
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
let lastGray = null, lastFlowAt = 0, motion = { x: 0, y: 0, ok: false };
let viewW = 0, viewH = 0, lastDraw = 0;
let photoMode = false, photoUrl = null;
let lastGoodAt = null, holdMs = 5500, missCount = 0, secondMissAt = null;
let apiReady = false, trackingGeneration = 0, shownState = '';
let requestAbort = null;
let lastRecognizedView = '';
let hintCooldownUntil = 0;

function apiPath(path) { return apiOrigin + path; }
function setStatus(message) { status.textContent = message; }
function setHint(message) { if (hint.textContent !== message) hint.textContent = message; }
function setDimensions(width, height) {
  viewW = width; viewH = height;
  scene.style.aspectRatio = `${width}/${height}`;
  scene.style.setProperty('--view-ratio', String(width / height));
  for (const canvas of [overlay, debug]) { canvas.width = width; canvas.height = height; }
  imageCanvas.width = Math.min(JPEG_WIDTH, width);
  imageCanvas.height = Math.max(1, Math.round(height * imageCanvas.width / width));
  motionCanvas.width = Math.min(MOTION_WIDTH, width);
  motionCanvas.height = Math.max(1, Math.round(height * motionCanvas.width / width));
}
function project(H, x, y, scaleX, scaleY) {
  const denominator = H[6] * x + H[7] * y + H[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) return null;
  return { x: scaleX * (H[0] * x + H[1] * y + H[2]) / denominator,
           y: scaleY * (H[3] * x + H[4] * y + H[5]) / denominator };
}
function drawTriangle(ctx, im, src, dst) {
  if (dst.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return;
  const [s1, s2, s3] = src;
  const [p1, p2, p3] = dst;
  const dx1 = s2.x - s1.x, dy1 = s2.y - s1.y, dx2 = s3.x - s1.x, dy2 = s3.y - s1.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(determinant) < 0.0001) return;
  const x1 = p2.x - p1.x, x2 = p3.x - p1.x, y1 = p2.y - p1.y, y2 = p3.y - p1.y;
  const a = (x1 * dy2 - x2 * dy1) / determinant;
  const c = (x2 * dx1 - x1 * dx2) / determinant;
  const b = (y1 * dy2 - y2 * dy1) / determinant;
  const d = (y2 * dx1 - y1 * dx2) / determinant;
  const e = p1.x - a * s1.x - c * s1.y;
  const f = p1.y - b * s1.x - d * s1.y;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath(); ctx.clip();
  ctx.setTransform(a, b, c, d, e, f);
  const left = Math.floor(Math.min(...src.map(p => p.x)));
  const top = Math.floor(Math.min(...src.map(p => p.y)));
  const right = Math.ceil(Math.max(...src.map(p => p.x)));
  const bottom = Math.ceil(Math.max(...src.map(p => p.y)));
  const sx = Math.max(0, left), sy = Math.max(0, top);
  const sw = Math.min(im.width - sx, right - sx);
  const sh = Math.min(im.height - sy, bottom - sy);
  if (sw > 0 && sh > 0) ctx.drawImage(im, sx, sy, sw, sh, sx, sy, sw, sh);
  ctx.restore();
}
function drawWarp(ctx, img, H, scaleX, scaleY) {
  const bounds = img._alphaBounds || { x: 0, y: 0, w: img.width, h: img.height };
  const tile = 95;
  for (let y = bounds.y; y < bounds.y + bounds.h; y += tile) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x += tile) {
      const x2 = Math.min(x + tile, bounds.x + bounds.w);
      const y2 = Math.min(y + tile, bounds.y + bounds.h);
      const a = { x, y }, b = { x: x2, y }, c = { x: x2, y: y2 }, d = { x, y: y2 };
      const aa = project(H, a.x, a.y, scaleX, scaleY);
      const bb = project(H, b.x, b.y, scaleX, scaleY);
      const cc = project(H, c.x, c.y, scaleX, scaleY);
      const dd = project(H, d.x, d.y, scaleX, scaleY);
      drawTriangle(ctx, img, [a, b, c], [aa, bb, cc]);
      drawTriangle(ctx, img, [a, c, d], [aa, cc, dd]);
    }
  }
}
function findAlphaBounds(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      if (data[(y * img.width + x) * 4 + 3] > 10) {
        minX = Math.min(x, minX); minY = Math.min(y, minY);
        maxX = Math.max(x, maxX); maxY = Math.max(y, maxY);
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: Math.max(0, minX - 3), y: Math.max(0, minY - 3),
           w: Math.min(img.width - minX + 3, maxX - minX + 7),
           h: Math.min(img.height - minY + 3, maxY - minY + 7) };
}
async function loadOverlay(pose) {
  const assetUrl = apiPath(pose.overlay_url);
  if (currentImageUrl === assetUrl && currentImage) return;
  const img = new Image();
  img.crossOrigin = 'anonymous'; img.src = assetUrl;
  await img.decode();
  img._alphaBounds = findAlphaBounds(img);
  if (img.width !== pose.image_width || img.height !== pose.image_height) {
    throw new Error('Эталон и наложение имеют разные размеры');
  }
  currentImage = img; currentImageUrl = assetUrl;
}
function clearCanvases() {
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  debug.getContext('2d').clearRect(0, 0, debug.width, debug.height);
}
function clearTracking() {
  targetPose = null; currentPose = null; currentImage = null; currentImageUrl = '';
  lastGoodAt = null; holdMs = 5500; missCount = 0; secondMissAt = null;
  shownState = ''; clearCanvases();
}
function dropPose() {
  targetPose = null; currentPose = null; lastGoodAt = null; missCount = 0; secondMissAt = null;
  shownState = ''; clearCanvases();
}
function roiForFlow() {
  if (!targetPose || !targetPose.roi_polygon) return null;
  const sX = motionCanvas.width / targetPose.frame_width;
  const sY = motionCanvas.height / targetPose.frame_height;
  const xs = targetPose.roi_polygon.map(p => p[0] * sX);
  const ys = targetPose.roi_polygon.map(p => p[1] * sY);
  const pad = 10;
  return {
    x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2
  };
}
function sampleLocalMotion(now) {
  if (!running || video.readyState < 2 || !viewW || !viewH || now - lastFlowAt < FLOW_INTERVAL_MS) return;
  // При долгой остановке страницы не пытаемся искать совпадение между далёкими кадрами.
  const gap = now - lastFlowAt;
  lastFlowAt = now;
  try {
    motionCtx.drawImage(video, 0, 0, motionCanvas.width, motionCanvas.height);
    const gray = toGray(motionCtx.getImageData(0, 0, motionCanvas.width, motionCanvas.height));
    if (lastGray && gap < 700) {
      const result = estimateTranslation(lastGray, gray, motionCanvas.width, motionCanvas.height, roiForFlow());
      motion.ok = result.ok;
      if (result.ok) {
        // Накопленный сдвиг — в координатах оригинального видео.
        motion.x += result.dx * viewW / motionCanvas.width;
        motion.y += result.dy * viewH / motionCanvas.height;
      }
    }
    lastGray = gray;
  } catch (e) {
    lastGray = null; motion.ok = false;
    console.warn('Локальное отслеживание временно недоступно:', e);
  }
}
function updateBanner(state) {
  if (shownState === state) return;
  shownState = state;
  if (state === 'found') setHint('Башня распознана · стена привязана');
  else if (state === 'hold') setHint('Удерживаем привязку · уточняем положение');
  else if (state === 'lost') setHint('Ракурс потерян — наведите камеру на башню');
}
function render(ts) {
  if (running) sampleLocalMotion(ts);
  if (viewW && viewH && ts - lastDraw > 65) {
    const delta = lastDraw ? ts - lastDraw : 65;
    lastDraw = ts;
    const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, viewW, viewH);
    const dbg = debug.getContext('2d'); dbg.clearRect(0, 0, viewW, viewH);
    if (targetPose && lastGoodAt !== null && currentImage) {
      const alpha = photoMode ? 1 : visibilityAt(ts, lastGoodAt, holdMs, missCount, secondMissAt);
      if (alpha > 0) {
        // Сервер возвращает позу того кадра, который был отправлен несколько секунд назад.
        // Локально компенсируем небольшие перемещения камеры за время ожидания ответа.
        const dx = photoMode ? 0 : (motion.x - targetPose.captureMotionX) * targetPose.frame_width / viewW;
        const dy = photoMode ? 0 : (motion.y - targetPose.captureMotionY) * targetPose.frame_height / viewH;
        const H = shiftHomography(targetPose.homography, dx, dy);
        if (!currentPose || currentPose.length !== 9) currentPose = H.slice();
        const blend = photoMode ? 1 : (1 - Math.exp(-delta / 230));
        for (let j = 0; j < 9; j++) currentPose[j] += blend * (H[j] - currentPose[j]);
        const sx = viewW / targetPose.frame_width, sy = viewH / targetPose.frame_height;
        ctx.globalAlpha = alpha;
        if (showOverlay.checked) drawWarp(ctx, currentImage, currentPose, sx, sy);
        ctx.globalAlpha = 1;
        if (showDebug.checked) {
          dbg.globalAlpha = alpha;
          dbg.beginPath();
          targetPose.roi_polygon.forEach(([px, py], i) => {
            const x = px * sx + dx * sx, y = py * sy + dy * sy;
            if (i === 0) dbg.moveTo(x, y); else dbg.lineTo(x, y);
          });
          dbg.closePath(); dbg.strokeStyle = '#32ffad'; dbg.lineWidth = 3; dbg.stroke();
          dbg.globalAlpha = 1;
        }
        if (!photoMode && (ts - lastGoodAt > Math.min(1500, holdMs * 0.4) || missCount > 0)) updateBanner('hold');
        else updateBanner('found');
      } else {
        dropPose();
        updateBanner('lost');
      }
    }
  }
  requestAnimationFrame(render);
}
function scheduleFrame(delayMs) {
  clearTimeout(timer);
  if (running) timer = setTimeout(sendCameraFrame, delayMs);
}

// При устойчивом захвате проверяем известную область башни вместо всего кадра.
// Координаты нормализованы, чтобы оставаться верными после изменения JPEG-размера.
// При сильном движении/потере локального слежения подсказку не отправляем.
function getTrackingHint(snapshot) {
  if (!running || !targetPose || !motion.ok || lastGoodAt === null ||
      performance.now() - lastGoodAt > 3500 || performance.now() < hintCooldownUntil) return null;
  const pose = targetPose;
  if (!Array.isArray(pose.roi_polygon) || pose.roi_polygon.length !== 4 ||
      !pose.frame_width || !pose.frame_height || !viewW || !viewH) return null;
  const dx = (snapshot.x - pose.captureMotionX) * pose.frame_width / viewW;
  const dy = (snapshot.y - pose.captureMotionY) * pose.frame_height / viewH;
  const xs = pose.roi_polygon.map(p => p[0] + dx);
  const ys = pose.roi_polygon.map(p => p[1] + dy);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padX = Math.max(60, (maxX - minX) * .35);
  const padY = Math.max(60, (maxY - minY) * .35);
  const x0 = Math.max(0, minX - padX) / pose.frame_width;
  const y0 = Math.max(0, minY - padY) / pose.frame_height;
  const x1 = Math.min(pose.frame_width, maxX + padX) / pose.frame_width;
  const y1 = Math.min(pose.frame_height, maxY + padY) / pose.frame_height;
  if (x1 - x0 < .12 || y1 - y0 < .12 || (x1 - x0) * (y1 - y0) < .07) return null;
  return [x0, y0, x1 - x0, y1 - y0].map(n => Math.round(n * 10000) / 10000);
}

function serverTiming(result, elapsed) {
  if (!Number.isFinite(result.processing_ms)) return `запрос ${Math.round(elapsed)} мс`;
  const networkMs = Math.max(0, Math.round(elapsed - result.processing_ms));
  const mode = result.search_mode === 'hint' ? 'быстрый поиск' : 'полный поиск';
  return `${mode} · OpenCV ${Math.round(result.processing_ms)} мс · сеть/ожидание ${networkMs} мс`;
}

async function analyze(blob, generation = trackingGeneration, snapshot = { x: motion.x, y: motion.y }) {
  const fd = new FormData();
  fd.append('frame', blob, 'frame.jpg'); fd.append('zone', zonePicker.value);
  if (lastRecognizedView) fd.append('preferred_view', lastRecognizedView);
  const hint = photoMode ? null : getTrackingHint(snapshot);
  if (hint) fd.append('hint_roi', JSON.stringify(hint));
  const started = performance.now();
  const controller = new AbortController();
  requestAbort = controller;
  const timeout = setTimeout(() => controller.abort(), MAX_REQUEST_MS);
  let result;
  try {
    const response = await fetch(apiPath('/api/track/frame'), {
      method: 'POST', body: fd, cache: 'no-store', signal: controller.signal
    });
    if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 140)}`);
    result = await response.json();
  } finally {
    clearTimeout(timeout);
    if (requestAbort === controller) requestAbort = null;
  }
  if (generation !== trackingGeneration) return;
  const elapsed = performance.now() - started;
  if (!result.found) {
    // После промаха в предполагаемой области обязательно ищем по всему кадру.
    if (result.search_mode === 'hint') hintCooldownUntil = performance.now() + 8000;
    if (targetPose) {
      missCount++;
      if (missCount >= 2 && secondMissAt === null) secondMissAt = performance.now();
      setHint('Ориентир временно не найден · ожидаем подтверждение');
    } else {
      setHint('Не найдено — приблизьтесь к опорному ракурсу');
    }
    setStatus(`OpenCV: ${result.reason || 'Нет совпадений'} · ${serverTiming(result, elapsed)} · совпадений ${result.matched ?? 0}, подтверждено ${result.inliers ?? 0}`);
    return;
  }
  await loadOverlay(result);
  if (generation !== trackingGeneration) return;
  if (targetPose?.view !== result.view) currentPose = null;
  lastRecognizedView = result.view;
  hintCooldownUntil = 0;
  targetPose = { ...result, captureMotionX: snapshot.x, captureMotionY: snapshot.y };
  lastGoodAt = performance.now();
  holdMs = photoMode ? Number.POSITIVE_INFINITY : holdDurationMs(elapsed);
  missCount = 0; secondMissAt = null; shownState = '';
  setHint('Башня распознана · стена привязана');
  setStatus(`Ракурс: ${result.view_label} · ${result.algorithm} · ${serverTiming(result, elapsed)} · подтверждённых точек ${result.inliers} · ошибка ${result.median_error_px} px`);
}
async function sendCameraFrame() {
  if (!running) return;
  if (busy || video.readyState < 2) { scheduleFrame(120); return; }
  busy = true;
  const generation = trackingGeneration;
  const snapshot = { x: motion.x, y: motion.y };
  try {
    // When searching, transmit more details. After capture, save bandwidth.
    const width = Math.min(lastGoodAt === null ? SEARCH_JPEG_WIDTH : JPEG_WIDTH, viewW);
    if (imageCanvas.width !== width) {
      imageCanvas.width = width;
      imageCanvas.height = Math.max(1, Math.round(viewH * width / viewW));
    }
    imageCtx.drawImage(video, 0, 0, imageCanvas.width, imageCanvas.height);
    const blob = await new Promise(resolve => imageCanvas.toBlob(resolve, 'image/jpeg', 0.69));
    if (blob && running && generation === trackingGeneration) await analyze(blob, generation, snapshot);
  } catch (e) {
    if (generation === trackingGeneration) {
      setStatus(`Ошибка запроса OpenCV: ${e.name === 'AbortError' ? 'превышено время ожидания' : e.message}`);
    }
  } finally {
    busy = false;
    if (running) scheduleFrame(lastGoodAt === null || performance.now() - lastGoodAt > 3500 ? RETRY_DELAY_MS : TRACKED_DELAY_MS);
  }
}
async function startCamera() {
  if (running) return;
  if (!apiReady) { setStatus('Сначала подключи OpenCV API.'); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('Для камеры необходим HTTPS либо localhost.'); return;
  }
  startButton.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = stream;
    await video.play();
    setDimensions(video.videoWidth, video.videoHeight);
    trackingGeneration++; photoMode = false; running = true; video.hidden = false;
    stopButton.disabled = false; startButton.disabled = true;
    clearTracking();
    motion = { x: 0, y: 0, ok: false }; lastGray = null; lastFlowAt = 0;
    setHint('Направьте камеру на башню');
    lastRecognizedView = '';
    hintCooldownUntil = 0;
    sendCameraFrame();
  } catch (e) {
    setStatus(`Камера не запустилась: ${e.message}`);
    stream?.getTracks().forEach(t => t.stop()); stream = null; startButton.disabled = false;
  }
}
function stopCamera() {
  trackingGeneration++;
  requestAbort?.abort(); requestAbort = null;
  running = false;
  clearTimeout(timer); timer = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  video.pause(); video.srcObject = null; video.hidden = true;
  startButton.disabled = false; stopButton.disabled = true;
  lastGray = null; motion = { x: 0, y: 0, ok: false };
  lastRecognizedView = ''; hintCooldownUntil = 0;
  clearTracking(); setHint('Камера выключена');
}
async function analyzeImageFile(file) {
  stopCamera();
  const bmp = await createImageBitmap(file);
  setDimensions(bmp.width, bmp.height);
  photoMode = true;
  const generation = trackingGeneration;
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
  const data = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(data);
  scene.style.backgroundImage = `url("${photoUrl}")`;
  scene.style.backgroundSize = '100% 100%';
  if (!apiReady) { setStatus('Нет подключения к OpenCV API.'); return; }
  try { await analyze(data, generation, { x: 0, y: 0 }); }
  catch (e) { setStatus(`Ошибка проверки фото: ${e.message}`); }
}
async function loadZones() {
  const response = await fetch(apiPath('/api/track/zones'));
  if (!response.ok) throw new Error('Нет доступа к API; проверь запуск FastAPI');
  const data = await response.json();
  zonePicker.replaceChildren();
  for (const z of data.zones) {
    const opt = document.createElement('option');
    opt.value = z.id; opt.textContent = `${z.label} (${z.views} ракурсов)`;
    zonePicker.appendChild(opt);
  }
  apiReady = data.zones.length > 0;
  startButton.disabled = !apiReady;
  setStatus(apiReady ? 'OpenCV API подключён. Включи камеру или загрузи фотографию.' : 'На сервере нет обзорных зон.');
}
$('start').addEventListener('click', () => { scene.style.backgroundImage = 'none'; startCamera(); });
$('stop').addEventListener('click', stopCamera);
upload.addEventListener('change', async () => {
  const file = upload.files[0];
  if (file) {
    try { await analyzeImageFile(file); } catch (e) { setStatus(e.message); }
    upload.value = '';
  }
});
zonePicker.addEventListener('change', () => {
  // Сбросить старый запрос, чтобы ответ предыдущей зоны не перезаписал новую.
  trackingGeneration++;
  requestAbort?.abort();
  clearTracking();
  lastRecognizedView = ''; hintCooldownUntil = 0;
  lastGray = null;
  if (running) scheduleFrame(150);
});
$('save-api').addEventListener('click', () => {
  const val = apiInput.value.trim().replace(/\/+$/, '');
  if (val && !val.startsWith('https://') && !val.startsWith('http://localhost')) {
    setStatus('Для телефона нужен HTTPS API'); return;
  }
  localStorage.setItem('webar-cv-api', val);
  location.reload();
});
window.addEventListener('pagehide', () => {
  stopCamera();
  if (photoUrl) URL.revokeObjectURL(photoUrl);
});
startButton.disabled = true;
loadZones().catch(e => {
  apiReady = false; startButton.disabled = true;
  setStatus(`Нет соединения с OpenCV API: ${e.message}. Проверь адрес API внизу страницы.`);
});
requestAnimationFrame(render);
