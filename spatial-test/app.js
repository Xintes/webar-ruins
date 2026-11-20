import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// SPATIAL TEST v1: 3DoF ONLY. No OpenCV, world tracking, or camera translation.
// The camera position is fixed; only its orientation is updated.
// Scene dimensions are in Three.js units, treated here as metres.
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const video = $('camera');
const message = $('status');
const stageHint = $('stage-hint');
const modeLabel = $('mode-label');
const trackingLabel = $('tracking-label');
const startBtn = $('start');
const stopBtn = $('stop');
const lockBtn = $('lock');
const recenterBtn = $('recenter');
const modePicker = $('control-mode');
const sensorInfo = $('sensor-info');
const angleInfo = $('angle-info');
const modelInfo = $('model-info');
const cameraInfo = $('camera-info');
const modelFile = $('model-file');

const DEFAULTS = Object.freeze({ distance: 30, offset: 0, modelYaw: 0, modelScale: 1, fov: 60 });
const CAMERA_HEIGHT = 1.65;
const GLB_PATH = './models/demo-wall.glb';
const DEG = Math.PI / 180;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(DEFAULTS.fov, 1, 0.02, 300);
camera.position.set(0, CAMERA_HEIGHT, 0);

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
$('webgl').appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x6c6f74, 2.25));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(-7, 14, 12);
scene.add(sun);

const modelAnchor = new THREE.Group();
scene.add(modelAnchor);
let model = null;
let modelName = 'Нет модели';

const grid = new THREE.GridHelper(80, 80, 0x65d2b1, 0x315e56);
grid.material.transparent = true;
grid.material.opacity = 0.48;
grid.visible = false;
scene.add(grid);

const settings = { ...DEFAULTS };
let stream = null;
let sensorActive = false;
let sensorCount = 0;
let lastSensorTime = 0;
let sensorQuaternion = null;
let referenceQuaternion = null;
const presentedQuaternion = new THREE.Quaternion();
let manualYaw = 0;
let manualPitch = 0;
let manualIsLocked = false;
let pointer = null;
let screenAngle = 0;
let calibratedScreenAngle = null;
let renderPreviousTime = 0;
let animationId = 0;

const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const correction = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const screenRotation = new THREE.Quaternion();
const worldZAxis = new THREE.Vector3(0, 0, 1);
const inverseReference = new THREE.Quaternion();
const desiredOrientation = new THREE.Quaternion();
const diagnosticsEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function status(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? '#ffc7b6' : '#bbd1d8';
}

function setDimensions() {
  const { width, height } = stage.getBoundingClientRect();
  if (width < 1 || height < 1) return;
  const w = Math.round(width), h = Math.round(height);
  const current = renderer.getSize(new THREE.Vector2());
  if (Math.abs(current.x - w) > 1 || Math.abs(current.y - h) > 1) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

function updateModelTransform() {
  modelAnchor.position.set(settings.offset, 0, -settings.distance);
  modelAnchor.rotation.set(0, settings.modelYaw * DEG, 0);
  modelAnchor.scale.setScalar(settings.modelScale);
}

function disposeMesh(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    for (const material of (Array.isArray(child.material) ? child.material : [child.material])) {
      if (!material) continue;
      for (const key of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
        material[key]?.dispose();
      }
      material.dispose();
    }
  });
}

function installModel(object, name) {
  // In both demo and custom GLB, put the object's footprint at (0, 0, 0).
  // The model is a child of an anchor placed N metres ahead of the camera.
  if (model) {
    modelAnchor.remove(model);
    disposeMesh(model);
  }
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error('В GLB нет отображаемой геометрии');
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  modelAnchor.add(object);
  model = object;
  modelName = name;
  modelInfo.textContent = `${name} · ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)} ед.`;
  updateModelTransform();
}

