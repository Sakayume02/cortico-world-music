import { describe, it, expect } from 'vitest';
import { classifyMediaApp, parsePlayerWindowTitle, playerName, type PlayerMeta } from '../src/metadata.ts';
import { lookupLyrics, stripSyncedLyrics } from '../src/lyrics.ts';

const meta: PlayerMeta = {
  kind: 'player',
  app: 'CloudMusic.exe',
  appName: '网易云音乐',
  title: '记忆点',
  artist: '陈卓璇',
  status: 'Playing',
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url: string, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch;
}

describe('metadata', () => {
  it('classifies known players, browsers and others', () => {
    expect(classifyMediaApp('CloudMusic.exe')).toBe('player');
    expect(classifyMediaApp('QQMusic.exe')).toBe('player');
    expect(classifyMediaApp('Spotify.exe')).toBe('player');
    expect(classifyMediaApp('chrome.exe')).toBe('browser');
    expect(classifyMediaApp('msedge.exe')).toBe('browser');
    expect(classifyMediaApp('explorer.exe')).toBe('other');
    expect(playerName('CloudMusic.exe')).toBe('网易云音乐');
  });

  it('parses player window titles as a fallback', () => {
    const netease = parsePlayerWindowTitle('cloudmusic.exe', '凉州曲_凉州曲 - 燕云十六声/Yida');
    expect(netease?.title).toBe('凉州曲_凉州曲');
    expect(netease?.artist).toBe('燕云十六声/Yida');

    const withSuffix = parsePlayerWindowTitle('QQMusic.exe', '记忆点 - 陈卓璇 - QQ音乐');
    expect(withSuffix?.title).toBe('记忆点');
    expect(withSuffix?.artist).toBe('陈卓璇');

    expect(parsePlayerWindowTitle('cloudmusic.exe', '桌面歌词')).toBeNull();
    expect(parsePlayerWindowTitle('cloudmusic.exe', '网易云音乐')).toBeNull();
    expect(parsePlayerWindowTitle('chrome.exe', 'Song - Artist - YouTube')).toBeNull();
  });
});

describe('lyrics', () => {
  it('strips LRC timestamps', () => {
    expect(stripSyncedLyrics('[00:01.00] 你 好\n[00:02.50] 再 见')).toBe('你 好\n再 见');
  });

  it('picks the matching record and returns plain lyrics', async () => {
    const result = await lookupLyrics(meta, mockFetch(() => new Response(JSON.stringify([
      { trackName: '别的歌', artistName: '别人', plainLyrics: '不对' },
      { trackName: '记忆点', artistName: '陈卓璇', plainLyrics: '所以你才选择离开\n别不说话我的亲爱' },
    ]), { status: 200 })));
    expect(result?.text).toContain('别不说话我的亲爱');
    expect(result?.source).toBe('lrclib');
    expect(result?.title).toBe('记忆点');
  });

  it('falls back to synced lyrics when plain is absent', async () => {
    const result = await lookupLyrics(meta, mockFetch(() => new Response(JSON.stringify([
      { trackName: '记忆点', artistName: '陈卓璇', plainLyrics: null, syncedLyrics: '[00:01.00] 你 好' },
    ]), { status: 200 })));
    expect(result?.text).toBe('你 好');
  });

  it('returns null when LRCLIB is overloaded', async () => {
    let calls = 0;
    const result = await lookupLyrics(meta, mockFetch(() => {
      calls++;
      return new Response('{"message":"busy"}', { status: 503 });
    }));
    expect(result).toBeNull();
    expect(calls).toBe(2);
  });
});
