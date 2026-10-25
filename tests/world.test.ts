import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { MUSIC } from '../src/definition.ts';
import { MUSIC_DEFAULTS, type MusicConfigSection } from '../src/config.ts';
import { MusicWorld } from '../src/world.ts';
import type { CaptureLike } from '../src/capture.ts';
import type { MusicAnalysis } from '../src/prompt.ts';
import { FakeHost } from './helpers/fake-host.ts';

const analysis: MusicAnalysis = {
  summary: '慢速钢琴，克制的惆怅。',
  tempoBpm: 70,
  instruments: [{ name: '钢琴', confidence: 0.8 }],
  mood: { valence: -0.4, arousal: 0.3, quality: '克制的惆怅', confidence: 0.7 },
};

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

class FakeCapture implements CaptureLike {
  cb: ((pcm: Int16Array) => void) | null = null;
  start(onPcm: (pcm: Int16Array) => void): void { this.cb = onPcm; }
  stop(): void { this.cb = null; }
  feed(pcm: Int16Array): void { this.cb?.(pcm); }
}

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'music-world-')); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('Music World', () => {
  it('dry mounts', async () => {
    const report = await dryMountWorld(MUSIC, { scratchDir: scratch });
    expect(report.failures).toEqual([]);
  });

  it('announces state, starts on sound, ends with a summary', async () => {
    const cfg: MusicConfigSection = {
      ...MUSIC_DEFAULTS,
      enabled: true,
      windowSec: 1,
      mode: 'end',
      screenFallback: false,
      maxCallsPerMinute: 10,
    };
    const capture = new FakeCapture();
    const world = new MusicWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir: scratch,
      secret: () => 'test-key',
      persist: () => {},
      captureFactory: () => capture,
      analyze: async () => ({ analysis }),
      screenCapture: async () => null,
    });
    const host = new FakeHost();
    await world.start(host);
    capture.feed(tone(1.2));
    await new Promise((r) => setTimeout(r, 20));
    capture.feed(silence(3));
    await new Promise((r) => setTimeout(r, 120));

    const types = host.events.map((e) => e.type);
    expect(types).toContain('music.state');
    expect(types).toContain('music.started');
    expect(types).toContain('music.ended');
    const ended = host.events.find((e) => e.type === 'music.ended')!;
    expect(ended.text).toContain('克制的惆怅');
    expect(ended.text).toContain('钢琴');
    await world.stop();
  });

  it('exposes the env prompt and config group', () => {
    const world = new MusicWorld({
      cfg: { ...MUSIC_DEFAULTS },
      timezone: 'Asia/Shanghai',
      dataDir: scratch,
      secret: () => '',
      persist: () => {},
      captureFactory: () => new FakeCapture(),
    });
    const ui = world.webUi();
    expect(ui.config?.some((c) => c.id === 'world:music')).toBe(true);
    expect(ui.promptDocs?.some((p) => p.key === 'worlds.music.envPrompt')).toBe(true);
    expect(world.envPromptVars()['music.mode']).toBe('end');
  });

  it('does not emit scene events in end mode', async () => {
    const cfg: MusicConfigSection = { ...MUSIC_DEFAULTS, windowSec: 1, mode: 'end', maxCallsPerMinute: 10 };
    const capture = new FakeCapture();
    const world = new MusicWorld({
      cfg, timezone: 'Asia/Shanghai', dataDir: scratch,
      secret: () => 'k', persist: () => {},
      captureFactory: () => capture,
      analyze: async () => ({ analysis }),
    });
    const host = new FakeHost();
    await world.start(host);
    capture.feed(tone(1.2));
    await new Promise((r) => setTimeout(r, 30));
    expect(host.events.some((e) => e.type === 'music.scene')).toBe(false);
    await world.stop();
  });
});
