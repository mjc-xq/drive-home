#!/usr/bin/env node
// Flag identifiers referenced in a module but declared NOWHERE in it and not imported / not a
// known global / not `ctx` or `THREE`. In the carved engine, such a name was a monolith closure
// var that must now be ctx.* or imported — otherwise it's a runtime ReferenceError the bundler
// won't catch. Over-approximates "declared" (collects every binding name in the file) so it only
// reports genuinely-undefined names.
import { readFileSync } from 'node:fs';
import { parseAst } from 'vite';
import { walk } from 'estree-walker';

const GLOBALS = new Set(['Math','window','document','performance','navigator','setTimeout','clearTimeout','setInterval','clearInterval','Promise','JSON','Object','Array','Number','String','Boolean','Date','console','isNaN','isFinite','parseInt','parseFloat','Infinity','NaN','undefined','globalThis','Set','Map','WeakMap','WeakSet','Float32Array','Float64Array','Uint8Array','Int32Array','Uint16Array','requestAnimationFrame','cancelAnimationFrame','location','fetch','AbortController','Error','TypeError','RegExp','Symbol','localStorage','sessionStorage','innerWidth','innerHeight','devicePixelRatio','matchMedia','getComputedStyle','DeviceOrientationEvent','CustomEvent','Event','URL','URLSearchParams','Blob','FileReader','Image','HTMLCanvasElement','requestIdleCallback','structuredClone','queueMicrotask','atob','btoa','encodeURIComponent','decodeURIComponent','ctx','THREE','arguments','import','self','top','screen','history','alert','crypto','addEventListener','removeEventListener','dispatchEvent','visualViewport','Int8Array','Int16Array','Uint32Array','Uint8ClampedArray','BigInt64Array','DataView','ResizeObserver','IntersectionObserver','MutationObserver']);

function patternNames(node, out) {
  if (!node) return;
  if (node.type === 'Identifier') out.push(node.name);
  else if (node.type === 'ObjectPattern') for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
  else if (node.type === 'ArrayPattern') for (const e of node.elements) patternNames(e, out);
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
}

let bad = 0;
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  let ast; try { ast = parseAst(src, { ecmaVersion: 'latest', sourceType: 'module' }); } catch (e) { console.log(`${file}: PARSE FAIL ${e.message}`); bad++; continue; }
  const declared = new Set();
  const imported = new Set();
  const refs = [];
  walk(ast, { enter(node, parent, key) {
    if (node.type === 'ImportDeclaration') { for (const s of node.specifiers) imported.add(s.local.name); this.skip(); return; }
    if (node.type === 'VariableDeclarator') { const ns = []; patternNames(node.id, ns); ns.forEach(n => declared.add(n)); }
    if (node.type === 'FunctionDeclaration' && node.id) declared.add(node.id.name);
    if (node.type === 'ClassDeclaration' && node.id) declared.add(node.id.name);
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) { for (const p of node.params) { const ns = []; patternNames(p, ns); ns.forEach(n => declared.add(n)); } if (node.id) declared.add(node.id.name); }
    if (node.type === 'CatchClause' && node.param) { const ns = []; patternNames(node.param, ns); ns.forEach(n => declared.add(n)); }
    if (node.type === 'Identifier') {
      if (parent.type === 'MetaProperty') return;
      if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
      if (parent.type === 'Property' && key === 'key' && !parent.computed) return;
      if (parent.type === 'VariableDeclarator' && key === 'id') return;
      if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') && (key === 'id' || key === 'params')) return;
      if (parent.type === 'CatchClause' && key === 'param') return;
      const line = src.slice(0, node.start).split('\n').length;
      refs.push({ name: node.name, line });
    }
  }});
  const unresolved = new Map();
  for (const r of refs) if (!declared.has(r.name) && !imported.has(r.name) && !GLOBALS.has(r.name)) { if (!unresolved.has(r.name)) unresolved.set(r.name, r.line); }
  if (unresolved.size) { bad++; console.log(`\n${file}: ${unresolved.size} UNRESOLVED free identifier(s):`); for (const [n, l] of unresolved) console.log(`  ${file}:${l}  ${n}`); }
}
if (!bad) console.log('All clean — no unresolved free identifiers.');
process.exit(bad ? 1 : 0);
