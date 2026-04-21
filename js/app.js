// app.js — UI controller: drag-drop, file list, convert orchestration

import { loadCSV, buildMapping, midiNoteName } from './mapping.js';
import { processMIDIFile, scanMIDIFileNotes } from './midi-processor.js';
import {
  loadPresets,
  savePresets,
  deletePreset as removePresetById,
  presetsForPair,
  resolvePreset,
  applyOverlay,
  exportPresetsJSON,
  importPresetsJSON,
  mergeImported,
} from './presets.js';
import { openMappingEditor } from './mapping-editor.js';

// State
let libraries = [];
let curatedMapping = new Map();     // source note → dest note (from CSV, unmodified)
let currentMapping = new Map();     // effective mapping (curated + active preset overlay)
let currentPersonalRef = new Map();
let activePreset = null;            // Preset | null — null = "none"/passive default
let midiFiles = []; // { id, file, name }
let scanResults = null;      // null = no scan, array = per-file scan results
let convertedResults = null; // null = not converted, array = per-file results

// DOM refs
const sourceSelect = document.getElementById('source-library');
const destSelect = document.getElementById('dest-library');
const fileInput = document.getElementById('file-input');
const clearAllBtn = document.getElementById('clear-all-btn');
const convertBtn = document.getElementById('convert-btn');
const fileCount = document.getElementById('file-count');
const dropZone = document.getElementById('drop-zone');
const emptyState = document.getElementById('empty-state');
const fileList = document.getElementById('file-list');
const errorMessage = document.getElementById('error-message');
const infoMessage = document.getElementById('info-message');
const dropOverlay = document.getElementById('drop-overlay');
const downloadSection = document.getElementById('download-section');
const downloadBtn = document.getElementById('download-btn');
const presetSelect = document.getElementById('preset-select');
const presetDeleteBtn = document.getElementById('preset-delete-btn');
const presetImportBtn = document.getElementById('preset-import-btn');
const presetExportBtn = document.getElementById('preset-export-btn');
const presetImportInput = document.getElementById('preset-import-input');
const openEditorLink = document.getElementById('open-editor-link');

let nextId = 0;
let lastDownloadBlob = null;
let lastDownloadName = null;

// ──────────────────────────── CSV Load ────────────────────────────

async function init() {
  try {
    const resp = await fetch('assets/mapping.csv');
    const csvText = await resp.text();
    const result = loadCSV(csvText);

    if (result.error) {
      showError(result.error);
      return;
    }

    libraries = result.libraries;
    populateDropdowns();
    refreshPresetUI();
    refreshMappingStatus();
    updateConvertBtn();
  } catch (e) {
    showError('Could not load mapping.csv — ensure it is in the assets/ folder.');
  }
}

function populateDropdowns() {
  const sorted = libraries.map(l => l.name).sort();
  sourceSelect.innerHTML = '';
  destSelect.innerHTML = '';

  // Blank placeholder
  const srcPlaceholder = new Option('– Select –', '');
  srcPlaceholder.disabled = true;
  srcPlaceholder.selected = true;
  sourceSelect.add(srcPlaceholder);

  const dstPlaceholder = new Option('– Select –', '');
  dstPlaceholder.disabled = true;
  dstPlaceholder.selected = true;
  destSelect.add(dstPlaceholder);

  for (const name of sorted) {
    sourceSelect.add(new Option(name, name));
    destSelect.add(new Option(name, name));
  }
}

// ──────────────────────────── Mapping ────────────────────────────

function updateMapping() {
  const srcLib = libraries.find(l => l.name === sourceSelect.value);
  const dstLib = libraries.find(l => l.name === destSelect.value);

  if (!srcLib || !dstLib) {
    curatedMapping = new Map();
    currentMapping = new Map();
    currentPersonalRef = new Map();
    // library pair incomplete — clear preset state
    activePreset = null;
    refreshPresetUI();
    refreshMappingStatus();
    return;
  }

  const result = buildMapping(srcLib, dstLib);
  curatedMapping = result.mapping;
  currentPersonalRef = result.personalReference;

  // If the active preset doesn't match the new pair, drop it
  if (activePreset && (activePreset.sourceLibrary !== srcLib.name || activePreset.targetLibrary !== dstLib.name)) {
    activePreset = null;
  }

  recomputeEffectiveMapping();
  refreshPresetUI();
  refreshMappingStatus();

  clearConvertedResults();
  runAutoScan();
  updateConvertBtn();
}

