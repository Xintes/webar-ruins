import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

// Экспериментальный редактор. Координаты снимка служат только для подгонки.
// Для реальной AR-реконструкции нужно отдельно калибровать камеру и масштаб.
const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 934;
const CAMERA_DISTANCE = 18;
const CAMERA_FOV = 50;
const STORAGE_KEY = "webar-wall-lab-v1";

const DEFAULTS = Object.freeze({
  joinX: 565,       // низ левого края башни, пиксели исходного снимка
  joinOverlap: 25, // удлинить стену в сторону башни (px на исходном снимке)
  baseY: 750,       // нижний стык стены и башни в пикселях
  length: 9.1,      // условные 3D единицы, НЕ метры
  height: 5.85,
  thickness: 0.80,
  yaw: -5,          // направление стены относительно плоскости кадра
  depth: 0,
  brightness: 1.0,
  roof: true,
  slots: true,
  occlusion: true,
  showAnchor: true
});

const FIELD_SPEC = [
  ["joinX", "Стык X на снимке (px)", 100, 1050, 1],
  ["joinOverlap", "Нахлёст стены на башню (px)", 0, 70, 1],
  ["baseY", "Стык у основания Y (px)", 300, 920, 1],
  ["length", "Длина стены", 0.5, 16, 0.1],
  ["height", "Высота стены", 0.5, 9, 0.05],
  ["thickness", "Толщина стены", 0.15, 2.5, 0.05],
  ["yaw", "Угол ухода стены (°)", -55, 55, 1],
  ["depth", "Глубина относительно фото", -5, 5, 0.1],
  ["brightness", "Яркость материала", 0.55, 1.65, 0.05]
];

const $ = (selector) => document.querySelector(selector);
const stage = $("#stage");
const controls = $("#controls");
const anchor = $("#anchor");
const maskCanvas = $("#tower-mask");
const image = $("#reference");
const liveVideo = $("#live-camera");
const startCameraButton = $("#start-camera");
const stopCameraButton = $("#stop-camera");
const viewModeLabel = $("#view-mode-label");
let cameraStream = null;
let cameraMode = false;
let customReference = false;
const status = $("#status");
const threeContainer = $("#three");

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    return sanitizedSettings(parsed);
  } catch {
    return { ...DEFAULTS };
  }
}
function sanitizedSettings(data) {
  const out = { ...DEFAULTS };
  for (const [key, , min, max] of FIELD_SPEC) {
    const number = Number(data[key]);
    if (data[key] !== undefined && data[key] !== null && data[key] !== "" && Number.isFinite(number)) {
      out[key] = THREE.MathUtils.clamp(number, min, max);
    }
  }
  for (const key of ["roof", "slots", "occlusion", "showAnchor"]) {
    if (typeof data[key] === "boolean") out[key] = data[key];
  }
  return out;
}
let settings = loadSettings();

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
threeContainer.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, IMAGE_WIDTH / IMAGE_HEIGHT, 0.01, 150);
camera.position.set(0, 0, CAMERA_DISTANCE);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x524537, 2.25));
const sunlight = new THREE.DirectionalLight(0xffffff, 2.0);
sunlight.position.set(-5, 7, 10);
scene.add(sunlight);

const brickTexture = buildBrickTexture();
const timber = new THREE.MeshStandardMaterial({ color: 0x3a3530, roughness: 0.97 });
const opening = new THREE.MeshStandardMaterial({ color: 0x211913, roughness: 1.0 });
const capStone = new THREE.MeshStandardMaterial({ color: 0x817367, roughness: 0.96 });
const wallMount = new THREE.Group();
scene.add(wallMount);
let wallModel = new THREE.Group();
wallMount.add(wallModel);

