#!/usr/bin/env node
// Normalize the import block of carved engine modules: scan which known leaf symbols each file
// actually references (as free identifiers) and emit exactly the right imports from the right
// module. Fixes agent mistakes (wrong source, missing import). Idempotent.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAst } from 'vite';
import { walk } from 'estree-walker';

// symbol -> source module (relative to src/engine/<folder>/<file>.js, i.e. one level up)
const MAP = {
  clamp: '../coords.js', makeGeoENU: '../coords.js',
  S: '../data.js', C: '../data.js', W: '../data.js', uvAt: '../data.js', terrainAt: '../data.js', SREC: '../data.js', GRID_ANG: '../data.js',
  asNonIndexed: '../geom.js', merge: '../geom.js',
  createAnimals: '../animals.js', createCharacter: '../animals.js', TOOLS: '../animals.js', toolAfterScoop: '../animals.js', POOP_ACTIVE_CAP: '../animals.js',
  loadCeceCrowd: '../crowd.js', loadDrewCrowd: '../crowd.js', loadDadCrowd: '../crowd.js', loadMomCrowd: '../crowd.js',
  createInterior: '../interior.js',
  loadDadController: '../dad.js', loadMomController: '../mom.js',
  DREW_HEIGHT_M: '../drew.js', CECE_HEIGHT_M: '../drew.js',
  createCar: '../car.js', loadRealCar: '../car.js', loadParkedCar: '../car.js', loadDrivableCar: '../car.js', loadCarProto: '../car.js', cycleVehicle: '../car.js', setVehicle: '../car.js', vehicleList: '../car.js', VEHICLES: '../car.js', setCarAniso: '../car.js',
  installDracoDecoder: '../draco-install.js', createAudio: '../audio.js',
  DRIVE_CAMS: '../camera/presets.js', SCOOP_CAMS: '../camera/presets.js',
};

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  const ast = parseAst(src, { ecmaVersion: 'latest', sourceType: 'module' });
  // collect used identifiers (reference position): skip member .property, property keys, import specifiers, decl ids, params
  const used = new Set();
  let usesTHREE = false, usesRoomEnv = false;
  const declared = new Set();
  walk(ast, { enter(node, parent, key) {
    if (node.type === 'ImportDeclaration') { this.skip(); return; }
    if (node.type === 'Identifier') {
      if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
      if (parent.type === 'Property' && key === 'key' && !parent.computed) return;
      if (parent.type === 'VariableDeclarator' && key === 'id') { declared.add(node.name); return; }
      if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression')) { if (key === 'params') { declared.add(node.name); return; } if (key === 'id') { declared.add(node.name); return; } }
      if (node.name === 'THREE') usesTHREE = true;
      else if (node.name === 'RoomEnvironment') usesRoomEnv = true;
      else used.add(node.name);
    }
  }});
  // build import lines
  const bySource = new Map();
  for (const name of used) { if (MAP[name] && !declared.has(name)) { const s = MAP[name]; if (!bySource.has(s)) bySource.set(s, new Set()); bySource.get(s).add(name); } }
  const lines = [];
  if (usesTHREE) lines.push("import * as THREE from 'three';");
  if (usesRoomEnv) lines.push("import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';");
  for (const [s, set] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`import { ${[...set].sort().join(', ')} } from '${s}';`);
  }
  // strip existing leading import block (contiguous import lines + blank/comment lines at top)
  const body = src.split('\n');
  let i = 0;
  while (i < body.length && (/^\s*import\b/.test(body[i]) || body[i].trim() === '' || body[i].trim().startsWith('//'))) i++;
  // keep from first non-import line
  const rest = body.slice(i).join('\n');
  const out = lines.join('\n') + '\n' + rest;
  writeFileSync(file, out);
  console.log(`${file}: ${lines.length} imports [${[...bySource.keys()].map(s => s.replace('../', '')).join(', ')}${usesTHREE ? ', three' : ''}]`);
}
