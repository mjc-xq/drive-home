import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { setVehicle, cycleVehicle, vehicleList } from '../src/engine/car.js';

// Build a `car` shaped like the one createCar() returns AFTER a couple of GLB
// models have registered: a procedural FALLBACK (loose meshes parented straight
// under car.group) plus real model groups stored in car.models[slot]. The
// fallback starts visible — exactly the state the bug leaves it in when the
// default car loads after the 2.8 s reveal-timeout (so the reveal went through
// setVehicle, which used to skip retiring the fallback).
function fakeCar() {
  const group = new THREE.Group();
  const fallbackA = new THREE.Mesh(); group.add(fallbackA);   // e.g. the procedural hull
  const fallbackB = new THREE.Mesh(); group.add(fallbackB);   // e.g. a procedural wheel
  const car = { group, models: [], modelIdx: 0, userPicked: false };
  for (const slot of [0, 1]) {
    const g = new THREE.Group(); g.visible = false; group.add(g);
    car.models[slot] = { group: g, name: 'Car ' + slot, spec: '', credit: '' };
  }
  return { car, fallback: [fallbackA, fallbackB] };
}

describe('vehicle swap retires the procedural fallback car', () => {
  it('hides the fallback when picking a specific model', () => {
    const { car, fallback } = fakeCar();
    setVehicle(car, 1);
    expect(car.models[1].group.visible).toBe(true);
    expect(car.models[0].group.visible).toBe(false);
    for (const f of fallback) expect(f.visible).toBe(false);   // no red placeholder left beneath
  });

  it('hides the fallback when cycling to the next model', () => {
    const { car, fallback } = fakeCar();
    cycleVehicle(car);
    for (const f of fallback) expect(f.visible).toBe(false);
    expect(car.models[car.modelIdx].group.visible).toBe(true);
  });

  it('keeps exactly one model visible after a swap', () => {
    const { car } = fakeCar();
    setVehicle(car, 0);
    const visible = car.models.filter(m => m && m.group.visible);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toBe(car.models[0]);
  });
});
