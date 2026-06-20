import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { retargetSkinSafeClip } from '../src/da-hilg/animation/clips.js';

function namedNode(name, { position = [0, 0, 0], quaternion = [0, 0, 0, 1] } = {}) {
  const node = new THREE.Object3D();
  node.name = name;
  node.position.fromArray(position);
  node.quaternion.fromArray(quaternion);
  return node;
}

describe('Da Hilg animation clip retargeting', () => {
  it('applies source animation deltas on top of the target rest pose', () => {
    const sourceRoot = new THREE.Group();
    const targetRoot = new THREE.Group();

    const sourceRest = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    const targetRest = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 6, 0));
    const animDelta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 4));
    const sourceAnimated = sourceRest.clone().multiply(animDelta);
    const expectedTarget = targetRest.clone().multiply(animDelta);

    sourceRoot.add(namedNode('Hips', { position: [1, 2, 3] }));
    targetRoot.add(namedNode('Hips', { position: [10, 20, 30] }));
    sourceRoot.add(namedNode('Spine02', { quaternion: sourceRest.toArray() }));
    targetRoot.add(namedNode('Spine02', { quaternion: targetRest.toArray() }));

    const clip = new THREE.AnimationClip('test', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0], [2, 4, 6]),
      new THREE.QuaternionKeyframeTrack('Spine02.quaternion', [0], sourceAnimated.toArray()),
      new THREE.VectorKeyframeTrack('Spine02.position', [0], [9, 9, 9]),
      new THREE.VectorKeyframeTrack('Hips.scale', [0], [2, 2, 2]),
    ]);

    const retargeted = retargetSkinSafeClip(clip, sourceRoot, targetRoot, 'unit-target');
    expect(retargeted.tracks.map((t) => t.name).sort()).toEqual([
      'Hips.position',
      'Spine02.quaternion',
    ]);

    const hipsTrack = retargeted.tracks.find((t) => t.name === 'Hips.position');
    expect(Array.from(hipsTrack.values)).toEqual([11, 22, 33]);

    const spineTrack = retargeted.tracks.find((t) => t.name === 'Spine02.quaternion');
    const actual = new THREE.Quaternion().fromArray(spineTrack.values);
    expect(actual.angleTo(expectedTarget)).toBeLessThan(1e-6);
  });

  // The family rigs are pure FK (no foot IK), so any Hips-Y motion lifts the feet off
  // the grounded motion.pos origin — the body floats and the feet-anchored clinging
  // nibblers detach. Grounded clips must therefore pin Hips Y to frame 0.
  it('pins Hips Y to frame 0 for grounded clips so the feet stay planted', () => {
    const sourceRoot = new THREE.Group();
    const targetRoot = new THREE.Group();
    sourceRoot.add(namedNode('Hips', { position: [1, 2, 3] }));
    targetRoot.add(namedNode('Hips', { position: [10, 20, 30] }));
    // The source 'dance' lifts the hips (Y 4 -> 9 across two frames).
    const clip = new THREE.AnimationClip('dance', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [2, 4, 6, 2, 9, 6]),
    ]);
    const out = retargetSkinSafeClip(clip, sourceRoot, targetRoot, 'unit-target', 'dance');
    const hips = out.tracks.find((t) => t.name === 'Hips.position');
    // frame 0 rebased = [11, 22, 33]; frame 1 Y flattened back to 22 (no float).
    expect(Array.from(hips.values)).toEqual([11, 22, 33, 11, 22, 33]);
  });

  // jump (and climb/crawl) intentionally keep their vertical motion.
  it('preserves Hips Y for non-grounded clips (jump keeps its vertical)', () => {
    const sourceRoot = new THREE.Group();
    const targetRoot = new THREE.Group();
    sourceRoot.add(namedNode('Hips', { position: [1, 2, 3] }));
    targetRoot.add(namedNode('Hips', { position: [10, 20, 30] }));
    const clip = new THREE.AnimationClip('jump', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [2, 4, 6, 2, 9, 6]),
    ]);
    const out = retargetSkinSafeClip(clip, sourceRoot, targetRoot, 'unit-target', 'jump');
    const hips = out.tracks.find((t) => t.name === 'Hips.position');
    // frame 1 Y stays rebased (27), not flattened.
    expect(Array.from(hips.values)).toEqual([11, 22, 33, 11, 27, 33]);
  });

  // knockdown is clamped, not flattened: it may sink toward the ground as the body
  // falls, but must never pop above standing rest first.
  it('clamps knockdown Hips Y so the fall never pops above standing rest', () => {
    const sourceRoot = new THREE.Group();
    const targetRoot = new THREE.Group();
    sourceRoot.add(namedNode('Hips', { position: [1, 2, 3] }));
    targetRoot.add(namedNode('Hips', { position: [10, 20, 30] }));
    // Source rises (Y 4 -> 9) then drops (Y -> 0).
    const clip = new THREE.AnimationClip('knockdown', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 0.5, 1], [2, 4, 6, 2, 9, 6, 2, 0, 6]),
    ]);
    const out = retargetSkinSafeClip(clip, sourceRoot, targetRoot, 'unit-target', 'knockdown');
    const hips = out.tracks.find((t) => t.name === 'Hips.position');
    // frame0 Y=22 (rest); frame1 rebased 27 -> clamped to 22; frame2 rebased 18 (drop kept).
    expect(Array.from(hips.values)).toEqual([11, 22, 33, 11, 22, 33, 11, 18, 33]);
  });
});