function recomputeEffectiveMapping() {
  const srcLib = libraries.find(l => l.name === sourceSelect.value);
  const dstLib = libraries.find(l => l.name === destSelect.value);
  if (!srcLib || !dstLib) {
    currentMapping = new Map(curatedMapping);
    return;
  }

  if (!activePreset) {
    currentMapping = new Map(curatedMapping);
    return;
  }

  const { overlay } = resolvePreset(activePreset, srcLib, dstLib);
  currentMapping = applyOverlay(curatedMapping, overlay);
}

// ──────────────────────────── Preset UI ────────────────────────────

function refreshPresetUI() {
  const srcName = sourceSelect.value;
  const dstName = destSelect.value;

  presetSelect.innerHTML = '';
  const noneOpt = new Option('None', '');
  presetSelect.add(noneOpt);

  if (!srcName || !dstName) {
    presetSelect.disabled = true;
    presetDeleteBtn.disabled = true;
    return;
  }

  presetSelect.disabled = false;
  const applicable = presetsForPair(loadPresets(), srcName, dstName);
  for (const p of applicable) {
    const opt = new Option(p.name || '(unnamed)', p.id);
    presetSelect.add(opt);
  }
  presetSelect.value = activePreset ? activePreset.id : '';
  presetDeleteBtn.disabled = !activePreset;
}

function refreshMappingStatus() {
  // The top-level "Customize mapping →" link is now only a fallback entry
  // point shown when libraries are selected but no files are loaded.
  // When files are loaded, per-file Customize buttons take over.
  const srcName = sourceSelect.value;
  const dstName = destSelect.value;
  const canEdit = Boolean(srcName && dstName);
  const filesPresent = midiFiles.length > 0;

  if (canEdit && !filesPresent) {
    openEditorLink.classList.remove('hidden');
  } else {
    openEditorLink.classList.add('hidden');
  }
}

function onPresetSelectChange() {
  const id = presetSelect.value;
  if (!id) {
    activePreset = null;
  } else {
    const all = loadPresets();
    activePreset = all.find(p => p.id === id) || null;
  }
  recomputeEffectiveMapping();
  refreshMappingStatus();
  presetDeleteBtn.disabled = !activePreset;
  clearConvertedResults();
  runAutoScan();
}

function onPresetDelete() {
  if (!activePreset) return;
  const name = activePreset.name || 'this preset';
  if (!confirm(`Delete preset "${name}"?`)) return;
  const remaining = removePresetById(loadPresets(), activePreset.id);
  savePresets(remaining);
  activePreset = null;
  recomputeEffectiveMapping();
  refreshPresetUI();
  refreshMappingStatus();
  clearConvertedResults();
  runAutoScan();
}

function onPresetExport() {
  const all = loadPresets();
  if (all.length === 0) {
    showError('No presets to export.');
    return;
  }
  const json = exportPresetsJSON(all);
  const blob = new Blob([json], { type: 'application/json' });
  saveAs(blob, 'rekit-presets.json');
}

function onPresetImportClick() {
  presetImportInput.click();
}

function onPresetImportFile() {
  const file = presetImportInput.files && presetImportInput.files[0];
  presetImportInput.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const { presets: incoming, error } = importPresetsJSON(String(reader.result || ''));
    if (error) {
      showError(`Preset import failed: ${error}`);
      return;
    }
    const merged = mergeImported(loadPresets(), incoming);
    savePresets(merged);
    refreshPresetUI();
    showInfo(`Imported ${incoming.length} preset${incoming.length === 1 ? '' : 's'}.`);
  };
  reader.onerror = () => showError('Could not read preset file.');
  reader.readAsText(file);
}

