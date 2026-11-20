import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computePlacement, horizontalDisplacement, distanceToPoint } from './placement.mjs';

// Spatial Test v2: real 6DoF from WebXR immersive-ar (when device/browser supports it).
// No fake translation from gyroscope, no GPS, no OpenCV and no repeated scanning.
// World coordinates exist ONLY for the current AR session; no cross-session persistence.
const $ = (id) => document.getElementById(id);
const support = $('support');
const startButton = $('start-ar');
const overlay = $('ar-overlay');
const stateText = $('ar-state');
const arTip = $('ar-tip');
const placeButton = $('place');
const relockButton = $('relock');
const exitButton = $('exit-ar');
const modelInfo = $('model-info');

const DEFAULT_SETTINGS = Object.freeze({
  distance: 3.5,
  offset: 0,
  cameraHeight: 1.5,
  height: 0,
  yawDeg: 0,
  scale: 0.3
});
const settings = { ...DEFAULT_SETTINGS };
const settingControls = {
  distance: $('distance'),
  offset: $('offset'),
  cameraHeight: $('camera-height'),
  height: $('height'),
  yawDeg: $('yaw'),
  scale: $('scale')
};
const textControls = {
  distance: $('distance-text'),
  offset: $('offset-text'),
  cameraHeight: $('camera-height-text'),
  height: $('height-text'),
  yawDeg: $('yaw-text'),
  scale: $('scale-text')
};
const loader = new GLTFLoader();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.02, 300);
const renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: true,
  powerPreference: 'low-power',
  preserveDrawingBuffer: false
});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
$('three-root').appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x647580, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(-5, 12, 8);
scene.add(sun);

// The model will stay attached to this *world-space* group after placement.
const modelAnchor = new THREE.Group();
modelAnchor.visible = false;
scene.add(modelAnchor);
let model = null;
let activeSession = null;
let placed = false;
let lockedPose = null;
let latestPose = null;
let latestPoseMs = -Infinity;
let latestDiagnosticMs = 0;
let spaceForReset = null;

const forward = new THREE.Vector3(0, 0, -1);
const orientation = new THREE.Quaternion();
const target = new THREE.Vector3();

function indicate(message, isError = false) {
  support.textContent = message;
  support.classList.toggle('no', isError);
  support.classList.toggle('ok', !isError && message.includes('поддерживается'));
}
function arStatus(message) { stateText.textContent = message; }

function disposeMesh(object) {
  object.traverse((item) => {
    if (!item.isMesh) return;
    item.geometry?.dispose();
    const materials = Array.isArray(item.material) ? item.material : [item.material];
    for (const material of materials) {
      if (!material) continue;
      for (const property of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        material[property]?.dispose();
      }
      material.dispose();
    }
  });
}

function installModel(object, name) {
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) throw new Error('В модели нет геометрии.');
  const middle = bounds.getCenter(new THREE.Vector3());
  const dimensions = bounds.getSize(new THREE.Vector3());
  // Local origin = middle of footprint on the model's ground plane.
  object.position.sub(new THREE.Vector3(middle.x, bounds.min.y, middle.z));
  modelAnchor.add(object);
  if (model) {
    modelAnchor.remove(model);
    disposeMesh(model);
  }
  model = object;
  modelInfo.textContent = `${name} · ${dimensions.x.toFixed(1)}×${dimensions.y.toFixed(1)}×${dimensions.z.toFixed(1)} м до масштабирования`;
}

function makeFallbackWall() {
  const group = new THREE.Group();
  const brick = new THREE.MeshStandardMaterial({ color: 0xad6146, roughness: 0.95 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x654533, roughness: 0.9 });
  const add = (w, h, d, x, y, z, material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };
  add(12, 4.1, 0.65, 0, 2.05, 0, brick);
  add(12.3, 0.35, 0.85, 0, 4.25, 0, trim);
  for (let i = -5; i <= 5; i += 2.5) add(0.3, 0.7, 0.12, i, 3, 0.39, trim);
  return group;
}

async function loadDemo() {
  try {
    const gltf = await loader.loadAsync('../models/demo-wall.glb');
    installModel(gltf.scene, 'demo-wall.glb');
  } catch (error) {
    console.warn('Using local Three.js fallback wall', error);
    installModel(makeFallbackWall(), 'Резервная стена Three.js');
  }
}

