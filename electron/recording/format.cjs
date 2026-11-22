'use strict';

// Binary record format for the intermediate files written during a recording.
//
// Each record is:  type (1 byte) | payload length (uint32, LE) | timestamp in microseconds (float64, LE) | payload
// Video frames are placed on a 10 fps grid: frame n has timestamp n * 100000 us.

const RECORD = Object.freeze({
  VIDEO_KEY: 1, // encoded H.264 keyframe (AVCC sample)
  VIDEO_DELTA: 2, // encoded H.264 delta frame (AVCC sample)
  VIDEO_SKIP: 3, // delta frame that repeats the previous frame; reused for DUP records
  VIDEO_DUP: 4, // no payload: this frame is the same as the previous one
  AUDIO: 5, // encoded Opus packet
  VIDEO_CONFIG: 6, // avcC box payload (decoder configuration)
  AUDIO_CONFIG: 7, // OpusHead identification header (optional decoder configuration)
});

const VALID_TYPES = new Set(Object.values(RECORD));
const HEADER_SIZE = 13;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const FRAME_US = 100000; // 10 fps

/** Encodes one record into a Buffer. */
function encodeRecord(type, timestampUs, payload = new Uint8Array(0)) {
  if (!VALID_TYPES.has(type)) throw new RangeError(`unknown record type: ${type}`);
  if (!Number.isFinite(timestampUs) || timestampUs < 0) {
    throw new RangeError(`invalid timestamp: ${timestampUs}`);
  }
  if (payload.byteLength > MAX_PAYLOAD) throw new RangeError('payload too large');
  const out = Buffer.alloc(HEADER_SIZE + payload.byteLength);
  out.writeUInt8(type, 0);
  out.writeUInt32LE(payload.byteLength, 1);
  out.writeDoubleLE(timestampUs, 5);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, HEADER_SIZE);
  return out;
}

/**
 * Parses as many complete records as possible from a buffer.
 * A record cut off at the end (for example by a crash) is ignored: `truncated` is true.
 */
function parseRecords(buffer) {
  const records = [];
  let offset = 0;
  while (offset + HEADER_SIZE <= buffer.length) {
    const type = buffer.readUInt8(offset);
    const length = buffer.readUInt32LE(offset + 1);
    const timestampUs = buffer.readDoubleLE(offset + 5);
    if (!VALID_TYPES.has(type) || length > MAX_PAYLOAD) {
      // Corrupt record: stop here, keep what came before it.
      return { records, truncated: true };
    }
    if (offset + HEADER_SIZE + length > buffer.length) break;
    const payload = buffer.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length);
    records.push({ type, timestampUs, payload });
    offset += HEADER_SIZE + length;
  }
  return { records, truncated: offset < buffer.length };
}

/** Frame index for a 10 fps timestamp (rounded to the nearest frame). */
function frameIndexOf(timestampUs) {
  return Math.round(timestampUs / FRAME_US);
}

module.exports = {
  RECORD,
  HEADER_SIZE,
  FRAME_US,
  MAX_PAYLOAD,
  encodeRecord,
  parseRecords,
  frameIndexOf,
};
