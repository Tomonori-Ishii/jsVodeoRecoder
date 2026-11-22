// Preload script: exposes a narrow recording API to the page (contextIsolation and sandbox stay on).
// The page cannot use ipcRenderer directly or any other Electron or Node.js API. Each function
// below sends one fixed message; the main process checks the arguments again.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('recorder', {
  /** Calls callback(savedPath) when the mp4 has been saved. Returns an unsubscribe function. */
  onSaved: (callback) => subscribe('recording-saved', callback),
  /** Calls callback(percent) while the mp4 is being created (0-100). */
  onProgress: (callback) => subscribe('rec:progress', callback),
  /** Calls callback({ reason, dir }) when the main process stops the recording (for example, low disk space). */
  onAutoStop: (callback) => subscribe('rec:auto-stop', callback),
  /** Calls callback(message) when a write fails. */
  onError: (callback) => subscribe('rec:error', callback),
  /** Starts a recording. Resolves to { ok, dir, fileName, windowExcluded } or { ok: false, code }. */
  startRecording: (options) =>
    ipcRenderer.invoke('rec:start', {
      hasAudio: options?.hasAudio === true,
      encoder: options?.encoder === 'prefer-hardware' ? 'prefer-hardware' : 'prefer-software',
    }),
  /** Sends one encoded record. data must be a Uint8Array. Fire and forget. */
  writeRecord: (type, timestampUs, data) => {
    if (typeof type !== 'number' || typeof timestampUs !== 'number' || !(data instanceof Uint8Array)) return;
    ipcRenderer.send('rec:write', { type, timestampUs, data });
  },
  /** Stops the recording and creates the mp4. durationUs is the length of the recording (for the progress). Resolves to { ok, path } or { ok: false, code, ... }. */
  finishRecording: (reason, durationUs) =>
    ipcRenderer.invoke('rec:finish', {
      reason: String(reason ?? 'user'),
      durationUs: Number.isFinite(durationUs) && durationUs > 0 ? durationUs : 0,
    }),
});