async function loadCustom(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.glb')) {
    modelInfo.textContent = 'Нужен файл с расширением .glb';
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
    installModel(gltf.scene, file.name);
  } catch (error) {
    console.error(error);
    modelInfo.textContent = `Не удалось загрузить GLB: ${error.message || String(error)}`;
  }
}

function syncSettingText() {
  textControls.distance.textContent = `${settings.distance.toFixed(1)} м`;
  textControls.offset.textContent = `${settings.offset.toFixed(1)} м`;
  textControls.cameraHeight.textContent = `${settings.cameraHeight.toFixed(2)} м`;
  textControls.height.textContent = `${settings.height.toFixed(1)} м`;
  textControls.yawDeg.textContent = `${settings.yawDeg}°`;
  textControls.scale.textContent = `${settings.scale.toFixed(2)}×`;
  $('ar-distance').value = String(settings.distance);
  $('ar-distance-text').textContent = `${settings.distance.toFixed(1)} м`;
}

function refreshAnchorFromSavedPose() {
  if (!lockedPose) return;
  applyAnchor(computePlacement(lockedPose, settings));
}
function updateSetting(name, value) {
  if (!Number.isFinite(value)) return;
  settings[name] = value;
  settingControls[name].value = String(value);
  syncSettingText();
  // Explicit user setting edits may move the anchor; ordinary camera motion never does.
  if (placed) refreshAnchorFromSavedPose();
}
function applyAnchor(result) {
  modelAnchor.position.set(result.x, result.y, result.z);
  modelAnchor.rotation.set(0, result.yaw, 0);
  modelAnchor.scale.setScalar(result.scale);
  modelAnchor.visible = true;
}

function snapshotCameraPose(webxrPose) {
  const tr = webxrPose.transform;
  orientation.set(tr.orientation.x, tr.orientation.y, tr.orientation.z, tr.orientation.w);
  forward.set(0, 0, -1).applyQuaternion(orientation);
  return {
    position: { x: tr.position.x, y: tr.position.y, z: tr.position.z },
    forward: { x: forward.x, y: forward.y, z: forward.z }
  };
}

function lockAtCurrentPose() {
  if (!activeSession) return;
  if (!latestPose || performance.now() - latestPoseMs > 900) {
    arStatus('Пока нет устойчивой позы камеры');
    return;
  }
  try {
    lockedPose = {
      position: { ...latestPose.position },
      forward: { ...latestPose.forward }
    };
    refreshAnchorFromSavedPose();
    placed = true;
    placeButton.disabled = true;
    relockButton.disabled = false;
    arStatus('Стена закреплена в 3D');
    arTip.textContent = 'Подойдите ближе, отойдите назад и шагните вбок. Стена должна оставаться в том же месте, пока WebXR отслеживает ваше перемещение.';
  } catch (error) {
    placed = false;
    lockedPose = null;
    arStatus(error.message || 'Не удалось закрепить стену');
  }
}

function resetPlacement(message = 'Наведите на нужную точку и закрепите стену') {
  placed = false;
  lockedPose = null;
  modelAnchor.visible = !!activeSession && !!latestPose;
  placeButton.disabled = false;
  relockButton.disabled = true;
  arStatus(message);
  arTip.textContent = 'Незакреплённая стена следует за камерой. Нажмите «Закрепить», чтобы оставить её в этой точке.';
  $('moved').textContent = '0.00 м';
}

function onReferenceSpaceReset() {
  resetPlacement('Система координат AR обновилась. Закрепите стену заново.');
}

function onXRSelect() {
  // Supports XR tap-to-place when the browser does not support HTML DOM Overlay.
  if (!placed) lockAtCurrentPose();
}

function onXREnd() {
  if (spaceForReset) spaceForReset.removeEventListener('reset', onReferenceSpaceReset);
  spaceForReset = null;
  activeSession = null;
  latestPose = null;
  latestPoseMs = -Infinity;
  placed = false;
  lockedPose = null;
  modelAnchor.visible = false;
  document.body.classList.remove('in-ar');
  startButton.disabled = false;
  $('three-root').setAttribute('aria-hidden', 'true');
  indicate('AR-сессия завершена. Для нового испытания запустите её ещё раз.');
}

