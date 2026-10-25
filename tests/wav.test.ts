import { describe, it, expect } from 'vitest';
import { encodeWav, downsampleStereo48ToMono16, rmsDb } from '../src/wav.ts';

function stereo48(frames: number, amp = 8000): Int16Array {
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    pcm[i * 2] = amp;
    pcm[i * 2 + 1] = amp;
  }
  return pcm;
}

describe('wav', () => {
  it('writes a valid 16-bit PCM WAV header', () => {
    const pcm = new Int16Array(16000);
    const wav = encodeWav(pcm);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('downsamples 48k stereo to 16k mono with a carry', () => {
    const input = stereo48(48000);
    const { pcm, carry } = downsampleStereo48ToMono16(input);
    expect(pcm.length).toBe(16000);
    expect(carry.length).toBe(0);
    expect(pcm[0]).toBe(8000);
  });

  it('keeps the remainder across chunks', () => {
    const a = downsampleStereo48ToMono16(stereo48(48000));
    const b = downsampleStereo48ToMono16(stereo48(48002), a.carry);
    expect(b.pcm.length + b.carry.length).toBe(16002);
  });

  it('reports silence as very low dB', () => {
    expect(rmsDb(new Int16Array(320))).toBeLessThan(-90);
  });
});
