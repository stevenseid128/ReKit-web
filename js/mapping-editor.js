// mapping-editor.js — modal UI for unmapped-articulation targets + curated-match overrides
//
// Shown when the user clicks "Customize" on the main screen.
// Edits a working Preset object in memory; persistence is explicit via Save.

import {
  newPreset,
  resolvePreset,
  applyOverlay,
  loadPresets,
  savePresets,
  upsertPreset,
} from './presets.js';
import { midiNoteName } from './mapping.js';

const UNMAPPED_VALUE = '__unmapped__';

/**
 * @typedef {Object} EditorContext
 * @property {import('./mapping.js').Library} srcLib
 * @property {import('./mapping.js').Library} dstLib
 * @property {Map<number, number>} curated          - output of buildMapping()
 * @property {Map<number, string>} personalReference - source note → articulation name
 * @property {Set<number>|null} fileScopedUnmappedNotes - source notes unmapped AND present in loaded files; null = no file scope (show library-wide)
 * @property {import('./presets.js').Preset|null} initialPreset - preset to edit, or null for a blank working preset
 * @property {(preset: import('./presets.js').Preset) => void} onApply - called when user clicks Done/Apply
 * @property {() => void} onClose
 */

/** @type {EditorContext|null} */
let ctx = null;

/** @type {import('./presets.js').Preset} */
let working = null;

// Cached DOM refs — populated on first open()
let modal, backdrop, unmappedList, overridesBody, overridesToggle, overridesHeader,
    saveBtn, clearBtn, closeBtn,
    unresolvedBox, titleEl;

// ──────────────────────────── Public API ────────────────────────────

/**
 * Open the Mapping Editor modal.
 * @param {EditorContext} editorCtx
 */
export function openMappingEditor(editorCtx) {
  ctx = editorCtx;
  working = editorCtx.initialPreset
    ? cloneWorkingFromPreset(editorCtx.initialPreset)
    : newPreset('', editorCtx.srcLib.name, editorCtx.dstLib.name);

  ensureModal();
  render();
  modal.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  document.addEventListener('keydown', onKeyDown);
}

function closeMappingEditor() {
  modal.classList.add('hidden');
  backdrop.classList.add('hidden');
  document.removeEventListener('keydown', onKeyDown);
  if (ctx && ctx.onClose) ctx.onClose();
  ctx = null;
  working = null;
}

// ──────────────────────────── Modal DOM ────────────────────────────

function ensureModal() {
  if (modal) return;

  backdrop = document.createElement('div');
  backdrop.className = 'editor-backdrop hidden';
  backdrop.addEventListener('click', onApplyAndClose);
  document.body.appendChild(backdrop);

  modal = document.createElement('div');
  modal.className = 'editor-modal hidden';
  modal.innerHTML = `
    <div class="editor-header">
      <h2 class="editor-title">Customize Mapping</h2>
      <button class="editor-close" title="Close">&times;</button>
    </div>

    <div class="editor-body">
      <div class="editor-section">
        <div class="editor-section-title">
          <span>Unmapped articulations</span>
          <span class="ua-count-badge" id="editor-unmapped-count"></span>
        </div>
        <div class="ua-list" id="editor-unmapped-list"></div>
        <div class="ua-empty" id="editor-unmapped-empty">No unmapped articulations — every source articulation has a curated target.</div>
      </div>

      <div class="editor-section">
        <div class="editor-section-title overrides-header" id="editor-overrides-header">
          <span class="toggle-arrow">&#9654;</span>
          <span>Show all library mappings</span>
          <span class="override-count-badge" id="editor-override-count"></span>
        </div>
        <div class="overrides-body hidden" id="editor-overrides-body"></div>
      </div>

      <div class="editor-unresolved hidden" id="editor-unresolved"></div>
    </div>

    <div class="editor-footer">
      <button class="editor-btn editor-btn-primary" id="editor-save">Save Current Mapping</button>
      <button class="editor-btn" id="editor-clear">Clear Mapping</button>
    </div>
  `;
  document.body.appendChild(modal);

  titleEl       = modal.querySelector('.editor-title');
  unmappedList  = modal.querySelector('#editor-unmapped-list');
  overridesBody = modal.querySelector('#editor-overrides-body');
  overridesHeader = modal.querySelector('#editor-overrides-header');
  saveBtn   = modal.querySelector('#editor-save');
  clearBtn  = modal.querySelector('#editor-clear');
  closeBtn  = modal.querySelector('.editor-close');
  unresolvedBox = modal.querySelector('#editor-unresolved');

  closeBtn.addEventListener('click', onApplyAndClose);
  overridesHeader.addEventListener('click', toggleOverrides);
  saveBtn.addEventListener('click', onSave);
  clearBtn.addEventListener('click', onClear);
}

