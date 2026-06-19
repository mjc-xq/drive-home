// NpcController — the strategy attached to every actor the human isn't driving.
// It owns no logic of its own: it delegates one frame of the FSM to npcAi.npcStep,
// which returns the Intent that the shared stepMotion will apply. Keeping this a
// thin shim means switching control is just swapping which strategy object is
// attached (controllers/assign.js) — zero movement code moves.

import { npcStep } from '../systems/npcAi.js';

/**
 * @type {{ id:'npc', produce(actor:any, ctx:any, dt:number):any }}
 */
export const NpcController = {
  id: 'npc',
  produce(actor, ctx, dt) {
    return npcStep(actor, ctx, dt);
  },
};