function onOpenEditor(e) {
  e.preventDefault();
  const srcLib = libraries.find(l => l.name === sourceSelect.value);
  const dstLib = libraries.find(l => l.name === destSelect.value);
  if (!srcLib || !dstLib) return;

  // Collect the set of unmapped notes actually present in loaded files. If no
  // files are loaded, pass null so the editor falls back to library-wide.
  let fileScopedUnmappedNotes = null;
  if (scanResults && midiFiles.length > 0) {
    fileScopedUnmappedNotes = new Set();
    for (const r of scanResults) {
      if (!r || r.error) continue;
      for (const u of r.unmapped) {
        if (!currentMapping.has(u.note)) fileScopedUnmappedNotes.add(u.note);
      }
    }
  }

  openMappingEditor({
    srcLib,
    dstLib,
    curated: curatedMapping,
    personalReference: currentPersonalRef,
    fileScopedUnmappedNotes,
    initialPreset: activePreset,
    onApply: (preset) => {
      // Reflect in-editor edits live on the main screen
      activePreset = preset;
      recomputeEffectiveMapping();
      refreshPresetUI();
      refreshMappingStatus();
      clearConvertedResults();
      runAutoScan();
    },
    onClose: () => {}
  });
}

// ──────────────────────────── Auto-Scan ────────────────────────────

function runAutoScan() {
  if (!sourceSelect.value || !destSelect.value || midiFiles.length === 0) {
    scanResults = null;
    refreshMappingStatus();
    return;
  }

  // Read all files and scan notes; uses promises but updates UI when done
  const promises = midiFiles.map(entry =>
    entry.file.arrayBuffer().then(arrayBuffer => {
      let notes;
      try {
        notes = scanMIDIFileNotes(arrayBuffer);
      } catch {
        return { id: entry.id, error: 'could not parse MIDI file', unmapped: [] };
      }

      const unmapped = [];
      for (const note of notes) {
        if (currentPersonalRef.has(note) && !currentMapping.has(note)) {
          unmapped.push({ note, name: currentPersonalRef.get(note) });
        }
      }
      unmapped.sort((a, b) => a.note - b.note);
      return { id: entry.id, error: null, unmapped };
    }).catch(() => {
      return { id: entry.id, error: 'could not read file', unmapped: [] };
    })
  );

  Promise.all(promises).then(results => {
    scanResults = results;
    renderFileList();
    refreshMappingStatus();
  });
}

// ──────────────────────────── File Management ────────────────────────────

function addFiles(fileListInput) {
  for (const file of fileListInput) {
    if (!file.name.match(/\.(mid|midi)$/i)) continue;
    if (midiFiles.some(f => f.name === file.name && f.file.size === file.size)) continue;
    midiFiles.push({ id: nextId++, file, name: file.name });
  }
  clearConvertedResults();
  runAutoScan();
  renderFileList();
}

function removeFile(id) {
  midiFiles = midiFiles.filter(f => f.id !== id);
  clearConvertedResults();
  runAutoScan();
  renderFileList();
}

function clearAll() {
  midiFiles = [];
  scanResults = null;
  clearConvertedResults();
  renderFileList();
  hideMessages();
}

function clearConvertedResults() {
  convertedResults = null;
  lastDownloadBlob = null;
  lastDownloadName = null;
  downloadSection.classList.add('hidden');
}

function renderFileList() {
  if (midiFiles.length === 0) {
    emptyState.classList.remove('hidden');
    fileList.classList.add('hidden');
    fileCount.textContent = '';
    clearAllBtn.disabled = true;
  } else {
    emptyState.classList.add('hidden');
    fileList.classList.remove('hidden');
    fileCount.textContent = `${midiFiles.length} file${midiFiles.length === 1 ? '' : 's'}`;
    clearAllBtn.disabled = false;

    // Prefer convertedResults, then scanResults, then plain list
    if (convertedResults || scanResults) {
      renderAnnotatedFileList();
    } else {
      renderSimpleFileList();
    }
  }
  updateConvertBtn();
}

function renderSimpleFileList() {
  const canCustomize = Boolean(sourceSelect.value && destSelect.value);
  fileList.innerHTML = midiFiles.map(f =>
    `<div class="file-row" data-id="${f.id}">
      <span class="file-name">${escapeHtml(f.name)}</span>
      ${canCustomize ? '<button class="file-customize-btn" title="Customize mapping">Customize</button>' : ''}
      <button class="remove-btn" title="Remove">&times;</button>
    </div>`
  ).join('');

  attachRemoveListeners();
  attachCustomizeListeners();
}

