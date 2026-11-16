/**
 * Опытная WebAR-привязка без маркеров и без нейросетей.
 *
 * Если страница открыта через сам FastAPI (/cv/), API_BASE оставьте пустым.
 * Если страница размещена на GitHub Pages, пропишите ПУБЛИЧНЫЙ HTTPS-адрес
 * собственного FastAPI сервера, например "https://ar-api.example.org".
 */
export const CV_CONFIG = {
  API_BASE: "",
  zone: "desk_cube",
  frameWidth: 640,
  intervalMs: 800,
  requestTimeoutMs: 4500,
  jpegQuality: 0.72,
  // Эти объекты отображаются ПОКА в приблизительной 2D-проекции.
  // Их положение в метрах пока не определено — это следующий этап с solvePnP.
  arrays: [
    {
      name: "Цепочка кубиков",
      enabled: true,
      type: "box",
      count: 5,
      start: { x: 1.15, y: 0, z: 0 },
      step: { x: 0.72, y: 0, z: 0 },
      size: { x: 0.46, y: 0.46, z: 0.46 },
      colors: ["#46b4ff", "#ffc46b", "#9bdf9d"],
      rotation: { x: 15, y: -28, z: 0 }
    },
    {
      name: "Собственные модели",
      enabled: false,
      type: "glb",
      file: "./models/my-object.glb",
      count: 3,
      start: { x: 1.1, y: -0.8, z: 0 },
      step: { x: 0.9, y: 0, z: 0 },
      scale: 0.5,
      rotation: { x: 0, y: 0, z: 0 }
    }
  ]
};
