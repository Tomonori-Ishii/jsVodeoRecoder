'use strict';

// Writes the intermediate files of one recording (ADR-0018, ADR-0023, design 24.2 and 26.1).
// Records are appended to seg-NNNN.bin files; a new segment starts every 3 minutes.

const fs = require('node:fs');
const path = require('node:path');
const { encodeRecord } = require('./format.cjs');

const SEGMENT_US = 180 * 1000 * 1000; // 3 minutes (F-030)
const STATE_FILE = 'state.json';

const STATUS = Object.freeze({
  RECORDING: 'recording',
  STOPPING: 'stopping',
  STOPPED_SPACE: 'stopped-space',
  FAILED: 'failed',
  SAVED: 'saved',
});

/** Builds the folder name for a recording, e.g. recording-20261121_113000. */
function folderNameFor(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `recording-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Writes state.json atomically (temporary file, then rename). */
function writeStateFile(dir, state) {
  const target = path.join(dir, STATE_FILE);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
  fs.renameSync(temp, target);
}

/** Reads state.json, or returns null when it is missing or broken. */
function readStateFile(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

class RecordingSession {
  /**
   * @param {string} dir Folder that holds this recording's intermediate files.
   */
  constructor(dir) {
    this.dir = dir;
    this.fd = null;
    this.segmentIndex = -1;
    this.bytesWritten = 0;
    this.segmentCount = 0;
  }

  /** Creates a new recording folder under baseDir and writes state "recording". */
  static create(baseDir, date = new Date()) {
    fs.mkdirSync(baseDir, { recursive: true });
    let name = folderNameFor(date);
    let n = 2;
    while (fs.existsSync(path.join(baseDir, name))) {
      name = `${folderNameFor(date)}-${n}`;
      n += 1;
    }
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir);
    const session = new RecordingSession(dir);
    session.setStatus(STATUS.RECORDING, { startedAt: date.toISOString() });
    return session;
  }

  /** Changes the state recorded in state.json. */
  setStatus(status, extra = {}) {
    const current = readStateFile(this.dir) ?? {};
    writeStateFile(this.dir, { ...current, ...extra, status });
  }

  /** Appends one record. Timestamps never move the write position backwards. */
  append(type, timestampUs, payload) {
    const wanted = Math.floor(timestampUs / SEGMENT_US);
    this.openSegment(Math.max(this.segmentIndex, wanted));
    const buffer = encodeRecord(type, timestampUs, payload);
    fs.writeSync(this.fd, buffer);
    this.bytesWritten += buffer.length;
  }

  openSegment(index) {
    if (index === this.segmentIndex && this.fd !== null) return;
    this.closeSegment();
    this.segmentIndex = index;
    const name = `seg-${String(index + 1).padStart(4, '0')}.bin`;
    this.fd = fs.openSync(path.join(this.dir, name), 'w');
    this.segmentCount += 1;
  }

  closeSegment() {
    if (this.fd === null) return;
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
  }

  /** Total bytes of intermediate data written so far (used for the disk policy). */
  get intermediateBytes() {
    return this.bytesWritten;
  }

  /** Closes the open segment file. The folder itself is kept. */
  close() {
    this.closeSegment();
  }
}

module.exports = {
  RecordingSession,
  STATUS,
  SEGMENT_US,
  STATE_FILE,
  folderNameFor,
  readStateFile,
  writeStateFile,
};
