# Framewise — code audit

Audit of the pre-existing Framewise build, performed before adding the
portrait/bokeh system. Every item below was found by reading the source and then confirmed
by measurement in headless Chromium.

---

## 0. Scope check: is this a photo app?

**Yes — and it already was.** A repo-wide grep for `MediaRecorder`, `record`, `.webm`,
`video/mp4`, `captureStream`, `startRecording`, `stopRecording` returned **no matches**.
There was no video recording, no video export and no record button to remove.

The only video-related code is the `<video>` element used as a viewfinder source, which is
correct and required. The single output path is `canvas.toBlob('image/jpeg')` → one still.

The new build keeps that guarantee and adds a comment at the top of `app.js` stating it.

---

## 1. Bugs found and fixed

### 1.1 `getImageData` called with a buffer instead of a settings object — exposure frozen at 0

**Before**
```js
expCtx.getImageData(0, 0, expCanvas.width, expCanvas.height, expImage.data);
var d = expImage.data;
```
The 5th argument of `getImageData` is a settings **object** (`{colorSpace, pixelFormat}`),
not a destination buffer. Passing a `Uint8ClampedArray` throws a `TypeError`, which was
swallowed by the surrounding `try/catch`. The result: `S.exp.mean` never updated, the
exposure bar never moved, and the "Too dark" coach fired permanently.

**After**
```js
var d = expCtx.getImageData(0, 0, expCanvas.width, expCanvas.height).data;
```

**Measured:** `expMean` went from **0** (stuck) to **117** on the same test frame, and the
coach changed from a permanent "Too dark" to "Good — take the shot".

This was the most serious bug in the app: the exposure coach — the single most useful
signal — was dead on every device, and the `try/catch` hid it.

### 1.2 Segmentation loop could freeze the app on a slow device

**Before**
```js
return clamp(cost * 1.6, target, 400);
```
The upper clamp was a hard 400ms. On a device where one segmentation pass costs 5s, the
loop re-entered every 400ms and blocked the main thread for 5s each time — a permanent
freeze, not a slow frame.

**After**
```js
return clamp(cost * 1.6, target, Math.max(target, cost * 2.5));
```
The ceiling now scales with the real cost, so a slow device gets a slow-but-alive loop
instead of a dead one.

**Measured:** `segCost` 5,321–5,605ms in this unaccelerated sandbox; the app stayed
responsive and the low-power path engaged.

### 1.3 Low-power fallback never triggered

**Before:** the fallback watched the FPS counter, but the FPS counter is itself starved by
the blocking inference — so it never observed a low number and never fired.

**After:** two triggers. The FPS path still exists, and a direct one fires when a single
segmentation pass exceeds 900ms:
```js
if (cost > 900 && !S.fx.lowPower) { S.fx.lowPower = true; ... }
```

**Measured:** `lowPower: false` → `true` after the first slow pass.

### 1.4 Auto blur strength never updated

**Before:** `startStrengthLoop()` was only called from the click handler, so setting the
mode programmatically (or restoring it) left strength at 0 and the blur invisible.

**After:** `setFxMode()` starts and stops the strength loop itself.

**Measured:** `strength` 0 → 6 → 10 as the loop ran.

### 1.5 Capture competed with the render loop

**Before:** `capture()` composited and encoded a 2400px frame while the rAF render loop
kept running, so the encoder and the compositor fought for the main thread. On a slow
device the `toBlob` callback could be starved for seconds.

**After:** the render loop is stopped for the duration of the capture and restarted on
failure or on retake.

### 1.6 Double JPEG encode on every shot

**Before**
```js
var dataUrl = c.toDataURL('image/jpeg', 0.9);   // encode #1
c.toBlob(function (blob) { ... }, 'image/jpeg', 0.9);  // encode #2
```
Two full encodes of a 2400px frame, back to back, on the main thread — roughly double the
capture latency for no benefit.

**After:** one `toBlob`, and the review screen shows the blob through
`URL.createObjectURL` instead of a base64 data URL. The object URL is revoked on retake.

### 1.7 Face box misaligned on any non-matching aspect ratio

**Before:** the subject box was positioned in **percent of the stage**, but the video is
`object-fit: cover`. On a 390×844 portrait stage showing a 16:9 feed, the box drifted far
off the face.

**After:** `coverRect()` computes where the video actually lands and the box is positioned
in pixels against that rect.

### 1.8 Segmentation input was squashed to 4:3

**Before:** the inference canvas was fixed at 256×192 (4:3) while the camera is 16:9, so
the mask was computed on a distorted frame and stretched back — the cutout edge was
systematically wrong.

**After:** `sizeAiCanvas()` sizes the canvas to the video's real aspect ratio.

