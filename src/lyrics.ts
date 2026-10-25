/** 完整歌词：只对桌面播放器（有准确曲目信息）查 LRCLIB；浏览器按音频识别，不查。 */
import type { PlayerMeta } from './metadata.ts';

export interface LyricsResult {
  text: string;
  source: 'lrclib';
  url: string;
  title: string;
  artist?: string;
  complete: true;
}

interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const norm = (value: unknown): string => String(value ?? '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');

/** 把 LRC 时间戳去掉，得到纯歌词。 */
export function stripSyncedLyrics(synced: string): string {
  return synced
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line && !line.startsWith('['))
    .join('\n');
}

function lyricText(record: LrclibRecord): string {
  const plain = String(record.plainLyrics ?? '').trim();
  if (plain) return plain;
  const synced = String(record.syncedLyrics ?? '').trim();
  return synced ? stripSyncedLyrics(synced) : '';
}

/**
 * 按播放器给出的曲目/歌手查 LRCLIB。查不到、服务不可用、不是播放器时返回 null，
 * 由分析提示词退回到「只听清多少写多少」。
 */
export async function lookupLyrics(meta: PlayerMeta, fetchImpl: typeof fetch = fetch): Promise<LyricsResult | null> {
  if (meta.kind !== 'player' || !meta.title) return null;
  const params = new URLSearchParams({ track_name: meta.title });
  if (meta.artist) params.set('artist_name', meta.artist);
  const url = `https://lrclib.net/api/search?${params.toString()}`;

  const doFetch = async (): Promise<Response> => fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'cortico-world-music/0.1.0 (Coopanion World; https://github.com/Pal-AI-Lab/Cortico)',
    },
    signal: AbortSignal.timeout(8000),
  });

  let res: Response;
  try {
    res = await doFetch();
    if (res.status === 503 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 1200));
      res = await doFetch();
    }
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let records: unknown;
  try {
    records = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(records)) return null;

  const titleNorm = norm(meta.title);
  const artistNorm = norm(meta.artist ?? '');
  let best: { record: LrclibRecord; text: string; score: number } | null = null;
  for (const raw of records) {
    const record = raw as LrclibRecord;
    if (!record || record.instrumental) continue;
    const text = lyricText(record).trim();
    if (!text) continue;
    const trackNorm = norm(record.trackName);
    const recordArtistNorm = norm(record.artistName);
    let score = 0;
    if (trackNorm === titleNorm) score += 4;
    else if (trackNorm.includes(titleNorm) || titleNorm.includes(trackNorm)) score += 2;
    if (artistNorm && recordArtistNorm === artistNorm) score += 3;
    else if (artistNorm && (recordArtistNorm.includes(artistNorm) || artistNorm.includes(recordArtistNorm))) score += 1;
    if (!best || score > best.score) best = { record, text, score };
  }
  if (!best || best.score <= 0) return null;
  return {
    text: best.text,
    source: 'lrclib',
    url: 'https://lrclib.net',
    title: String(best.record.trackName ?? meta.title),
    artist: best.record.artistName ? String(best.record.artistName) : meta.artist,
    complete: true,
  };
}
