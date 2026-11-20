# WebAR Spatial Test v1 — 3DoF, fixed world scene

This experiment is **independent** from OpenCV, Python, Render, `/track/`, and `/wall-lab/`.
It tests only whether a 3D object remains in the same virtual direction as the camera/head rotates.

## Deploy

1. Copy the complete `spatial-test` directory into the root of the existing `webar-ruins` repository.
2. GitHub Desktop: Commit to `main` -> Push origin.
3. Once GitHub Pages updates, open:
   `https://xintes.github.io/webar-ruins/spatial-test/`
4. Use Chrome on Android or Safari on iPhone (prefer a normal browser, not an in-app browser).
5. Tap **Включить камеру и датчики** and grant the permissions.
6. Point at a real static feature and tap **Закрепить направление**.
7. Stand in one place and rotate the phone slowly, returning to the start orientation.

## Expected result

- A test GLB wall appears at the chosen distance (30 m by default).
- Looking left or right shifts the wall in the opposite direction of the screen while its world position remains unchanged.
- Returning to the same direction should bring the wall back to about the same location.
- The virtual position is not yet tied to any real landmark. Calibration means *the user selects a direction manually*.
- Camera translation is NOT tracked: moving your body 1–6 m causes parallax errors.
- Phone heading may drift since deviceorientation does not guarantee stable absolute heading.
- Camera intrinsic parameters are not available here. Adjust FOV manually to get approximate visual alignment.

## Manual test

- On a desktop, select `Мышь / пальцем по экрану`.
- Drag in the video/3D window; the wall should move accordingly.
- If camera is unavailable, the 3D wall remains visible against a dark fallback background.

## Custom GLB

- Use `Своя GLB-модель`, choose a standalone binary GLB (embedded assets).
- The model is repositioned to ground level (lowest vertex at y=0) and horizontally centered.
- Existing GLB geometric units are treated as metres; edit **Масштаб модели** if necessary.
- You can also export a GLB from the current `/wall-lab/` editor and load it into this page.
- GLB is read locally in the visitor's browser; no uploading to Render.

## Files

- `index.html`: UI and dependency import map (Three.js r160, same version as current `/wall-lab/`).
- `styles.css`: responsive page and camera layers.
- `app.js`: rendering, sensor permission, relative camera rotation, manual controls, 3D model handling.
- `models/demo-wall.glb`: lightweight built-in real 3D wall model (approx 10 KB).

## Known limitations

- 3DoF only. Camera position is fixed to (0, 1.65, 0) metres, and orientation is adjusted from relative DeviceOrientationEvent events or manual dragging.
- No image recognition, no marker, no world-space SLAM, no GPS, no depth occlusion or ground detection.
- Device orientation requires HTTPS and user permissions where applicable, particularly Safari/iOS.
- Sensor alignment may differ by phone/browser; test the actual target devices and adjust implementation based on results.
- Loading Three.js requires internet access to unpkg.com. GitHub Pages provides HTTPS automatically.
