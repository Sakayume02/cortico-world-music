import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { MUSIC } from '../src/definition.ts';
import { MUSIC_DEFAULTS, type MusicConfigSection } from '../src/config.ts';
import { MusicWorld, type MusicWorldOptions } from '../src/world.ts';
import type { CaptureLike } from '../src/capture.ts';
import type { MusicAnalysis, ListeningContext } from '../src/prompt.ts';
import type { PlayerMeta } from '../src/metadata.ts';
import type { LyricsResult } from '../src/lyrics.ts';
import { FakeHost } from './helpers/fake-host.ts';

const analysis: MusicAnalysis = {
  summary: '慢速钢琴，克制的惆怅。',
  listenerSummary: '像傍晚的空房间，钢琴声一层层落下来；我坐着没动，呼吸变轻了。',
  feeling: '克制的惆怅',
  imagery: '傍晚的空房间',
  body: '肩膀松下来',
  arc: '从平静到有点鼻酸',
  isMusic: true,
  musicConfidence: 0.9,
  tempoBpm: 70,
  instruments: [{ name: '钢琴', confidence: 0.8 }],
  mood: { valence: -0.4, arousal: 0.3, quality: '克制的惆怅', confidence: 0.7 },
  lyrics: { present: true, text: '再见', confidence: 0.4, source: 'asr', complete: false },
};

const meta: PlayerMeta = {
  kind: 'player',
  app: 'CloudMusic.exe',
  appName: '网易云音乐',
  title: '记忆点',
  artist: '陈卓璇',
  status: 'Playing',
};

const browserMeta: PlayerMeta = {
  kind: 'browser',
  app: 'chrome.exe',
  appName: 'Chrome',
  title: '某视频 - YouTube',
  status: 'Playing',
};

const lyrics: LyricsResult = {
  text: '所以你才选择离开\n别不说话我的亲爱',
  source: 'lrclib',
  url: 'https://lrclib.net',
  title: '记忆点',
  artist: '陈卓璇',
  complete: true,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeCapture implements CaptureLike {
  cb: ((pcm: Int16Array) => void) | null = null;
  started = 0;
  start(onPcm: (pcm: Int16Array) => void): void { this.started++; this.cb = onPcm; }
  stop(): void { this.cb = null; }
  feed(pcm: Int16Array): void { this.cb?.(pcm); }
}

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'music-world-')); });
afterEach(() => { vi.useRealTimers(); rmSync(scratch, { recursive: true, force: true }); });

function makeWorld(overrides: Partial<MusicWorldOptions> = {}): { world: MusicWorld; capture: FakeCapture } {
  const capture = new FakeCapture();
  const { cfg: cfgOverride, ...rest } = overrides;
  const cfg: MusicConfigSection = {
    ...MUSIC_DEFAULTS,
    windowSec: 1,
    mode: 'end',
    screenFallback: false,
    readPlayerMeta: false,
    lookupLyrics: false,
    maxCallsPerMinute: 10,
    ...(cfgOverride ?? {}),
  };
  const world = new MusicWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: scratch,
    secret: () => 'test-key',
    storeSecret: () => {},
    persist: () => {},
    captureFactory: () => capture,
    analyze: async () => ({ analysis }),
    metadataReader: async () => null,
    lyricsResolver: async () => null,
    ...rest,
  });
  return { world, capture };
}

async function startListening(world: MusicWorld): Promise<string> {
  const tool = world.tools().find((t) => t.name === 'music_watch')!;
  const result = await tool.handler({ action: 'start' }, {} as ToolCallContext);
  return typeof result === 'string' ? result : result.text;
}

