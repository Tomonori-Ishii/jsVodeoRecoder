'use strict';

// Creates the mp4 from the intermediate files (F-031, ADR-0018, design 24.3).
// The H.264 and Opus samples are copied as they are (no re-encoding). The file is written
// through positional writes, so the whole mp4 is never held in memory.

const fs = require('node:fs');
const path = require('node:path');
const { RECORD, FRAME_US, parseRecords } = require('./format.cjs');

const AUDIO_FRAME_US = (960 / 48000) * 1000000; // one Opus frame (20 ms)
const MIN_OPUS_HEAD = 18; // the OpusHead identification header is at least 18 bytes
const PROGRESS_INTERVAL_MS = 500; // progress is reported at most every 0.5 s (design 24.3)

function listSegments(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /^seg-\d{4}\.bin$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Multiplexes all segments in dir into one mp4 at outPath.
 * @param {object} options
 * @param {string} options.dir Recording folder.
 * @param {string} options.outPath File to write (normally the ".partial" name).
 * @param {boolean} options.hasAudio Whether audio records are expected.
 * @param {number} options.width Video width (1920).
 * @param {number} options.height Video height (1080).
 * @param {(fraction: number) => void} [options.onProgress] Called with 0..1.
 * @param {number} [options.totalDurationUs] Length of the whole recording (microseconds), used for the progress.
 * @returns {Promise<{videoSamples: number, audioSamples: number, durationUs: number}>}
 */
async function muxRecording({ dir, outPath, hasAudio, width = 1920, height = 1080, onProgress, totalDurationUs = 0 }) {
  const { Muxer, StreamTarget } = await import('mp4-muxer');
  const segments = listSegments(dir);
  if (segments.length === 0) throw new Error('録画データが見つかりません。');

  const fd = fs.openSync(outPath, 'w');
  try {
    const target = new StreamTarget({
      onData: (data, position) => {
        fs.writeSync(fd, data, 0, data.byteLength, position);
      },
    });
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height },
      audio: hasAudio ? { codec: 'opus', numberOfChannels: 1, sampleRate: 48000 } : undefined,
      fastStart: false,
    });

    let avcC = null;
    let asc = null;
    let lastSkip = null; // bytes of the last VIDEO_SKIP sample, reused for VIDEO_DUP
    let pendingVideo = null; // sample waiting for its duration
    let pendingAudio = null;
    let videoEmitted = 0;
    let audioEmitted = 0;
    let videoSamples = 0;
    let audioSamples = 0;
    let videoEndUs = 0;
    let lastProgressAt = 0;
    let lastTimestampUs = 0;
    const reportProgress = (force) => {
      if (!onProgress || totalDurationUs <= 0) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      onProgress(Math.min(1, lastTimestampUs / totalDurationUs));
    };

    const videoMeta = () => ({
      decoderConfig: { codec: 'avc1.4d4028', codedWidth: width, codedHeight: height, description: avcC },
    });
    // The OpusHead description is optional; mp4-muxer uses defaults without it.
    const opusDescription = asc && asc.byteLength >= MIN_OPUS_HEAD ? asc : undefined;
    const audioMeta = () => ({
      decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000, description: opusDescription },
    });

    const emitVideo = (timestampUs, data, type) => {
      if (pendingVideo) {
        if (timestampUs <= pendingVideo.timestampUs) throw new Error('映像の時刻が逆転しています。');
        const meta = videoEmitted === 0 ? videoMeta() : undefined;
        muxer.addVideoChunkRaw(
          pendingVideo.data,
          pendingVideo.type,
          pendingVideo.timestampUs,
          timestampUs - pendingVideo.timestampUs,
          meta,
        );
        videoEmitted += 1;
        videoSamples += 1;
      }
      pendingVideo = { data, type, timestampUs };
    };

    const emitAudio = (timestampUs, data) => {
      if (pendingAudio) {
        const meta = audioEmitted === 0 ? audioMeta() : undefined;
        muxer.addAudioChunkRaw(
          pendingAudio.data,
          'key',
          pendingAudio.timestampUs,
          Math.max(1, timestampUs - pendingAudio.timestampUs),
          meta,
        );
        audioEmitted += 1;
        audioSamples += 1;
      }
      pendingAudio = { data, timestampUs };
    };

    for (let i = 0; i < segments.length; i++) {
      const buffer = fs.readFileSync(segments[i]);
      const { records } = parseRecords(buffer);
      for (const record of records) {
        const payload = new Uint8Array(record.payload); // copy, the buffer is reused by Node
        lastTimestampUs = Math.max(lastTimestampUs, record.timestampUs);
        reportProgress(false);
        switch (record.type) {
          case RECORD.VIDEO_CONFIG:
            avcC = payload;
            break;
          case RECORD.AUDIO_CONFIG:
            asc = payload;
            break;
          case RECORD.VIDEO_KEY:
          case RECORD.VIDEO_DELTA:
            lastSkip = null;
            emitVideo(record.timestampUs, payload, record.type === RECORD.VIDEO_KEY ? 'key' : 'delta');
            videoEndUs = Math.max(videoEndUs, record.timestampUs + FRAME_US);
            break;
          case RECORD.VIDEO_SKIP:
            lastSkip = payload;
            emitVideo(record.timestampUs, payload, 'delta');
            videoEndUs = Math.max(videoEndUs, record.timestampUs + FRAME_US);
            break;
          case RECORD.VIDEO_DUP:
            // Repeats the previous frame. With a skip sample the repeat is written as that sample;
            // without one, the previous sample simply lasts longer (its duration is set by the next sample).
            if (lastSkip) emitVideo(record.timestampUs, lastSkip, 'delta');
            videoEndUs = Math.max(videoEndUs, record.timestampUs + FRAME_US);
            break;
          case RECORD.AUDIO:
            emitAudio(record.timestampUs, payload);
            break;
          default:
            break;
        }
      }
    }

    if (videoEmitted === 0 && pendingVideo === null) throw new Error('映像データが見つかりません。');
    if (!avcC) throw new Error('映像の設定が見つかりません。');

    if (pendingVideo) {
      const meta = videoEmitted === 0 ? videoMeta() : undefined;
      muxer.addVideoChunkRaw(
        pendingVideo.data,
        pendingVideo.type,
        pendingVideo.timestampUs,
        Math.max(FRAME_US, videoEndUs - pendingVideo.timestampUs),
        meta,
      );
      videoEmitted += 1;
      videoSamples += 1;
    }
    if (pendingAudio) {
      const meta = audioEmitted === 0 ? audioMeta() : undefined;
      muxer.addAudioChunkRaw(pendingAudio.data, 'key', pendingAudio.timestampUs, AUDIO_FRAME_US, meta);
      audioEmitted += 1;
      audioSamples += 1;
    }

    muxer.finalize();
    fs.fsyncSync(fd);
    onProgress?.(1);
    return { videoSamples, audioSamples, durationUs: videoEndUs };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { muxRecording, listSegments };
