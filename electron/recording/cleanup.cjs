'use strict';

// Startup cleanup of leftover recordings (ADR-0023, design 26.2).
// A recording whose state is "recording" or "stopping" was interrupted (abnormal exit).
// "stopped-space" and "failed" are kept until the next start (F-039). "saved" is removed.

const fs = require('node:fs');
const path = require('node:path');
const { readStateFile, STATUS } = require('./session.cjs');

const DELETE_STATES = new Set([
  STATUS.RECORDING, // abnormal exit (F-040)
  STATUS.STOPPING, // abnormal exit during mux (F-040)
  STATUS.STOPPED_SPACE, // stopped for space; removed at the next start (F-039)
  STATUS.FAILED, // mux failed; removed at the next start (ADR-0023)
  STATUS.SAVED, // already saved
]);

/**
 * Removes leftover recording folders under baseDir. Returns a summary.
 * Folders whose state.json is missing or unreadable are kept and reported.
 */
async function cleanupStaleRecordings(baseDir, log = () => {}) {
  const summary = { removed: [], kept: [] };
  let names = [];
  try {
    names = await fs.promises.readdir(baseDir);
  } catch {
    return summary; // nothing has been recorded yet
  }
  for (const name of names) {
    if (!name.startsWith('recording-')) continue;
    const dir = path.join(baseDir, name);
    const state = readStateFile(dir);
    if (!state || !DELETE_STATES.has(state.status)) {
      summary.kept.push(name);
      log(`recording folder kept (unknown state): ${name}`);
      continue;
    }
    try {
      if (typeof state.partialPath === 'string') {
        await fs.promises.rm(state.partialPath, { force: true });
      }
      await fs.promises.rm(dir, { recursive: true, force: true });
      summary.removed.push(name);
    } catch (err) {
      summary.kept.push(name);
      log(`cleanup failed for ${name}: ${err.message}`);
    }
  }
  return summary;
}

module.exports = { cleanupStaleRecordings, DELETE_STATES };