describe('Music World', () => {
  it('dry mounts', async () => {
    const report = await dryMountWorld(MUSIC, { scratchDir: scratch });
    expect(report.failures).toEqual([]);
  });

  it('stays on standby until the user explicitly starts', async () => {
    const { world, capture } = makeWorld();
    const host = new FakeHost();
    await world.start(host);
    expect(capture.started).toBe(0);
    expect(host.events.map((e) => e.type)).toEqual(['music.state']);
    expect(host.events[0]!.text).toContain('待命');

    await startListening(world);
    expect(capture.started).toBe(1);
    await world.stop();
  });

  it('starts on sound after explicit start and ends with a feeling summary', async () => {
    const { world, capture } = makeWorld();
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(30);
    capture.feed(silence(3));
    await sleep(160);

    const types = host.events.map((e) => e.type);
    expect(types).toContain('music.state');
    expect(types).toContain('music.started');
    expect(types).toContain('music.ended');
    const started = host.events.find((e) => e.type === 'music.started')!;
    expect(started.text).toContain('想动就动');
    const ended = host.events.find((e) => e.type === 'music.ended')!;
    expect(ended.text).toContain('傍晚的空房间');
    expect(ended.text).toContain('克制的惆怅');
    expect(ended.text).toContain('内部参考');
    await world.stop();
  });

  it('uses player metadata and trusted lyrics', async () => {
    let seen: ListeningContext | undefined;
    const { world, capture } = makeWorld({
      cfg: { ...MUSIC_DEFAULTS, readPlayerMeta: true, lookupLyrics: true, windowSec: 1, mode: 'end', maxCallsPerMinute: 10 },
      metadataReader: async () => meta,
      lyricsResolver: async () => lyrics,
      analyze: async (_wav, _cfg, _key, _windowSec, context) => { seen = context; return { analysis }; },
    });
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(40);
    capture.feed(silence(3));
    await sleep(160);

    const started = host.events.find((e) => e.type === 'music.started')!;
    expect(started.text).toContain('记忆点');
    expect(started.text).toContain('来自播放器媒体信息');
    expect(seen?.lyrics).toContain('所以你才选择离开');
    const ended = host.events.find((e) => e.type === 'music.ended')!;
    expect(ended.text).toContain('LRCLIB');
    expect(ended.text).toContain('所以你才选择离开');
    await world.stop();
  });

  it('keeps a player track even when the first window says not music', async () => {
    const { world, capture } = makeWorld({
      cfg: { ...MUSIC_DEFAULTS, readPlayerMeta: true, windowSec: 1, mode: 'end', maxCallsPerMinute: 10 },
      metadataReader: async () => meta,
      analyze: async () => ({ analysis: { ...analysis, isMusic: false, musicConfidence: 0.95, summary: '前奏像说话' } }),
    });
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(40);
    capture.feed(silence(3));
    await sleep(160);
    const types = host.events.map((e) => e.type);
    expect(types).toContain('music.started');
    expect(types).toContain('music.ended');
    expect(host.events.find((e) => e.type === 'music.started')!.text).toContain('记忆点');
    await world.stop();
  });

  it('gives feedback when a known player track stops before the first window confirms', async () => {
    const { world, capture } = makeWorld({
      cfg: { ...MUSIC_DEFAULTS, readPlayerMeta: true, windowSec: 1, mode: 'end', maxCallsPerMinute: 10 },
      metadataReader: async () => meta,
      analyze: async () => new Promise(() => {}),
    });
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(40);
    capture.feed(silence(3));
    await sleep(160);
    expect(host.events.some((e) => e.type === 'music.started')).toBe(true);
    expect(host.events.some((e) => e.type === 'music.state' && e.text.includes('音乐停下来了'))).toBe(true);
    await world.stop();
  });

  it('treats browser media as a tab-title hint, not a confirmed song', async () => {
    const { world, capture } = makeWorld({
      cfg: { ...MUSIC_DEFAULTS, readPlayerMeta: true, screenFallback: false, lookupLyrics: false, windowSec: 1, mode: 'end', maxCallsPerMinute: 10 },
      metadataReader: async () => browserMeta,
    });
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(40);
    capture.feed(silence(3));
    await sleep(160);
    const started = host.events.find((e) => e.type === 'music.started')!;
    expect(started.text).toContain('浏览器');
    expect(started.text).toContain('不是已确认歌名');
    expect(started.text).toContain('某视频');
    expect(host.events.some((e) => e.type === 'music.ended')).toBe(true);
    await world.stop();
  });

  it('drops audio that is not music', async () => {
    const { world, capture } = makeWorld({
      analyze: async () => ({ analysis: { ...analysis, isMusic: false, musicConfidence: 0.95, summary: '播客旁白' } }),
    });
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(40);
    capture.feed(silence(3));
    await sleep(150);
    const types = host.events.map((e) => e.type);
    expect(types).toContain('music.state');
    expect(types).not.toContain('music.started');
    expect(types).not.toContain('music.ended');
    await world.stop();
  });

  it('does not emit scene events in end mode', async () => {
    const { world, capture } = makeWorld();
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(40);
    expect(host.events.some((e) => e.type === 'music.scene')).toBe(false);
    await world.stop();
  });

  it('exposes the env prompt, standby label and config group', () => {
    const { world } = makeWorld();
    const ui = world.webUi();
    expect(ui.label).toBe('一起感受音乐');
    expect(ui.lamps?.[0]?.state).toBe('offline');
    expect(ui.lamps?.[0]?.hint).toContain('待命');
    expect(ui.config?.some((c) => c.id === 'world:music')).toBe(true);
    expect(ui.promptDocs?.some((p) => p.key === 'worlds.music.envPrompt')).toBe(true);
    expect(world.envPromptVars()['music.mode']).toBe('end');
  });

  it('exposes the settings panel and saves endpoint and key', async () => {
    const captured = {
      stored: null as { name: string; value: string } | null,
      persisted: null as Partial<MusicConfigSection> | null,
    };
    const { world } = makeWorld({
      storeSecret: (name, value) => { captured.stored = { name, value }; },
      persist: (patch) => { captured.persisted = patch; },
    });
    const invoke = world.webUi().invoke!;
    const state = await invoke('settings', 'state', []) as { hasKey: boolean };
    expect(state.hasKey).toBe(true);

    const saved = await invoke('settings', 'save', [{
      backend: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      model: 'my-audio-model',
    }]) as { backend: string };
    expect(saved.backend).toBe('openai-compatible');
    expect(captured.persisted?.model).toBe('my-audio-model');
    expect(captured.persisted?.afterSong).toBeUndefined();

    const keyState = await invoke('settings', 'save-key', [{ key: 'sk-test-123456' }]) as { hasKey: boolean };
    expect(captured.stored?.name).toBe('AUDIO_API_KEY');
    expect(captured.stored?.value).toBe('sk-test-123456');
    expect(keyState.hasKey).toBe(true);
  });

  it('auto stops after 30 seconds without music', async () => {
    vi.useFakeTimers();
    try {
      const { world, capture } = makeWorld();
      const host = new FakeHost();
      await world.start(host);
      await startListening(world);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(capture.cb).toBeNull();
      expect(host.events.some((e) => e.type === 'music.state' && e.text.includes('30 秒'))).toBe(true);
      await world.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a fresh round when the user asks again and drops old pending events', async () => {
    const { world, capture } = makeWorld({
      cfg: { ...MUSIC_DEFAULTS, windowSec: 1, mode: 'both', screenFallback: false, readPlayerMeta: false, lookupLyrics: false, maxCallsPerMinute: 10 },
    });
    const host = new FakeHost();
    await world.start(host);
    const first = await startListening(world);
    expect(first).toContain('正在一起听');
    capture.feed(tone(1.2));
    await sleep(60);
    expect(host.events.some((e) => e.type === 'music.scene')).toBe(true);
    const again = await startListening(world);
    expect(again).toContain('重新开始');
    expect(host.withdrawn.length).toBeGreaterThan(0);
    expect(host.events.some((e) => e.type === 'music.state' && e.text.includes('重新开始'))).toBe(true);
    await world.stop();
  });

  it('switches songs with the previous complete summary and announces the new track', async () => {
    let metaCall = 0;
    const first: PlayerMeta = { ...meta, title: '第一首' };
    const second: PlayerMeta = { ...meta, title: '第二首' };
    const { world, capture } = makeWorld({
      cfg: { ...MUSIC_DEFAULTS, readPlayerMeta: true, lookupLyrics: false, windowSec: 1, mode: 'end', maxCallsPerMinute: 10 },
      metadataReader: async () => (metaCall++ === 0 ? first : second),
    });
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);

    capture.feed(tone(1.2));
    await sleep(40);
    capture.feed(silence(3));
    await sleep(180);
    expect(host.events.some((e) => e.type === 'music.ended')).toBe(true);
    expect(host.events.some((e) => e.type === 'music.ending')).toBe(true);

    capture.feed(tone(1.2));
    await sleep(220);
    const sw = host.events.find((e) => e.type === 'music.switch');
    expect(sw).toBeDefined();
    expect(sw!.text).toContain('第一首');
    expect(sw!.text).toContain('第二首');
    expect(host.pushOpts[host.events.indexOf(sw!)]?.trigger).toBe('interrupt');
    expect(host.withdrawn.length).toBeGreaterThan(0);
    await world.stop();
  });

  it('stops after one song when afterSong is stop', async () => {
    const { world, capture } = makeWorld({
      cfg: { ...MUSIC_DEFAULTS, afterSong: 'stop', windowSec: 1, mode: 'end', maxCallsPerMinute: 10, screenFallback: false, readPlayerMeta: false, lookupLyrics: false },
    });
    const host = new FakeHost();
    await world.start(host);
    await startListening(world);
    capture.feed(tone(1.2));
    await sleep(30);
    capture.feed(silence(3));
    await sleep(180);
    expect(host.events.some((e) => e.type === 'music.ended')).toBe(true);
    expect(host.events.some((e) => e.type === 'music.state' && e.text.includes('听完这首就停'))).toBe(true);
    expect(capture.cb).toBeNull();
    await world.stop();
  });
});
