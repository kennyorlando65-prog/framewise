/* Framewise service worker — offline app shell only.
   The camera, the sensors and the AI models all need the network or the device;
   this caches the shell so the app opens instantly and survives a flaky signal. */

var CACHE = 'framewise-v1';
var SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL).catch(function () { /* a missing icon must not block install */ });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Never cache the MediaPipe models or the CDN bundle — they are large and versioned.
  if (url.hostname.indexOf('cdn.jsdelivr.net') !== -1 ||
      url.hostname.indexOf('storage.googleapis.com') !== -1) {
    return;
  }

  // Same-origin shell: cache first, then network.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () {
          return caches.match('./index.html');
        });
      })
    );
  }
});