function buildBrickTexture() {
  const surface = document.createElement("canvas");
  surface.width = 512;
  surface.height = 256;
  const ctx = surface.getContext("2d");
  ctx.fillStyle = "#997764";
  ctx.fillRect(0, 0, 512, 256);
  let seed = 187;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const brickHeight = 18;
  const brickWidth = 43;
  for (let row = -1; row <= Math.ceil(256 / brickHeight); row += 1) {
    const offset = row % 2 ? 0 : -(brickWidth / 2);
    for (let x = offset - brickWidth; x < 512 + brickWidth; x += brickWidth) {
      const y = row * brickHeight;
      const shade = Math.floor(random() * 29);
      ctx.fillStyle = `rgb(${137 + shade},${62 + shade / 2},${43 + shade / 2})`;
      ctx.fillRect(x + 1, y + 1, brickWidth - 2, brickHeight - 2);
      ctx.fillStyle = `rgba(42,32,26,${(0.06 + random() * 0.08).toFixed(3)})`;
      for (let i = 0; i < 9; i += 1) {
        ctx.fillRect(x + 2 + random() * (brickWidth - 6), y + 2 + random() * (brickHeight - 5), 2, 1);
      }
    }
  }
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function addMesh(parent, geometry, material, x, y, z) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function disposeGroup(group) {
  const releaseMaterial = (material) => {
    if (material.map && material.map !== brickTexture) material.map.dispose();
    material.dispose();
  };
  group.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    if (Array.isArray(object.material)) object.material.forEach(releaseMaterial);
    else releaseMaterial(object.material);
  });
}

function buildWall() {
  wallMount.remove(wallModel);
  disposeGroup(wallModel);
  wallModel = new THREE.Group();
  wallMount.add(wallModel);

  const { length: L, height: H, thickness: T } = settings;
  // 3D-геометрия продлевается только в сторону примыкания (+X).
  // Левый внешний торец остаётся на месте при изменении нахлёста.
  const referenceWorldWidth = 2 * CAMERA_DISTANCE *
    Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2) *
    (IMAGE_WIDTH / IMAGE_HEIGHT);
  const overlapWorld = (settings.joinOverlap / IMAGE_WIDTH) * referenceWorldWidth;
  const extendedLength = L + overlapWorld;
  const texture = brickTexture.clone();
  texture.repeat.set(Math.max(1, L / 2.2), Math.max(1, H / 2.4));
  texture.needsUpdate = true;
  const brick = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.99 });
  brick.color.setRGB(settings.brightness, settings.brightness, settings.brightness);
  const body = addMesh(wallModel, new THREE.BoxGeometry(extendedLength, H, T), brick, -L / 2 + overlapWorld / 2, H / 2, 0);
  body.name = "Кирпичная стена";
  addMesh(wallModel, new THREE.BoxGeometry(extendedLength + 0.06, 0.16, T + 0.10), capStone, -L / 2 + overlapWorld / 2, 0.08, 0).name = "Цоколь";
  if (settings.roof) {
    addMesh(wallModel, new THREE.BoxGeometry(extendedLength + 0.20, 0.22, T + 0.34), timber,
      -L / 2 + overlapWorld / 2, H + 0.14, 0).name = "Деревянная кровля";
  }
  if (settings.slots) {
    const n = Math.max(1, Math.min(32, Math.floor(L / 0.66)));
    for (let i = 0; i < n; i += 1) {
      const x = -L * (i + 0.5) / n;
      addMesh(wallModel, new THREE.BoxGeometry(0.085, 0.42, 0.025), opening,
        x, H - 0.82, T / 2 + 0.015).name = `Бойница ${i + 1}`;
      if (settings.roof) {
        addMesh(wallModel, new THREE.BoxGeometry(0.073, 0.36, 0.058), timber,
          x, H - 0.08, T / 2 + 0.045).name = `Деревянная балка ${i + 1}`;
      }
    }
  }
  updateWallPlacement();
}

function updateWallPlacement() {
  const d = CAMERA_DISTANCE - settings.depth;
  // Проекция через известные параметры виртуальной камеры.
  const worldHeight = 2 * d * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2);
  const bounds = stage.getBoundingClientRect();
  const aspect = bounds.height > 0 ? bounds.width / bounds.height : IMAGE_WIDTH / IMAGE_HEIGHT;
  wallMount.position.set(
    (settings.joinX / IMAGE_WIDTH - 0.5) * worldHeight * aspect,
    (0.5 - settings.baseY / IMAGE_HEIGHT) * worldHeight,
    settings.depth
  );
  wallModel.rotation.y = THREE.MathUtils.degToRad(settings.yaw);
  anchor.style.left = `${100 * settings.joinX / IMAGE_WIDTH}%`;
  anchor.style.top = `${100 * settings.baseY / IMAGE_HEIGHT}%`;
  anchor.hidden = !settings.showAnchor;
}

