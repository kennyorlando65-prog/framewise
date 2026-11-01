# Framewise

A camera that coaches you while you shoot. Level, steadiness, exposure and framing are
checked live on your phone, and the app tells you the single worst problem in the frame —
one instruction at a time.

**This is a photo app.** There is no video recording, no `MediaRecorder`, no video export.
The camera feed is a viewfinder only; the single output is one JPEG still.

Static site. No backend, no database, no API keys, no environment variables.

---

## Saving a photo

Saving has three routes, tried best-first, and **every route ends in a visible message** —
the app never silently does nothing.

| Route | When it is used | What you see |
|---|---|---|
| Share sheet | `navigator.canShare({files})` is true (iOS Safari, Android Chrome) | "Shared — choose Save Image to keep it" |
| Download | No share support (desktop, some Android) | "Download started — check your Downloads" |
| Long-press sheet | iOS Safari without share support | A full-size image + "Long-press → Save to Photos" |

**On Android:** tap **Save photo** → the share sheet opens → choose **Save Image** (or
Photos/Files). The photo lands in your gallery.

**On iPhone:** tap **Save photo** → share sheet → **Save Image**. It goes to Photos.
If the share sheet is unavailable, a full-size image opens — long-press it and choose
**Save to Photos**.

**Cancelling the share sheet is not an error.** It shows "Cancelled — nothing was saved"
and the photo stays in the app.

### Recent shots — the safety net

Every capture is written to **IndexedDB before the review screen paints**, so the photo
survives a failed save, a dismissed share sheet, a reload or a crash. The last 12 shots
appear in a strip on the review screen; tap any thumbnail to save it again.

---

## Files

```
index.html      markup + all CSS (colour tokens at the top of <style>)
app.js          camera, sensors, histogram, MediaPipe, effects pipeline, capture, save
manifest.json   PWA manifest
sw.js           offline app shell (never caches the AI models)
icons/          192, 512, maskable 512, apple-touch
AUDIT.md        the code audit: bugs found, before/after, measurements
```

---

## Run locally

Camera needs a secure context. `localhost` counts, `file://` does not.

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` by double-clicking will show the "Camera needs HTTPS" screen — that
is the app working as designed, not a bug.

---

## Deploy to Vercel

Zero config. No build step, no framework preset, no environment variables.

**Import the repo:** [vercel.com/new](https://vercel.com/new) → Import Git Repository →
`kennyorlando65-prog/framewise` → Framework preset **Other**, build command **none**,
output directory **blank** → Deploy.

**Or drag-and-drop:** drag this folder onto [vercel.com/new](https://vercel.com/new).
`index.html` must be at the root of what you upload.

**Or CLI:** `npx vercel --prod` from inside this folder.

Then **open the `https://` URL on your phone**. The camera will not work on a local file.

---

## Browser support and caveats

- **Camera requires HTTPS.** `getUserMedia` is blocked on insecure origins. Deployed
  Vercel URL or `localhost` only.
- **iOS motion permission needs a user gesture.** `DeviceOrientationEvent.requestPermission()`
  must be called from a tap. Framewise chains it off the Start button. If the prompt is
  dismissed, the level line and stability meter stay inactive and the app still shoots.
- **MediaPipe needs WebGL.** The face landmarker and selfie segmenter load from a CDN and
  run on the GPU delegate. If WebGL is unavailable or the CDN is blocked, the app degrades
  to sensor-only coaching, shows "AI coach off", and disables the Portrait toggle with a
  visible reason.
- **Portrait/bokeh is a segmentation effect, not depth.** See limitations below.

---

## Known limitations

**Portrait mode is a mask, not a lens.** A real lens blurs by depth — every point gets a
blur radius proportional to its true distance from the focal plane. Framewise blurs by a
2D outline guessing which pixels are "person". Consequences: hair edges show a halo or a
hard fringe, glasses are often half-masked, thin objects (a raised hand, a plant stem) get
clipped at the mask edge, and two people at different distances get identical blur. It is
convincing on a clean single subject against a distinct background and unconvincing the
moment hair, glasses or a cluttered edge enters the frame.

**Segmentation is expensive.** On a CPU-only path one pass costs seconds. The app throttles
the mask to ~12fps, blurs the background at quarter resolution, and drops to a 480p
low-power viewfinder when a single pass exceeds 900ms. Measure the real FPS on your target
phone before relying on the effect.

**Sharpness scoring is uncalibrated.** The Laplacian variance implementation is correct and
ranks shots sensibly, but the normaliser is a guess — the absolute number is not meaningful.

**Composition only scores when a face is found.** No face means `n/a`, not an invented
number. Framewise is a portrait coach, not a general photo coach.

**The coach shows one problem at a time by design.** The priority order (exposure > level >
stability > framing) is a judgement call, not a tested one. "Too bright behind" will
dominate many scenes and can mask a tilted horizon.

**No sun mode.** The UI is dark, which is right for the preview and wrong at noon outdoors.

---

## Licence

MIT — see [LICENSE](LICENSE).