function renderAnnotatedFileList() {
  // Prefer convertedResults over scanResults for each file
  const activeResults = convertedResults || scanResults;
  const canCustomize = Boolean(sourceSelect.value && destSelect.value);
  const customizeBtn = canCustomize ? '<button class="file-customize-btn" title="Customize mapping">Customize</button>' : '';

  fileList.innerHTML = midiFiles.map(f => {
    const result = activeResults ? activeResults.find(r => r.id === f.id) : null;
    if (!result) {
      return `<div class="file-row" data-id="${f.id}">
        <span class="file-name">${escapeHtml(f.name)}</span>
        ${customizeBtn}
        <button class="remove-btn" title="Remove">&times;</button>
      </div>`;
    }

    if (result.error) {
      return `<div class="file-row file-row-error" data-id="${f.id}">
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-error">${escapeHtml(result.error)}</span>
        ${customizeBtn}
        <button class="remove-btn" title="Remove">&times;</button>
      </div>`;
    }

    const unmappedCount = result.unmapped.length;
    const hasUnmapped = unmappedCount > 0;
    const expandedClass = hasUnmapped ? 'expanded' : '';
    const toggleId = `toggle-${f.id}`;

    let unmappedRows = '';
    if (hasUnmapped) {
      unmappedRows = `<div class="unmapped-details" id="details-${f.id}">
        ${result.unmapped.map(o =>
          `<div class="unmapped-detail-row">
            <span>${escapeHtml(o.name)}</span>
            <span class="unmapped-note">${midiNoteName(o.note)}</span>
          </div>`
        ).join('')}
      </div>`;
    }

    const badge = hasUnmapped
      ? `<span class="unmapped-badge">${unmappedCount} unmapped</span>`
      : `<span class="file-ok">\u2713</span>`;

    return `<div class="file-row-wrap ${expandedClass}" data-id="${f.id}">
      <div class="file-row file-row-converted" id="${toggleId}">
        <span class="toggle-arrow">${hasUnmapped ? '\u25BC' : ''}</span>
        <span class="file-name">${escapeHtml(f.name)}</span>
        ${badge}
        ${customizeBtn}
        <button class="remove-btn" title="Remove">&times;</button>
      </div>
      ${unmappedRows}
    </div>`;
  }).join('');

  // Attach toggle listeners
  fileList.querySelectorAll('.file-row-converted').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.remove-btn') || e.target.closest('.file-customize-btn')) return;
      const wrap = row.closest('.file-row-wrap');
      if (!wrap || !wrap.querySelector('.unmapped-details')) return;
      wrap.classList.toggle('expanded');
      const arrow = row.querySelector('.toggle-arrow');
      if (arrow) arrow.textContent = wrap.classList.contains('expanded') ? '\u25BC' : '\u25B6';
    });
  });

  attachRemoveListeners();
  attachCustomizeListeners();
}

function attachRemoveListeners() {
  fileList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Walk up until we find an element carrying data-id. The annotated
      // layout has data-id on the outer .file-row-wrap, but closest() would
      // otherwise stop at the inner .file-row which has no data-id.
      let el = e.target;
      while (el && !(el.dataset && el.dataset.id)) el = el.parentElement;
      if (!el) return;
      const id = parseInt(el.dataset.id, 10);
      if (!Number.isNaN(id)) removeFile(id);
    });
  });
}

function attachCustomizeListeners() {
  fileList.querySelectorAll('.file-customize-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onOpenEditor(e);
    });
  });
}

function updateConvertBtn() {
  convertBtn.disabled = midiFiles.length === 0 || !sourceSelect.value || !destSelect.value;
}

// ──────────────────────────── Convert ────────────────────────────