function makeFallbackWall() {
  const group = new THREE.Group();
  const brick = new THREE.MeshStandardMaterial({ color: 0xb86b4a, roughness: 0.95 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x694632, roughness: 0.95 });
  const add = (w, h, d, x, y, z, material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };
  add(12, 4, .7, 0, 2.1, 0, brick);
  add(12.4, .45, 1.05, 0, 4.35, 0, trim);
  for (let i = -5; i <= 5; i += 2.5) add(.55, 4.4, 1, i, 2.25, .3, trim);
  for (const x of [-4, -2, 0, 2, 4]) add(.27, .8, .12, x, 3, .42, trim);
  return group;
}

const gltfLoader = new GLTFLoader();
async function loadDemoModel() {
  try {
    const gltf = await gltfLoader.loadAsync(GLB_PATH);
    installModel(gltf.scene, 'demo-wall.glb');
  } catch (error) {
    console.error('GLB loading failed, switching to Three.js geometry:', error);
    installModel(makeFallbackWall(), 'Резервная стена Three.js');
    status('Демо-GLB не загрузился: показана резервная стена. Проверьте папку models/.', true);
  }
}

async function loadSelectedGlb(file) {
  if (!file) return;
  if (!/\.glb$/i.test(file.name)) {
    status('Нужен именно .glb, а не .gltf или .obj.', true);
    return;
  }
  try {
    const data = await file.arrayBuffer();
    const parsed = await new Promise((resolve, reject) => {
      gltfLoader.parse(data, '', resolve, reject);
    });
    installModel(parsed.scene, file.name);
    status(`GLB «${file.name}» загружен. Выберите направление и закрепите сцену.`);
  } catch (error) {
    console.error(error);
    status(`Ошибка чтения GLB: ${error.message || String(error)}`, true);
  }
}

function getScreenAngle() {
  const angle = window.screen?.orientation?.angle;
  return Number.isFinite(angle) ? angle : (Number(window.orientation) || 0);
}

function setSensorQuaternion(event) {
  if (!Number.isFinite(event.alpha) || !Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) {
    return false;
  }
  const alpha = event.alpha * DEG;
  const beta = event.beta * DEG;
  const gamma = event.gamma * DEG;
  screenAngle = getScreenAngle();
  // DeviceOrientationControls convention: phone body -> camera (rear camera) -> screen rotation.
  euler.set(beta, alpha, -gamma, 'YXZ');
  sensorQuaternion = new THREE.Quaternion().setFromEuler(euler);
  sensorQuaternion.multiply(correction);
  screenRotation.setFromAxisAngle(worldZAxis, -screenAngle * DEG);
  sensorQuaternion.multiply(screenRotation).normalize();
  return true;
}

function onDeviceOrientation(event) {
  if (!sensorActive || !setSensorQuaternion(event)) return;
  sensorCount += 1;
  lastSensorTime = performance.now();
  if (sensorCount === 1) {
    sensorInfo.textContent = 'Данные поступают';
    status('Датчики работают. Наведите телефон на нужное место и нажмите «Закрепить направление».');
  }
}

async function askSensorPermission() {
  if (!('DeviceOrientationEvent' in window)) {
    sensorInfo.textContent = 'Устройство не поддерживает API';
    return false;
  }
  try {
    // On iOS this call MUST be directly triggered by a tap; start it before any await.
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        sensorInfo.textContent = 'Доступ запрещён';
        return false;
      }
    }
    return true;
  } catch (error) {
    sensorInfo.textContent = `Доступ не получен: ${error.message || error}`;
    return false;
  }
}

