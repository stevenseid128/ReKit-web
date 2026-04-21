// presets.test.js — quick smoke tests for presets.js
// Run via /test-presets.html and watch the console.

import {
  newPreset,
  resolvePreset,
  applyOverlay,
  diffOverlay,
  upsertPreset,
  deletePreset,
  presetsForPair,
  exportPresetsJSON,
  importPresetsJSON,
  mergeImported
} from './presets.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('%c✓', 'color: green', msg);
  } else {
    failed++;
    console.error('✗', msg);
  }
}

function eqSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ──────────────────────────── Fixtures ────────────────────────────

const srcLib = {
  name: 'MaxiLib',
  rows: [
    { personalName: 'Kick',          midiNote: 36 },
    { personalName: 'Snare',         midiNote: 38 },
    { personalName: 'Snare Rim',     midiNote: 40 },
    { personalName: 'Ride Edge',     midiNote: 59 },
    { personalName: 'Ride Bell',     midiNote: 53 },
    { personalName: 'China Choke',   midiNote: 67 }, // unmapped — not in mini
  ],
};

const dstLib = {
  name: 'MiniLib',
  rows: [
    { personalName: 'Kick',      midiNote: 36 },
    { personalName: 'Snare',     midiNote: 38 },
    { personalName: 'Snare Rim', midiNote: 40 },
    { personalName: 'Crash 1',   midiNote: 49 },
    { personalName: 'Ride',      midiNote: 51 },
    { personalName: '',          midiNote: null },
  ],
};

// Curated mapping: MaxiLib row i ↔ MiniLib row i, when both have notes.
// That mirrors what buildMapping() in mapping.js does (positional on row index).
const curated = new Map([
  [36, 36], // Kick → Kick
  [38, 38], // Snare → Snare
  [40, 40], // Snare Rim → Snare Rim
  [59, 49], // Ride Edge → Crash 1 (by position — user might override this)
  [53, 51], // Ride Bell → Ride
  // 67 (China Choke) → no curated match (unmapped)
]);

// ──────────────────────────── Tests ────────────────────────────

// newPreset shape
{
  const p = newPreset('test', 'MaxiLib', 'MiniLib');
  assert(typeof p.id === 'string' && p.id.startsWith('preset_'), 'newPreset: id is a preset_* string');
  assert(p.sourceLibrary === 'MaxiLib' && p.targetLibrary === 'MiniLib', 'newPreset: scope set correctly');
  assert(Object.keys(p.unmappedAssignments).length === 0, 'newPreset: empty unmappedAssignments');
  assert(Object.keys(p.overrides).length === 0, 'newPreset: empty overrides');
}

// resolvePreset: unmapped assignment resolves by name
{
  const p = newPreset('china→crash', 'MaxiLib', 'MiniLib');
  p.unmappedAssignments = { 'China Choke': 'Crash 1' };
  const { overlay, unresolved } = resolvePreset(p, srcLib, dstLib);
  assert(overlay.get(67) === 49, 'unmapped: China Choke(67) → Crash 1(49)');
  assert(unresolved.length === 0, 'unmapped: no unresolved entries');
}

// resolvePreset: override replaces a curated match
{
  const p = newPreset('fix ride edge', 'MaxiLib', 'MiniLib');
  p.overrides = { 'Ride Edge': 'Ride' };
  const { overlay } = resolvePreset(p, srcLib, dstLib);
  assert(overlay.get(59) === 51, 'override: Ride Edge(59) → Ride(51) in overlay');

  const effective = applyOverlay(curated, overlay);
  assert(effective.get(59) === 51, 'applyOverlay: effective mapping reflects override');
  assert(effective.get(36) === 36, 'applyOverlay: untouched curated entries preserved');
}

// resolvePreset: stale source name is flagged, not silently dropped
{
  const p = newPreset('stale', 'MaxiLib', 'MiniLib');
  p.unmappedAssignments = { 'Flam Tap Ghost': 'Snare' }; // not in srcLib
  const { overlay, unresolved } = resolvePreset(p, srcLib, dstLib);
  assert(overlay.size === 0, 'stale source: no overlay entry added');
  assert(unresolved.length === 1 && unresolved[0].kind === 'unmapped', 'stale source: flagged as unresolved unmapped');
  assert(unresolved[0].reason.includes('source'), 'stale source: reason mentions source');
}

// resolvePreset: stale target name is flagged
{
  const p = newPreset('stale-target', 'MaxiLib', 'MiniLib');
  p.unmappedAssignments = { 'China Choke': 'Mystery Cymbal' };
  const { overlay, unresolved } = resolvePreset(p, srcLib, dstLib);
  assert(overlay.size === 0, 'stale target: no overlay entry added');
  assert(unresolved[0].reason.includes('target'), 'stale target: reason mentions target');
}

// diffOverlay: categorises added vs overridden
{
  const effective = new Map(curated);
  effective.set(67, 49);  // added (was unmapped)
  effective.set(59, 51);  // overridden (was 49)
  const { overriddenSourceNotes, addedSourceNotes } = diffOverlay(curated, effective);
  assert(eqSet(addedSourceNotes, new Set([67])), 'diffOverlay: added = {67}');
  assert(eqSet(overriddenSourceNotes, new Set([59])), 'diffOverlay: overridden = {59}');
}

// upsertPreset inserts then updates
{
  let list = [];
  const p = newPreset('one', 'A', 'B');
  list = upsertPreset(list, p);
  assert(list.length === 1, 'upsert: insert');
  const edited = { ...p, name: 'renamed' };
  list = upsertPreset(list, edited);
  assert(list.length === 1 && list[0].name === 'renamed', 'upsert: update in place');
  assert(list[0].updatedAt >= p.updatedAt, 'upsert: bumps updatedAt');
}

// deletePreset
{
  const p1 = newPreset('one', 'A', 'B');
  const p2 = newPreset('two', 'A', 'B');
  const after = deletePreset([p1, p2], p1.id);
  assert(after.length === 1 && after[0].id === p2.id, 'delete: removes by id');
}

// presetsForPair filters correctly
{
  const list = [
    newPreset('ab', 'A', 'B'),
    newPreset('ac', 'A', 'C'),
    newPreset('ab2', 'A', 'B'),
  ];
  const ab = presetsForPair(list, 'A', 'B');
  assert(ab.length === 2, 'presetsForPair: only matching direction');
}

// export/import round trip
{
  const p = newPreset('roundtrip', 'MaxiLib', 'MiniLib');
  p.unmappedAssignments = { 'China Choke': 'Crash 1' };
  const json = exportPresetsJSON([p]);
  const { presets, error } = importPresetsJSON(json);
  assert(error === null, 'export/import: no error');
  assert(presets.length === 1 && presets[0].unmappedAssignments['China Choke'] === 'Crash 1', 'export/import: content preserved');
}

// import rejects wrong format
{
  const { error: e1 } = importPresetsJSON('not json');
  assert(e1 !== null, 'import: rejects non-JSON');
  const { error: e2 } = importPresetsJSON(JSON.stringify({ foo: 'bar' }));
  assert(e2 !== null, 'import: rejects non-ReKit JSON');
}

// mergeImported reassigns id on collision
{
  const p = newPreset('dup', 'A', 'B');
  const merged = mergeImported([p], [p]);
  assert(merged.length === 2, 'merge: collision produces two entries, not one');
  assert(merged[0].id !== merged[1].id, 'merge: second copy gets a fresh id');
}

// ──────────────────────────── Summary ────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('%c✓ all preset tests passed', 'color: green; font-weight: bold');
} else {
  console.error(`✗ ${failed} test(s) failed`);
}
