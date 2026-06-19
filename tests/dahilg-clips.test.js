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
});
