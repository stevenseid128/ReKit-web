// midi-processor.js — MIDI load, remap, unmapped extraction, file generation

import { midiNoteName } from './mapping.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ANCHOR_CHANNEL = 15;  // channel index (0-based in @tonejs/midi = channel 16)
const ANCHOR_VELOCITY = 1 / 127; // @tonejs/midi uses 0-1 range
const MAIN_CHANNEL = 0;

/**
 * @typedef {Object} UnmappedNoteEvent
 * @property {number} note - MIDI note number
 * @property {number} ticks - start time in ticks
 * @property {number} durationTicks - duration in ticks
 * @property {number} velocity - 0-1 range
 * @property {string} articulation
 */

/**
 * @typedef {Object} RemapResult
 * @property {Uint8Array|null} mainMidi - Remapped MIDI file bytes (null if no mapped notes)
 * @property {UnmappedNoteEvent[]} unmappedEvents
 */

/**
 * Remap a single MIDI file.
 * @param {ArrayBuffer} arrayBuffer - Raw MIDI file data
 * @param {Map<number, number>} mapping - source note → dest note
 * @param {Map<number, string>} personalReference - source note → articulation name
 * @returns {RemapResult}
 */
export function remapMIDIFile(arrayBuffer, mapping, personalReference) {
  const midi = new Midi(arrayBuffer);
  const unmappedEvents = [];
  let mappedNotesExist = false;

  for (const track of midi.tracks) {
    const keptNotes = [];
    for (const note of track.notes) {
      const srcNote = note.midi;
      if (mapping.has(srcNote)) {
        note.midi = mapping.get(srcNote);
        keptNotes.push(note);
        mappedNotesExist = true;
      } else if (personalReference.has(srcNote)) {
        unmappedEvents.push({
          note: srcNote,
          ticks: note.ticks,
          durationTicks: note.durationTicks,
          velocity: note.velocity,
          articulation: personalReference.get(srcNote)
        });
        // Don't keep this note — it's unmapped
      } else {
        // Unknown note — keep as-is
        keptNotes.push(note);
      }
    }
    track.notes = keptNotes;
  }

  const mainMidi = mappedNotesExist ? new Uint8Array(midi.toArray()) : null;
  return { mainMidi, unmappedEvents };
}

/**
 * Find the earliest note time (in ticks) across all tracks.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {number}
 */
export function earliestNoteTime(arrayBuffer) {
  const midi = new Midi(arrayBuffer);
  let earliest = Infinity;
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      if (note.ticks < earliest) earliest = note.ticks;
    }
  }
  return earliest === Infinity ? 0 : earliest;
}

/**
 * Create an unmapped MIDI file for a group of unmapped events.
 * Includes an anchor note at the earliest time in the source file.
 * @param {UnmappedNoteEvent[]} events
 * @param {number} sourceStartTicks - earliest note time from source file
 * @param {number} ppq - pulses per quarter note from source
 * @returns {Uint8Array}
 */
export function createUnmappedMIDI(events, sourceStartTicks, ppq) {
  const midi = new Midi();
  midi.header.setTempo(120); // default tempo
  // ppq is read-only via getter; set via the underlying timeDivision
  midi.header.timeDivision = ppq || 480;
  const track = midi.addTrack();

  const effectivePPQ = ppq || 480;

  // Anchor note: same note as unmapped articulation, very quiet, on channel 16 (index 15)
  track.addNote({
    midi: events[0].note,
    ticks: sourceStartTicks,
    durationTicks: Math.round(effectivePPQ * 0.01), // very short
    velocity: ANCHOR_VELOCITY,
    channel: ANCHOR_CHANNEL
  });

  // Unmapped events on channel 1 (index 0)
  for (const event of events) {
    track.addNote({
      midi: event.note,
      ticks: event.ticks,
      durationTicks: event.durationTicks,
      velocity: event.velocity,
      channel: MAIN_CHANNEL
    });
  }

  return new Uint8Array(midi.toArray());
}

/**
 * Sanitize a filename by replacing unsafe characters.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  return name.replace(/[/\\:*?"<>|]/g, '-');
}

/**
 * Scan a MIDI file and return the set of note numbers it contains (read-only).
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Set<number>}
 */
export function scanMIDIFileNotes(arrayBuffer) {
  const midi = new Midi(arrayBuffer);
  const notes = new Set();
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      notes.add(note.midi);
    }
  }
  return notes;
}

/**
 * Process a single MIDI file end-to-end.
 * @param {File} file
 * @param {Map<number, number>} mapping
 * @param {Map<number, string>} personalReference
 * @param {string} dstLibName
 * @returns {Promise<{ error: string|null, files: { name: string, data: Uint8Array, folder?: string }[] }>}
 */
export async function processMIDIFile(file, mapping, personalReference, dstLibName) {
  if (file.size > MAX_FILE_SIZE) {
    return { error: `file too large (max ${MAX_FILE_SIZE / (1024 * 1024)} MB)`, files: [] };
  }

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    return { error: 'could not read file', files: [] };
  }

  let result;
  try {
    result = remapMIDIFile(arrayBuffer, mapping, personalReference);
  } catch {
    return { error: 'could not parse MIDI file', files: [] };
  }

  const baseName = file.name.replace(/\.(mid|midi)$/i, '');
  const outputFiles = [];

  if (result.mainMidi) {
    outputFiles.push({
      name: `${baseName}(${sanitizeFilename(dstLibName)}).mid`,
      data: result.mainMidi
    });
  }

  // Group unmapped by articulation
  const grouped = new Map();
  for (const event of result.unmappedEvents) {
    if (!grouped.has(event.articulation)) {
      grouped.set(event.articulation, []);
    }
    grouped.get(event.articulation).push(event);
  }

  if (grouped.size > 0) {
    const sourceStart = earliestNoteTime(arrayBuffer);
    const ppq = new Midi(arrayBuffer).header.ppq;
    const unmappedFolder = `${baseName} (unmapped articulations)`;

    for (const [articulation, events] of grouped) {
      const rawName = articulation || midiNoteName(events[0].note);
      const noteName = midiNoteName(events[0].note);
      const label = rawName === noteName ? noteName : `${rawName} - ${noteName}`;
      const safeName = sanitizeFilename(label);
      const unmappedData = createUnmappedMIDI(events, sourceStart, ppq);
      outputFiles.push({
        name: `${baseName}(${safeName}).mid`,
        data: unmappedData,
        folder: unmappedFolder
      });
    }
  }

  if (outputFiles.length === 0) {
    return { error: 'no mappable notes found', files: [] };
  }

  return { error: null, files: outputFiles };
}