// Левый реальный край башни на ЭТОЙ эталонной фотографии.
// Маска накрывает соединение и не позволяет виртуальному кирпичу
// попадать поверх существующей башни. Для нового ракурса нужна своя маска.
const TOWER_OCCLUSION_POLYGON = [
  [575, 392], [842, 392], [842, 610], [847, 743], [866, 847],
  [576, 847], [573, 765], [574, 740], [574, 555]
];

function drawTowerOcclusion() {
  const ctx = maskCanvas.getContext("2d");
  ctx.clearRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  if (cameraMode || !settings.occlusion || !image.complete || image.naturalWidth === 0) return;
  // Ручная маска по фотографии, чтобы 3D-стена не рисовалась поверх башни.
  // Это маска ТОЛЬКО для текущего контрольного снимка.
  const polygon = TOWER_OCCLUSION_POLYGON;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(...polygon[0]);
  for (const p of polygon.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(image, 0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  ctx.restore();
}

function render() {
  const bounds = stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(bounds.width));
  const h = Math.max(1, Math.round(bounds.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}

function refresh(rebuild = false) {
  if (rebuild) buildWall();
  else updateWallPlacement();
  drawTowerOcclusion();
  render();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  syncInputs();
}
function syncInputs() {
  document.querySelectorAll("[data-field]").forEach((input) => {
    const value = settings[input.dataset.field];
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (document.activeElement !== input) input.value = String(value);
  });
}

function buildControls() {
  for (const [key, caption, min, max, step] of FIELD_SPEC) {
    const box = document.createElement("div");
    box.className = "control";
    const id = `field-${key}`;
    box.innerHTML = `<div class="control-top"><label for="${id}">${caption}</label></div>`;
    const valueBox = document.createElement("input");
    valueBox.type = "number";
    valueBox.min = String(min);
    valueBox.max = String(max);
    valueBox.step = String(step);
    valueBox.dataset.field = key;
    valueBox.id = id;
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.dataset.field = key;
    box.querySelector(".control-top").append(valueBox);
    box.append(range);
    controls.append(box);
    for (const input of [range, valueBox]) {
      input.addEventListener("input", () => {
        const number = Number(input.value);
        if (!Number.isFinite(number) || input.value.trim() === "") return;
        settings[key] = THREE.MathUtils.clamp(number, min, max);
        refresh(["length", "height", "thickness", "brightness"].includes(key));
      });
    }
  }
  for (const toggle of document.querySelectorAll('input[type="checkbox"][data-field]')) {
    toggle.addEventListener("change", () => {
      settings[toggle.dataset.field] = toggle.checked;
      refresh(["roof", "slots"].includes(toggle.dataset.field));
    });
  }
  syncInputs();
}

// Перетаскиваем точку соединения непосредственно на фотографии.
let dragging = false;
anchor.addEventListener("pointerdown", (event) => {
  dragging = true;
  anchor.setPointerCapture(event.pointerId);
  event.preventDefault();
});
anchor.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const rect = stage.getBoundingClientRect();
  settings.joinX = THREE.MathUtils.clamp(Math.round((event.clientX - rect.left) * IMAGE_WIDTH / rect.width), 100, 1050);
  settings.baseY = THREE.MathUtils.clamp(Math.round((event.clientY - rect.top) * IMAGE_HEIGHT / rect.height), 300, 920);
  refresh(false);
});
anchor.addEventListener("pointerup", () => { dragging = false; });
anchor.addEventListener("pointercancel", () => { dragging = false; });

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function exportSettings() {
  return {
    format: "webar-wall-photo-lab-v1",
    reference: "reference.png",
    camera: { fovDegrees: CAMERA_FOV, distance: CAMERA_DISTANCE },
    photoSize: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT },
    settings: { ...settings }
  };
}

$("#reset").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  refresh(true);
  status.textContent = "Настройки сброшены";
});
$("#save-json").addEventListener("click", () => {
  download(new Blob([JSON.stringify(exportSettings(), null, 2)], { type: "application/json" }), "wall-settings.json");
  status.textContent = "Настройки сохранены";
});
$("#copy-json").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(exportSettings(), null, 2));
    status.textContent = "Настройки скопированы";
  } catch {
    status.textContent = "Буфер обмена недоступен. Используйте «Скачать настройки JSON».";
  }
});
$("#load-json").addEventListener("change", async (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    settings = sanitizedSettings(data.settings ?? data);
    refresh(true);
    status.textContent = "Настройки загружены";
  } catch(error) {
    status.textContent = `Ошибка JSON: ${error.message}`;
  }
  event.currentTarget.value = "";
});

