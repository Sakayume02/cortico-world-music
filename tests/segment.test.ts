import { describe, it, expect } from 'vitest';
import { MusicSegmenter, type WindowChunk } from '../src/segment.ts';

function tone(seconds: number, amp = 9000): Int16Array {
  const frames = Math.round(48000 * seconds);
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * amp);
    pcm[i * 2] = v;
    pcm[i * 2 + 1] = v;
  }
  return pcm;
}

function silence(seconds: number): Int16Array {
  return new Int16Array(Math.round(48000 * seconds) * 2);
}

describe('MusicSegmenter', () => {
  it('starts on sound, emits windows, ends after silence', () => {
    const starts: number[] = [];
    const windows: WindowChunk[] = [];
    let ends = 0;
    let endMs = 0;
    const seg = new MusicSegmenter({
      windowSec: 1,
      minWindowSec: 0.5,
      silenceMs: 300,
      onStart: (i) => starts.push(i.startedAt),
      onWindow: (w) => windows.push(w),
      onEnd: (e) => { ends++; endMs = e.durationMs; },
    });

    seg.push48Stereo(tone(1.2));
    expect(starts.length).toBe(1);
    expect(windows.length).toBe(1); // 1s 满窗
    expect(windows[0]!.pcm.length).toBe(16000);

    seg.push48Stereo(silence(0.6));
    expect(ends).toBe(1);
    expect(endMs).toBeGreaterThan(1400);
    expect(windows.length).toBe(2); // 尾窗

    // 静音不会触发新的一段
    seg.push48Stereo(silence(1));
    expect(starts.length).toBe(1);
  });

  it('does not start on silence only', () => {
    let starts = 0;
    const seg = new MusicSegmenter({ windowSec: 1, onStart: () => { starts++; } });
    seg.push48Stereo(silence(2));
    expect(starts).toBe(0);
  });

  it('starts a new segment after an end', () => {
    let starts = 0;
    const seg = new MusicSegmenter({
      windowSec: 1,
      minWindowSec: 0.5,
      silenceMs: 300,
      onStart: () => { starts++; },
    });
    seg.push48Stereo(tone(1.1));
    seg.push48Stereo(silence(0.6));
    seg.push48Stereo(tone(1.1));
    expect(starts).toBe(2);
  });

  it('ends when frames stop arriving (native drops silent packets)', () => {
    let t = 1000;
    let ends = 0;
    const seg = new MusicSegmenter({
      windowSec: 1,
      minWindowSec: 0.5,
      silenceMs: 300,
      now: () => t,
      onEnd: () => { ends++; },
    });
    seg.push48Stereo(tone(1.1));
    expect(ends).toBe(0);
    t += 2500;
    seg.tick();
    expect(ends).toBe(1);
  });
});
