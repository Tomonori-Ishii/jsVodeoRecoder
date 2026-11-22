// Screen recording in the page: capture, 10 fps timing, same-frame detection, H.264 encoding
// (hardware first, software otherwise), and audio mixing with Opus encoding.
// Encoded records are sent to the main process, which writes the intermediate files (design 23-24).

export const METER_FLOOR_DB = -60;

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 10;
const FRAME_US = 100000; // 10 fps in microseconds
const TICK_MS = 100;
const RECORDING_LIMIT_FRAMES = 2 * 60 * 60 * FPS; // 2 hours (F-029)
const KEYFRAME_INTERVAL = 30; // encoded frames between keyframes
const VIDEO_BITRATE = 3000000; // 3 Mbps: quality equal to 720p at 1.5 Mbps (ADR-0027)
const AVC_CODEC = 'avc1.4d4028'; // H.264 Main, level 4.0 (1080p needs more macroblocks than level 3.1)

const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITRATE = 128000;
const AUDIO_BLOCK = 960; // one Opus frame of 20 ms at 48 kHz
const OPUS_CODEC = 'opus';
const MIC_GAIN = 0.7;
const SYSTEM_GAIN = 0.7;
const METER_INTERVAL_SEC = 0.05;

// Record types (must match electron/recording/format.cjs).
const RECORD = {
  VIDEO_KEY: 1,
  VIDEO_DELTA: 2,
  VIDEO_SKIP: 3,
  VIDEO_DUP: 4,
  AUDIO: 5,
  VIDEO_CONFIG: 6,
  AUDIO_CONFIG: 7,
};

// Mixes the microphone and system audio into one mono signal and passes it to the page.
const WORKLET_SOURCE = `
class MixCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('mix-capture', MixCapture);
`;

/** Error with a code that the interface can translate into a message. */
export class RecorderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecorderError';
    this.code = code;
  }
}

