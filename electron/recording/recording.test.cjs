'use strict';

// Unit tests for the recording modules (run with: node --test electron/recording/).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RECORD, FRAME_US, encodeRecord, parseRecords, frameIndexOf } = require('./format.cjs');
const policy = require('./policy.cjs');
const { RecordingSession, STATUS, SEGMENT_US, readStateFile, folderNameFor } = require('./session.cjs');
const { cleanupStaleRecordings } = require('./cleanup.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'js-recorder-test-'));
}

test('records round-trip through encodeRecord and parseRecords', () => {
  const payload = new Uint8Array([1, 2, 3, 250]);
  const buffer = Buffer.concat([
    encodeRecord(RECORD.VIDEO_KEY, 0, payload),
    encodeRecord(RECORD.VIDEO_DUP, FRAME_US),
    encodeRecord(RECORD.AUDIO, 21333.5, new Uint8Array([9])),
  ]);
  const { records, truncated } = parseRecords(buffer);
  assert.equal(truncated, false);
  assert.equal(records.length, 3);
  assert.equal(records[0].type, RECORD.VIDEO_KEY);
  assert.deepEqual([...records[0].payload], [1, 2, 3, 250]);
  assert.equal(records[1].type, RECORD.VIDEO_DUP);
  assert.equal(records[1].payload.length, 0);
  assert.equal(records[1].timestampUs, FRAME_US);
  assert.equal(records[2].timestampUs, 21333.5);
});

test('a record cut off at the end is ignored, earlier records are kept', () => {
  const whole = encodeRecord(RECORD.VIDEO_DELTA, FRAME_US, new Uint8Array(10));
  const cut = encodeRecord(RECORD.VIDEO_DELTA, 2 * FRAME_US, new Uint8Array(10));
  const { records, truncated } = parseRecords(Buffer.concat([whole, cut.subarray(0, cut.length - 3)]));
  assert.equal(records.length, 1);
  assert.equal(truncated, true);
});

test('unknown record types and bad timestamps are rejected', () => {
  assert.throws(() => encodeRecord(99, 0));
  assert.throws(() => encodeRecord(RECORD.VIDEO_KEY, -1));
  assert.throws(() => encodeRecord(RECORD.VIDEO_KEY, Number.NaN));
  const garbage = Buffer.from([99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(parseRecords(garbage).records.length, 0);
});

test('frame index is derived from the 10 fps timestamp', () => {
  assert.equal(frameIndexOf(0), 0);
  assert.equal(frameIndexOf(7 * FRAME_US), 7);
});

test('disk policy thresholds (ADR-0022)', () => {
  const GB = policy.GB;
  assert.equal(policy.canStartRecording(3 * GB), true);
  assert.equal(policy.canStartRecording(3 * GB - 1), false);
  // Recording stops when free space falls below intermediate + 0.5 GB.
  assert.equal(policy.shouldStopForSpace(1.5 * GB + 1, 1 * GB), false);
  assert.equal(policy.shouldStopForSpace(1.5 * GB - 1, 1 * GB), true);
  // The mp4 is created only when free space is at least intermediate + 0.2 GB.
  assert.equal(policy.canMux(1.2 * GB, 1 * GB), true);
  assert.equal(policy.canMux(1.2 * GB - 1, 1 * GB), false);
});

test('folder names use the start time', () => {
  const date = new Date(2026, 10, 21, 11, 30, 5); // months are 0-based
  assert.equal(folderNameFor(date), 'recording-20261121_113005');
});

test('a session writes state, splits segments every 3 minutes and counts bytes', () => {
  const base = tempDir();
  const session = RecordingSession.create(base, new Date(2026, 10, 21, 10, 0, 0));
  assert.equal(readStateFile(session.dir).status, STATUS.RECORDING);

  session.append(RECORD.VIDEO_CONFIG, 0, new Uint8Array([1, 2, 3]));
  session.append(RECORD.VIDEO_KEY, 0, new Uint8Array(100));
  session.append(RECORD.VIDEO_DUP, FRAME_US, new Uint8Array(0));
  session.append(RECORD.VIDEO_KEY, SEGMENT_US + FRAME_US, new Uint8Array(50)); // second segment
  // A timestamp that goes backwards never reopens an earlier segment.
  session.append(RECORD.AUDIO, 5, new Uint8Array(20));
  session.close();

  const files = fs.readdirSync(session.dir).filter((f) => f.startsWith('seg-')).sort();
  assert.deepEqual(files, ['seg-0001.bin', 'seg-0002.bin']);
  const first = parseRecords(fs.readFileSync(path.join(session.dir, 'seg-0001.bin')));
  assert.equal(first.records.length, 3); // config, keyframe, duplicate
  // The audio record with an earlier timestamp stays in the current (second) segment.
  const second = parseRecords(fs.readFileSync(path.join(session.dir, 'seg-0002.bin')));
  assert.equal(second.records.length, 2); // keyframe, audio
  // Five records: payload sizes 3, 100, 0 (duplicate), 50, 20, each with a 13-byte header.
  assert.equal(session.intermediateBytes, [3, 100, 0, 50, 20].reduce((a, n) => a + n + 13, 0));

  session.setStatus(STATUS.STOPPED_SPACE);
  assert.equal(readStateFile(session.dir).status, STATUS.STOPPED_SPACE);
  fs.rmSync(base, { recursive: true, force: true });
});

test('startup cleanup removes interrupted and finished recordings, keeps unknown ones', async () => {
  const base = tempDir();
  const make = (name, state) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'seg-0001.bin'), 'x');
    if (state !== undefined) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    return dir;
  };
  const partial = path.join(base, 'screen_x.mp4.partial');
  fs.writeFileSync(partial, 'partial');
  make('recording-a', { status: STATUS.RECORDING }); // abnormal exit (F-040)
  make('recording-b', { status: STATUS.STOPPING, partialPath: partial }); // removes the partial mp4 too
  make('recording-c', { status: STATUS.STOPPED_SPACE }); // removed at the next start (F-039)
  make('recording-d', { status: STATUS.FAILED }); // mux failed earlier
  make('recording-e', { status: STATUS.SAVED });
  make('recording-f'); // no state.json: kept
  make('recording-g', { status: 'something-else' }); // unknown state: kept
  fs.mkdirSync(path.join(base, 'other'));

  const logs = [];
  const summary = await cleanupStaleRecordings(base, (m) => logs.push(m));
  assert.deepEqual(summary.removed.sort(), ['recording-a', 'recording-b', 'recording-c', 'recording-d', 'recording-e']);
  assert.deepEqual(summary.kept.sort(), ['recording-f', 'recording-g']);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.existsSync(path.join(base, 'other')), true);
  assert.equal(logs.length, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

test('startup cleanup does nothing when the folder does not exist', async () => {
  const summary = await cleanupStaleRecordings(path.join(tempDir(), 'missing'));
  assert.deepEqual(summary, { removed: [], kept: [] });
});
