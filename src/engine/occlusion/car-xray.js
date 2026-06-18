import * as THREE from 'three';

function capsuleShape(length, width, inset = 0) {
  const r = Math.max(0.05, width * 0.5 - inset);
  const halfStraight = Math.max(0.05, length * 0.5 - width * 0.5);
  const path = new THREE.Shape();
  path.moveTo(-halfStraight, -r);
  path.lineTo(halfStraight, -r);
  path.absarc(halfStraight, 0, r, -Math.PI * 0.5, Math.PI * 0.5, false);
  path.lineTo(-halfStraight, r);
  path.absarc(-halfStraight, 0, r, Math.PI * 0.5, Math.PI * 1.5, false);
  return path;
}

function capsuleBandGeometry(length, width, band, y) {
  const shape = capsuleShape(length, width);
  const hole = new THREE.Path();
  const inner = capsuleShape(length - band * 2, width - band * 2);
  const pts = inner.getPoints(48).reverse();
  hole.setFromPoints(pts);
  shape.holes.push(hole);
  const geom = new THREE.ShapeGeometry(shape, 24);
  geom.rotateX(-Math.PI * 0.5);
  geom.translate(0, y, 0);
  return geom;
}

function setMatOpacity(mat, target, dt) {
  const rate = 1 - Math.exp(-dt * 14);
  mat.opacity += (target - mat.opacity) * rate;
}

export function createCarXray(scene) {
  const group = new THREE.Group();
  group.visible = false;
  group.frustumCulled = false;
  scene.add(group);

  const throughBase = {
    transparent: true,
    depthTest: true,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
    toneMapped: false,
  };
  const shellMat = new THREE.MeshBasicMaterial({
    ...throughBase,
    color: 0x64e6ff,
    opacity: 0,
    side: THREE.FrontSide,
  });
  const roofMat = new THREE.MeshBasicMaterial({
    ...throughBase,
    color: 0x9af5ff,
    opacity: 0,
    side: THREE.FrontSide,
  });
  const wakeMat = new THREE.MeshBasicMaterial({
    ...throughBase,
    color: 0x35d8ff,
    opacity: 0,
    side: THREE.FrontSide,
  });

  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 14), shellMat);
  shell.position.y = 0.82;
  shell.scale.set(2.58, 0.52, 1.13);
  shell.renderOrder = 2600;
  shell.frustumCulled = false;

  const roof = new THREE.Mesh(capsuleBandGeometry(4.75, 2.05, 0.28, 1.32), roofMat);
  roof.renderOrder = 2601;
  roof.frustumCulled = false;

  const wake = new THREE.Mesh(capsuleBandGeometry(5.2, 2.45, 0.18, 0.36), wakeMat);
  wake.renderOrder = 2600;
  wake.frustumCulled = false;

  group.add(shell, wake, roof);

  function hide() {
    group.visible = false;
    shellMat.opacity = 0;
    roofMat.opacity = 0;
    wakeMat.opacity = 0;
  }

  function update(car, view = {}, dt = 1 / 60) {
    if (!car?.group?.visible) {
      hide();
      return;
    }

    group.visible = true;
    group.position.copy(car.group.position);
    group.quaternion.copy(car.group.quaternion);
    group.scale.setScalar(car.dispScale || car.group.scale.x || 1);

    const close = !view.aerial && !view.topdown && !view.drone;
    const topdown = !!view.topdown;
    const aerial = !!view.aerial;
    const shellOpacity = close ? 0.22 : topdown ? 0.14 : aerial ? 0.12 : 0.16;
    const roofOpacity = close ? 0.54 : topdown ? 0.46 : aerial ? 0.4 : 0.34;
    const wakeOpacity = close ? 0.18 : topdown ? 0.12 : aerial ? 0.1 : 0.12;

    setMatOpacity(shellMat, shellOpacity, dt);
    setMatOpacity(roofMat, roofOpacity, dt);
    setMatOpacity(wakeMat, wakeOpacity, dt);
  }

  return { group, update, hide };
}
