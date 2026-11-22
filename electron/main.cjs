const { app, BrowserWindow, session, desktopCapturer, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { RecordingSession, STATUS } = require('./recording/session.cjs');
const { muxRecording } = require('./recording/mux.cjs');
const { cleanupStaleRecordings } = require('./recording/cleanup.cjs');
const policy = require('./recording/policy.cjs');
const { RECORD } = require('./recording/format.cjs');

// Fixed content size. Keep in sync with the spacing and button sizes in src/App.css.
// 292 = 256 (3 buttons, checked: 240px overflows, 256px fits) + one 30px button + 6px gap (4th button, issue #3).
// Not yet checked in a real render; verify that every element fits at this width.
const WINDOW_WIDTH = 292;
const WINDOW_HEIGHT = 80;

// Only the permissions the recorder needs (ADR-0025, design 7.2).
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture']);

const VALID_RECORD_TYPES = new Set(Object.values(RECORD));

let mainWindow = null;
let active = null; // the recording in progress, or null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true, // width/height refer to the web content area, not the frame
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'Video Recoder',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Exposes only the recording API (see preload.cjs).
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/** Free bytes on the disk that holds the intermediate files and the Downloads folder (the smaller value). */
async function freeBytes() {
  const dirs = [app.getPath('userData'), app.getPath('downloads')];
  const values = await Promise.all(
    dirs.map(async (dir) => {
      const stats = await fs.promises.statfs(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    }),
  );
  return Math.min(...values);
}

/**
 * Hides the recording window from screen capture where the OS supports it (F-027).
 * Returns true when the window is excluded. Linux is not supported yet (ADR-0021).
 */
function setCaptureExcluded(excluded) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (process.platform === 'win32' || process.platform === 'darwin') {
    mainWindow.setContentProtection(excluded);
    return excluded;
  }
  return false;
}

function sendToWindow(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function isFromWindow(event) {
  return Boolean(mainWindow) && event.sender === mainWindow.webContents;
}

async function checkSpace() {
  if (!active || active.stoppedSpace) return;
  const free = await freeBytes();
  if (policy.shouldStopForSpace(free, active.session.intermediateBytes)) {
    active.stoppedSpace = true;
    clearInterval(active.timer);
    active.session.close();
    active.session.setStatus(STATUS.STOPPED_SPACE);
    sendToWindow('rec:auto-stop', { reason: 'space', dir: active.session.dir });
  }
}

async function startRecording(options) {
  if (active) return { ok: false, code: 'BUSY' };
  const free = await freeBytes();
  if (!policy.canStartRecording(free)) {
    return { ok: false, code: 'LOW_SPACE', freeBytes: free };
  }
  const session = RecordingSession.create(app.getPath('userData'), new Date());
  // F-036: record the accepted H.264 encoder config (prefer-hardware or prefer-software). It does not prove that hardware was used.
  session.setStatus(STATUS.RECORDING, { encoder: options.encoder === 'prefer-hardware' ? 'prefer-hardware' : 'prefer-software' });
  const fileName = `screen_${path.basename(session.dir).slice('recording-'.length)}.mp4`;
  active = {
    session,
    fileName,
    hasAudio: options.hasAudio === true,
    stoppedSpace: false,
    timer: setInterval(() => {
      checkSpace().catch(() => {});
    }, policy.POLICY.CHECK_INTERVAL_MS),
  };
  const windowExcluded = setCaptureExcluded(true);
  return { ok: true, dir: session.dir, fileName, windowExcluded };
}

function writeRecord(event, message) {
  if (!active || active.stoppedSpace || !isFromWindow(event)) return;
  if (!message || !VALID_RECORD_TYPES.has(message.type)) return;
  if (!Number.isFinite(message.timestampUs) || message.timestampUs < 0) return;
  const data = message.data instanceof Uint8Array ? message.data : new Uint8Array(0);
  try {
    active.session.append(message.type, message.timestampUs, data);
  } catch (err) {
    sendToWindow('rec:error', `録画データの書き込みに失敗しました: ${err.message}`);
  }
}

async function finishRecording(event, options) {
  if (!active || !isFromWindow(event)) return { ok: false, code: 'NOT_RECORDING' };
  const current = active;
  active = null;
  clearInterval(current.timer);
  setCaptureExcluded(false);
  const { session } = current;
  session.close();

  if (current.stoppedSpace) {
    return { ok: false, code: 'STOPPED_SPACE', dir: session.dir };
  }

  const free = await freeBytes();
  if (!policy.canMux(free, session.intermediateBytes)) {
    session.setStatus(STATUS.STOPPED_SPACE);
    return { ok: false, code: 'NO_SPACE_FOR_MP4', dir: session.dir };
  }

  const finalPath = path.join(app.getPath('downloads'), current.fileName);
  const partialPath = `${finalPath}.partial`;
  session.setStatus(STATUS.STOPPING, { partialPath });
  try {
    await muxRecording({
      dir: session.dir,
      outPath: partialPath,
      hasAudio: current.hasAudio,
      totalDurationUs: Number.isFinite(options.durationUs) ? options.durationUs : 0,
      onProgress: (fraction) => sendToWindow('rec:progress', Math.round(fraction * 100)),
    });
    fs.renameSync(partialPath, finalPath);
    session.setStatus(STATUS.SAVED, { savedPath: finalPath });
    fs.rmSync(session.dir, { recursive: true, force: true });
    sendToWindow('recording-saved', finalPath);
    return { ok: true, path: finalPath };
  } catch (err) {
    fs.rmSync(partialPath, { force: true });
    session.setStatus(STATUS.FAILED, { partialPath, error: err.message });
    return { ok: false, code: 'MUX_FAILED', message: err.message, dir: session.dir };
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  // Screen capture without a picker: always the primary display (ADR-0021).
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
      if (!source) return callback({});
      // System audio (loopback) is only offered on Windows for now.
      callback(process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
    } catch {
      callback({});
    }
  });

  ipcMain.handle('rec:start', (event, options) => (isFromWindow(event) ? startRecording(options ?? {}) : null));
  ipcMain.on('rec:write', (event, message) => writeRecord(event, message));
  ipcMain.handle('rec:finish', (event, options) => finishRecording(event, options ?? {}));

  // Leftovers of interrupted recordings are removed at startup (ADR-0023). Runs in the background.
  cleanupStaleRecordings(app.getPath('userData'), (message) => console.warn(message)).catch(() => {});

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Intermediate files of a recording in progress are left behind; the next start removes them (F-040).
  if (active) active.session.close();
});

app.on('window-all-closed', () => {
  app.quit();
});

