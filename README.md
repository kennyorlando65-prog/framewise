# Framewise

A camera that coaches you while you shoot. Level, steadiness, exposure and framing are
checked live on your phone, and the app tells you the single worst problem in the frame —
one instruction at a time.

**Framewise is a photo app.** There is no video recording, no video export and no record
button. The camera feed is a viewfinder; the only output is one still JPEG.

Static site. No backend, no database, no API keys, no environment variables.

---

## What it does

**Live coaching** — one instruction at a time, never a wall of warnings:

- **Level** — device roll, with a horizon bar that turns green within 1°
- **Stability** — accelerometer variance over a rolling 1.2s window, shown as a ring
  around the shutter; auto-capture fires after 600ms steady
- **Exposure** — luminance histogram sampled from the frame; catches blown highlights and
  crushed shadows
- **Framing** — rule-of-thirds grid, plus face position and size
- **Subject vs background light** — the real lighting coach: "Background is 2.1 stops
  brighter than your subject"
- **Golden hour** — SunCalc + geolocation, in a corner chip. Hidden silently if denied.

**Portrait / bokeh** — Off / Portrait / Studio, using the selfie segmentation mask:

- background blurred at 1/4 resolution then upscaled, subject composited back sharp
- mask alpha feathered so the cutout edge is not a razor line
- **auto strength** — closer subject (larger face in frame) means stronger blur, the way a
  real fast lens behaves
- **baked into the saved file**, not just the preview: the viewfinder and the capture call
  the same `drawComposed()` function

**Adjustments** — exposure, contrast and warmth sliders, applied through the same canvas
pipeline (so they are real, not CSS overlays pretending to be camera effects).

**Capture** — shutter, post-shot critique (level / sharpness / exposure / composition),
one thing to fix, then save via the share sheet or a download.

---

## Run it locally

The camera needs a secure origin. `localhost` counts.

```bash
cd framewise
python3 -m http.server 8000
# open http://localhost:8000
```

Do **not** open `index.html` by double-clicking it — `file://` is not a secure origin and
the browser will refuse the camera. The app detects this and tells you so.

---

## Deploy to Vercel

Zero config. No build step, no framework, no environment variables.

**From the dashboard:** go to [vercel.com/new](https://vercel.com/new), drag this folder
onto the page, Deploy.

**From the CLI:**
```bash
npx vercel --prod
```

**From GitHub:** import the repo at [vercel.com/new](https://vercel.com/new) and accept the
defaults — Vercel detects a static site and serves it as-is.

⚠️ **The camera only works on the deployed HTTPS URL.** Open the Vercel URL on your phone,
not a local file.

---

## Browser support and caveats

| Requirement | Why |
|---|---|
| **HTTPS** | `getUserMedia` is blocked on insecure origins. `localhost` is exempt. |
| **A user gesture for iOS motion** | iOS 13+ requires `DeviceOrientationEvent.requestPermission()` to be called from a tap. Framewise chains it off the Start button. |
| **WebGL for MediaPipe** | The face landmarker and segmenter need WebGL. Without it the AI coach reports "off" and the app falls back to sensor-only coaching. |
| **`navigator.share` for the gallery** | On iOS/Android the share sheet → "Save Image" is how a photo reaches the gallery. Without it, the app downloads the file instead. |

If MediaPipe cannot load (offline, blocked CDN, old browser) the app **still works** — it
coaches on sensors alone and the Portrait toggle is disabled with a visible reason.

---

## Known limitations

**The bokeh is a guess, not a depth measurement.** A real lens blurs by optical depth. This
blurs by a segmentation mask, which is a 2D outline. Consequences:

- **Hair edges** will show a halo or a hard fringe — the mask cannot resolve individual
  strands
- **Glasses** often get partially masked, so the frames can stay sharp while the face
  behind them blurs, or vice versa
- **Thin objects** (a raised hand, a phone, a plant stem) may be cut off or blurred
- **Two people at different distances** get the same blur — there is no depth ordering
- The effect is strongest on a clean, well-lit, single subject against a distinct background

**Performance is the real risk.** Segmentation is the expensive part. The pipeline is built
to survive a slow device (720p viewfinder, quarter-res blur, ~12fps mask, automatic
low-power fallback), but the effect is genuinely heavy. On a low-end Android expect the
low-power path to engage.

**Sharpness scoring is uncalibrated.** The Laplacian variance implementation is correct,
but the normaliser (`/24`) is a guess. It will rank a sharp shot above a soft one; the
absolute number is not meaningful yet.

**Composition is only scored when a face is detected.** No face means `n/a`, not a made-up
number. Framewise is a portrait coach, not a general photo coach.

**The coach sees one problem at a time by design.** The priority order (exposure > level >
stability > framing) is a judgement call, not a tested one. "Too bright behind" will
dominate many scenes and can mask a tilted horizon.

**No sun mode.** The UI is dark, which is right for the preview and wrong at noon outdoors.

---

## Files

```
index.html      markup + all CSS (colour tokens at the top of <style>)
app.js          camera, sensors, histogram, MediaPipe, effects pipeline, capture
manifest.json   PWA manifest
sw.js           offline app shell (never caches the AI models)
icons/          192, 512, maskable 512, apple-touch
AUDIT.md        the code audit: bugs found, before/after, measurements
```

---

## Licence

MIT — see [LICENSE](LICENSE).
