# WebAR v1.4 — faster reacquisition, without neural networks

This update **does not change the wall artwork, 3D geometry, or the existing v1.3 local translation tracker**. It only improves the server-assisted search and the cadence of sending images.

## What changed

1. While the tower is tracked and local motion estimation is confident, the browser can suggest an expanded region where the tower was last seen. SIFT then processes that crop instead of the entire video frame.
2. A failed *cropped* search is followed by a fresh **full-frame** search. It never asserts that a tower is found solely from the hint.
3. The last successfully recognized reference view is preferred when multiple prepared views are available; other views are still checked when the preferred match is uncertain.
4. Only **one frame request at a time** is sent. After a failure, the browser submits a newly captured frame shortly after the response, rather than waiting for the next polling tick. During tracking, checks are spaced out to reduce load.
5. The camera sends 960-pixel-wide JPEGs when searching and 840-pixel-wide JPEGs when tracking, where supported by the camera.
6. Diagnostics show OpenCV processing time separately from the **approximate** network/queue/browser time, plus candidate matches and inliers on failed detections. Network timing is an estimate, not a precise network profiler.

## Deployment — both GitHub Pages and Render must be updated

Replace these files relative to repository root:

- `track/main.js` — browser logic (GitHub Pages)
- `track/index.html` — forces browsers to refresh the v1.4 JS (GitHub Pages)
- `server/tracker.py` — optimized image recognition (Render)
- `server/app.py` — accepts optional `preferred_view` and `hint_roi` form fields (Render)

`track/motion.js`, the existing overlay PNG and all wall editor files remain unchanged in this patch.

Commit and push to `main`. Check the Render service's **Events / Deploys** page to ensure deployment of the same commit has finished successfully. GitHub Pages likewise must publish the new JS. The two sides remain backwards compatible if one deployment finishes later.

Page: `https://xintes.github.io/webar-ruins/track/`
API: `https://webar-ruins.onrender.com/api/health`

If the phone uses a cached script, reload the page or open a fresh private tab. Keep the Render base URL selected in the API field.

## How to evaluate honestly

- Point the phone at the tower on the monitor, wait for capture, then move away and return to the same viewpoint. Note the time from returning to the first valid detection.
- Test slow panning and deliberate loss of the tower. There must be **no instant false wall** on a different object.
- Compare status messages: `быстрый поиск` vs `полный поиск`, number of matches, server processing milliseconds, estimated wait outside OpenCV.
- A free Render instance may be CPU-throttled or cold-start. This patch cannot guarantee sub-second server responses or continuous 6DoF tracking.
- The scene is still a **2D warped PNG**, not yet a spatially stable GLB anchor. In v1.4, the model isn't "baked" into a world map; see `server/viewpoints.example.json` for the future observation-zone data contract.

## Fixed observation zones — intended next stage

For a real tower, record the viewing area, distance to the tower, approximate viewing direction, camera height range, camera intrinsics when available, and 3D reference points on the landmark. Build the historical GLB **once**, aligned with those measured coordinates. After initial localization, keep the GLB in the scene, update the virtual camera locally and use the server only for occasional drift correction/reacquisition.

**Distance alone does not determine a full 3D pose.** A known distance plus image features helps, but the camera direction/orientation and reference geometry are still needed. Without local motion tracking, a wall cannot stay spatially fixed after the landmark leaves the camera frame.

## Testing

From the project root with dependencies installed:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests\test_tracking_v14.py
```

(Tests use FastAPI TestClient and httpx; install those tools separately for development if missing.)

Also check JavaScript syntax with `node --check track/main.js` if Node.js is installed.
