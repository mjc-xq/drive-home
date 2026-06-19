// IdleController — produces no movement at all. Used as a momentary hand-off
// strategy (switch transitions, pause, safe-zone-pacified actors) so the actor
// stands still and animation settles to idle. It feeds the same stepMotion as
// every other controller; it just always asks for nothing.

import { EMPTY_INTENT } from './Controller.js';

/**
 * @type {{ id:'idle', produce():any }}
 */
export const IdleController = {
  id: 'idle',
  produce() {
    return EMPTY_INTENT;
  },
};