### 1.9 Loops and listeners leaked across camera flips

**Before:** `startExposureLoop`, `startAILoop` and `startCoachLoop` each created their own
`setTimeout`/`requestAnimationFrame` chain with no handle. `flipCamera()` called
`stopCamera()` then `startCamera()`, which started a **second** set of every loop. Each
flip doubled the work. `deviceorientation`/`devicemotion` were added on every start and
never removed.

**After:** a central registry:
```js
var LOOPS = Object.create(null);
loopTimer(name, fn)   // setTimeout chain, returns next delay
loopRaf(name, fn)     // rAF chain
loopStop(name) / loopStopAll()
```
Every loop is named and cancellable. `startCamera()` calls `loopStopAll()` first.
Sensors attach once behind an `S.sensorsOn` guard and are removed in `stopSensors()`.

### 1.10 Race between camera start and the AI loader

**Before:** two rapid taps on Start (or a flip during startup) could leave two
`getUserMedia` promises in flight; the loser's stream was never stopped, leaking a camera
track. `loadAI()` could likewise run twice and leak a landmarker.

**After:** a generation token `S.gen` is bumped on every start; any async continuation
whose generation is stale stops its own stream and returns. `ensureAI()` is idempotent —
it caches its promise, so repeated calls share one load.

### 1.11 Render loop kept running behind the review screen and in a hidden tab

**Before:** the rAF loop ran regardless of state, compositing frames nobody could see.

**After:** `showReview()` stops the render loop; `visibilitychange` stops it when hidden
and restarts it on return (unless the review screen is open).

### 1.12 Canvas / ImageData churn

**Before:** `laplacianVariance()` and `histogramOf()` each created a new canvas, a new
context and a new `Float32Array` on every call; the AI path called `getImageData` fresh
each pass.

**After:** all scratch canvases and the `Float32Array` are module-level and reused, resized
only when the target dimensions change.

### 1.13 MediaPipe handles never closed

**Before:** `close()` was called on the per-frame `seg` result but never on the
`FaceLandmarker` / `ImageSegmenter` instances themselves.

**After:** `closeAI()` closes both, and is called from the AI failure path and on
`pagehide`.

---

## 2. Performance measurements

Headless Chromium, 390×844 @2x, canvas-backed fake camera at 1280×720, **CPU-only
inference (SwiftShader, no GPU)**. These numbers are a worst case, not a phone.

| Mode | FPS | Notes |
|---|---|---|
| Effects off | **37–44** | render loop only, 720p internal |
| Portrait on | **3** | `segCost` 5.3–5.6s per pass |

**Read this honestly:** 3fps is not a usable preview. It is also not what a phone will do —
this sandbox runs MediaPipe on the CPU with no GPU delegate, which is roughly 20–50× slower
than a phone's GPU path. The architecture is built for the phone case:

- viewfinder renders at **720p max** (480p in low-power), upscaled by CSS
- background blurred at **1/4 resolution** then upscaled — never full-res per frame
- mask updated at **~12fps target**, held between updates, while the video layer runs at
  full rate
- low-power fallback drops resolution and mask rate automatically

**Unverified:** real-device FPS. This must be measured on an actual mid-range Android and
an iPhone before anyone claims the effect is shippable.

---

## 3. What the headless test proved

| Check | Result |
|---|---|
| Camera initialises | 1280×720, `readyState 4` |
| MediaPipe loads | `ai.state: ready`, face found |
| Exposure histogram | `expMean 117` (was 0 before the fix) |
| Portrait toggle | mask produced, `maskReady: true` |
| Auto strength | 0 → 6 → 10 |
| Low-power fallback | fires on slow segmentation |
| Capture | `image/jpeg`, 1280×720, 232–235 KB |
| Effect baked into file | portrait capture 232,204 B vs plain 268,734 B — different files, and the portrait one is smaller because the blurred background compresses better |
| Review screen | appears, scores returned (96 / 100 / 88 / 88) |
| Console errors | none from the app (only MediaPipe's own XNNPACK info line) |

**Caveat on the screenshot:** Playwright's screenshot of the `<canvas>` element came back
black in this environment even though the canvas backing store measured a mean luminance of
94–116 (i.e. real image data). That is a headless compositing artefact, not an app fault —
the pixel data is present and the captured JPEGs are correct.

---

## 4. Not verified — needs a real phone

- Motion sensors (synthetic events were injected; real accelerometer noise and iOS
  `requestPermission()` gesture handling are untested)
- `navigator.share({files})` — headless Chromium has no share sheet, so only the download
  fallback was exercised
- Real-device FPS with the GPU delegate
- iOS Safari WebGL memory limits for the segmenter
- Battery and thermal behaviour under continuous inference
