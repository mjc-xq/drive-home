import { VEHICLES, cycleVehicle, loadDrivableCar, loadRealCar, setVehicle, vehicleList } from '../car.js';
import { installDracoDecoder } from '../draco-install.js';
import carGlbUrl from '../../assets/ferrari.glb';
export function createCars(ctx) {
  function ensureVehicle(slot) {
    if (ctx.flags.has('nocar') || ctx.disposed) return;
    if (slot === 2) {   // Ferrari — Draco, lazy on first need (its own fallback toast)
      if (ctx.ferrariLoadStarted) return;
      ctx.ferrariLoadStarted = true;
      installDracoDecoder();
      ctx.cancelCarLoad = loadRealCar(ctx.car, carGlbUrl, () => { if (!ctx.disposed) ctx.toast('Using fallback car model'); });
      return;
    }
    if (ctx.car.models[slot] || ctx.vehLoading.has(slot)) return;   // already loaded / in flight
    const def = ctx.CAR_DEFS[slot];
    if (!def) return;
    ctx.vehLoading.add(slot);
    ctx.modelLoadCancels.push(loadDrivableCar(ctx.car, def.url, slot, {
      length: def.length, flip: def.flip !== false, black: false, extraYaw: def.extraYaw || 0, meta: VEHICLES[slot],   // default nose -Z (flip:true); extraYaw is a per-car quarter-turn for odd model axes
      onReady: (s) => { ctx.vehLoading.delete(s); ctx.emit('cars', ctx.cars.getCars()); if (ctx.car.modelIdx === s) ctx.cars.showCarCard(); }
    }));
  }
  function showCarCard() {
    const v = ctx.car.models[ctx.car.modelIdx];
    const meta = v && v.name ? v : VEHICLES[0];     // fallback card while no GLB has loaded yet
    ctx.emit('carCard', { name: meta.name, spec: meta.spec, credit: meta.credit || '' });
  }
  function cycleCar() {
    if (!cycleVehicle(ctx.car)) { ctx.toast('Open the garage (☰ → Cars) to pick another ride'); return; }
    ctx.cars.showCarCard();
    ctx.audio.blip();
  }
  function checkFerrariUnlock() {
    if (ctx.ferrariUnlocked || ctx.poiFound.size < ctx.POIS.length) return;
    ctx.ferrariUnlocked = true;
    try { localStorage.setItem('dahill.drive.ferrari', '1'); } catch (e) { }
    ctx.toast('🏎️ You earned the Ferrari 458! Tap 🚗 to drive it', 4000);
    if (ctx.audio.sfxChime) ctx.audio.sfxChime([523, 659, 784, 1047]);
    ctx.emit('cars', ctx.cars.getCars());
  }
  function getCars() { return vehicleList(ctx.car).map(v => v.slot === 2 ? Object.assign({}, v, { locked: !ctx.ferrariUnlocked }) : v); }
  function pickCar(slot) {
    if (slot === 2 && !ctx.ferrariUnlocked) { ctx.toast('🔒 Find all 5 neighbourhood places to unlock the Ferrari!', 2400); return; }
    ctx.cars.ensureVehicle(slot);                              // lazy: fetch its GLB now if it isn't loaded yet
    if (setVehicle(ctx.car, slot)) { ctx.cars.showCarCard(); ctx.audio.blip(); }
    else { ctx.car.pendingPick = slot; ctx.toast('Loading ' + (VEHICLES[slot] ? ctx.esc(VEHICLES[slot].name) : 'car') + '…', 1500); }   // it swaps in (registerVehicle) the moment it arrives
  }
  return { ensureVehicle, showCarCard, cycleCar, checkFerrariUnlock, getCars, pickCar };
}
