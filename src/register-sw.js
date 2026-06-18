if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  } else {
    navigator.serviceWorker.getRegistration('/').then(reg => {
      if (reg && reg.active && reg.active.scriptURL.endsWith('/sw.js')) reg.unregister();
    }).catch(() => {});
  }
}