$("#save-image").addEventListener("click", () => {
  try {
    render();
    const out = document.createElement("canvas");
    out.width = IMAGE_WIDTH; out.height = IMAGE_HEIGHT;
    const ctx = out.getContext("2d");
    const background = cameraMode ? liveVideo : image;
    if (cameraMode && !liveVideo.videoWidth) throw new Error("Кадр камеры ещё не получен");
    ctx.drawImage(background, 0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
    ctx.drawImage(renderer.domElement, 0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
    if (!cameraMode && settings.occlusion) ctx.drawImage(maskCanvas, 0, 0);
    out.toBlob((blob) => {
      if (blob) download(blob, "wall-preview.png");
    }, "image/png");
    status.textContent = "Макет PNG сохранён";
  } catch (error) {
    status.textContent = `Не удалось сохранить PNG: ${error.message}`;
  }
});
$("#export-glb").addEventListener("click", async () => {
  status.textContent = "Экспорт 3D-стены...";
  const copy = wallModel.clone(true);
  // Физическая модель имеет начало в стыке; screen offset в GLB не включаем.
  const group = new THREE.Group();
  group.add(copy);
  try {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(group, { binary: true, onlyVisible: true });
    download(new Blob([result], { type: "model/gltf-binary" }), "wall-draft.glb");
    status.textContent = "Стена экспортирована. Сохрани также JSON для дальнейшей AR-калибровки.";
  } catch(error) {
    status.textContent = `Ошибка GLB: ${error.message}`;
    console.error(error);
  }
});

// Экспортируем результат в ТОЧНЫХ координатах эталонной фотографии.
// Никакой фотографии в PNG: только отрендеренная 3D-стена с прозрачностью.
function renderOverlayAtReferenceSize() {
  const savedSize = stage.getBoundingClientRect();
  renderer.setSize(IMAGE_WIDTH, IMAGE_HEIGHT, false);
  camera.aspect = IMAGE_WIDTH / IMAGE_HEIGHT;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const out = document.createElement("canvas");
  out.width = IMAGE_WIDTH;
  out.height = IMAGE_HEIGHT;
  const ctx = out.getContext("2d");
  ctx.drawImage(renderer.domElement, 0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  // Стена на непрозрачном кирпиче не должна показывать фон сквозь себя.
  // Для гладких границ сохраняем частичную альфу только по самому краю.
  const imageData = ctx.getImageData(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  const pixels = imageData.data;
  const pixelsW = IMAGE_WIDTH;
  for (let y = 1; y < IMAGE_HEIGHT - 1; y += 1) {
    for (let x = 1; x < IMAGE_WIDTH - 1; x += 1) {
      const i = (y * pixelsW + x) * 4 + 3;
      if (pixels[i] < 50) continue;
      if (pixels[i - 4] > 50 && pixels[i + 4] > 50 &&
          pixels[i - pixelsW * 4] > 50 && pixels[i + pixelsW * 4] > 50) {
        pixels[i] = 255;
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  if (settings.occlusion && !customReference) {
    // Удаляем альфу там, где на исходном снимке проходит реальная башня.
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    const polygon = TOWER_OCCLUSION_POLYGON;
    ctx.moveTo(...polygon[0]);
    for (const pt of polygon.slice(1)) ctx.lineTo(...pt);
    ctx.closePath();ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  renderer.setSize(Math.max(1,Math.round(savedSize.width)),
                   Math.max(1,Math.round(savedSize.height)),false);
  camera.aspect = savedSize.width / savedSize.height;
  camera.updateProjectionMatrix();renderer.render(scene,camera);
  return out;
}
$("#save-overlay").addEventListener("click", () => {
  try {
    renderOverlayAtReferenceSize().toBlob((blob)=>{
      if(blob) download(blob,"wall-overlay.png");
      else status.textContent="Ошибка сохранения PNG";
    }, "image/png");
    status.textContent="Прозрачная стена экспортирована. Добавь её вместе с эталонным фото в /track/setup.html";
  } catch (error) { status.textContent = `Ошибка экспорта: ${error.message}`; }
});
$("#save-reference").addEventListener("click",()=>{
  const out=document.createElement("canvas");out.width=IMAGE_WIDTH;out.height=IMAGE_HEIGHT;
  out.getContext("2d").drawImage(image,0,0,IMAGE_WIDTH,IMAGE_HEIGHT);
  out.toBlob(blob=>{if(blob)download(blob,"reference.png");},"image/png");
});
$("#load-reference").addEventListener("change", async event=>{
  const file=event.currentTarget.files[0];if(!file)return;
  try {
    // Приводим загружаемое фото к единому 1200x934 с центральной обрезкой,
    // чтобы и PNG наложение, и подготовленный эталон имели одинаковый размер.
    const bitmap=await createImageBitmap(file);
    const tmp=document.createElement("canvas");tmp.width=IMAGE_WIDTH;tmp.height=IMAGE_HEIGHT;
    const ctx=tmp.getContext("2d");
    const scale=Math.max(IMAGE_WIDTH/bitmap.width,IMAGE_HEIGHT/bitmap.height);
    const dw=bitmap.width*scale,dh=bitmap.height*scale;
    ctx.drawImage(bitmap,(IMAGE_WIDTH-dw)/2,(IMAGE_HEIGHT-dh)/2,dw,dh);
    bitmap.close();
    image.src=tmp.toDataURL("image/png");
    await image.decode();customReference=true;settings.occlusion=false;
    refresh(false);
    status.textContent="Новый ракурс загружен. Подгони стену, затем скачай эталон и прозрачное наложение.";
  }catch(error){status.textContent=`Ошибка загрузки фото: ${error.message}`;}
  event.currentTarget.value="";
});

// Режим просмотра поверх живой камеры. Не выполняет распознавание башни:
// координаты сохраняются в системе экрана, а не в координатах реального объекта.
async function startLiveCamera() {
  if (cameraMode) return;
  startCameraButton.disabled = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Камера доступна только на HTTPS или localhost. Для телефона опубликуйте сайт на GitHub Pages.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    cameraStream = stream;
    liveVideo.srcObject = stream;
    liveVideo.hidden = false;
    await liveVideo.play();
    const w = liveVideo.videoWidth || 1280;
    const h = liveVideo.videoHeight || 720;
    stage.style.setProperty("--camera-aspect", `${w} / ${h}`);
    stage.classList.add("camera-mode");
    cameraMode = true;
    image.hidden = true;
    startCameraButton.hidden = true;
    stopCameraButton.hidden = false;
    viewModeLabel.textContent = "Живое изображение · камера";
    refresh(false);
    status.textContent = "Камера включена. Передвинь жёлтую точку к башне. Слежение за объектом пока отсутствует.";
  } catch (error) {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    liveVideo.srcObject = null;
    liveVideo.hidden = true;
    stage.classList.remove("camera-mode");
    status.textContent = `Ошибка камеры: ${error.message}`;
  } finally {
    startCameraButton.disabled = false;
  }
}
function stopLiveCamera() {
  if (!cameraMode && !cameraStream) return;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  liveVideo.pause();
  liveVideo.srcObject = null;
  liveVideo.hidden = true;
  image.hidden = false;
  stage.classList.remove("camera-mode");
  stage.style.removeProperty("--camera-aspect");
  cameraMode = false;
  startCameraButton.hidden = false;
  stopCameraButton.hidden = true;
  viewModeLabel.textContent = "Контрольный ракурс · фотография";
  refresh(false);
  status.textContent = "Режим фото. Камера выключена.";
}
startCameraButton.addEventListener("click", startLiveCamera);
stopCameraButton.addEventListener("click", stopLiveCamera);
window.addEventListener("pagehide", () => {
  cameraStream?.getTracks().forEach((track) => track.stop());
});

image.addEventListener("load", drawTowerOcclusion);
window.addEventListener("resize", () => refresh(false));
new ResizeObserver(() => refresh(false)).observe(stage);
buildControls();
refresh(true);
status.textContent = "Редактор готов: перетаскивай жёлтую точку или меняй параметры";