async function start() {
  if (stream) return;
  startBtn.disabled = true;
  // Begin permissions synchronously on the click. Do not first await camera access.
  const sensorPermissionPromise = askSensorPermission();
  status('Запрашиваем разрешения...');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не поддерживает камеру в этом контексте. Нужен HTTPS.');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    const cfg = track?.getSettings?.() || {};
    cameraInfo.textContent = `${cfg.width || video.videoWidth}×${cfg.height || video.videoHeight}`;
  } catch (error) {
    console.error(error);
    status(`Камера: ${error.message || String(error)}. Можно использовать ручной режим.`, true);
    cameraInfo.textContent = 'Недоступна';
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  const permitted = await sensorPermissionPromise;
  sensorActive = permitted;
  sensorCount = 0;
  sensorQuaternion = null;
  referenceQuaternion = null;
  manualIsLocked = false;
  if (permitted) {
    window.addEventListener('deviceorientation', onDeviceOrientation);
    sensorInfo.textContent = 'Ожидаем данные...';
    modePicker.value = 'sensor';
    modeLabel.textContent = 'Датчики 3DoF';
  } else {
    modePicker.value = 'manual';
    modeLabel.textContent = 'Ручное управление';
    sensorInfo.textContent ||= 'Недоступны';
  }
  lockBtn.disabled = false;
  recenterBtn.disabled = false;
  stopBtn.disabled = !stream;
  startBtn.disabled = false;
  startBtn.textContent = stream ? 'Камера включена' : 'Повторить подключение';
  if (stream) startBtn.disabled = true;
  stageHint.textContent = 'Смотрите в выбранном направлении. Нажмите «Закрепить направление», затем поворачивайте телефон.';
  trackingLabel.textContent = 'Не закреплено';
  if (!stream && !permitted) status('Без камеры и датчиков можно проверять модель вручную.');
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  cameraInfo.textContent = 'Выключена';
  stopBtn.disabled = true;
  startBtn.disabled = false;
  startBtn.textContent = 'Включить камеру и датчики';
  status('Камера остановлена. 3D-сцена остаётся доступна в ручном режиме.');
}

function lockDirection() {
  if (modePicker.value === 'sensor') {
    if (!sensorQuaternion || performance.now() - lastSensorTime > 1500) {
      status('Нет свежих данных ориентации. Откройте сайт в Chrome или Safari и разрешите датчики.', true);
      return;
    }
    referenceQuaternion = sensorQuaternion.clone();
    calibratedScreenAngle = getScreenAngle();
  } else {
    // Manual direction becomes the new zero, with no device sensor involved.
    manualYaw = 0;
    manualPitch = 0;
    manualIsLocked = true;
  }
  presentedQuaternion.identity();
  camera.quaternion.identity();
  trackingLabel.textContent = 'Закреплено';
  stageHint.textContent = 'Стена стоит неподвижно в виртуальном мире. Поверните телефон — посмотрите, остаётся ли она на месте.';
  status('Направление зафиксировано. Теперь поворачивайте телефон на месте.');
}

function resetDirection() {
  referenceQuaternion = null;
  manualYaw = 0;
  manualPitch = 0;
  manualIsLocked = false;
  presentedQuaternion.identity();
  camera.quaternion.identity();
  trackingLabel.textContent = 'Не закреплено';
  stageHint.textContent = 'Направьте телефон туда, где должна находиться стена, и нажмите «Закрепить направление».';
  status('Привязка сброшена. Можно выбрать новое направление.');
}

function onModeChange() {
  resetDirection();
  if (modePicker.value === 'manual') {
    modeLabel.textContent = 'Ручное управление';
    status('Проведите пальцем по 3D-окну или перетащите мышью, чтобы посмотреть по сторонам.');
  } else {
    modeLabel.textContent = 'Датчики 3DoF';
    if (!sensorActive) status('Сначала нажмите «Включить камеру и датчики», чтобы разрешить датчики.', true);
  }
}

function updateSettings() {
  settings.distance = Number($('distance').value);
  settings.offset = Number($('offset').value);
  settings.modelYaw = Number($('model-yaw').value);
  settings.modelScale = Number($('model-scale').value);
  settings.fov = Number($('fov').value);
  $('distance-value').textContent = `${settings.distance} м`;
  $('offset-value').textContent = `${settings.offset.toLocaleString('ru-RU')} м`;
  $('model-yaw-value').textContent = `${settings.modelYaw}°`;
  $('model-scale-value').textContent = `${settings.modelScale.toFixed(2).replace('.', ',')}×`;
  $('fov-value').textContent = `${settings.fov}°`;
  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
  updateModelTransform();
}

