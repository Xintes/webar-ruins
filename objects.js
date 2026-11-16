import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const SUPPORTED_TYPES = new Set(["box", "sphere", "cylinder", "cone", "glb"]);
const MAX_OBJECTS = 250;

function vector(value, defaultValue = 0) {
  return {
    x: Number(value?.x ?? defaultValue),
    y: Number(value?.y ?? defaultValue),
    z: Number(value?.z ?? defaultValue)
  };
}

function assertFiniteVector(value, description) {
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new Error(`Некорректные координаты: ${description}`);
  }
}

function primitiveGeometry(type, size) {
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
    throw new Error("Размеры примитивов должны быть положительными.");
  }

  switch (type) {
    case "box":
      return new THREE.BoxGeometry(size.x, size.y, size.z);
    case "sphere":
      // Для сферы size.x — диаметр.
      return new THREE.SphereGeometry(size.x / 2, 24, 16);
    case "cylinder":
      // size.x — диаметр, size.y — высота.
      return new THREE.CylinderGeometry(size.x / 2, size.x / 2, size.y, 24);
    case "cone":
      return new THREE.ConeGeometry(size.x / 2, size.y, 24);
    default:
      throw new Error(`Неизвестный примитив: ${type}`);
  }
}

/**
 * Создаёт цепочки 3D-объектов в локальных координатах ориентира.
 * X — вправо на изображении; Y — вверх; Z — к камере от лицевой плоскости.
 * Единица длины приблизительно равна ширине распознаваемого изображения.
 *
 * Каждый элемент массива задаёт тип объектов, первый центр, шаг и количество.
 * Никакие GLB не загружаются для элементов с enabled: false.
 */
export async function createObjectArrays(arrays) {
  if (!Array.isArray(arrays)) {
    throw new Error("В settings.js поле arrays должно быть массивом.");
  }

  const sceneGroup = new THREE.Group();
  const loader = new GLTFLoader();
  const loadedGlbs = new Map();
  let totalCount = 0;

  for (const config of arrays) {
    if (config.enabled === false) continue;

    const type = config.type;
    if (!SUPPORTED_TYPES.has(type)) {
      throw new Error(`Неизвестный тип объекта: ${type}`);
    }

    const count = config.count;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Поле count должно быть целым числом >= 1 (${config.name ?? type}).`);
    }

    totalCount += count;
    if (totalCount > MAX_OBJECTS) {
      throw new Error(`Слишком много объектов. Лимит для прототипа: ${MAX_OBJECTS}.`);
    }

    const start = vector(config.start);
    const step = vector(config.step);
    const rotation = vector(config.rotation);
    assertFiniteVector(start, `${config.name ?? type}.start`);
    assertFiniteVector(step, `${config.name ?? type}.step`);
    assertFiniteVector(rotation, `${config.name ?? type}.rotation`);

    let sourceModel = null;
    let geometry = null;
    let materials = null;
    let modelScale = 1;

    if (type === "glb") {
      if (typeof config.file !== "string" || !config.file.trim()) {
        throw new Error(`Для ${config.name ?? "glb"} нужно указать file.`);
      }
      modelScale = Number(config.scale ?? 1);
      if (!Number.isFinite(modelScale) || modelScale <= 0) {
        throw new Error("Масштаб .glb должен быть положительным числом.");
      }
      if (!loadedGlbs.has(config.file)) {
        const gltf = await loader.loadAsync(config.file);
        loadedGlbs.set(config.file, gltf.scene);
      }
      sourceModel = loadedGlbs.get(config.file);
    } else {
      const size = vector(config.size, 0.25);
      assertFiniteVector(size, `${config.name ?? type}.size`);
      geometry = primitiveGeometry(type, size);
      const palette = Array.isArray(config.colors) && config.colors.length
        ? config.colors
        : [config.color ?? "#63b3ed"];
      materials = palette.map((color) => new THREE.MeshStandardMaterial({
        color,
        roughness: 0.75,
        metalness: 0.05
      }));
    }

    for (let index = 0; index < count; index++) {
      // GLB: простое клонирование для СТАТИЧЕСКИХ моделей без скелетной анимации.
      const object = sourceModel
        ? sourceModel.clone(true)
        : new THREE.Mesh(geometry, materials[index % materials.length]);

      object.position.set(
        start.x + step.x * index,
        start.y + step.y * index,
        start.z + step.z * index
      );
      object.rotation.set(
        THREE.MathUtils.degToRad(rotation.x),
        THREE.MathUtils.degToRad(rotation.y),
        THREE.MathUtils.degToRad(rotation.z),
        "XYZ"
      );
      if (sourceModel) object.scale.setScalar(modelScale);
      object.name = `${config.name ?? type} ${index + 1}`;
      sceneGroup.add(object);
    }
  }

  return sceneGroup;
}
