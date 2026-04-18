// app.js — UI controller: drag-drop, file list, convert orchestration

import { loadCSV, buildMapping, midiNoteName } from './mapping.js';
import { processMIDIFile, scanMIDIFileNotes } from './midi-processor.js';

// State
let libraries = [];
let currentMapping = new Map();
let currentPersonalRef = new Map();
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

  if (!srcLib || !dstLib) return;

  const result = buildMapping(srcLib, dstLib);
  currentMapping = result.mapping;
  currentPersonalRef = result.personalReference;

  clearConvertedResults();
  runAutoScan();
  updateConvertBtn();
}

// ──────────────────────────── Auto-Scan ────────────────────────────

function runAutoScan() {
  if (!sourceSelect.value || !destSelect.value || midiFiles.length === 0) {
    scanResults = null;
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
  fileList.innerHTML = midiFiles.map(f =>
    `<div class="file-row" data-id="${f.id}">
      <span class="file-name">${escapeHtml(f.name)}</span>
      <button class="remove-btn" title="Remove">&times;</button>
    </div>`
  ).join('');

  attachRemoveListeners();
}

function renderAnnotatedFileList() {
  // Prefer convertedResults over scanResults for each file
  const activeResults = convertedResults || scanResults;

  fileList.innerHTML = midiFiles.map(f => {
    const result = activeResults ? activeResults.find(r => r.id === f.id) : null;
    if (!result) {
      return `<div class="file-row" data-id="${f.id}">
        <span class="file-name">${escapeHtml(f.name)}</span>
        <button class="remove-btn" title="Remove">&times;</button>
      </div>`;
    }

    if (result.error) {
      return `<div class="file-row file-row-error" data-id="${f.id}">
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-error">${escapeHtml(result.error)}</span>
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
        <button class="remove-btn" title="Remove">&times;</button>
      </div>
      ${unmappedRows}
    </div>`;
  }).join('');

  // Attach toggle listeners
  fileList.querySelectorAll('.file-row-converted').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.remove-btn')) return;
      const wrap = row.closest('.file-row-wrap');
      if (!wrap || !wrap.querySelector('.unmapped-details')) return;
      wrap.classList.toggle('expanded');
      const arrow = row.querySelector('.toggle-arrow');
      if (arrow) arrow.textContent = wrap.classList.contains('expanded') ? '\u25BC' : '\u25B6';
    });
  });

  attachRemoveListeners();
}

function attachRemoveListeners() {
  fileList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('.file-row, .file-row-wrap');
      const id = parseInt(row.dataset.id, 10);
      removeFile(id);
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