function resetSettings() {
  for (const [id, value] of Object.entries(DEFAULTS)) {
    const inputId = id === 'modelYaw' ? 'model-yaw' : id === 'modelScale' ? 'model-scale' : id;
    $(inputId).value = String(value);
  }
  updateSettings();
}

function onPointerDown(event) {
  if (modePicker.value !== 'manual') return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  stage.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!pointer || pointer.id !== event.pointerId || modePicker.value !== 'manual') return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  manualYaw -= dx * .004;
  manualPitch -= dy * .004;
  manualPitch = THREE.MathUtils.clamp(manualPitch, -Math.PI * .48, Math.PI * .48);
}

function updateCameraQuaternion() {
  if (modePicker.value === 'sensor' && sensorActive && referenceQuaternion && sensorQuaternion) {
    if (calibratedScreenAngle !== getScreenAngle()) {
      resetDirection();
      status('Ориентация экрана изменилась. Закрепите направление заново.', true);
      return;
    }
    // The anchor's axes are the camera axes at lock time; camera remains at fixed position.
    inverseReference.copy(referenceQuaternion).invert();
    desiredOrientation.copy(inverseReference).multiply(sensorQuaternion).normalize();
  } else if (modePicker.value === 'manual') {
    euler.set(manualPitch, manualYaw, 0, 'YXZ');
    desiredOrientation.setFromEuler(euler);
  } else {
    desiredOrientation.identity();
  }
  presentedQuaternion.slerp(desiredOrientation, .22);
  camera.quaternion.copy(presentedQuaternion);
}

function diagnostics(now) {
  if (modePicker.value === 'sensor' && sensorActive) {
    if (sensorCount === 0) sensorInfo.textContent = 'Ожидаем события ориентации';
    else if (now - lastSensorTime > 3000) sensorInfo.textContent = 'Сигнал пропал';
    else sensorInfo.textContent = `${sensorCount} событий · ${Math.round(now - lastSensorTime)} мс назад`;
  }
  diagnosticsEuler.setFromQuaternion(camera.quaternion, 'YXZ');
  const yaw = THREE.MathUtils.radToDeg(diagnosticsEuler.y);
  const pitch = THREE.MathUtils.radToDeg(diagnosticsEuler.x);
  const roll = THREE.MathUtils.radToDeg(diagnosticsEuler.z);
  angleInfo.textContent = `${yaw.toFixed(1)}° / ${pitch.toFixed(1)}° / ${roll.toFixed(1)}°`;
}

function render(now) {
  animationId = requestAnimationFrame(render);
  setDimensions();
  updateCameraQuaternion();
  if (now - renderPreviousTime > 180) {
    diagnostics(now);
    renderPreviousTime = now;
  }
  renderer.render(scene, camera);
}

// Input listeners — any action that asks device permission runs from a real click.
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stopCamera);
lockBtn.addEventListener('click', lockDirection);
recenterBtn.addEventListener('click', resetDirection);
modePicker.addEventListener('change', onModeChange);
modelFile.addEventListener('change', () => loadSelectedGlb(modelFile.files?.[0]));
for (const id of ['distance', 'offset', 'model-yaw', 'model-scale', 'fov']) {
  $(id).addEventListener('input', updateSettings);
}
$('show-grid').addEventListener('change', (event) => { grid.visible = event.target.checked; });
$('reset-settings').addEventListener('click', resetSettings);
stage.addEventListener('pointerdown', onPointerDown);
stage.addEventListener('pointermove', onPointerMove);
stage.addEventListener('pointerup', () => { pointer = null; });
stage.addEventListener('pointercancel', () => { pointer = null; });
window.addEventListener('resize', setDimensions);
window.addEventListener('pagehide', () => {
  stopCamera();
  cancelAnimationFrame(animationId);
  window.removeEventListener('deviceorientation', onDeviceOrientation);
});

updateSettings();
setDimensions();
loadDemoModel();
animationId = requestAnimationFrame(render);