async function startAR() {
  if (activeSession) return;
  startButton.disabled = true;
  try {
    if (!navigator.xr) throw new Error('Этот браузер не поддерживает WebXR.');
    // Needs a user gesture: requestSession is directly called from click handler.
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlay }
    });
    activeSession = session;
    session.addEventListener('end', onXREnd, { once: true });
    session.addEventListener('select', onXRSelect);
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    spaceForReset = renderer.xr.getReferenceSpace();
    spaceForReset?.addEventListener('reset', onReferenceSpaceReset);
    latestPose = null;
    latestPoseMs = -Infinity;
    placed = false;
    lockedPose = null;
    document.body.classList.add('in-ar');
    $('three-root').setAttribute('aria-hidden', 'false');
    resetPlacement('Изучаем окружение. Медленно поводите камерой.');
    if (!session.domOverlayState) {
      indicate('WebXR работает, но AR-интерфейс недоступен. Коснитесь экрана для закрепления; завершите сессию системной кнопкой.');
    }
  } catch (error) {
    console.error('Could not start immersive AR', error);
    if (activeSession) {
      const s = activeSession;
      activeSession = null;
      try { await s.end(); } catch (_) { /* Browser might already have ended it. */ }
    }
    onXREnd();
    indicate(`Не удалось запустить 6DoF: ${error.message || String(error)}. Проверьте Chrome, ARCore и разрешения камеры.`, true);
  } finally {
    if (!activeSession) startButton.disabled = false;
  }
}

async function stopAR() {
  const session = activeSession;
  if (!session) return;
  try { await session.end(); } catch (error) { console.error(error); onXREnd(); }
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

renderer.setAnimationLoop((time, frame) => {
  if (activeSession && frame) {
    const space = renderer.xr.getReferenceSpace();
    if (space) {
      const viewerPose = frame.getViewerPose(space);
      if (viewerPose) {
        latestPose = snapshotCameraPose(viewerPose);
        latestPoseMs = performance.now();
        if (!placed) {
          try {
            applyAnchor(computePlacement(latestPose, settings));
            if (time - latestDiagnosticMs > 250) arStatus('Камера отслеживается. Закрепите стену.');
          } catch (_) {
            modelAnchor.visible = false;
            if (time - latestDiagnosticMs > 250) arStatus('Наведите камеру ближе к горизонту');
          }
        }
        if (time - latestDiagnosticMs > 250) {
          if (placed && lockedPose) {
            const walked = horizontalDisplacement(lockedPose.position, latestPose.position);
            $('moved').textContent = `${walked.toFixed(2)} м`;
            $('to-wall').textContent = `${distanceToPoint(latestPose.position, modelAnchor.position).toFixed(2)} м`;
            arStatus('6DoF · положение отслеживается');
          } else {
            $('to-wall').textContent = `${distanceToPoint(latestPose.position, modelAnchor.position).toFixed(2)} м`;
          }
          latestDiagnosticMs = time;
        }
      } else if (time - latestDiagnosticMs > 400) {
        arStatus('Трекинг камеры временно потерян');
        latestDiagnosticMs = time;
      }
    }
  }
  renderer.render(scene, camera);
});

for (const [key, control] of Object.entries(settingControls)) {
  control.addEventListener('input', () => updateSetting(key, Number(control.value)));
}
$('ar-distance').addEventListener('input', (event) => updateSetting('distance', Number(event.target.value)));
$('model-file').addEventListener('change', (event) => loadCustom(event.target.files?.[0]));
startButton.addEventListener('click', startAR);
placeButton.addEventListener('click', lockAtCurrentPose);
relockButton.addEventListener('click', () => resetPlacement('Выберите новое место для стены'));
exitButton.addEventListener('click', stopAR);
// Prevent taps on overlay buttons from also being treated as WebXR select events.
overlay.addEventListener('beforexrselect', (event) => {
  if (event.target.closest('button,input,label')) event.preventDefault();
});
window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { if (activeSession) void stopAR(); });

async function init() {
  syncSettingText();
  relockButton.disabled = true;
  await loadDemo();
  if (!navigator.xr?.isSessionSupported) {
    indicate('WebXR 6DoF недоступен в этом браузере. На Android откройте ссылку напрямую в Chrome с установленным ARCore. На iPhone используйте прежний тест 3DoF.', true);
    return;
  }
  try {
    if (await navigator.xr.isSessionSupported('immersive-ar')) {
      indicate('WebXR AR поддерживается. Можно запускать 6DoF.');
      startButton.disabled = false;
    } else {
      indicate('На этом устройстве immersive-ar недоступен. Попробуйте Chrome на Android с Google Play Services for AR.', true);
    }
  } catch (error) {
    indicate(`Ошибка проверки WebXR: ${error.message || String(error)}`, true);
  }
}

init();
