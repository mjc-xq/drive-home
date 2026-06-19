// One explicit Jotai store shared by both the DOM HUD and the R3F <Canvas>.
// Passed to <Provider store={daHilgStore}> wrapping both trees in DaHilgApp so
// they read/write identical state. Game systems (inside useFrame) read/write it
// imperatively via daHilgStore.get/set; the HUD subscribes with hooks.

import { createStore } from 'jotai';

export const daHilgStore = createStore();
