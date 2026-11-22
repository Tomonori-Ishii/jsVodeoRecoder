'use strict';

// Disk-space policy (ADR-0022, ADR-0027, F-035). All numbers are provisional until measured.

const GB = 1024 ** 3;

const POLICY = Object.freeze({
  // Needs room for a full 2-hour recording: intermediate (~2.6 GB at 3 Mbps) + mp4 (~2.6 GB) + margin.
  START_MIN_FREE_BYTES: 6 * GB, // needed before a recording may start
  RECORDING_MARGIN_BYTES: 0.5 * GB, // stop recording when free space falls below intermediate + this
  MUX_MARGIN_BYTES: 0.2 * GB, // create the mp4 only when free space is at least intermediate + this
  CHECK_INTERVAL_MS: 10000, // how often free space is checked while recording
});

/** True when a recording may start with this much free space. */
function canStartRecording(freeBytes) {
  return freeBytes >= POLICY.START_MIN_FREE_BYTES;
}

/** True when recording must stop now because free space is too low (F-035). */
function shouldStopForSpace(freeBytes, intermediateBytes) {
  return freeBytes < intermediateBytes + POLICY.RECORDING_MARGIN_BYTES;
}

/** True when the mp4 may be created after stopping (F-031, F-035). */
function canMux(freeBytes, intermediateBytes) {
  return freeBytes >= intermediateBytes + POLICY.MUX_MARGIN_BYTES;
}

module.exports = { GB, POLICY, canStartRecording, shouldStopForSpace, canMux };
