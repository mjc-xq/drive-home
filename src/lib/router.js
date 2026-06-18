// router — a dependency-free, three-view path router. Each top-level view is a
// real URL: `/` (menu), `/drive`, `/scoop`. There's no client framework here on
// purpose; the whole app is one mounted engine + a swap of HUD chrome, so a
// 30-line history-API router is all the routing this needs.
//
// Direct loads of /drive and /scoop work because navigations fall back to
// index.html in every layer that serves this app: the service worker
// (networkFirst → /index.html, see public/sw.js) and Vite's dev + preview
// servers (default SPA history fallback).

import { useEffect, useState } from 'react';

/** Map a URL path to a view id. Trailing slashes are ignored; anything we don't
    recognise falls back to the menu. */
export function routeFromPath(pathname) {
  const p = (pathname || '/').replace(/\/+$/, '') || '/';
  if (p === '/drive') return 'drive';
  if (p === '/scoop') return 'scoop';
  return 'menu';
}

/** Inverse of routeFromPath: the canonical path for a view id. */
export function pathForRoute(route) {
  return route === 'drive' ? '/drive' : route === 'scoop' ? '/scoop' : '/';
}

/** Navigate to a view. pushState alone doesn't notify listeners, so we dispatch
    a popstate ourselves — the same event a Back/Forward press fires — and
    useRoute() picks it up. No-ops if already there. */
export function navigate(route) {
  const path = pathForRoute(route);
  if (typeof window === 'undefined' || window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Subscribe a component to the current view id; re-renders on nav (push or
    Back/Forward). */
export function useRoute() {
  const [route, setRoute] = useState(() =>
    routeFromPath(typeof window !== 'undefined' ? window.location.pathname : '/'));
  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
