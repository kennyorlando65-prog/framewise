/* Framewise — a still-photo coach. No backend, no keys, everything on-device.
 *
 * This is a PHOTO app. There is no recording, no MediaRecorder, no video export.
 * The camera feed is a viewfinder only; the single output is one JPEG still.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    stage: $('stage'), video: $('video'), view: $('view'), grid: $('grid'),
    level: $('level'), levelBar: $('levelBar'),
    subjectBox: $('subjectBox'),
    exposure: $('exposure'), expFill: $('expFill'), expClip: $('expClip'), expCrush: $('expCrush'),
    aiChip: $('aiChip'), aiText: $('aiText'),
    sunChip: $('sunChip'), sunText: $('sunText'),
    coach: $('coach'), coachText: $('coachText'), coachSub: $('coachSub'),
    shutter: $('shutter'), stabProg: $('stabProg'),
    flipBtn: $('flipBtn'), timerBtn: $('timerBtn'), adjustBtn: $('adjustBtn'),
    fxBar: $('fxBar'), fxNote: $('fxNote'),
    adjust: $('adjust'), adjustClose: $('adjustClose'),
    expSlider: $('expSlider'), conSlider: $('conSlider'), warmSlider: $('warmSlider'),
    expVal: $('expVal'), conVal: $('conVal'), warmVal: $('warmVal'),
    countdown: $('countdown'), countdownNum: $('countdownNum'),
    flash: $('flash'), toast: $('toast'),
    permScreen: $('permScreen'), permTitle: $('permTitle'), permBody: $('permBody'),
    permHint: $('permHint'), startBtn: $('startBtn'), retryBtn: $('retryBtn'),
    reviewScreen: $('reviewScreen'), shotImg: $('shotImg'), reviewTime: $('reviewTime'),
    fixText: $('fixText'), retakeBtn: $('retakeBtn'), saveBtn: $('saveBtn'), saveNote: $('saveNote')
  };

  var S = {
    stream: null, facing: 'environment', running: false,
    gen: 0,                       // bumped on every camera start; stale async work bails
    roll: 0, rollValid: false,
    stability: 0, stableSince: 0,
    exp: { mean: 128, clip: 0, crush: 0, valid: false },
    face: null, seg: null,
    ai: { state: 'idle', face: null, seg: null, promise: null, segCost: 0, faceCost: 0 },
    autoCapture: false, counting: false,
    lastShot: null, lastBlob: null,
    currentCoach: null, coachChangedAt: 0,
    motionBuf: [], lastMotionAt: 0, motionSeen: false,
    wakeLock: null, sunTimer: null,
    sensorsOn: false,
    fps: 0, fpsFrames: 0, fpsSince: 0,
    fx: {
      mode: 'off',          // off | portrait | studio
      auto: true,
      strength: 0,          // 0..1, derived from face size when auto
      exposure: 0,          // -50..50
      contrast: 0,          // -50..50
      warmth: 0,            // -50..50
      lowPower: false,
      maskReady: false
    }
  };

  /* ---------------------------------------------------------------- utils */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  var toastTimer = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('on'); }, ms || 2600);
  }

  /* ------------------------------------------------------- loop registry
   * Every repeating timer and rAF lives here so teardown is one call and
   * nothing can survive a camera flip, a retake or a backgrounded tab.
   */
  var LOOPS = Object.create(null);

  function loopStop(name) {
    var l = LOOPS[name];
    if (!l) return;
    if (l.raf) cancelAnimationFrame(l.raf);
    if (l.timer) clearTimeout(l.timer);
    delete LOOPS[name];
  }

  function loopStopAll() {
    Object.keys(LOOPS).forEach(loopStop);
  }

  // setTimeout chain. fn returns the delay for the next tick, or false to stop.
  function loopTimer(name, fn, firstDelay) {
    loopStop(name);
    var gen = S.gen;
    var rec = { timer: null };
    LOOPS[name] = rec;
    function tick() {
      if (S.gen !== gen || LOOPS[name] !== rec) return;   // stale generation
      var next;
      try { next = fn(); } catch (e) { next = 500; }
      if (next === false) { loopStop(name); return; }
      rec.timer = setTimeout(tick, next || 100);
    }
    rec.timer = setTimeout(tick, firstDelay || 0);
  }

  function loopRaf(name, fn) {
    loopStop(name);
    var gen = S.gen;
    var rec = { raf: null };
    LOOPS[name] = rec;
    function tick(ts) {
      if (S.gen !== gen || LOOPS[name] !== rec) return;
      try { fn(ts); } catch (e) { /* never let one bad frame kill the loop */ }
      rec.raf = requestAnimationFrame(tick);
    }
    rec.raf = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------- camera */
  function isSecure() {
    return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function showPerm(title, body, hint, showRetry) {
    el.permTitle.textContent = title;
    el.permBody.innerHTML = body;
    el.permHint.innerHTML = hint || '';
    el.permScreen.classList.add('on');
    el.startBtn.hidden = !!showRetry;
    el.retryBtn.hidden = !showRetry;
  }

  function hidePerm() { el.permScreen.classList.remove('on'); }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showPerm('Camera needs HTTPS',
        'This browser will not give a page access to the camera over an insecure connection. Open Framewise on its <code>https://</code> address — a deployed Vercel URL or <code>localhost</code> — not a local file.',
        'If you opened this by double-clicking <code>index.html</code>, that is the cause.', true);
      return;
    }
    if (!isSecure()) {
      showPerm('Camera needs HTTPS',
        'You are on an insecure origin, so the browser blocks the camera. Use the deployed <code>https://</code> URL.', '', true);
      return;
    }

    // Any in-flight start is now obsolete.
    var gen = ++S.gen;
    loopStopAll();
    stopStream();

    el.startBtn.disabled = true;
    el.startBtn.textContent = 'Starting…';

    var constraints = {
      audio: false,
      video: {
        facingMode: { ideal: S.facing },
        width: { ideal: 1920 }, height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
      }
    };

    navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      if (gen !== S.gen) {                       // a newer start won the race
        stream.getTracks().forEach(function (t) { t.stop(); });
        return null;
      }
      S.stream = stream;
      el.video.srcObject = stream;
      el.video.setAttribute('playsinline', '');
      return el.video.play().catch(function () { /* muted autoplay, usually fine */ }).then(function () {
        return stream;
      });
    }).then(function (stream) {
      if (!stream || gen !== S.gen) return;
      hidePerm();
      el.startBtn.disabled = false;
      el.startBtn.textContent = 'Start camera';
      S.running = true;
      el.stage.classList.toggle('mirrored', S.facing === 'user');
      el.grid.classList.add('on');
      el.level.classList.add('on');
      el.exposure.classList.add('on');

      requestWakeLock();
      startSensors();
      startExposureLoop();
      startRenderLoop();
      startCoachLoop();
      ensureAI();
      initSun();
      setCoach({ id: 'boot', text: 'Hold steady', sub: 'Reading the scene', tone: 'warn', sev: 0.5 });
    }).catch(function (err) {
      if (gen !== S.gen) return;
      el.startBtn.disabled = false;
      el.startBtn.textContent = 'Start camera';
      var name = (err && err.name) || 'Error';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        showPerm('Camera blocked',
          'You denied camera access, or the browser remembered an earlier denial. Framewise cannot coach a photo it cannot see.',
          'On iPhone: Settings → Safari → Camera → Allow. On Android Chrome: tap the padlock in the address bar → Permissions → Camera.', true);
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        showPerm('No camera found',
          'This device did not report a usable camera. If you are on a desktop, plug one in or open Framewise on your phone.', '', true);
      } else if (name === 'NotReadableError') {
        showPerm('Camera is busy',
          'Another app or tab is holding the camera. Close it and try again.', '', true);
      } else {
        showPerm('Camera did not start',
          'The browser refused the request: <code>' + name + '</code>.', 'Try reloading the page.', true);
      }
    });
  }

  function stopStream() {
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { t.stop(); });
      S.stream = null;
    }
    if (el.video.srcObject) el.video.srcObject = null;
    S.running = false;
  }

  function stopCamera() {
    S.gen++;
    loopStopAll();
    stopStream();
    S.fx.maskReady = false;
  }

  function flipCamera() {
    S.facing = S.facing === 'environment' ? 'user' : 'environment';
    el.flipBtn.setAttribute('aria-pressed', S.facing === 'user' ? 'true' : 'false');
    startCamera();          // startCamera tears down the old stream itself
  }

  /* ------------------------------------------------------------ wake lock */
  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      S.wakeLock = lock;
      lock.addEventListener('release', function () { S.wakeLock = null; });
    }).catch(function () { /* not fatal */ });
  }

  /* ------------------------------------------------------------- sensors */
  function startSensors() {
    if (S.sensorsOn) return;                 // attach once, never twice
    var DOE = window.DeviceOrientationEvent;
    var DME = window.DeviceMotionEvent;
    var needOrient = DOE && typeof DOE.requestPermission === 'function';
    var needMotion = DME && typeof DME.requestPermission === 'function';

    var chain = Promise.resolve();
    if (needOrient) chain = chain.then(function () { return DOE.requestPermission(); }).catch(function () { return 'denied'; });
    if (needMotion) chain = chain.then(function () { return DME.requestPermission(); }).catch(function () { return 'denied'; });

    chain.then(function () {
      if (S.sensorsOn) return;
      window.addEventListener('deviceorientation', onOrientation, true);
      window.addEventListener('devicemotion', onMotion, true);
      S.sensorsOn = true;
    });
  }

  function stopSensors() {
    if (!S.sensorsOn) return;
    window.removeEventListener('deviceorientation', onOrientation, true);
    window.removeEventListener('devicemotion', onMotion, true);
    S.sensorsOn = false;
  }

  function onOrientation(e) {
    var angle = 0;
    if (screen.orientation && typeof screen.orientation.angle === 'number') angle = screen.orientation.angle;
    else if (typeof window.orientation === 'number') angle = window.orientation;

    var roll;
    if (angle === 90) roll = -e.beta;
    else if (angle === -90 || angle === 270) roll = e.beta;
    else roll = e.gamma;

    if (roll === null || roll === undefined || !isFinite(roll)) { S.rollValid = false; return; }
    S.rollValid = true;
    S.roll = lerp(S.roll, roll, 0.35);

    var locked = Math.abs(S.roll) <= 1;
    el.level.classList.toggle('locked', locked);
    el.levelBar.style.transform = 'rotate(' + (-S.roll).toFixed(2) + 'deg)';
  }

  function onMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a || a.x === null) return;
    var now = performance.now();
    if (now - S.lastMotionAt < 40) return;
    S.lastMotionAt = now;

    var mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    S.motionBuf.push({ t: now, v: mag });
    // Time-based window: a count-based buffer never fills on a slow device.
    while (S.motionBuf.length && now - S.motionBuf[0].t > 1200) S.motionBuf.shift();
    if (S.motionBuf.length > 40) S.motionBuf.shift();
    if (S.motionBuf.length < 3) return;

    var mean = 0, i;
    for (i = 0; i < S.motionBuf.length; i++) mean += S.motionBuf[i].v;
    mean /= S.motionBuf.length;
    var varr = 0;
    for (i = 0; i < S.motionBuf.length; i++) { var d = S.motionBuf[i].v - mean; varr += d * d; }
    varr /= S.motionBuf.length;

    var sd = Math.sqrt(varr);
    var score = clamp(1 - (sd - 0.06) / 0.9, 0, 1);
    S.stability = lerp(S.stability, score, 0.3);
    S.motionSeen = true;

    var dash = 264;
    el.stabProg.style.strokeDashoffset = String(dash - dash * S.stability);
    el.stabProg.style.stroke = S.stability > 0.82 ? 'var(--green)' : S.stability > 0.5 ? 'var(--amber)' : 'var(--red)';

    if (S.stability > 0.85) {
      if (!S.stableSince) S.stableSince = now;
      if (S.autoCapture && !S.counting && now - S.stableSince > 600) beginCountdown();
    } else {
      S.stableSince = 0;
    }
  }

  /* ------------------------------------------------------------ exposure */
  // Allocated once. Reallocating ImageData every frame is the classic churn bug.
  var expCanvas = document.createElement('canvas');
  expCanvas.width = 80; expCanvas.height = 60;
  var expCtx = expCanvas.getContext('2d', { willReadFrequently: true });
  var expImage = expCtx.createImageData(80, 60);

  function startExposureLoop() {
    loopTimer('exposure', function () {
      if (!S.running) return 400;
      if (el.video.readyState >= 2 && el.video.videoWidth) {
        try {
          expCtx.drawImage(el.video, 0, 0, expCanvas.width, expCanvas.height);
          // NOTE: getImageData's 5th arg is a settings OBJECT, not a buffer.
          // Passing a Uint8ClampedArray there throws, which silently left the
          // exposure reading stuck at 0 forever.
          var d = expCtx.getImageData(0, 0, expCanvas.width, expCanvas.height).data;
          var n = d.length / 4, sum = 0, clip = 0, crush = 0;
          for (var i = 0; i < d.length; i += 4) {
            var y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            sum += y;
            if (y >= 250) clip++;
            if (y <= 8) crush++;
          }
          S.exp.mean = sum / n;
          S.exp.clip = clip / n;
          S.exp.crush = crush / n;
          S.exp.valid = true;
          paintExposure();
        } catch (err) { /* frame not ready */ }
      }
      return 180;
    });
  }

  function paintExposure() {
    var m = S.exp.mean;
    el.expFill.style.height = clamp((m / 255) * 100, 2, 100) + '%';
    el.expFill.style.background = (m > 200 || m < 55) ? 'var(--amber)' : 'var(--green)';
    el.expClip.style.height = clamp(S.exp.clip * 100 * 3, 0, 100) + '%';
    el.expCrush.style.height = clamp(S.exp.crush * 100 * 3, 0, 100) + '%';
  }

  /* ------------------------------------------------------------- framing */
  function thirdsDistance(x, y) {
    var pts = [[1 / 3, 1 / 3], [2 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 2 / 3]];
    var best = 9;
    for (var i = 0; i < pts.length; i++) {
      var dx = x - pts[i][0], dy = y - pts[i][1];
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
    }
    return best;
  }

  // Where the video actually lands inside the stage under object-fit:cover.
  function coverRect(vw, vh, cw, ch) {
    var s = Math.max(cw / vw, ch / vh);
    var w = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h };
  }

  /* ------------------------------------------------------------ MediaPipe */
  function setAI(state, text) {
    S.ai.state = state;
    el.aiChip.setAttribute('data-state', state);
    el.aiText.textContent = text;
    if (state === 'off') {
      // Portrait needs a mask. Say why instead of leaving a dead button.
      setFxMode('off', true);
      el.fxNote.textContent = 'Portrait needs the AI coach — unavailable on this connection or browser.';
      el.fxNote.hidden = false;
      Array.prototype.forEach.call(el.fxBar.querySelectorAll('.fxseg'), function (b) {
        if (b.dataset.fx !== 'off') { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
      });
    } else if (state === 'ready') {
      el.fxNote.hidden = true;
      Array.prototype.forEach.call(el.fxBar.querySelectorAll('.fxseg'), function (b) {
        b.disabled = false; b.removeAttribute('aria-disabled');
      });
    }
  }

  // Idempotent: repeated calls share one promise, so a flip cannot start a
  // second model load or leak a second landmarker.
  function ensureAI() {
    if (S.ai.state === 'ready' || S.ai.state === 'off') return Promise.resolve();
    if (S.ai.promise) return S.ai.promise;

    setAI('loading', 'AI coach loading…');
    var base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
    var wasm = base + '/wasm';

    S.ai.promise = import(base + '/vision_bundle.mjs').then(function (vision) {
      return vision.FilesetResolver.forVisionTasks(wasm).then(function (fileset) {
        return vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'IMAGE',
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true
        }).then(function (fl) {
          S.ai.face = fl;
          return vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
              delegate: 'GPU'
            },
            runningMode: 'IMAGE',
            outputCategoryMask: true,
            outputConfidenceMasks: false
          });
        }).then(function (seg) {
          S.ai.seg = seg;
          setAI('ready', 'AI coach ready');
          startFaceLoop();
          startSegLoop();
        });
      });
    }).catch(function () {
      setAI('off', 'AI coach off');
      closeAI();
      toast('AI coach unavailable — coaching on sensors only', 3400);
    });

    return S.ai.promise;
  }

  function closeAI() {
    try { if (S.ai.face && S.ai.face.close) S.ai.face.close(); } catch (e) {}
    try { if (S.ai.seg && S.ai.seg.close) S.ai.seg.close(); } catch (e) {}
    S.ai.face = null;
    S.ai.seg = null;
  }

  // Shared scratch for inference input. Sized to the video aspect so the mask
  // is not squashed into a 4:3 box and then stretched back.
  var aiCanvas = document.createElement('canvas');
  aiCanvas.width = 256; aiCanvas.height = 144;
  var aiCtx = aiCanvas.getContext('2d', { willReadFrequently: true });

  function sizeAiCanvas() {
    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!vw || !vh) return;
    var w = 256, h = Math.max(1, Math.round(256 * vh / vw));
    if (aiCanvas.width !== w || aiCanvas.height !== h) {
      aiCanvas.width = w; aiCanvas.height = h;
    }
  }

  function startFaceLoop() {
    var interval = 400;
    loopTimer('face', function () {
      if (!S.running || !S.ai.face) return 500;
      if (el.video.readyState < 2 || !el.video.videoWidth) return 300;
      sizeAiCanvas();
      var t0 = performance.now();
      try { runFace(); } catch (e) { /* keep the loop alive */ }
      var cost = performance.now() - t0;
      S.ai.faceCost = cost;
      // Inference is synchronous and blocks the main thread, which starves the
      // motion handler. Keep the duty cycle under ~25% so sensors stay live.
      interval = clamp(cost * 4, 400, 2500);
      return interval;
    });
  }

  function runFace() {
    aiCtx.drawImage(el.video, 0, 0, aiCanvas.width, aiCanvas.height);
    var res = S.ai.face.detect(aiCanvas);
    if (res && res.faceLandmarks && res.faceLandmarks.length) {
      var lm = res.faceLandmarks[0];
      var minX = 1, maxX = 0, minY = 1, maxY = 0;
      for (var i = 0; i < lm.length; i++) {
        if (lm[i].x < minX) minX = lm[i].x;
        if (lm[i].x > maxX) maxX = lm[i].x;
        if (lm[i].y < minY) minY = lm[i].y;
        if (lm[i].y > maxY) maxY = lm[i].y;
      }
      var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      var w = maxX - minX, h = maxY - minY;

      var pitch = null;
      if (res.facialTransformationMatrixes && res.facialTransformationMatrixes.length) {
        var m = res.facialTransformationMatrixes[0].data;
        if (m && m.length >= 11) {
          var p = Math.asin(clamp(-m[9], -1, 1)) * 180 / Math.PI;
          if (isFinite(p) && Math.abs(p) < 80) pitch = p;
        }
      }

      S.face = { cx: cx, cy: cy, w: w, h: h, pitch: pitch, at: performance.now() };
      paintSubjectBox(minX, minY, w, h);
    } else {
      S.face = null;
      el.subjectBox.classList.remove('on');
    }
  }

  // The old code positioned the box in % of the stage, but the video is
  // object-fit:cover, so on any non-matching aspect the box drifted off the face.
  function paintSubjectBox(minX, minY, w, h) {
    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    var cw = el.stage.clientWidth, ch = el.stage.clientHeight;
    if (!vw || !vh || !cw || !ch) return;
    var r = coverRect(vw, vh, cw, ch);
    el.subjectBox.classList.add('on');
    el.subjectBox.style.left = (r.x + minX * r.w) + 'px';
    el.subjectBox.style.top = (r.y + minY * r.h) + 'px';
    el.subjectBox.style.width = (w * r.w) + 'px';
    el.subjectBox.style.height = (h * r.h) + 'px';
  }

  /* --------------------------------------------------- segmentation mask */
  var maskCanvas = document.createElement('canvas');   // raw alpha mask
  var maskCtx = maskCanvas.getContext('2d');
  var featherCanvas = document.createElement('canvas'); // blurred alpha
  var featherCtx = featherCanvas.getContext('2d');
  var maskImage = null;

  function startSegLoop() {
    loopTimer('seg', function () {
      if (!S.running || !S.ai.seg) return 500;
      if (el.video.readyState < 2 || !el.video.videoWidth) return 300;
      // No point burning inference on a mask nobody is compositing.
      if (S.fx.mode === 'off') return 400;

      sizeAiCanvas();
      var t0 = performance.now();
      try { runSeg(); } catch (e) { /* keep the loop alive */ }
      var cost = performance.now() - t0;
      S.ai.segCost = cost;

      // A single inference this slow means the device cannot afford the effect
      // at full quality. Drop to low-power immediately rather than waiting for
      // the FPS counter, which is itself starved by the blocking inference.
      if (cost > 900 && !S.fx.lowPower) {
        S.fx.lowPower = true;
        toast('Low-power mode — this device is slow at segmentation', 3600);
      }

      // Target ~12fps for the mask, but never let it eat the main thread.
      // The upper clamp must scale with the real cost: on a slow device a
      // 5s inference clamped to a 400ms interval freezes the whole app.
      var target = S.fx.lowPower ? 125 : 83;
      return clamp(cost * 1.6, target, Math.max(target, cost * 2.5));
    });
  }

  function runSeg() {
    aiCtx.drawImage(el.video, 0, 0, aiCanvas.width, aiCanvas.height);
    var seg = S.ai.seg.segment(aiCanvas);
    var mask = seg.categoryMask;
    if (!mask) { if (seg.close) seg.close(); return; }

    var mw = mask.width, mh = mask.height;
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
      maskCanvas.width = mw; maskCanvas.height = mh;
      featherCanvas.width = mw; featherCanvas.height = mh;
      maskImage = maskCtx.createImageData(mw, mh);
    }
    if (!maskImage) maskImage = maskCtx.createImageData(mw, mh);

    var md = mask.getAsUint8Array();
    var out = maskImage.data;
    for (var j = 0, px = 0; j < md.length; j++, px += 4) {
      out[px] = 255; out[px + 1] = 255; out[px + 2] = 255;
      out[px + 3] = md[j] ? 255 : 0;
    }
    maskCtx.putImageData(maskImage, 0, 0);

    // Feather the alpha so the cutout edge is not a razor line.
    featherCtx.clearRect(0, 0, mw, mh);
    featherCtx.filter = 'blur(2px)';
    featherCtx.drawImage(maskCanvas, 0, 0);
    featherCtx.filter = 'none';

    S.fx.maskReady = true;

    // Subject vs background luminance, from the same pass.
    var img = aiCtx.getImageData(0, 0, mw, mh).data;
    var sSum = 0, sN = 0, bSum = 0, bN = 0;
    for (var k = 0, p2 = 0; k < md.length; k++, p2 += 4) {
      var y2 = 0.2126 * img[p2] + 0.7152 * img[p2 + 1] + 0.0722 * img[p2 + 2];
      if (md[k] === 1) { sSum += y2; sN++; } else { bSum += y2; bN++; }
    }
    if (sN > 200 && bN > 200) {
      S.seg = { subject: sSum / sN, background: bSum / bN, at: performance.now() };
    } else { S.seg = null; }

    if (mask.close) mask.close();
    if (seg.close) seg.close();
  }

  /* ------------------------------------------------------ render pipeline
   * One function draws the frame, used by BOTH the live viewfinder and the
   * capture. That is the only way the saved JPEG can be guaranteed to match
   * what the user saw.
   */
  var gradeCanvas = document.createElement('canvas');
  var gradeCtx = gradeCanvas.getContext('2d');
  var bgCanvas = document.createElement('canvas');
  var bgCtx = bgCanvas.getContext('2d');
  var subjCanvas = document.createElement('canvas');
  var subjCtx = subjCanvas.getContext('2d');

  function gradeFilter(studio) {
    var b = 1 + S.fx.exposure / 100;                 // 0.5 .. 1.5
    var c = 1 + S.fx.contrast / 100;                 // 0.5 .. 1.5
    var w = S.fx.warmth / 100;                       // -1 .. 1
    var sep = Math.max(0, w) * 0.28;
    var hue = w * 9;
    var sat = 1 + Math.max(0, w) * 0.12;
    if (studio) { c *= 1.1; sat *= 1.06; }
    return 'brightness(' + b.toFixed(3) + ') contrast(' + c.toFixed(3) +
           ') saturate(' + sat.toFixed(3) + ') sepia(' + sep.toFixed(3) +
           ') hue-rotate(' + hue.toFixed(1) + 'deg)';
  }

  function blurPxFor(w, strength, studio) {
    // Blur is applied at 1/4 resolution, so this is ~4x the visible radius.
    var base = 1 + strength * 4.2;
    if (studio) base *= 1.55;
    return base * (w / 720);   // scale with output size so capture matches preview
  }

  function drawComposed(ctx, w, h, useMask) {
    var studio = S.fx.mode === 'studio';

    if (gradeCanvas.width !== w || gradeCanvas.height !== h) {
      gradeCanvas.width = w; gradeCanvas.height = h;
    }
    gradeCtx.filter = gradeFilter(studio);
    gradeCtx.drawImage(el.video, 0, 0, w, h);
    gradeCtx.filter = 'none';

    if (!useMask || !S.fx.maskReady) {
      ctx.drawImage(gradeCanvas, 0, 0);
      return;
    }

    // 1. blurred background, computed at quarter resolution then upscaled
    var bw = Math.max(1, Math.round(w / 4)), bh = Math.max(1, Math.round(h / 4));
    if (bgCanvas.width !== bw || bgCanvas.height !== bh) {
      bgCanvas.width = bw; bgCanvas.height = bh;
    }
    bgCtx.clearRect(0, 0, bw, bh);
    bgCtx.filter = 'blur(' + blurPxFor(w, S.fx.strength, studio).toFixed(2) + 'px)';
    bgCtx.drawImage(gradeCanvas, 0, 0, bw, bh);
    bgCtx.filter = 'none';
    ctx.drawImage(bgCanvas, 0, 0, w, h);

    // 2. sharp subject, masked by the feathered alpha
    if (subjCanvas.width !== w || subjCanvas.height !== h) {
      subjCanvas.width = w; subjCanvas.height = h;
    }
    subjCtx.globalCompositeOperation = 'source-over';
    subjCtx.clearRect(0, 0, w, h);
    subjCtx.drawImage(gradeCanvas, 0, 0);
    subjCtx.globalCompositeOperation = 'destination-in';
    subjCtx.drawImage(featherCanvas, 0, 0, w, h);
    subjCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(subjCanvas, 0, 0);
  }

  var viewCtx = el.view.getContext('2d');

  function viewSize() {
    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    var longEdge = S.fx.lowPower ? 480 : 720;
    var s = Math.min(1, longEdge / Math.max(vw, vh));
    return { w: Math.max(2, Math.round(vw * s)), h: Math.max(2, Math.round(vh * s)) };
  }

  function startRenderLoop() {
    S.fpsFrames = 0; S.fpsSince = performance.now();
    var lowStreak = 0;

    loopRaf('render', function (ts) {
      if (!S.running || el.video.readyState < 2 || !el.video.videoWidth) return;

      var d = viewSize();
      if (el.view.width !== d.w || el.view.height !== d.h) {
        el.view.width = d.w; el.view.height = d.h;
      }
      drawComposed(viewCtx, d.w, d.h, S.fx.mode !== 'off');

      // --- fps ---
      S.fpsFrames++;
      if (ts - S.fpsSince >= 1000) {
        S.fps = Math.round(S.fpsFrames * 1000 / (ts - S.fpsSince));
        S.fpsFrames = 0; S.fpsSince = ts;

        // Low-power fallback: if the effect cannot hold ~24fps, drop resolution
        // and mask rate rather than shipping a slideshow.
        if (S.fx.mode !== 'off' && !S.fx.lowPower) {
          if (S.fps < 24) {
            lowStreak++;
            if (lowStreak >= 3) {
              S.fx.lowPower = true;
              toast('Low-power mode — reduced resolution to keep the preview smooth', 3600);
            }
          } else { lowStreak = 0; }
        }
      }
    });
  }

  /* ------------------------------------------------------------ golden hour */
  function initSun() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      if (typeof SunCalc === 'undefined') return;
      el.sunChip.hidden = false;
      function update() {
        var now = new Date();
        var t = SunCalc.getTimes(now, lat, lon);
        var gh = t.goldenHour, sunset = t.sunset;
        if (!gh || isNaN(gh.getTime())) { el.sunChip.hidden = true; return; }
        var diff = gh.getTime() - now.getTime();
        var label;
        if (diff > 0) {
          label = 'Golden hour in <b>' + fmtDur(diff) + '</b>';
        } else if (sunset && now < sunset) {
          label = '<b>Golden hour now</b>';
        } else {
          var tomorrow = new Date(now.getTime() + 86400000);
          var t2 = SunCalc.getTimes(tomorrow, lat, lon);
          var d2 = t2.goldenHour ? t2.goldenHour.getTime() - now.getTime() : 0;
          label = d2 > 0 ? 'Golden hour in <b>' + fmtDur(d2) + '</b>' : 'Golden hour passed';
        }
        el.sunText.innerHTML = label;
      }
      update();
      if (S.sunTimer) clearInterval(S.sunTimer);
      S.sunTimer = setInterval(update, 60000);
    }, function () {
      el.sunChip.hidden = true;
    }, { timeout: 8000, maximumAge: 600000 });
  }

  function fmtDur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  /* ------------------------------------------------------------- coaching */
  function setCoach(c) {
    var now = performance.now();
    if (S.currentCoach && S.currentCoach.id === c.id) {
      if (c.sub && el.coachSub.textContent !== c.sub) el.coachSub.textContent = c.sub;
      el.coach.setAttribute('data-tone', c.tone);
      return;
    }
    if (S.currentCoach && now - S.coachChangedAt < 700) return;
    if (S.currentCoach && c.sev < S.currentCoach.sev + 0.12 && now - S.coachChangedAt < 2200) return;

    S.currentCoach = c;
    S.coachChangedAt = now;
    el.coachText.textContent = c.text;
    el.coachSub.textContent = c.sub || '';
    el.coach.setAttribute('data-tone', c.tone);
    el.coach.classList.add('on');
  }

  function startCoachLoop() {
    loopTimer('coach', function () {
      if (!S.running) return 400;
      var cands = [];

      if (S.exp.valid) {
        if (S.exp.clip > 0.06) {
          cands.push({ id: 'clip', sev: 0.55 + Math.min(0.45, S.exp.clip * 2.2), tone: 'warn',
            text: 'Too bright behind', sub: 'Turn around, or move so the light is on your subject' });
        } else if (S.exp.mean < 52) {
          cands.push({ id: 'dark', sev: 0.5 + Math.min(0.4, (52 - S.exp.mean) / 90), tone: 'warn',
            text: 'Too dark', sub: 'Find a window, a lamp, or step outside' });
        } else if (S.exp.crush > 0.22) {
          cands.push({ id: 'crush', sev: 0.45, tone: 'warn',
            text: 'Shadows are crushed', sub: 'Lift the phone slightly, or add light' });
        }
      }

      if (S.rollValid && Math.abs(S.roll) > 1.2) {
        var deg = Math.abs(S.roll);
        cands.push({ id: 'level', sev: 0.42 + Math.min(0.4, deg / 22), tone: 'warn',
          text: 'Tilt ' + (S.roll > 0 ? 'left' : 'right') + ' ' + Math.round(deg) + '°',
          sub: 'Line the bar up with the horizon' });
      }

      if (S.motionSeen && S.stability < 0.55) {
        cands.push({ id: 'shake', sev: 0.4 + (0.55 - S.stability) * 0.7, tone: 'warn',
          text: 'Hold still', sub: 'Tuck your elbows in, breathe out, then shoot' });
      }

      if (S.face && performance.now() - S.face.at < 1200) {
        var f = S.face;
        if (f.h > 0.78) {
          cands.push({ id: 'close', sev: 0.5, tone: 'warn', text: 'Move back a little', sub: 'Their head is filling the frame' });
        } else if (f.h < 0.16) {
          cands.push({ id: 'far', sev: 0.46, tone: 'warn', text: 'Move closer', sub: 'The subject is small in the frame' });
        } else if (f.cy - f.h / 2 < 0.02) {
          cands.push({ id: 'head', sev: 0.52, tone: 'warn', text: 'You are cutting off their head', sub: 'Tilt the phone up slightly' });
        } else if (f.pitch !== null && Math.abs(f.pitch) > 14) {
          cands.push({ id: 'pitch', sev: 0.38, tone: 'warn',
            text: f.pitch > 0 ? 'Get lower' : 'Raise the phone',
            sub: f.pitch > 0 ? 'You are shooting down at them' : 'You are shooting up at them' });
        } else {
          var off = Math.sqrt(Math.pow(f.cx - 0.5, 2) + Math.pow(f.cy - 0.5, 2));
          if (off < 0.055) {
            cands.push({ id: 'centre', sev: 0.34, tone: 'warn', text: 'Subject is dead centre', sub: 'Shift them onto a third line' });
          }
        }
      }

      if (S.seg && performance.now() - S.seg.at < 1500) {
        var stops = Math.log2(Math.max(1, S.seg.background) / Math.max(1, S.seg.subject));
        if (stops > 0.85) {
          cands.push({ id: 'backlight', sev: 0.6 + Math.min(0.35, stops / 4), tone: 'warn',
            text: 'Background is ' + stops.toFixed(1) + ' stops brighter',
            sub: 'Turn so the light falls on your subject, not behind them' });
        }
      }

      if (!cands.length) {
        var steady = !S.motionSeen || S.stability > 0.7;
        var ready = steady && (!S.rollValid || Math.abs(S.roll) <= 1.5);
        setCoach({ id: 'ok', sev: 0, tone: 'ok',
          text: ready ? 'Good — take the shot' : 'Looks good',
          sub: ready ? 'Level and steady' : 'Nothing to fix right now' });
        el.shutter.classList.toggle('armed', ready);
        return 220;
      }

      cands.sort(function (a, b) { return b.sev - a.sev; });
      setCoach(cands[0]);
      el.shutter.classList.remove('armed');
      return 220;
    });
  }

  /* -------------------------------------------------------------- capture */
  function beginCountdown() {
    if (S.counting) return;
    S.counting = true;
    var n = 3;
    el.countdown.classList.add('on');
    el.countdownNum.textContent = String(n);
    var iv = setInterval(function () {
      n--;
      if (n <= 0) {
        clearInterval(iv);
        el.countdown.classList.remove('on');
        S.counting = false;
        capture();
      } else {
        el.countdownNum.textContent = String(n);
      }
    }, 1000);
  }

  function capture() {
    if (!S.running || !el.video.videoWidth) return;
    var vw = el.video.videoWidth, vh = el.video.videoHeight;

    // Pause the viewfinder while we composite and encode. Otherwise the render
    // loop competes with the encoder for the main thread and the toBlob
    // callback can be starved for seconds on a slow device.
    var wasRendering = !!LOOPS.render;
    loopStop('render');

    var maxEdge = 2400;
    var scale = Math.min(1, maxEdge / Math.max(vw, vh));
    var cw = Math.round(vw * scale), ch = Math.round(vh * scale);

    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var ctx = c.getContext('2d');

    // Same pipeline as the viewfinder, at full resolution, so the effect is
    // baked into the file rather than only shown on screen.
    drawComposed(ctx, cw, ch, S.fx.mode !== 'off');

    if (S.facing === 'user') {
      // Mirror the finished frame, not the source, so the mask stays aligned.
      var m = document.createElement('canvas');
      m.width = cw; m.height = ch;
      var mctx = m.getContext('2d');
      mctx.translate(cw, 0); mctx.scale(-1, 1);
      mctx.drawImage(c, 0, 0);
      c = m; ctx = mctx;
    }

    el.flash.classList.add('go');
    setTimeout(function () { el.flash.classList.remove('go'); }, 360);

    // Encode once. The old code did toDataURL AND toBlob — two full JPEG
    // encodes of a 2400px frame, back to back, on the main thread.
    c.toBlob(function (blob) {
      if (!blob) { toast('Could not encode the photo'); if (wasRendering) startRenderLoop(); return; }
      var url = URL.createObjectURL(blob);
      S.lastShot = { canvas: c, url: url, w: cw, h: ch };
      S.lastBlob = blob;
      showReview(url, c, blob);
    }, 'image/jpeg', 0.9);
  }

  /* ------------------------------------------------------------- critique */
  var lapCanvas = document.createElement('canvas');
  var lapCtx = lapCanvas.getContext('2d', { willReadFrequently: true });
  var lapGray = null;

  function laplacianVariance(canvas) {
    var w = 640;
    var h = Math.round(canvas.height * (w / canvas.width));
    if (lapCanvas.width !== w || lapCanvas.height !== h) {
      lapCanvas.width = w; lapCanvas.height = h;
      lapGray = new Float32Array(w * h);
    }
    if (!lapGray) lapGray = new Float32Array(w * h);
    lapCtx.drawImage(canvas, 0, 0, w, h);
    var d = lapCtx.getImageData(0, 0, w, h).data;

    var gray = lapGray;
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }

    var sum = 0, sumSq = 0, n = 0;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = y * w + x;
        var lap = -4 * gray[idx] + gray[idx - 1] + gray[idx + 1] + gray[idx - w] + gray[idx + w];
        sum += lap; sumSq += lap * lap; n++;
      }
    }
    if (!n) return 0;
    var mean = sum / n;
    return sumSq / n - mean * mean;
  }

  var histCanvas = document.createElement('canvas');
  var histCtx = histCanvas.getContext('2d', { willReadFrequently: true });

  function histogramOf(canvas) {
    var w = 120, h = Math.round(canvas.height * (w / canvas.width));
    if (histCanvas.width !== w || histCanvas.height !== h) {
      histCanvas.width = w; histCanvas.height = h;
    }
    histCtx.drawImage(canvas, 0, 0, w, h);
    var d = histCtx.getImageData(0, 0, w, h).data;
    var n = d.length / 4, sum = 0, clip = 0, crush = 0;
    for (var i = 0; i < d.length; i += 4) {
      var y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += y;
      if (y >= 250) clip++;
      if (y <= 8) crush++;
    }
    return { mean: sum / n, clip: clip / n, crush: crush / n };
  }

  function showReview(url, canvas, blob) {
    el.shotImg.src = url;
    el.reviewTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.reviewScreen.classList.add('on');

    // Freeze the viewfinder while the review is open — no point burning frames.
    loopStop('render');

    var rollAbs = S.rollValid ? Math.abs(S.roll) : 0;
    var levelScore = S.rollValid ? clamp(100 - rollAbs * 9, 0, 100) : null;

    var lv = laplacianVariance(canvas);
    var sharpScore = clamp(Math.sqrt(Math.max(0, lv)) / 24 * 100, 0, 100);

    var h = histogramOf(canvas);
    var expScore = clamp(100 - h.clip * 220 - h.crush * 180 - Math.abs(h.mean - 128) * 0.35, 0, 100);

    var compScore = null;
    if (S.face && performance.now() - S.face.at < 4000) {
      var f = S.face;
      var off = Math.sqrt(Math.pow(f.cx - 0.5, 2) + Math.pow(f.cy - 0.5, 2));
      var td = thirdsDistance(f.cx, f.cy);
      var sizePen = f.h > 0.8 ? (f.h - 0.8) * 300 : f.h < 0.15 ? (0.15 - f.h) * 300 : 0;
      compScore = clamp(100 - off * 90 - td * 22 - sizePen, 0, 100);
    }

    paintScore('sLevel', 'vLevel', levelScore);
    paintScore('sSharp', 'vSharp', sharpScore);
    paintScore('sExp', 'vExp', expScore);
    paintScore('sComp', 'vComp', compScore);

    var fixes = [
      { s: sharpScore, t: 'This one is soft. Brace the phone against something solid and shoot again.' },
      { s: expScore, t: h.clip > 0.06 ? 'The highlights are blown. Turn so the bright background is behind you.' : 'The exposure is off. Move toward better light.' }
    ];
    if (levelScore !== null) {
      fixes.push({ s: levelScore, t: 'Straighten the horizon — it is ' + Math.round(rollAbs) + '° off level.' });
    }
    if (compScore !== null) {
      fixes.push({ s: compScore, t: 'Give the subject more room — shift them off centre.' });
    }
    fixes.sort(function (a, b) { return a.s - b.s; });
    el.fixText.textContent = fixes[0].s > 82 ? 'Nothing major — this one is solid.' : fixes[0].t;

    el.saveNote.textContent = canShareFiles()
      ? 'Saving opens your phone\u2019s share sheet — choose \u201cSave Image\u201d to put it in your gallery.'
      : 'Your browser cannot share files directly, so this downloads the photo instead.';
  }

  function paintScore(barId, valId, score) {
    var bar = $(barId), val = $(valId);
    if (score === null || score === undefined) {
      bar.style.width = '0%';
      bar.style.background = 'var(--dim)';
      val.textContent = 'n/a';
      val.style.color = 'var(--dim)';
      return;
    }
    var s = Math.round(score);
    bar.style.width = s + '%';
    bar.style.background = s >= 75 ? 'var(--green)' : s >= 50 ? 'var(--amber)' : 'var(--red)';
    val.textContent = String(s);
    val.style.color = 'var(--ink)';
  }

  /* ----------------------------------------------------------------- save */
  function canShareFiles() {
    if (!navigator.canShare || !navigator.share) return false;
    try {
      var f = new File([new Blob(['x'], { type: 'image/jpeg' })], 't.jpg', { type: 'image/jpeg' });
      return navigator.canShare({ files: [f] });
    } catch (e) { return false; }
  }

  function saveShot() {
    if (!S.lastBlob) { toast('Nothing to save yet'); return; }
    var name = 'framewise-' + Date.now() + '.jpg';
    var file = new File([S.lastBlob], name, { type: 'image/jpeg' });

    if (canShareFiles()) {
      navigator.share({ files: [file], title: 'Framewise' }).then(function () {
        toast('Shared — pick \u201cSave Image\u201d');
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        downloadFallback(file, name);
      });
    } else {
      downloadFallback(file, name);
    }
  }

  function downloadFallback(file, name) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Downloaded to your device');
  }

  /* ------------------------------------------------------------ fx controls */
  function setFxMode(mode, silent) {
    S.fx.mode = mode;
    Array.prototype.forEach.call(el.fxBar.querySelectorAll('.fxseg'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.fx === mode ? 'true' : 'false');
    });
    if (mode === 'off') {
      S.fx.maskReady = false;
      el.fxNote.hidden = true;
      loopStop('strength');
    } else if (!silent) {
      el.fxNote.hidden = false;
      startStrengthLoop();
    }
    updateStrengthLabel();
  }

  function updateStrengthLabel() {
    if (S.fx.mode === 'off') { el.fxNote.hidden = true; return; }
    var pct = Math.round(S.fx.strength * 100);
    el.fxNote.hidden = false;
    el.fxNote.textContent = (S.fx.auto ? 'Auto' : 'Fixed') + ' blur \u00b7 ' + pct + '%' +
      (S.fx.lowPower ? ' \u00b7 low-power' : '');
  }

  // Auto strength: a real fast lens blurs more as the subject gets closer.
  // Face height in frame is our only distance proxy.
  function updateAutoStrength() {
    if (!S.fx.auto) return;
    if (S.face && performance.now() - S.face.at < 1500) {
      var target = clamp((S.face.h - 0.14) / 0.46, 0.12, 1);
      S.fx.strength = lerp(S.fx.strength, target, 0.12);
    } else {
      S.fx.strength = lerp(S.fx.strength, 0.35, 0.05);
    }
    updateStrengthLabel();
  }

  function startStrengthLoop() {
    loopTimer('strength', function () {
      if (S.fx.mode !== 'off') updateAutoStrength();
      return 200;
    });
  }

  /* ------------------------------------------------------------- lifecycle */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      // Stop the render loop entirely; a hidden tab must not keep compositing.
      loopStop('render');
      if (S.stream) S.stream.getVideoTracks().forEach(function (t) { t.enabled = false; });
    } else {
      if (S.stream) S.stream.getVideoTracks().forEach(function (t) { t.enabled = true; });
      if (S.running && !el.reviewScreen.classList.contains('on')) {
        startRenderLoop();
        requestWakeLock();
      }
    }
  });

  window.addEventListener('pagehide', function () {
    stopCamera();
    stopSensors();
    closeAI();
    if (S.sunTimer) { clearInterval(S.sunTimer); S.sunTimer = null; }
  });

  /* ------------------------------------------------------------------ wire */
  el.startBtn.addEventListener('click', startCamera);
  el.retryBtn.addEventListener('click', startCamera);
  el.flipBtn.addEventListener('click', flipCamera);
  el.shutter.addEventListener('click', function () {
    if (S.counting) return;
    capture();
  });
  el.timerBtn.addEventListener('click', function () {
    S.autoCapture = !S.autoCapture;
    el.timerBtn.setAttribute('aria-pressed', S.autoCapture ? 'true' : 'false');
    toast(S.autoCapture ? 'Auto-capture on — fires when you hold steady' : 'Auto-capture off');
  });

  el.fxBar.addEventListener('click', function (e) {
    var b = e.target.closest('.fxseg');
    if (!b || b.disabled) return;
    if (b.dataset.fx !== 'off' && S.ai.state !== 'ready') {
      toast('Portrait needs the AI coach, which is not ready yet');
      return;
    }
    setFxMode(b.dataset.fx);
    if (b.dataset.fx !== 'off') startStrengthLoop();
    else loopStop('strength');
  });

  el.adjustBtn.addEventListener('click', function () {
    el.adjust.classList.toggle('on');
  });
  el.adjustClose.addEventListener('click', function () {
    el.adjust.classList.remove('on');
  });

  function bindSlider(input, valEl, key, fmt) {
    input.addEventListener('input', function () {
      S.fx[key] = Number(input.value);
      valEl.textContent = fmt(S.fx[key]);
    });
  }
  bindSlider(el.expSlider, el.expVal, 'exposure', function (v) { return (v > 0 ? '+' : '') + v; });
  bindSlider(el.conSlider, el.conVal, 'contrast', function (v) { return (v > 0 ? '+' : '') + v; });
  bindSlider(el.warmSlider, el.warmVal, 'warmth', function (v) { return (v > 0 ? '+' : '') + v; });

  el.retakeBtn.addEventListener('click', function () {
    el.reviewScreen.classList.remove('on');
    if (S.lastShot && S.lastShot.url) URL.revokeObjectURL(S.lastShot.url);
    S.lastShot = null; S.lastBlob = null;
    if (S.running) startRenderLoop();
  });
  el.saveBtn.addEventListener('click', saveShot);

  // Expose read-only state for automated testing. Harmless in production.
  window.__framewise = S;
  window.__fw = {
    setFxMode: setFxMode,
    capture: capture,
    drawComposed: drawComposed,
    getMask: function () { return featherCanvas; },
    fps: function () { return S.fps; }
  };

  // PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });
    });
  }

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'camera' }).then(function (p) {
      if (p.state === 'granted') startCamera();
    }).catch(function () { /* Safari does not support this query */ });
  }
})();
