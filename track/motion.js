/**
 * Лёгкая оценка сдвига двух последовательных кадров в браузере.
 * Это НЕ SLAM, не определение 3D-позы и не нейросеть.
 * Для слабых телефонов работаем с серым кадром шириной не более 256 px.
 */
export function toGray(imageData) {
  const src = imageData.data;
  const gray = new Uint8Array(imageData.width * imageData.height);
  for (let j = 0, k = 0; k < gray.length; j += 4, k++) {
    gray[k] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8;
  }
  return gray;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  const mid = ordered.length >> 1;
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) * 0.5;
}

function patchError(a, b, width, x, y, dx, dy) {
  let total = 0;
  // 7x7 пикселей с шагом 1; сдвиг ищем в небольшом окне.
  for (let v = -3; v <= 3; v++) {
    const aRow = (y + v) * width + x;
    const bRow = (y + v + dy) * width + x + dx;
    for (let u = -3; u <= 3; u++) {
      total += Math.abs(a[aRow + u] - b[bRow + u]);
    }
  }
  return total;
}

function localTexture(gray, width, x, y) {
  let value = 0;
  for (let v = -2; v <= 2; v += 2) {
    for (let u = -2; u <= 2; u += 2) {
      const i = (y + v) * width + x + u;
      value += Math.abs(gray[i - 2] - gray[i + 2]);
      value += Math.abs(gray[i - width * 2] - gray[i + width * 2]);
    }
  }
  return value;
}

/**
 * Оценить общий сдвиг (в пикселях уменьшенного изображения).
 * region: необязательный прямоугольник {x,y,w,h} на уменьшенном изображении.
 * При недостаточном количестве согласованных участков возвращаем ok:false.
 */
export function estimateTranslation(previous, current, width, height, region = null) {
  if (!previous || !current || previous.length !== width * height || current.length !== previous.length || width < 80 || height < 60) {
    return { ok: false, dx: 0, dy: 0, matches: 0, inliers: 0 };
  }
  const margin = 13;
  const area = region || { x: 0, y: 0, w: width, h: height };
  const minX = Math.max(margin, Math.floor(area.x));
  const minY = Math.max(margin, Math.floor(area.y));
  const maxX = Math.min(width - margin - 1, Math.ceil(area.x + area.w));
  const maxY = Math.min(height - margin - 1, Math.ceil(area.y + area.h));
  if (maxX - minX < 28 || maxY - minY < 28) {
    return { ok: false, dx: 0, dy: 0, matches: 0, inliers: 0 };
  }

  const candidates = [];
  // Каждый участок зоны даёт не больше одного опорного фрагмента.
  const cols = 6, rows = 4;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.round(minX + (col + 0.5) * (maxX - minX) / cols);
      const y = Math.round(minY + (row + 0.5) * (maxY - minY) / rows);
      const texture = localTexture(previous, width, x, y);
      if (texture >= 130) candidates.push({ x, y, texture });
    }
  }
  candidates.sort((a, b) => b.texture - a.texture);
  const motions = [];
  for (const { x, y } of candidates.slice(0, 18)) {
    let best = Number.POSITIVE_INFINITY;
    let bestDx = 0, bestDy = 0;
    for (let dy = -7; dy <= 7; dy++) {
      for (let dx = -7; dx <= 7; dx++) {
        const err = patchError(previous, current, width, x, y, dx, dy);
        if (err < best) { best = err; bestDx = dx; bestDy = dy; }
      }
    }
    // Слишком большая ошибка означает, что фрагмент поменялся или перекрыт.
    if (best <= 49 * 24) motions.push({ dx: bestDx, dy: bestDy });
  }
  if (motions.length < 5) return { ok: false, dx: 0, dy: 0, matches: motions.length, inliers: 0 };
  const midX = median(motions.map(m => m.dx));
  const midY = median(motions.map(m => m.dy));
  const good = motions.filter(m => Math.hypot(m.dx - midX, m.dy - midY) <= 2.5);
  if (good.length < 5 || good.length / motions.length < 0.5) {
    return { ok: false, dx: 0, dy: 0, matches: motions.length, inliers: good.length };
  }
  return { ok: true, dx: median(good.map(m => m.dx)), dy: median(good.map(m => m.dy)), matches: motions.length, inliers: good.length };
}

/** Композиция 2D-сдвига кадра с гомографией, выраженной в пикселях текущего кадра. */
export function shiftHomography(h, dx, dy) {
  if (!Array.isArray(h) || h.length !== 9) throw new TypeError('Ожидалась гомография 3x3');
  return [
    h[0] + dx * h[6], h[1] + dx * h[7], h[2] + dx * h[8],
    h[3] + dy * h[6], h[4] + dy * h[7], h[5] + dy * h[8],
    h[6], h[7], h[8]
  ];
}

/** Срок удержания: следующий облачный ответ может прийти существенно позже 1,5 с. */
export function holdDurationMs(requestMs) {
  return Math.min(9000, Math.max(4500, Math.round(requestMs * 2.5 + 1200)));
}

export function visibilityAt(now, goodAt, holdMs, missCount, secondMissAt) {
  if (goodAt === null) return 0;
  const staleAt = goodAt + holdMs;
  const lossAt = missCount >= 2 && secondMissAt !== null ? Math.min(staleAt, secondMissAt + 350) : staleAt;
  if (now <= lossAt - 450) return 1;
  if (now >= lossAt) return 0;
  return Math.max(0, (lossAt - now) / 450);
}
