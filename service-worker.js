/* Bíblia de Estudo ARA — Cache offline com notas de estudo. */
const CACHE_NAME = 'biblia-ara-notas-genebra-v1';
const ASSETS = ['./index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png'];
self.addEventListener('install', event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME && k.startsWith('biblia-ara-')).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(caches.match(event.request).then(async cached=>{
    if(cached)return cached;
    if(event.request.mode==='navigate'){
      const offlineIndex=await caches.match('./index.html');
      if(offlineIndex)return offlineIndex;
    }
    return fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy)).catch(()=>{});}
    return response;
    });
  }));
});
