/** Pure placement geometry. World = WebXR local reference space; units = metres. */
export function computePlacement(pose, config) {
  const f = pose.forward;
  const len = Math.hypot(f.x, f.z);
  if (!Number.isFinite(len) || len < 0.12) {
    throw new Error('Направьте камеру ближе к горизонту, затем повторите закрепление.');
  }
  const fx = f.x / len;
  const fz = f.z / len;
  // Right perpendicular to horizontal forward. Forward (0,0,-1) -> Right (+1,0,0).
  const rx = -fz;
  const rz = fx;
  return {
    x: pose.position.x + fx * config.distance + rx * config.offset,
    y: pose.position.y - config.cameraHeight + config.height,
    z: pose.position.z + fz * config.distance + rz * config.offset,
    yaw: Math.atan2(-fx, -fz) + config.yawDeg * Math.PI / 180,
    scale: config.scale
  };
}

export function horizontalDisplacement(from, to) {
  return Math.hypot(to.x - from.x, to.z - from.z);
}

export function distanceToPoint(from, point) {
  return Math.hypot(point.x - from.x, point.y - from.y, point.z - from.z);
}
