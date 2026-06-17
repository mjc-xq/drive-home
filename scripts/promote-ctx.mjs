#!/usr/bin/env node
// Phase-0 codemod for the engine monolith breakup.
//
// Promotes selected top-level `let`/`const` bindings declared directly inside the
// createEngine() closure to properties on a shared `ctx` object, rewriting every
// in-scope reference. Scope- and comment/string-aware (AST-driven), formatting-preserving
// (magic-string offset edits). Idempotent across runs: once `foo` becomes `ctx.foo`, it is
// a MemberExpression property and is never re-touched.
//
//   node scripts/promote-ctx.mjs --scan                       list top-level decls + shadow conflicts
//   node scripts/promote-ctx.mjs --promote a,b,c [--write]    promote names (dry-run unless --write)
//   node scripts/promote-ctx.mjs --promote-fns a,b [--write]  same, but allow function declarations
//
// File defaults to src/engine/engine.js; override with --file <path>.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAst } from 'vite';
import MagicString from 'magic-string';
import { walk } from 'estree-walker';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const FILE = val('--file') || 'src/engine/engine.js';
const WRITE = has('--write');
const allowFns = has('--promote-fns');
const cut = has('--cut');         // delete the named top-level definitions AND rewrite external call sites to ctx.<ns>.<name>; prints the removed source so it can be pasted into a module factory
const refsOnly = has('--refs-only') || cut;
const NS = val('--ns'); // when set, references rewrite to `ctx.<NS>.<name>` (subsystem namespace) instead of `ctx.<name>`
const pfx = (name) => NS ? `ctx.${NS}.${name}` : `ctx.${name}`;
const promoteArg = val('--promote') || val('--promote-fns') || val('--refs-only') || val('--cut');
const names = new Set((promoteArg || '').split(',').map(s => s.trim()).filter(Boolean));

const src = readFileSync(FILE, 'utf8');
const ast = parseAst(src, { ecmaVersion: 'latest', sourceType: 'module' });

// ---- locate createEngine() ----
let fn = null;
for (const node of ast.body) {
  if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'createEngine') fn = node.declaration;
  if (node.type === 'FunctionDeclaration' && node.id?.name === 'createEngine') fn = node;
}
if (!fn) { console.error('createEngine() not found'); process.exit(1); }
const body = fn.body.body; // direct statements of the closure

// ---- collect binding names from a pattern (Identifier/Object/Array/Assignment/Rest) ----
function patternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern': for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of node.elements) patternNames(e, out); break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
  }
}

