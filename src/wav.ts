/**
 * 音频小工具：48k 立体声 → 16k 单声道、WAV 封装、RMS。
 * 采集件给的是 48kHz 立体声 16-bit little-endian PCM；上传云端前降到 16k 单声道。
 */

export const SRC_RATE = 48000;
export const SRC_CHANNELS = 2;
export const OUT_RATE = 16000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (OUT_RATE * FRAME_MS) / 1000; // 320
const DECIMATE = SRC_RATE / OUT_RATE; // 3

/** 把 48k 立体声 interleaved PCM 降成 16k 单声道；carry 保存跨包的余数。 */
export function downsampleStereo48ToMono16(
  input: Int16Array<ArrayBufferLike>,
  carry: Int16Array<ArrayBufferLike> = new Int16Array(0),
): { pcm: Int16Array<ArrayBufferLike>; carry: Int16Array<ArrayBufferLike> } {
  const monoLen = Math.floor(input.length / SRC_CHANNELS);
  const mono = new Int16Array(monoLen);
  for (let i = 0; i < monoLen; i++) {
    const l = input[i * SRC_CHANNELS]!;
    const r = input[i * SRC_CHANNELS + 1]!;
    mono[i] = (l + r) >> 1;
  }

  const all = new Int16Array(carry.length + mono.length);
  all.set(carry, 0);
  all.set(mono, carry.length);

  const outLen = Math.floor(all.length / DECIMATE);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const base = i * DECIMATE;
    let sum = 0;
    for (let j = 0; j < DECIMATE; j++) sum += all[base + j]!;
    out[i] = Math.round(sum / DECIMATE);
  }
  const used = outLen * DECIMATE;
  return { pcm: out, carry: all.slice(used) };
}

/** 16-bit PCM 的 WAV 字节（RIFF/WAVE，单声道/多声道）。 */
export function encodeWav(pcm: Int16Array<ArrayBufferLike>, sampleRate = OUT_RATE, channels = 1): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  const out = new Uint8Array(buffer);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), 44);
  return out;
}

/** 一段 PCM 的 RMS 分贝；全零返回 -100。 */
export function rmsDb(frame: Int16Array<ArrayBufferLike>): number {
  if (frame.length === 0) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]! / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 1e-9) return -100;
  return 20 * Math.log10(rms);
}

/** 把多个 Int16Array 拼起来。 */
export function joinInt16(parts: readonly Int16Array<ArrayBufferLike>[]): Int16Array<ArrayBufferLike> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
