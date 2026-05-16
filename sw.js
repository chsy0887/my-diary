// ============================================================
//  sw.js - 서비스 워커 (Service Worker)
//
//  역할: 정적 파일을 캐시에 저장해서 오프라인에서도 앱이 열리게 함
//  버전을 바꾸면 (예: 'my-diary-v2') 이전 캐시를 삭제하고 새로 저장함
// ============================================================

const CACHE_NAME = 'my-diary-v2';

// 미리 캐시해 둘 파일 목록 (앱의 핵심 정적 파일)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/firebase-config.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
];

// ============================================================
//  install 이벤트: 서비스 워커가 처음 설치될 때 실행
//  → 정적 파일들을 캐시에 저장
// ============================================================
self.addEventListener('install', function (event) {
  console.log('[SW] 설치 중... 버전:', CACHE_NAME);

  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Promise.allSettled: 일부 파일 캐시 실패해도 설치 계속 진행
      return Promise.allSettled(
        STATIC_ASSETS.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[SW] 캐시 저장 실패 (무시하고 계속):', url, err.message);
          });
        })
      );
    })
  );

  // 이전 서비스 워커를 기다리지 않고 즉시 활성화
  self.skipWaiting();
});

// ============================================================
//  activate 이벤트: 서비스 워커가 활성화될 때 실행
//  → 이전 버전의 캐시를 삭제
// ============================================================
self.addEventListener('activate', function (event) {
  console.log('[SW] 활성화됨. 이전 캐시 정리 중...');

  event.waitUntil(
    caches.keys().then(function (cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function (name) { return name !== CACHE_NAME; }) // 현재 버전 외 모두 삭제
          .map(function (name) {
            console.log('[SW] 이전 캐시 삭제:', name);
            return caches.delete(name);
          })
      );
    }).then(function () {
      // 이미 열려있는 탭도 즉시 이 서비스 워커로 제어
      return self.clients.claim();
    })
  );
});

// ============================================================
//  fetch 이벤트: 브라우저의 모든 네트워크 요청을 가로챔
// ============================================================
self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);

  // /api/ 요청은 캐시하지 않음 (AI 분석은 항상 서버 네트워크 필요)
  if (url.pathname.startsWith('/api/')) {
    return; // 기본 fetch 동작 그대로 통과
  }

  // 외부 CDN (폰트, Chart.js): 네트워크 우선 → 오프라인이면 캐시 사용
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          // 네트워크 성공: 캐시에도 저장해 두기
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(function () {
          // 오프라인: 이전에 저장된 캐시 반환
          return caches.match(event.request);
        })
    );
    return;
  }

  // 로컬 정적 파일: 캐시 우선 → 캐시 없으면 네트워크
  event.respondWith(
    caches.match(event.request).then(function (cachedResponse) {
      // 캐시 히트: 바로 반환 (오프라인에서도 빠름)
      if (cachedResponse) {
        return cachedResponse;
      }

      // 캐시 미스: 네트워크에서 가져오고 캐시에 저장
      return fetch(event.request)
        .then(function (networkResponse) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
          return networkResponse;
        })
        .catch(function () {
          // 오프라인 + 캐시 없음: 페이지 이동이면 index.html로 대체
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
    })
  );
});