async function runConversion() {
  hideMessages();
  if (midiFiles.length === 0) return;

  const dstLibName = destSelect.value;
  convertBtn.disabled = true;
  convertBtn.textContent = 'Converting...';

  const results = [];
  const allOutputFiles = [];
  const failures = [];

  for (const entry of midiFiles) {
    const result = await processMIDIFile(entry.file, currentMapping, currentPersonalRef, dstLibName);
    if (result.error) {
      results.push({ id: entry.id, error: result.error, unmapped: [], outputFiles: [] });
      failures.push(`${entry.name}: ${result.error}`);
    } else {
      // Extract unmapped info: files in a folder are unmapped articulations
      const unmapped = [];
      const seen = new Set();
      for (const f of result.files) {
        if (f.folder) {
          // Extract articulation name from filename: baseName(articulationName).mid
          const match = f.name.match(/\(([^)]+)\)\.mid$/i);
          const name = match ? match[1] : f.name;
          // Get the note from the unmapped data — parse the note number from the name
          // We need the actual note, so let's look it up from personalReference
          // The unmapped files come from processMIDIFile which groups by articulation name
          // We can find the note by looking up in personalReference
          let noteNum = null;
          for (const [note, artName] of currentPersonalRef) {
            const noteName = midiNoteName(note);
            const label = artName === noteName ? noteName : `${artName} - ${noteName}`;
            if (name === label || name === artName || name === noteName) {
              noteNum = note;
              break;
            }
          }
          const key = name;
          if (!seen.has(key)) {
            seen.add(key);
            unmapped.push({ name: name, note: noteNum !== null ? noteNum : 0 });
          }
        }
      }
      results.push({ id: entry.id, error: null, unmapped, outputFiles: result.files });
      allOutputFiles.push(...result.files);
    }
  }

  convertedResults = results;

  // Prepare download blob
  if (allOutputFiles.length > 0) {
    if (allOutputFiles.length === 1 && !allOutputFiles[0].folder) {
      const f = allOutputFiles[0];
      lastDownloadBlob = new Blob([f.data], { type: 'audio/midi' });
      lastDownloadName = f.name;
    } else {
      const zip = new JSZip();
      for (const f of allOutputFiles) {
        const path = f.folder ? `${f.folder}/${f.name}` : f.name;
        zip.file(path, f.data);
      }
      lastDownloadBlob = await zip.generateAsync({ type: 'blob' });
      lastDownloadName = 'ReKit_Output.zip';
    }
    downloadSection.classList.remove('hidden');
  }

  // Show error messages
  if (failures.length > 0) {
    showError(failures.join('\n'));
  }

  // Immediately trigger download
  if (lastDownloadBlob && lastDownloadName) {
    saveAs(lastDownloadBlob, lastDownloadName);
  }

  // Re-render file list with unmapped details
  renderFileList();

  convertBtn.textContent = 'Convert';
  updateConvertBtn();
}

// ──────────────────────────── Drag & Drop ────────────────────────────

let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dropOverlay.classList.remove('hidden');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) dropOverlay.classList.add('hidden');
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.add('hidden');

  if (e.dataTransfer.files.length > 0) {
    addFiles(e.dataTransfer.files);
  }
});

// ──────────────────────────── Event Listeners ────────────────────────────

sourceSelect.addEventListener('change', updateMapping);
destSelect.addEventListener('change', updateMapping);
presetSelect.addEventListener('change', onPresetSelectChange);
presetDeleteBtn.addEventListener('click', onPresetDelete);
presetExportBtn.addEventListener('click', onPresetExport);
presetImportBtn.addEventListener('click', onPresetImportClick);
presetImportInput.addEventListener('change', onPresetImportFile);
openEditorLink.addEventListener('click', onOpenEditor);
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});
clearAllBtn.addEventListener('click', clearAll);
convertBtn.addEventListener('click', runConversion);
downloadBtn.addEventListener('click', () => {
  if (lastDownloadBlob && lastDownloadName) {
    saveAs(lastDownloadBlob, lastDownloadName);
  }
});

// Keyboard delete
document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // Only if not focused on an input
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
  }
});

// ──────────────────────────── Helpers ────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.classList.remove('hidden');
}

function showInfo(msg) {
  infoMessage.textContent = msg;
  infoMessage.classList.remove('hidden');
}

function hideMessages() {
  errorMessage.classList.add('hidden');
  infoMessage.classList.add('hidden');
}

// ──────────────────────────── Init ────────────────────────────

init();
