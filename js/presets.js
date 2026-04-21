// presets.js — custom mapping preset schema, overlay logic, storage, import/export
//
// Presets are articulation-name-keyed (not raw MIDI note ints) so they survive
// mapping.csv edits. At apply time, names are resolved to notes using the
// current CSV-derived libraries.

const STORAGE_KEY = 'rekit.presets.v1';

/**
 * @typedef {Object} Preset
 * @property {string} id                 - stable unique id
 * @property {string} name               - user-visible name
 * @property {string} sourceLibrary      - source library name (as in CSV header)
 * @property {string} targetLibrary      - target library name (as in CSV header)
 * @property {Object<string,string>} unmappedAssignments - sourceArticulationName → targetArticulationName (for source articulations with no curated match)
 * @property {Object<string,string>} overrides           - sourceArticulationName → targetArticulationName (overrides curated match)
 * @property {number} createdAt          - epoch ms
 * @property {number} updatedAt          - epoch ms
 */

/**
 * Build a fresh, empty preset scoped to a library pair.
 * @param {string} name
 * @param {string} sourceLibrary
 * @param {string} targetLibrary
 * @returns {Preset}
 */
export function newPreset(name, sourceLibrary, targetLibrary) {
  const now = Date.now();
  return {
    id: `preset_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    sourceLibrary,
    targetLibrary,
    unmappedAssignments: {},
    overrides: {},
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Resolve a preset against the current libraries → note-level mapping overlay.
 *
 * Returns only the extra/changed entries the preset contributes; callers
 * compose this with the curated mapping from buildMapping().
 *
 * An entry in unmappedAssignments or overrides that can't be resolved (name
 * not present in the current library, or target has no MIDI note) is silently
 * skipped and reported in `unresolved` so the UI can surface stale presets.
 *
 * @param {Preset} preset
 * @param {Library} srcLib
 * @param {Library} dstLib
 * @returns {{ overlay: Map<number, number>, unresolved: { kind: 'unmapped'|'override', sourceName: string, targetName: string, reason: string }[] }}
 */
export function resolvePreset(preset, srcLib, dstLib) {
  const overlay = new Map();
  const unresolved = [];

  const srcByName = new Map();
  for (const row of srcLib.rows) {
    if (row.personalName && row.midiNote !== null) {
      srcByName.set(row.personalName, row.midiNote);
    }
  }

  const dstByName = new Map();
  for (const row of dstLib.rows) {
    if (row.personalName && row.midiNote !== null) {
      dstByName.set(row.personalName, row.midiNote);
    }
  }

  const apply = (kind, assignments) => {
    for (const [sourceName, targetName] of Object.entries(assignments)) {
      const srcNote = srcByName.get(sourceName);
      if (srcNote === undefined) {
        unresolved.push({ kind, sourceName, targetName, reason: 'source articulation no longer in library' });
        continue;
      }
      const dstNote = dstByName.get(targetName);
      if (dstNote === undefined) {
        unresolved.push({ kind, sourceName, targetName, reason: 'target articulation no longer in library' });
        continue;
      }
      overlay.set(srcNote, dstNote);
    }
  };

  apply('override', preset.overrides);
  apply('unmapped', preset.unmappedAssignments);

  return { overlay, unresolved };
}

/**
 * Compose a curated mapping with a preset overlay.
 * Overlay entries replace curated entries for the same source note.
 *
 * @param {Map<number, number>} curated
 * @param {Map<number, number>} overlay
 * @returns {Map<number, number>}
 */
export function applyOverlay(curated, overlay) {
  const out = new Map(curated);
  for (const [srcNote, dstNote] of overlay) {
    out.set(srcNote, dstNote);
  }
  return out;
}

/**
 * Partition a mapping into curated-vs-overridden for UI indicators.
 * @param {Map<number, number>} curated
 * @param {Map<number, number>} effective
 * @returns {{ overriddenSourceNotes: Set<number>, addedSourceNotes: Set<number> }}
 *   overriddenSourceNotes = source notes whose target changed from curated
 *   addedSourceNotes      = source notes that had no curated entry (from unmappedAssignments)
 */
export function diffOverlay(curated, effective) {
  const overriddenSourceNotes = new Set();
  const addedSourceNotes = new Set();
  for (const [srcNote, dstNote] of effective) {
    if (!curated.has(srcNote)) {
      addedSourceNotes.add(srcNote);
    } else if (curated.get(srcNote) !== dstNote) {
      overriddenSourceNotes.add(srcNote);
    }
  }
  return { overriddenSourceNotes, addedSourceNotes };
}

// ──────────────────────────── Storage ────────────────────────────

/**
 * Read all saved presets from localStorage. Returns [] if none or on parse error.
 * @returns {Preset[]}
 */
export function loadPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persist the full preset list to localStorage.
 * @param {Preset[]} presets
 */
export function savePresets(presets) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

/**
 * Insert or update a preset by id. Returns the new list.
 * @param {Preset[]} presets
 * @param {Preset} preset
 * @returns {Preset[]}
 */
export function upsertPreset(presets, preset) {
  const updated = { ...preset, updatedAt: Date.now() };
  const idx = presets.findIndex(p => p.id === preset.id);
  if (idx === -1) return [...presets, updated];
  const copy = [...presets];
  copy[idx] = updated;
  return copy;
}

/**
 * Remove a preset by id. Returns the new list.
 * @param {Preset[]} presets
 * @param {string} id
 * @returns {Preset[]}
 */
export function deletePreset(presets, id) {
  return presets.filter(p => p.id !== id);
}

/**
 * Filter presets applicable to a given library pair.
 * @param {Preset[]} presets
 * @param {string} sourceLibrary
 * @param {string} targetLibrary
 * @returns {Preset[]}
 */
export function presetsForPair(presets, sourceLibrary, targetLibrary) {
  return presets.filter(p =>
    p.sourceLibrary === sourceLibrary && p.targetLibrary === targetLibrary
  );
}

// ──────────────────────────── Import / Export ────────────────────────────

const EXPORT_VERSION = 1;

/**
 * Serialize a preset list to a JSON string for download.
 * @param {Preset[]} presets
 * @returns {string}
 */
export function exportPresetsJSON(presets) {
  return JSON.stringify({
    format: 'rekit-presets',
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    presets
  }, null, 2);
}

/**
 * Parse a previously-exported JSON string.
 * @param {string} text
 * @returns {{ presets: Preset[], error: string|null }}
 */
export function importPresetsJSON(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { presets: [], error: 'file is not valid JSON' };
  }
  if (!parsed || parsed.format !== 'rekit-presets') {
    return { presets: [], error: 'not a ReKit preset file' };
  }
  if (!Array.isArray(parsed.presets)) {
    return { presets: [], error: 'preset list missing or malformed' };
  }
  const valid = parsed.presets.filter(isPresetShape);
  if (valid.length === 0) {
    return { presets: [], error: 'file contained no valid presets' };
  }
  return { presets: valid, error: null };
}

function isPresetShape(p) {
  return p
    && typeof p.id === 'string'
    && typeof p.name === 'string'
    && typeof p.sourceLibrary === 'string'
    && typeof p.targetLibrary === 'string'
    && p.unmappedAssignments && typeof p.unmappedAssignments === 'object'
    && p.overrides && typeof p.overrides === 'object';
}

/**
 * Merge imported presets into the existing list. Collisions on id are resolved
 * by assigning a fresh id to the imported copy (never overwrites existing data).
 * @param {Preset[]} existing
 * @param {Preset[]} incoming
 * @returns {Preset[]}
 */
export function mergeImported(existing, incoming) {
  const existingIds = new Set(existing.map(p => p.id));
  const remapped = incoming.map(p => {
    if (!existingIds.has(p.id)) return p;
    const now = Date.now();
    return { ...p, id: `preset_${now}_${Math.random().toString(36).slice(2, 8)}` };
  });
  return [...existing, ...remapped];
}
