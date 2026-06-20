// The service worker was removed: a stale SW cache caused blank-screen loads on iOS
// Safari (a cached index referencing deleted chunk hashes). Instead of registering one,
// we proactively UNREGISTER any previously-installed worker and purge its caches so a
// stuck device self-heals. (public/sw.js is now a self-destructing kill-switch for
// devices whose old worker is still serving a stale shell and re-fetches it.)
//
// One guarded reload after cleanup re-fetches everything fresh; the sessionStorage guard
// prevents any reload loop.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      if (!regs.length) return; // healthy device, nothing to clean up
      const purgeCaches = window.caches
        ? caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        : Promise.resolve();
      return Promise.all([
        Promise.all(regs.map((r) => r.unregister())),
        purgeCaches,
      ]).then(() => {
        if (!sessionStorage.getItem('sw-purged')) {
          sessionStorage.setItem('sw-purged', '1');
          window.location.reload();
        }
      });
    })
    .catch(() => {});
}