// ──────────────────────────── Rendering ────────────────────────────

function render() {
  const { srcLib, dstLib, curated, personalReference } = ctx;

  // Target dropdown options — all dst articulations with a note, sorted in
  // piano-roll order (ascending MIDI note). Articulation name is tiebreaker
  // for the rare case where two articulations share a note.
  const dstOptions = dstLib.rows
    .filter(r => r.personalName && r.midiNote !== null)
    .map(r => ({ name: r.personalName, note: r.midiNote }))
    .sort((a, b) => a.note - b.note || a.name.localeCompare(b.name));

  // Resolve working preset → overlay
  const { overlay, unresolved } = resolvePreset(working, srcLib, dstLib);
  const effective = applyOverlay(curated, overlay);

  renderUnmapped(srcLib, personalReference, curated, effective, dstOptions);
  renderOverrides(srcLib, curated, effective, dstOptions);
  renderUnresolved(unresolved);
}

function renderUnmapped(srcLib, personalRef, curated, effective, dstOptions) {
  const countEl = modal.querySelector('#editor-unmapped-count');
  const emptyEl = modal.querySelector('#editor-unmapped-empty');
  const fileScope = ctx.fileScopedUnmappedNotes; // Set<number> | null

  // Unmapped = a source articulation with a note that has no curated match.
  // When fileScope is provided, restrict to notes that actually appear in the
  // loaded MIDI files (matches the main-screen status line).
  const rows = srcLib.rows
    .filter(r => r.personalName && r.midiNote !== null && !curated.has(r.midiNote))
    .filter(r => !fileScope || fileScope.has(r.midiNote))
    .map(r => ({
      sourceName: r.personalName,
      sourceNote: r.midiNote,
      assignedTargetName: working.unmappedAssignments[r.personalName] || ''
    }));

  countEl.textContent = rows.length === 1
    ? '1 unmapped articulation'
    : `${rows.length} unmapped articulations`;

  if (rows.length === 0) {
    emptyEl.textContent = fileScope
      ? 'No unmapped articulations in the loaded files.'
      : 'No unmapped articulations — every source articulation has a curated target.';
    emptyEl.classList.remove('hidden');
    unmappedList.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  unmappedList.classList.remove('hidden');

  unmappedList.innerHTML = rows.map(o => `
    <div class="ua-row">
      <div class="ua-meta">
        <span class="ua-name">${escapeHtml(o.sourceName)}</span>
        <span class="ua-note">${midiNoteName(o.sourceNote)}</span>
      </div>
      <select class="ua-select" data-source-name="${escapeAttr(o.sourceName)}">
        <option value="${UNMAPPED_VALUE}">— individual file (default) —</option>
        ${dstOptions.map(opt => `
          <option value="${escapeAttr(opt.name)}" ${opt.name === o.assignedTargetName ? 'selected' : ''}>
            ${escapeHtml(opt.name)} (${midiNoteName(opt.note)})
          </option>
        `).join('')}
      </select>
    </div>
  `).join('');

  unmappedList.querySelectorAll('.ua-select').forEach(sel => {
    sel.addEventListener('change', onUnmappedChange);
  });
}

function renderOverrides(srcLib, curated, effective, dstOptions) {
  const countEl = modal.querySelector('#editor-override-count');

  // Rows = every source articulation with a curated target.
  const rows = srcLib.rows
    .filter(r => r.personalName && r.midiNote !== null && curated.has(r.midiNote))
    .map(r => {
      const curatedDstNote = curated.get(r.midiNote);
      const effectiveDstNote = effective.get(r.midiNote);
      const curatedDstName = nameForNote(ctx.dstLib, curatedDstNote);
      const effectiveDstName = nameForNote(ctx.dstLib, effectiveDstNote);
      const overridden = working.overrides[r.personalName] !== undefined;
      return {
        sourceName: r.personalName,
        sourceNote: r.midiNote,
        curatedDstName,
        effectiveDstName: overridden ? working.overrides[r.personalName] : curatedDstName,
        overridden
      };
    });

  const overrideCount = rows.filter(r => r.overridden).length;
  countEl.textContent = overrideCount > 0 ? `${overrideCount} overridden` : '';

  overridesBody.innerHTML = rows.map(row => `
    <div class="override-row ${row.overridden ? 'is-overridden' : ''}">
      <div class="override-meta">
        <span class="override-name">${escapeHtml(row.sourceName)}</span>
        <span class="override-note">${midiNoteName(row.sourceNote)}</span>
      </div>
      <div class="override-arrow">→</div>
      <select class="override-select" data-source-name="${escapeAttr(row.sourceName)}" data-curated="${escapeAttr(row.curatedDstName)}">
        ${dstOptions.map(opt => `
          <option value="${escapeAttr(opt.name)}" ${opt.name === row.effectiveDstName ? 'selected' : ''}>
            ${escapeHtml(opt.name)} (${midiNoteName(opt.note)})
          </option>
        `).join('')}
      </select>
      ${row.overridden ? '<span class="override-indicator" title="Overridden from curated">●</span>' : '<span class="override-indicator-placeholder"></span>'}
    </div>
  `).join('');

  overridesBody.querySelectorAll('.override-select').forEach(sel => {
    sel.addEventListener('change', onOverrideChange);
  });
}

function renderUnresolved(unresolved) {
  if (!unresolved || unresolved.length === 0) {
    unresolvedBox.classList.add('hidden');
    unresolvedBox.innerHTML = '';
    return;
  }
  unresolvedBox.classList.remove('hidden');
  unresolvedBox.innerHTML = `
    <div class="unresolved-title">Stale preset entries (skipped):</div>
    ${unresolved.map(u => `
      <div class="unresolved-row">
        <span class="unresolved-kind">${u.kind}</span>
        ${escapeHtml(u.sourceName)} → ${escapeHtml(u.targetName)} <span class="unresolved-reason">(${escapeHtml(u.reason)})</span>
      </div>
    `).join('')}
  `;
}

// ──────────────────────────── Event handlers ────────────────────────────

function onUnmappedChange(e) {
  const sourceName = e.target.dataset.sourceName;
  const value = e.target.value;
  if (value === UNMAPPED_VALUE) {
    delete working.unmappedAssignments[sourceName];
  } else {
    working.unmappedAssignments[sourceName] = value;
  }
  render();
}

function onOverrideChange(e) {
  const sourceName = e.target.dataset.sourceName;
  const curatedName = e.target.dataset.curated;
  const value = e.target.value;
  if (value === curatedName) {
    delete working.overrides[sourceName];
  } else {
    working.overrides[sourceName] = value;
  }
  render();
}

function toggleOverrides() {
  overridesBody.classList.toggle('hidden');
  const arrow = overridesHeader.querySelector('.toggle-arrow');
  arrow.innerHTML = overridesBody.classList.contains('hidden') ? '&#9654;' : '&#9660;';
}

function onClear() {
  working.unmappedAssignments = {};
  working.overrides = {};
  render();
}

function onSave() {
  const suggested = working.name || '';
  const entered = window.prompt('Name this preset:', suggested);
  if (entered === null) return;            // user cancelled
  const name = entered.trim();
  if (!name) return;                       // empty name — treat as cancel

  working.name = name;
  const existing = loadPresets();
  const merged = upsertPreset(existing, working);
  savePresets(merged);
  saveBtn.textContent = 'Saved ✓';
  setTimeout(() => { saveBtn.textContent = 'Save Current Mapping'; }, 1100);
  // Notify caller immediately so the main-screen dropdown updates
  if (ctx && ctx.onApply) ctx.onApply(working);
}

function onApplyAndClose() {
  if (ctx && ctx.onApply) ctx.onApply(working);
  closeMappingEditor();
}

function onKeyDown(e) {
  if (e.key === 'Escape') onApplyAndClose();
}

// ──────────────────────────── Helpers ────────────────────────────

function cloneWorkingFromPreset(p) {
  return {
    ...p,
    unmappedAssignments: { ...p.unmappedAssignments },
    overrides: { ...p.overrides }
  };
}

function nameForNote(lib, note) {
  if (note === null || note === undefined) return '';
  const row = lib.rows.find(r => r.midiNote === note && r.personalName);
  return row ? row.personalName : '';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
