/**
 * Меняйте только эти настройки, чтобы подключить своё здание.
 *
 * 1. Создайте targets.mind из фотографии реального ориентира:
 *    https://hiukim.github.io/mind-ar-js-doc/tools/compile
 * 2. Поместите его в assets/targets.mind.
 * 3. Поместите 3D-модель в assets/building.glb.
 * 4. Укажите локальные пути ниже.
 *
 * ВНИМАНИЕ: единица координат MindAR = ширина опорного изображения,
 * а не один метр. Для моделей в метрах стартовый scale ~= 1 / ширина
 * реального участка, попавшего на изображение, в метрах.
 */
export const SETTINGS = {
  // Демонстрационная цель из официального примера MindAR.
  // Для своей башни: "./assets/targets.mind"
  targetFile: "https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.mind",

  // null = встроенный тестовый макет. Для собственной модели: "./assets/building.glb"
  modelFile: null,

  // Положение относительно фотографии-ориентира:
  // X: вправо, Y: вверх, Z: от плоскости изображения к камере.
  // Углы в градусах, масштаб — безразмерный коэффициент.
  transform: {
    x: 0,
    y: 0,
    z: 0.12,
    scale: 1,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0
  }
};
