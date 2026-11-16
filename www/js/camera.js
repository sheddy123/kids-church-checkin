/*
 * In-app camera: one-tap photos and QR scanning.
 *
 *   Cam.photo({ title, hint, shape: 'square'|'wide', facing, canRemove })
 *       -> Promise<string|null>   JPEG data URL, '' if "Remove photo" was tapped, null if cancelled
 *   Cam.scan({ title, hint })
 *       -> Promise<string|null>   text inside the QR code, or null if cancelled
 *
 * Falls back to the phone's own camera/gallery picker when the live camera
 * is not available (permission refused, or the page is not on https).
 */
(function () {
  'use strict';
  var SIZES = { square: [360, 360], wide: [800, 600] };

  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function getStream(facing) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('no-camera-api'));
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } } });
  }
  function stop(stream) { if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); }

  // Centre-crop any image source to the target shape, so the saved photo is what the viewfinder showed.
  function crop(src, sw, sh, shape) {
    var size = SIZES[shape] || SIZES.square, tw = size[0], th = size[1];
    var ratio = tw / th, cw = sw, ch = sw / ratio;
    if (ch > sh) { ch = sh; cw = sh * ratio; }
    var c = document.createElement('canvas'); c.width = tw; c.height = th;
    c.getContext('2d').drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, tw, th);
    return c.toDataURL('image/jpeg', 0.72);
  }
  function fileToPhoto(file, shape) {
    return new Promise(function (res) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { var out = crop(img, img.naturalWidth, img.naturalHeight, shape); URL.revokeObjectURL(url); res(out); };
      img.onerror = function () { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }

  function shell(o, body) {
    return el('<div class="cam" role="dialog" aria-modal="true" aria-label="' + esc(o.title) + '">' +
      '<div class="cam-top"><div class="grow"><div class="cam-title">' + esc(o.title) + '</div>' + (o.hint ? '<div class="cam-hint">' + esc(o.hint) + '</div>' : '') + '</div>' +
      '<button class="cam-x" data-cam="close" aria-label="Close">×</button></div>' + body + '</div>');
  }

  function photo(o) {
    o = Object.assign({ title: 'Take a photo', hint: '', shape: 'square', facing: 'environment', canRemove: false }, o || {});
    return new Promise(function (resolve) {
      var stream = null, facing = o.facing, done = false;
      var root = shell(o,
        '<div class="cam-stage"><div class="cam-frame ' + o.shape + '"><video playsinline muted autoplay poster="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="></video><div class="cam-msg" hidden></div></div></div>' +
        '<div class="cam-bar"><label class="cam-side" aria-label="Choose from gallery"><input type="file" accept="image/*" hidden>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg></label>' +
        '<button class="cam-shutter" data-cam="shoot" aria-label="Take photo"><span></span></button>' +
        '<button class="cam-side" data-cam="flip" aria-label="Switch camera"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg></button></div>' +
        (o.canRemove ? '<button class="cam-link" data-cam="remove">Remove this photo</button>' : ''));
      var video = root.querySelector('video'), msg = root.querySelector('.cam-msg'), file = root.querySelector('input[type=file]');

      function finish(v) { if (done) return; done = true; stop(stream); root.remove(); resolve(v); }
      function start() {
        stop(stream); stream = null;
        getStream(facing).then(function (s) {
          if (done) { stop(s); return; }
          stream = s; video.srcObject = s; msg.hidden = true;
          video.classList.toggle('mirror', facing === 'user');
          video.play().catch(function () {});
        }).catch(function () {
          msg.hidden = false;
          msg.innerHTML = '<strong>Camera not available here.</strong><br>Tap the picture button below to use your phone’s camera or gallery.';
          root.querySelector('[data-cam=shoot]').disabled = true;
        });
      }
      root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-cam]'); if (!b) return;
        var a = b.dataset.cam;
        if (a === 'close') finish(null);
        else if (a === 'remove') finish('');
        else if (a === 'flip') { facing = facing === 'user' ? 'environment' : 'user'; start(); }
        else if (a === 'shoot') {
          if (!video.videoWidth) return;
          var out = crop(video, video.videoWidth, video.videoHeight, o.shape);
          if (navigator.vibrate) { try { navigator.vibrate(20); } catch (e2) {} }
          finish(out);
        }
      });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0]; if (!f) return;
        fileToPhoto(f, o.shape).then(function (out) { if (out) finish(out); });
      });
      document.body.appendChild(root);
      start();
    });
  }

  function scan(o) {
    o = Object.assign({ title: 'Scan pickup pass', hint: 'Point at the QR code on the parent’s phone.' }, o || {});
    return new Promise(function (resolve) {
      var stream = null, done = false, timer = null, busy = false;
      var root = shell(o,
        '<div class="cam-stage"><div class="cam-frame square scan"><video playsinline muted autoplay poster="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="></video><div class="cam-corners"><i></i><i></i><i></i><i></i></div><div class="cam-msg" hidden></div></div></div>' +
        '<button class="cam-link" data-cam="close">Type the code instead</button>');
      var video = root.querySelector('video'), msg = root.querySelector('.cam-msg');
      var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });

      function finish(v) { if (done) return; done = true; clearInterval(timer); stop(stream); root.remove(); resolve(v); }
      function found(text) { if (!text) return; if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} } finish(String(text)); }
      // The bundled reader (jsQR) is used on purpose. The browser's own BarcodeDetector
      // crashes the whole app on Android phones without Google Play Services.
      function tick() {
        if (busy || done || !video.videoWidth) return;
        busy = true;
        try {
          if (window.jsQR) {
            var scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (r && r.data) { found(r.data); return; }
          }
        } catch (e) { /* try again on the next frame */ }
        finally { busy = false; }
      }
      root.addEventListener('click', function (e) { if (e.target.closest('[data-cam=close]')) finish(null); });
      document.body.appendChild(root);

      (async function () {
        try {
          var s = await getStream('environment');
          if (done) { stop(s); return; }
          stream = s; video.srcObject = s; video.play().catch(function () {});
          timer = setInterval(tick, 160);
        } catch (e) {
          msg.hidden = false;
          msg.innerHTML = '<strong>Camera not available.</strong><br>Allow camera access in your phone’s settings, or type the 4-character code instead.';
        }
      })();
    });
  }

  window.Cam = { photo: photo, scan: scan };
})();
