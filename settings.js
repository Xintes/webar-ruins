/**
 * НАСТРОЙКИ ПРИВЯЗКИ К КУБИКУ
 *
 * 1) Для теста можно использовать стандартную картинку MindAR.
 * 2) Для своего кубика прикрепите к ОДНОЙ ПЛОСКОЙ ГРАНИ контрастный рисунок
 *    с разнообразными деталями и сфотографируйте эту грань почти спереди.
 * 3) Скомпилируйте снимок в https://hiukim.github.io/mind-ar-js-doc/tools/compile
 *    и положите файл в assets/targets.mind, затем смените targetFile ниже.
 *
 * Оси привязаны к рисунку на грани куба:
 *   +X — вправо, +Y — вверх, +Z — к камере от распознанной плоскости.
 * 1 единица — ширина плоского изображения (если рисунок ровно 10 см,
 * 1 единица примерно равна 10 см).
 */
export const SETTINGS = {
  // После создания собственного targets.mind замените строку на:
  // targetFile: "./assets/targets.mind",
  targetFile: "https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.mind",

  // "objects" — цепочки объектов из массива ниже.
  // "building" — исходный пример здания, сохранён для совместимости.
  mode: "objects",

  // Только для mode: "building": null = встроенный замок; либо путь к GLB.
  modelFile: null,

  // Смещение и поворот ВСЕЙ сцены относительно распознанного рисунка.
  // Удобно настраивать с телефона через ?edit=1.
  transform: {
    x: 0,
    y: 0,
    z: 0.12,
    scale: 1,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0
  },

  // КАЖДЫЙ элемент arrays — отдельная цепочка объектов.
  // start = координаты ЦЕНТРА первого объекта.
  // step = смещение от одного объекта к следующему.
  // count = количество объектов в цепочке.
  arrays: [
    {
      name: "Кубы вправо от ориентира",
      enabled: true,
      type: "box",             // box, sphere, cylinder, cone, glb
      count: 5,
      start: { x: 0.9, y: -0.34, z: 0 },
      step: { x: 0.45, y: 0, z: 0 },
      size: { x: 0.26, y: 0.26, z: 0.26 },
      colors: ["#4eb7ff", "#ffc46b", "#9bdf9d"],
      rotation: { x: 0, y: 0, z: 0 }
    },
    {
      name: "Шары в глубину",
      enabled: false,          // Поменяйте на true для второй цепочки.
      type: "sphere",
      count: 4,
      start: { x: 0, y: 0, z: -0.7 },
      step: { x: 0, y: 0, z: -0.5 },
      size: { x: 0.3, y: 0.3, z: 0.3 },
      color: "#ff778b",
      rotation: { x: 0, y: 0, z: 0 }
    },
    {
      name: "Мои собственные модели",
      enabled: false,          // Поменяйте на true, когда загрузите GLB.
      type: "glb",
      file: "./assets/my-object.glb",
      count: 3,
      start: { x: 0.9, y: -0.3, z: 0 },
      step: { x: 0.6, y: 0, z: 0 },
      scale: 1,               // Масштаб своей 3D-модели.
      rotation: { x: 0, y: 0, z: 0 }
    }
  ]
};