// ---- top-level (direct-body) declarations of the closure ----
const topDecls = []; // { name, kind, declNode, declaratorNode, isFn }
for (const st of body) {
  if (st.type === 'VariableDeclaration') {
    for (const d of st.declarations) {
      const ns = []; patternNames(d.id, ns);
      for (const n of ns) topDecls.push({ name: n, kind: st.kind, declNode: st, declaratorNode: d, isFn: d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') });
    }
  } else if (st.type === 'FunctionDeclaration' && st.id) {
    topDecls.push({ name: st.id.name, kind: 'function', declNode: st, declaratorNode: st, isFn: true });
  }
}
const topNames = new Set(topDecls.map(d => d.name));

// ---- nested declared names (shadow set): any binding declared NOT at the direct body level ----
const shadow = new Set();
walk(fn.body, {
  enter(node, parent) {
    // params of any function (always nested bindings) — but NOT the function's own name when
    // it is declared at the closure's direct body level (that is a top-level binding, not a shadow).
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) {
      for (const p of node.params) { const ns = []; patternNames(p, ns); ns.forEach(n => shadow.add(n)); }
      if (node.id && node !== fn && parent !== fn.body) shadow.add(node.id.name);
    }
    if (node.type === 'CatchClause' && node.param) { const ns = []; patternNames(node.param, ns); ns.forEach(n => shadow.add(n)); }
    if (node.type === 'VariableDeclaration' && parent !== fn.body) {
      // declared inside a nested block/loop/function body, not the closure's direct body
      for (const d of node.declarations) { const ns = []; patternNames(d.id, ns); ns.forEach(n => shadow.add(n)); }
    }
    if (node.type === 'ClassDeclaration' && node.id && parent !== fn.body) shadow.add(node.id.name);
  },
});

if (has('--scan')) {
  console.log(`# createEngine() top-level declarations (${topDecls.length})`);
  for (const d of topDecls) console.log(`  ${d.kind.padEnd(8)} ${d.name}${d.isFn ? ' [fn]' : ''}${shadow.has(d.name) ? '  <-- SHADOWED in nested scope' : ''}`);
  const conflicts = [...topNames].filter(n => shadow.has(n));
  console.log(`\n# names also declared in a nested scope (need scope-aware/manual handling): ${conflicts.length ? conflicts.join(', ') : '(none)'}`);
  process.exit(0);
}

if (!names.size) { console.error('nothing to promote; pass --promote a,b,c'); process.exit(1); }

// ---- validate requested names ----
if (!refsOnly) {
  const missing = [...names].filter(n => !topNames.has(n));
  if (missing.length) { console.error('NOT a createEngine top-level declaration: ' + missing.join(', ')); process.exit(1); }
}
const fnsRequested = refsOnly ? [] : topDecls.filter(d => names.has(d.name) && d.kind === 'function');
if (fnsRequested.length && !allowFns) { console.error('these are hoisted function declarations; use --promote-fns to allow: ' + fnsRequested.map(d => d.name).join(', ')); process.exit(1); }

// ---- --cut: delete the named top-level definitions (+ leading line-comment block) ----
const cutRanges = []; // {start, end, name}
if (cut) {
  const missing = [...names].filter(n => !topNames.has(n));
  if (missing.length) { console.error('--cut: not a top-level declaration: ' + missing.join(', ')); process.exit(1); }
  const byNode = new Map(); // declNode -> Set(names) so we can verify whole multi-declarator lines are cut together
  for (const d of topDecls) if (names.has(d.name)) {
    if (!byNode.has(d.declNode)) byNode.set(d.declNode, []);
    byNode.get(d.declNode).push(d);
  }
  for (const [node, ds] of byNode) {
    if (node.type === 'VariableDeclaration' && node.declarations.length !== ds.length) {
      console.error(`--cut: ${ds.map(d=>d.name).join(',')} share a multi-declarator line with un-cut siblings; cut them together or split first`); process.exit(1);
    }
    // extend end past a trailing semicolon
    let end = node.end; while (end < src.length && /[ \t]/.test(src[end])) end++; if (src[end] === ';') end++;
    // capture contiguous leading line-comment block (and the newline before the node)
    let start = node.start;
    // back up to the start of the node's own line
    let ls = src.lastIndexOf('\n', start - 1) + 1;
    start = ls;
    // walk upward over contiguous comment-only lines (// ... ), stop at blank/code
    while (start > 0) {
      const prevLineEnd = start - 1;                 // the '\n' terminating the previous line
      const prevLineStart = src.lastIndexOf('\n', prevLineEnd - 1) + 1;
      const line = src.slice(prevLineStart, prevLineEnd).trim();
      if (line.startsWith('//')) start = prevLineStart; else break;
    }
    // include the trailing newline after end
    if (src[end] === '\n') end++;
    cutRanges.push({ start, end, name: ds.map(d => d.name).join(','), order: node.start });
  }
  cutRanges.sort((a, b) => a.start - b.start);
}
const inCut = (pos) => cutRanges.some(r => pos >= r.start && pos < r.end);

// ---- lexical scope resolver (no `var` in this codebase -> pure block scoping) ----
// We walk pushing a scope on each scope-creating node (collecting that scope's direct
// declarations up-front so forward refs/closures resolve), and resolve every identifier
// reference to its owning scope. Only references owned by the closure's root scope AND in
// `names` are rewritten — so a nested binding of the same name (onRoad param, BFS prev, etc.)
// is correctly left alone.
function collectInto(scopeVars, statements) {
  for (const st of statements || []) {
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) { const ns = []; patternNames(d.id, ns); ns.forEach(n => scopeVars.add(n)); }
    else if (st.type === 'FunctionDeclaration' && st.id) scopeVars.add(st.id.name);
    else if (st.type === 'ClassDeclaration' && st.id) scopeVars.add(st.id.name);
  }
}
function isFnNode(n) { return n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'); }
function makeScope(node, parent) {
  const vars = new Set();
  if (isFnNode(node)) { for (const p of node.params) { const ns = []; patternNames(p, ns); ns.forEach(n => vars.add(n)); } if (node.body && node.body.type === 'BlockStatement') collectInto(vars, node.body.body); else if (node.body && node.body.type !== 'BlockStatement') { /* arrow expr body: no decls */ } }
  else if (node.type === 'BlockStatement') collectInto(vars, node.body);
  else if (node.type === 'ForStatement') { if (node.init && node.init.type === 'VariableDeclaration') collectInto(vars, [node.init]); }
  else if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') { if (node.left && node.left.type === 'VariableDeclaration') collectInto(vars, [node.left]); }
  else if (node.type === 'CatchClause') { if (node.param) { const ns = []; patternNames(node.param, ns); ns.forEach(n => vars.add(n)); } }
  else if (node.type === 'SwitchStatement') for (const c of node.cases) collectInto(vars, c.consequent);
  else if (node.type === 'StaticBlock') collectInto(vars, node.body);
  return { vars, node };
}
function createsScope(node, parent) {
  if (isFnNode(node)) return true;
  if (node.type === 'BlockStatement') return !isFnNode(parent); // a fn body block is the fn's scope, don't double
  if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') return true;
  if (node.type === 'CatchClause' || node.type === 'SwitchStatement' || node.type === 'StaticBlock') return true;
  return false;
}

const ms = new MagicString(src);
let refCount = 0, shorthandCount = 0;

// ---- rewrite the declarations (minimal in-place edits; initializers left for the ref pass) ----
// Strategy that avoids magic-string chunk collisions when one promoted decl's initializer
// references ANOTHER promoted name: do NOT slice/rebuild initializers. Instead, for a
// VariableDeclaration whose declarators are ALL promoted, strip the `let`/`const` keyword and
// rewrite each declarator id `x` -> `ctx.x`, leaving ` = <init>` in place. The result is a
// comma-expression statement (`ctx.a = 0, ctx.b = 1;`), and inner refs to promoted names inside
// the initializers are handled by the reference pass (separate ranges).
let declCount = 0;
if (!refsOnly) {
  // 1) hoisted function declarations
  for (const d of topDecls) if (names.has(d.name) && d.kind === 'function') {
    ms.appendLeft(d.declNode.start, `${pfx(d.name)} = `); declCount++;
  }
  // 2) variable declarations — auto-include siblings, reject destructure patterns
  const varDecls = new Map(); // VariableDeclaration -> declarators[]
  for (const d of topDecls) if (names.has(d.name) && d.kind !== 'function') {
    if (!varDecls.has(d.declNode)) varDecls.set(d.declNode, d.declNode.declarations);
  }
  for (const decl of varDecls.keys()) {
    const patternDeclarators = decl.declarations.filter(dd => dd.id.type !== 'Identifier');
    if (patternDeclarators.length) {
      const ns = []; patternDeclarators.forEach(dd => patternNames(dd.id, ns));
      console.error(`destructure/pattern declarator (handle manually + use --refs-only): ${ns.join(', ')} (line offset ${decl.start})`);
      process.exit(1);
    }
    // auto-include every sibling declarator so we never leave a bare `name = init` (strict-mode ReferenceError)
    const siblingNames = decl.declarations.map(dd => dd.id.name);
    const notRequested = siblingNames.filter(n => !names.has(n));
    if (notRequested.length) { console.error(`auto-including multi-declarator siblings: ${notRequested.join(', ')} (declared with ${siblingNames.filter(n => names.has(n)).join(', ')})`); notRequested.forEach(n => names.add(n)); }
    // strip the keyword
    ms.overwrite(decl.start, decl.declarations[0].start, '');
    // rewrite each declarator id
    for (const dd of decl.declarations) { ms.overwrite(dd.id.start, dd.id.end, pfx(dd.id.name)); declCount++; }
  }
}

// ---- rewrite references (scope-aware) ----
const scopeStack = [];
const ancestors = []; // node stack so we can see a Property's parent (ObjectExpression vs ObjectPattern)
let rootScope = null;
walk(fn, {
  enter(node, parent, key) {
    if (createsScope(node, parent)) {
      const sc = makeScope(node, parent);
      if (refsOnly && node === fn) for (const n of names) sc.vars.add(n); // seed root with refs-only names (no decl exists)
      node.__scope = sc;
      if (node === fn) rootScope = sc;
      scopeStack.push(sc);
    }
    ancestors.push(node);
    if (node.type !== 'Identifier' || !names.has(node.name)) return;
    if (cut && inCut(node.start)) return; // inside a to-be-deleted definition — don't rewrite (it's going away)
    // skip declaration ids & binding positions
    if (parent.type === 'VariableDeclarator' && key === 'id') return;
    if (isFnNode(parent) && (key === 'id' || key === 'params')) return;
    let shorthandValue = false;
    if (parent.type === 'Property') {
      // A shorthand Property's key and value are the SAME node; estree-walker visits it twice
      // (as 'key' then 'value'). Act ONLY on the 'value' visit so we expand exactly once.
      if (parent.shorthand) { if (key !== 'value') return; shorthandValue = true; }
      else if (key === 'key' && !parent.computed) return; // non-computed property key
    }
    if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return; // obj.NAME
    if (parent.type === 'MethodDefinition' && key === 'key' && !parent.computed) return;
    if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
    // resolve to the owning scope: only rewrite references owned by the closure root scope
    let owner = null;
    for (let i = scopeStack.length - 1; i >= 0; i--) if (scopeStack[i].vars.has(node.name)) { owner = scopeStack[i]; break; }
    if (!refsOnly && owner !== rootScope) return; // shadowed by a nested binding (or unresolved) -> leave alone
    if (refsOnly && owner && owner !== rootScope) return; // refs-only: skip genuine nested bindings
    if (shorthandValue) {
      const grandparent = ancestors[ancestors.length - 3]; // [-1]=identifier, [-2]=Property, [-3]=Object{Expression,Pattern}
      if (grandparent && grandparent.type === 'ObjectPattern') {
        // pattern shorthand: declaration patterns shadow (skip); assignment-target patterns need expansion
        return; // promoted names are never re-declared via pattern (would shadow) -> safe to leave
      }
      ms.appendLeft(node.end, `: ${pfx(node.name)}`); shorthandCount++; return; // { x } -> { x: ctx.x } in an object literal
    }
    ms.overwrite(node.start, node.end, pfx(node.name));
    refCount++;
  },
  leave(node) { ancestors.pop(); if (node.__scope) { scopeStack.pop(); delete node.__scope; } },
});

// ---- --cut: remove the definition ranges, and write the removed source to --out (or stdout) ----
let removed = '';
if (cut) {
  for (const r of cutRanges) { removed += src.slice(r.start, r.end); ms.remove(r.start, r.end); }
  const outPath = val('--out');
  if (outPath && WRITE) { writeFileSync(outPath, removed); console.log(`  removed-source -> ${outPath} (${cutRanges.length} defs)`); }
  else { console.log(`\n----- REMOVED SOURCE (${cutRanges.length} defs) -----\n${removed}\n----- END REMOVED -----`); }
}

console.log(`${cut ? 'cut' : 'promote'}${refsOnly && !cut ? ' (refs-only)' : ''}: ${[...names].join(', ')}`);
console.log(`  declarations rewritten: ${declCount}, references: ${refCount}, shorthand expanded: ${shorthandCount}${cut ? `, defs removed: ${cutRanges.length}` : ''}`);
if (WRITE) { writeFileSync(FILE, ms.toString()); console.log(`  WROTE ${FILE}`); }
else console.log('  (dry-run; pass --write to apply)');
