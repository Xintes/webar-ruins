import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MindARThree } from "mindar-image-three";
import { SETTINGS } from "./settings.js";

const container = document.querySelector("#ar-container");
const statusElement = document.querySelector("#status");
const welcome = document.querySelector("#welcome");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const bottomBar = document.querySelector("#bottom-bar");
const editor = document.querySelector("#editor");
const fields = document.querySelector("#fields");
const copyButton = document.querySelector("#copy-button");
const resetButton = document.querySelector("#reset-button");

const STORAGE_KEY = "webar-ruins-transform-v1";
const FIELD_LABELS = {
  x: "Смещение X",
  y: "Смещение Y",
  z: "Смещение Z",
  scale: "Масштаб",
  rotationX: "Поворот X (°)",
  rotationY: "Поворот Y (°)",
  rotationZ: "Поворот Z (°)"
};

let transform = { ...SETTINGS.transform };
let mindar = null;
let modelRoot = null;
let starting = false;
let running = false;

function setStatus(message) {
  statusElement.textContent = message;
}

function applyTransform() {
  if (!modelRoot) return;
  modelRoot.position.set(transform.x, transform.y, transform.z);
  modelRoot.scale.setScalar(transform.scale);
  modelRoot.rotation.set(
    THREE.MathUtils.degToRad(transform.rotationX),
    THREE.MathUtils.degToRad(transform.rotationY),
    THREE.MathUtils.degToRad(transform.rotationZ),
    "XYZ"
  );
}

function makeDemoBuilding() {
  // Временный геометрический макет. НЕ является исторической реконструкцией.
  const building = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xb5a58b, roughness: 0.95 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x8b4d3b, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x302e31, roughness: 0.95 });

  function block(w, h, d, x, y, z, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    building.add(mesh);
    return mesh;
  }

  block(0.62, 0.31, 0.16, 0, -0.09, 0, stone); // центральный корпус
  block(0.13, 0.49, 0.18, -0.30, 0, 0.015, stone); // левая башня
  block(0.13, 0.49, 0.18,  0.30, 0, 0.015, stone); // правая башня
  block(0.13, 0.22, 0.19, 0, 0.17, 0, stone); // центральная надстройка

  [-0.30, 0, 0.30].forEach((x) => {
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.18, 4), roof);
    top.position.set(x, x === 0 ? 0.37 : 0.33, 0);
    top.rotation.y = Math.PI / 4;
    building.add(top);
  });

  block(0.09, 0.19, 0.012, 0, -0.15, 0.088, dark); // дверь
  for (const x of [-0.19, 0.19]) {
    block(0.065, 0.095, 0.012, x, -0.07, 0.088, dark); // окна
  }
  return building;
}

async function loadModel() {
  if (!SETTINGS.modelFile) return makeDemoBuilding();
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(SETTINGS.modelFile);
  return gltf.scene;
}

async function startAR() {
  if (starting || running) return;
  starting = true;
  startButton.disabled = true;
  setStatus("Загрузка AR и 3D-модели...");

  try {
    if (!window.isSecureContext) {
      throw new Error("Камера требует HTTPS или localhost. Откройте сайт через GitHub Pages.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("В этом браузере недоступна камера через getUserMedia.");
    }

    mindar = new MindARThree({
      container,
      imageTargetSrc: SETTINGS.targetFile,
      maxTrack: 1,
      uiLoading: "yes",
      uiScanning: "no",
      uiError: "no"
    });

    const { scene, camera, renderer } = mindar;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x665544, 2.1));
    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(0, 2, 4);
    scene.add(light);

    const anchor = mindar.addAnchor(0);
    modelRoot = new THREE.Group();
    modelRoot.add(await loadModel());
    anchor.group.add(modelRoot);
    applyTransform();

    anchor.onTargetFound = () => setStatus("Ориентир найден · реконструкция активна");
    anchor.onTargetLost = () => setStatus("Ориентир потерян · наведите камеру снова");

    await mindar.start();
    renderer.setAnimationLoop(() => renderer.render(scene, camera));

    running = true;
    welcome.hidden = true;
    bottomBar.hidden = false;
    setStatus("Наведите камеру на ориентир");
  } catch (error) {
    console.error("Ошибка запуска AR:", error);
    setStatus(`Ошибка: ${error.message ?? String(error)}`);
    try { mindar?.stop(); } catch (ignored) { /* Камера ещё могла не запуститься. */ }
    mindar = null;
    modelRoot = null;
  } finally {
    starting = false;
    startButton.disabled = false;
  }
}

function stopAR() {
  if (!running || !mindar) return;
  mindar.renderer.setAnimationLoop(null);
  mindar.stop();
  running = false;
  mindar = null;
  modelRoot = null;
  welcome.hidden = false;
  bottomBar.hidden = true;
  setStatus("Камера выключена");
}

function initEditor() {
  if (!new URLSearchParams(window.location.search).has("edit")) return;
  editor.hidden = false;

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      for (const name of Object.keys(FIELD_LABELS)) {
        if (Number.isFinite(saved[name]) && (name !== "scale" || saved[name] > 0)) {
          transform[name] = saved[name];
        }
      }
    }
  } catch (error) {
    console.warn("Сохранённые настройки не прочитаны:", error);
  }

  for (const [name, label] of Object.entries(FIELD_LABELS)) {
    const row = document.createElement("label");
    row.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.step = name.startsWith("rotation") ? "1" : "0.01";
    if (name === "scale") input.min = "0.001";
    input.value = String(transform[name]);
    input.dataset.field = name;
    input.addEventListener("input", () => {
      const value = input.valueAsNumber;
      if (!Number.isFinite(value) || (name === "scale" && value <= 0)) return;
      transform[name] = value;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(transform));
      applyTransform();
    });
    row.append(input);
    fields.append(row);
  }

  copyButton.addEventListener("click", async () => {
    const output = JSON.stringify(transform, null, 2);
    try {
      await navigator.clipboard.writeText(output);
      setStatus("Настройки скопированы — вставьте в settings.js");
    } catch (error) {
      console.log("Настройки модели:", output);
      setStatus("Не получилось скопировать. Настройки выведены в консоль.");
    }
  });

  resetButton.addEventListener("click", () => {
    transform = { ...SETTINGS.transform };
    localStorage.removeItem(STORAGE_KEY);
    fields.querySelectorAll("input").forEach((input) => {
      input.value = String(transform[input.dataset.field]);
    });
    applyTransform();
    setStatus("Настройки сброшены");
  });
}

startButton.addEventListener("click", startAR);
stopButton.addEventListener("click", stopAR);
initEditor();
