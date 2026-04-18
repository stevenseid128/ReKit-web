// mapping.js — CSV parsing, library list, mapping builder, unmapped detection

/**
 * Parse one CSV row, respecting double-quoted fields that may contain commas.
 * Mirrors MappingModel.parseCSVRow() from the native app.
 */
export function parseCSVRow(row) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (const ch of row) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * @typedef {Object} LibraryRow
 * @property {string} personalName
 * @property {number|null} midiNote
 */

/**
 * @typedef {Object} Library
 * @property {string} name
 * @property {LibraryRow[]} rows
 */

/**
 * Load and parse mapping.csv.
 * @param {string} csvText - Raw CSV content
 * @returns {{ libraries: Library[], error: string|null }}
 */
export function loadCSV(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) {
    return { libraries: [], error: 'mapping.csv is empty.' };
  }

  const headerCols = parseCSVRow(lines[0]);
  const libraries = [];

  for (let i = 0; i < headerCols.length; i += 2) {
    const libName = headerCols[i];
    if (!libName) continue;

    const rows = [];
    for (let r = 1; r < lines.length; r++) {
      const cols = parseCSVRow(lines[r]);
      const name = i < cols.length ? cols[i] : '';
      const midiStr = (i + 1) < cols.length ? cols[i + 1] : '';
      const midiNote = midiStr !== '' ? parseInt(midiStr, 10) : null;
      rows.push({
        personalName: name,
        midiNote: Number.isNaN(midiNote) ? null : midiNote
      });
    }
    libraries.push({ name: libName, rows });
  }

  if (libraries.length === 0) {
    return { libraries: [], error: 'mapping.csv contained no valid library definitions.' };
  }

  return { libraries, error: null };
}

/**
 * Build the source→destination note mapping.
 * @param {Library} srcLib
 * @param {Library} dstLib
 * @returns {{ mapping: Map<number, number>, personalReference: Map<number, string> }}
 */
export function buildMapping(srcLib, dstLib) {
  const mapping = new Map();           // srcNote → dstNote
  const personalReference = new Map(); // srcNote → articulationName

  for (let i = 0; i < srcLib.rows.length; i++) {
    const srcRow = srcLib.rows[i];
    if (srcRow.midiNote !== null) {
      personalReference.set(srcRow.midiNote, srcRow.personalName);
    }

    if (i < dstLib.rows.length &&
        srcRow.midiNote !== null &&
        dstLib.rows[i].midiNote !== null) {
      mapping.set(srcRow.midiNote, dstLib.rows[i].midiNote);
    }
  }

  return { mapping, personalReference };
}

/**
 * Get unmapped articulations for the current mapping.
 * @param {Map<number, number>} mapping
 * @param {Map<number, string>} personalReference
 * @returns {{ note: number, name: string }[]}
 */
export function unmappedArticulations(mapping, personalReference) {
  const unmapped = [];
  for (const [note, name] of personalReference) {
    if (!mapping.has(note)) {
      unmapped.push({ note, name });
    }
  }
  unmapped.sort((a, b) => a.note - b.note);
  return unmapped;
}

/**
 * Returns the note name in Pro Tools convention (C-2 = 0, C3 = 60).
 * @param {number} note
 * @returns {string}
 */
export function midiNoteName(note) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(note / 12) - 2;
  return names[note % 12] + octave;
}