function equalPixels(a, b) {
  const x = new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

async function chooseVideoConfig() {
  const base = {
    codec: AVC_CODEC,
    width: WIDTH,
    height: HEIGHT,
    bitrate: VIDEO_BITRATE,
    framerate: FPS,
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  };
  for (const preference of ['prefer-hardware', 'prefer-software']) {
    const config = { ...base, hardwareAcceleration: preference };
    const result = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (result.supported) {
      return { config, accel: preference };
    }
  }
  throw new RecorderError('NO_H264', 'この環境では H.264 の符号化が使えません。');
}

async function isAudioSupported() {
  if (typeof AudioEncoder === 'undefined') return false;
  const result = await AudioEncoder.isConfigSupported({
    codec: OPUS_CODEC,
    sampleRate: AUDIO_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  }).catch(() => ({ supported: false }));
  return result.supported === true;
}

/**
 * Records the primary screen with audio into an mp4 (through the main process).
 *
 * The elapsed time is the number of 10 fps frames processed, so pausing stops it and
 * the length of the mp4 matches the displayed time.
 */
export class Recorder {
  /**
   * @param {object} options
   * @param {(level: {db: number, percent: number}) => void} [options.onLevel]
   * @param {(reason: string) => void} [options.onAutoStop] Called when recording must stop (2 hours).
   * @param {(error: Error) => void} [options.onError]
   */
  constructor({ onLevel, onAutoStop, onError } = {}) {
    this.onLevel = onLevel;
    this.onAutoStop = onAutoStop;
    this.onError = onError;
    this.notes = []; // information for the user, for example "no audio"
    this.accel = null; // the accepted encoder config: 'prefer-hardware' or 'prefer-software'
    this.active = false;
    this.paused = false;
    this.stopping = false;
    this.frameIndex = 0;
    this.audioSamples = 0;
    this.queue = []; // ordered video entries waiting to be written
    this.prevPixels = null;
    this.skipDefined = false;
    this.framesSinceKey = 0;
    this.videoConfigSent = false;
    this.audioConfigSent = false;
    this.mic = null;
    this.display = null;
    this.ctx = null;
    this.video = null;
    this.canvas = null;
    this.g2d = null;
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.timer = null;
    this.audioBlock = new Float32Array(AUDIO_BLOCK);
    this.audioFill = 0;
    this.meterSumSquares = 0;
    this.meterCount = 0;
    this.audioEnabled = false;
    this.dir = null;
    this.fileName = null;
    this.windowExcluded = false;
  }

  /**
   * Starts recording. Throws RecorderError or a DOMException (for example NotAllowedError).
   * @param {object} [options]
   * @param {string} [options.deviceId] Microphone to use.
   */
  async start({ deviceId } = {}) {
    if (!window.recorder) {
      throw new RecorderError('NO_ELECTRON', '画面録画は Electron アプリとしてのみ使えます。');
    }
    const videoChoice = await chooseVideoConfig();
    this.accel = videoChoice.accel;
    this.audioEnabled = await isAudioSupported();
    if (!this.audioEnabled) {
      this.notes.push('この環境では Opus の音声を符号化できないため、音声を含めずに録画します。');
    }

    try {
      if (this.audioEnabled) {
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: AUDIO_CHANNELS,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        });
      }
      try {
        this.display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: FPS, cursor: 'never' },
          audio: this.audioEnabled,
        });
      } catch {
        throw new RecorderError(
          'SCREEN_DENIED',
          '画面の録画が許可されていません。OSやアプリの画面収録の設定を確認してください。',
        );
      }
      if (this.audioEnabled && this.display.getAudioTracks().length === 0) {
        this.notes.push('スピーカーの音を取得できないため、マイクの音だけを録音します。');
      }
      this.display.getVideoTracks()[0].addEventListener('ended', () => {
        if (this.active) this.onAutoStop?.('display-ended');
      });

      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.srcObject = new MediaStream(this.display.getVideoTracks());
      await this.video.play();

      this.canvas = new OffscreenCanvas(WIDTH, HEIGHT);
      this.g2d = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });

      this.videoEncoder = new VideoEncoder({
        output: (chunk, meta) => this.onVideoOutput(chunk, meta),
        error: (err) => this.fail(err),
      });
      this.videoEncoder.configure(videoChoice.config);

      if (this.audioEnabled) await this.startAudio();

      const result = await window.recorder.startRecording({
        hasAudio: this.audioEnabled,
        encoder: this.accel,
      });
      if (!result?.ok) {
        throw new RecorderError(
          result?.code ?? 'START_FAILED',
          result?.code === 'LOW_SPACE'
            ? '空き容量が足りません。録画を始めるには 6GB 以上の空きが必要です。'
            : '録画を始められませんでした。',
        );
      }
      this.dir = result.dir;
      this.fileName = result.fileName;
      this.windowExcluded = result.windowExcluded;
      if (!this.windowExcluded) {
        this.notes.push('この環境では、録画に録画ウィンドウが映ります。');
      }
    } catch (err) {
      this.releaseCapture();
      throw err;
    }

    this.active = true;
    this.paused = false;
    this.frameIndex = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async startAudio() {
    this.ctx = new AudioContext({ sampleRate: AUDIO_RATE });
    if (this.ctx.sampleRate !== AUDIO_RATE) {
      throw new RecorderError('AUDIO_RATE', `音声のサンプルレートが ${AUDIO_RATE}Hz になりませんでした。`);
    }
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const mix = this.ctx.createGain();
    mix.gain.value = 1;
    const micGain = this.ctx.createGain();
    micGain.gain.value = MIC_GAIN;
    this.ctx.createMediaStreamSource(this.mic).connect(micGain).connect(mix);
    if (this.display.getAudioTracks().length > 0) {
      const systemGain = this.ctx.createGain();
      systemGain.gain.value = SYSTEM_GAIN;
      this.ctx.createMediaStreamSource(new MediaStream(this.display.getAudioTracks()))
        .connect(systemGain)
        .connect(mix);
    }

    this.worklet = new AudioWorkletNode(this.ctx, 'mix-capture');
    this.worklet.port.onmessage = (event) => this.onAudioFrame(event.data);
    mix.connect(this.worklet);
    // The worklet only runs while it is connected to the output; a silent gain keeps it quiet.
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    this.worklet.connect(silent).connect(this.ctx.destination);

    this.audioEncoder = new AudioEncoder({
      output: (chunk, meta) => this.onAudioOutput(chunk, meta),
      error: (err) => this.fail(err),
    });
    this.audioEncoder.configure({
      codec: OPUS_CODEC,
      sampleRate: AUDIO_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: AUDIO_BITRATE,
      opus: { frameDuration: AUDIO_BLOCK * 1000000 / AUDIO_RATE },
    });
  }

  /** Draws the newest screen frame onto the 1920x1080 canvas, letterboxed in black. */
  drawFrame() {
    const g = this.g2d;
    g.fillStyle = '#000';
    g.fillRect(0, 0, WIDTH, HEIGHT);
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw && vh) {
      const scale = Math.min(WIDTH / vw, HEIGHT / vh);
      const dw = Math.round(vw * scale);
      const dh = Math.round(vh * scale);
      g.drawImage(this.video, Math.round((WIDTH - dw) / 2), Math.round((HEIGHT - dh) / 2), dw, dh);
    }
  }

  /** One 10 fps step: decide whether this frame is new, a repeat, or the first repeat. */
  tick() {
    if (!this.active || this.paused || this.stopping) return;
    const index = this.frameIndex;
    const timestampUs = index * FRAME_US;

    this.drawFrame();
    const pixels = this.g2d.getImageData(0, 0, WIDTH, HEIGHT).data;
    const repeated = this.prevPixels !== null && equalPixels(pixels, this.prevPixels);

    if (!repeated) {
      // New picture: encode it.
      if (!this.prevPixels) this.prevPixels = new Uint8ClampedArray(pixels.length);
      this.prevPixels.set(pixels);
      this.skipDefined = false;
      this.encodeFrame(timestampUs, false);
    } else if (!this.skipDefined) {
      // First repeat of this picture: encode it once; the output becomes the skip sample (ADR-0020).
      this.skipDefined = true;
      this.encodeFrame(timestampUs, true);
    } else {
      // Later repeats are not encoded or stored; the mux writes the skip sample again.
      this.queue.push({ timestampUs, record: { type: RECORD.VIDEO_DUP, timestampUs, data: null } });
    }

    this.frameIndex += 1;
    this.flushQueue();
    if (this.frameIndex >= RECORDING_LIMIT_FRAMES) this.onAutoStop?.('time-limit');
  }

  encodeFrame(timestampUs, isSkipCandidate) {
    const keyFrame = this.framesSinceKey === 0 || this.framesSinceKey >= KEYFRAME_INTERVAL;
    this.framesSinceKey = keyFrame ? 1 : this.framesSinceKey + 1;
    const frame = new VideoFrame(this.canvas, { timestamp: timestampUs, duration: FRAME_US });
    this.videoEncoder.encode(frame, { keyFrame });
    frame.close();
    this.queue.push({ timestampUs, record: null, isSkipCandidate });
  }

  onVideoOutput(chunk, meta) {
    const description = meta?.decoderConfig?.description;
    if (description && !this.videoConfigSent) {
      this.videoConfigSent = true;
      this.send(RECORD.VIDEO_CONFIG, 0, new Uint8Array(description));
    }
    // Outputs arrive in encode order. An entry without output was dropped by the encoder;
    // it becomes a repeat so the timeline stays continuous.
    while (this.queue.length && this.queue[0].timestampUs < chunk.timestamp) {
      const dropped = this.queue.shift();
      this.send(RECORD.VIDEO_DUP, dropped.timestampUs, null);
    }
    const entry = this.queue.find((e) => e.timestampUs === chunk.timestamp && e.record === null);
    if (!entry) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    let type = chunk.type === 'key' ? RECORD.VIDEO_KEY : RECORD.VIDEO_DELTA;
    if (entry.isSkipCandidate && chunk.type === 'delta') type = RECORD.VIDEO_SKIP;
    entry.record = { type, timestampUs: chunk.timestamp, data };
    this.flushQueue();
  }

  /** Writes the entries at the head of the queue whose records are ready, in order. */
  flushQueue() {
    while (this.queue.length && this.queue[0].record !== null) {
      const { record } = this.queue.shift();
      this.send(record.type, record.timestampUs, record.data);
    }
  }

  send(type, timestampUs, data) {
    window.recorder.writeRecord(type, timestampUs, data ?? new Uint8Array(0));
  }

  onAudioFrame(frame) {
    if (!this.active || this.paused || this.stopping) return;
    // Level meter: RMS over about 50 ms.
    for (let i = 0; i < frame.length; i++) this.meterSumSquares += frame[i] * frame[i];
    this.meterCount += frame.length;
    if (this.meterCount >= AUDIO_RATE * METER_INTERVAL_SEC) {
      const rms = Math.sqrt(this.meterSumSquares / this.meterCount);
      const db = Math.max(METER_FLOOR_DB, 20 * Math.log10(rms || 1e-12));
      const percent = ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100;
      this.onLevel?.({ db, percent });
      this.meterSumSquares = 0;
      this.meterCount = 0;
    }
    // Collect 20 ms blocks for the Opus encoder.
    let offset = 0;
    while (offset < frame.length) {
      const take = Math.min(AUDIO_BLOCK - this.audioFill, frame.length - offset);
      this.audioBlock.set(frame.subarray(offset, offset + take), this.audioFill);
      this.audioFill += take;
      offset += take;
      if (this.audioFill === AUDIO_BLOCK) this.encodeAudioBlock();
    }
  }

  /** Sends the full audio block to the Opus encoder. */
  encodeAudioBlock() {
    const data = new AudioData({
      format: 'f32',
      sampleRate: AUDIO_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      numberOfFrames: AUDIO_BLOCK,
      timestamp: Math.round((this.audioSamples / AUDIO_RATE) * 1000000),
      data: this.audioBlock,
    });
    this.audioEncoder.encode(data);
    data.close();
    this.audioSamples += AUDIO_BLOCK;
    this.audioFill = 0;
  }

  onAudioOutput(chunk, meta) {
    const description = meta?.decoderConfig?.description;
    if (description && !this.audioConfigSent) {
      this.audioConfigSent = true;
      this.send(RECORD.AUDIO_CONFIG, 0, new Uint8Array(description));
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.send(RECORD.AUDIO, chunk.timestamp, data);
  }

  /** Elapsed recording time in seconds (paused time is not counted). */
  getElapsed() {
    return this.frameIndex / FPS;
  }

  async pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    await this.ctx?.suspend();
  }

  async resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    await this.ctx?.resume();
  }

  fail(err) {
    this.onError?.(err);
  }

  /**
   * Stops recording, finishes the encoders and asks the main process to create the mp4.
   * Resolves to the main process result: { ok, path } or { ok: false, code, dir }.
   */
  async stop(reason = 'user') {
    if (!this.active) return null;
    this.active = false;
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;

    // Finish the encoders before releasing the devices.
    if (this.videoEncoder) await this.videoEncoder.flush().catch(() => {});
    if (this.audioEncoder && this.audioFill > 0) {
      // Pad the last partial block with silence so it can be encoded.
      this.audioBlock.fill(0, this.audioFill);
      this.encodeAudioBlock();
    }
    if (this.audioEncoder) await this.audioEncoder.flush().catch(() => {});
    for (const entry of this.queue) {
      if (entry.record === null) {
        entry.record = { type: RECORD.VIDEO_DUP, timestampUs: entry.timestampUs, data: null };
      }
    }
    this.flushQueue();
    this.releaseCapture();

    return window.recorder.finishRecording(reason, this.frameIndex * FRAME_US);
  }

  releaseCapture() {
    clearInterval(this.timer);
    this.timer = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.display?.getTracks().forEach((t) => t.stop());
    this.worklet?.disconnect();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.videoEncoder?.close?.();
    this.audioEncoder?.close?.();
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.ctx = null;
    this.worklet = null;
    this.mic = null;
    this.display = null;
  }
}
