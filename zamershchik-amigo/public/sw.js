// Сервис-воркер: приложение должно открываться в поле, где связи нет.
// Оболочку (HTML/JS/CSS/иконки) держим в кэше, данные — только с сетью.

// Версию поднимаем при каждом изменении файлов: старый кэш иначе продолжит
// отдавать прежний styles.css, и правка просто не дойдёт до телефона.
const CACHE = 'zamershchik-v30';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // отдельные файлы могут отсутствовать (например, иконки ещё не сгенерированы)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // картинки каталога идут напрямую с Amigo
  if (url.pathname.startsWith('/api/')) return; // данные — только свежие с сервера

  // Навигация: сначала сеть, при неудаче — кэш (иначе приложение не откроется без связи)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || caches.match('/'))),
    );
    return;
  }

  // Статика: сначала кэш, потом сеть
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

// Заявка, сохранённая офлайн, уходит сама, как только появится сеть
self.addEventListener('sync', (event) => {
  if (event.tag === 'zam-outbox') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'flush-outbox' }));
      }),
    );
  }
});