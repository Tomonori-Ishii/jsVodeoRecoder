import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Recorder, METER_FLOOR_DB, RecorderError } from './recorder.js';
import './App.css';

const IDLE_LEVEL = { db: METER_FLOOR_DB, percent: 0 };

/** Converts a recorder, getUserMedia or AudioContext error into a message for the user. */
function describeError(err) {
  if (err instanceof RecorderError) return err.message; // already a user-facing message
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されていません。OSやアプリのマイク設定を確認してください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'マイクが見つかりません。マイクを接続してから再度お試しください。';
    case 'NotReadableError':
    case 'AbortError':
      return 'マイクを使用できません。他のアプリがマイクを使用していないか確認してください。';
    default:
      return `エラーが発生しました: ${err?.message ?? err}`;
  }
}

// Button icons (drawn in currentColor).
function IconRecord() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="3" width="2.8" height="10" rx="0.6" />
      <rect x="9.2" y="3" width="2.8" height="10" rx="0.6" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.2v9.6L13 8z" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </svg>
  );
}

/** Formats seconds as h:mm:ss.t, where t is the 100 ms digit (one digit). */
function formatTime(totalSeconds) {
  const tenths = Math.floor(totalSeconds * 10);
  const t = tenths % 10;
  const s = Math.floor(tenths / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return `${h}:${mm}:${ss}.${t}`;
}

const TICKER_SPEED_PX_PER_SEC = 30;

/**
 * Shows a message on one line. When it is wider than its box, it scrolls
 * horizontally in a loop, like a news ticker. The text is repeated so the
 * loop is seamless; the copy after the first one is hidden from screen readers.
 */
function Ticker({ text }) {
  const boxRef = useRef(null);
  const itemRef = useRef(null);
  // null: the text fits. Otherwise the duration of one scroll cycle in seconds.
  const [cycle, setCycle] = useState(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const measure = () => {
      const item = itemRef.current;
      if (!item) return;
      const range = document.createRange();
      range.selectNodeContents(item);
      const textWidth = range.getBoundingClientRect().width;
      // Each repeat carries a gap of 3em (see .ticker-track .ticker-item in App.css).
      const gap = parseFloat(getComputedStyle(item).fontSize) * 3;
      setCycle(textWidth > box.clientWidth ? (textWidth + gap) / TICKER_SPEED_PX_PER_SEC : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="ticker" ref={boxRef}>
      {cycle === null ? (
        <span className="ticker-item" ref={itemRef}>{text}</span>
      ) : (
        <div className="ticker-track" style={{ animationDuration: `${cycle}s` }}>
          <span className="ticker-item" ref={itemRef}>{text}</span>
          <span className="ticker-item" aria-hidden="true">{text}</span>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState('idle'); // 'idle' | 'recording' | 'paused' | 'saving'
  const [devices, setDevices] = useState([]); // audio input devices
  const [deviceId, setDeviceId] = useState('');
  const [level, setLevel] = useState(IDLE_LEVEL);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState({ text: '', isError: false });
  const recorderRef = useRef(null);
  const startingRef = useRef(false);
  const savingRef = useRef(false);

  const showError = (text) => setNotice({ text, isError: true });
  const showInfo = (text) => setNotice({ text, isError: false });

  const refreshDevices = async () => {
    try {
      const list = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audioinput',
      );
      setDevices(list);
      setDeviceId((prev) => (list.some((d) => d.deviceId === prev) ? prev : list[0]?.deviceId ?? ''));
      if (list.length === 0) showError('マイクが見つかりません。マイクを接続してください。');
    } catch (err) {
      showError(describeError(err));
    }
  };

  // On launch: ask for microphone permission once so device names become visible,
  // then list the devices and keep the list up to date when devices change.
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        if (!cancelled) showError(describeError(err));
      }
      if (!cancelled) await refreshDevices();
    };
    init();

    const onDeviceChange = () => refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      recorderRef.current?.stop();
      recorderRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Electron reports the saved mp4 path, the progress while it is created, and
  // automatic stops (low disk space). See electron/preload.cjs.
  useEffect(() => {
    const api = window.recorder;
    if (!api) return undefined;
    const offSaved = api.onSaved((savedPath) => showInfo(`保存しました: ${savedPath}`));
    const offProgress = api.onProgress((percent) => {
      if (savingRef.current) showInfo(`保存しています… ${percent}%`);
    });
    const offAutoStop = api.onAutoStop(({ reason }) => {
      handleStopRef.current?.(reason);
    });
    const offError = api.onError((message) => showError(message));
    return () => {
      offSaved();
      offProgress();
      offAutoStop();
      offError();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the elapsed-time display while recording.
  useEffect(() => {
    if (status !== 'recording') return undefined;
    const id = setInterval(() => {
      if (recorderRef.current) setElapsed(recorderRef.current.getElapsed());
    }, 30); // fast enough to show milliseconds smoothly
    return () => clearInterval(id);
  }, [status]);

  const handleStart = async () => {
    if (startingRef.current || recorderRef.current) return; // ignore double clicks
    startingRef.current = true;
    showInfo('');
    const recorder = new Recorder({
      onLevel: setLevel,
      onAutoStop: (reason) => handleStopRef.current?.(reason),
      onError: (err) => showError(describeError(err)),
    });
    try {
      await recorder.start({ deviceId: deviceId || undefined });
      recorderRef.current = recorder;
      setElapsed(0);
      setLevel(IDLE_LEVEL);
      setStatus('recording');
      if (recorder.notes.length > 0) showInfo(recorder.notes.join(' '));
      refreshDevices(); // device names are available once permission is granted
    } catch (err) {
      showError(describeError(err));
    } finally {
      startingRef.current = false;
    }
  };

  const handlePauseResume = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (status === 'recording') {
      await recorder.pause();
      setElapsed(recorder.getElapsed());
      setLevel(IDLE_LEVEL); // show zero level while paused
      setStatus('paused');
    } else if (status === 'paused') {
      await recorder.resume();
      setStatus('recording');
    }
  };

  const handleStop = async (reason = 'user') => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    savingRef.current = true;
    setElapsed(recorder.getElapsed());
    setLevel(IDLE_LEVEL);
    setStatus('saving');
    showInfo('保存しています… 0%');
    try {
      const result = await recorder.stop(reason);
      if (result?.ok) {
        showInfo(`保存しました: ${result.path}`);
      } else if (result?.code === 'STOPPED_SPACE' || result?.code === 'NO_SPACE_FOR_MP4') {
        showError(`空き容量が足りないため、録画は保存されませんでした。中間ファイル: ${result.dir}`);
      } else if (result?.code === 'MUX_FAILED') {
        showError(`保存に失敗しました: ${result.message}。中間ファイル: ${result.dir}`);
      } else {
        showError('録画を保存できませんでした。');
      }
    } catch (err) {
      showError(describeError(err));
    } finally {
      savingRef.current = false;
      setStatus('idle');
    }
  };

  // Used by the recorder and by Electron (through the event listeners above).
  const handleStopRef = useRef(null);
  handleStopRef.current = handleStop;

  const busy = status === 'recording' || status === 'paused' || status === 'saving';
  const saving = status === 'saving';
  const percent = Math.round(level.percent);
  const dbText = `${level.db.toFixed(1)} dB`;
  // While recording or paused, the message line stays empty. Errors are still shown.
  const quiet = status === 'recording' || status === 'paused';
  const messageText = quiet && !notice.isError ? '' : notice.text;

  return (
    <main className="app">
      {/* Top row: elapsed time, dB value, level meter.
          Bottom row: microphone picker (spans the first two columns), buttons. */}
      <span className="timer" aria-live="off">{formatTime(elapsed)}</span>
      <span className="db">{dbText}</span>
      <div
        className="meter"
        role="meter"
        aria-label="音量"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="meter-fill" style={{ width: `${percent}%` }} />
      </div>

      <select
        id="mic"
        className="mic-select"
        aria-label="マイク入力"
        title="マイク入力"
        value={deviceId}
        onChange={(e) => setDeviceId(e.target.value)}
        disabled={busy || devices.length === 0}
      >
        <option value="" disabled>
          Select Input
        </option>
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `マイク ${i + 1}`}
          </option>
        ))}
      </select>

      <div className="buttons">
        <button type="button" onClick={handleStart} disabled={busy} aria-label="開始" title="開始">
          <IconRecord />
        </button>
        <button
          type="button"
          onClick={handlePauseResume}
          disabled={!busy || saving}
          aria-label={status === 'paused' ? '再開' : '一時停止'}
          title={status === 'paused' ? '再開' : '一時停止'}
        >
          {status === 'paused' ? <IconPlay /> : <IconPause />}
        </button>
        <button
          type="button"
          onClick={() => handleStop('user')}
          disabled={!busy || saving}
          aria-label="停止"
          title="停止"
        >
          <IconStop />
        </button>
      </div>

      <p
        className={`message${notice.isError ? ' message-error' : ''}`}
        role="status"
        title={messageText}
      >
        {notice.isError ? notice.text : <Ticker text={messageText} />}
      </p>
    </main>
  );
}
