/** 支持的媒体会话：当前正在播放的播放器（GSMTC，Windows 媒体会话）。 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GSMTS_SCRIPT = fileURLToPath(new URL('./scripts/gsmts.ps1', import.meta.url));

export type MediaKind = 'player' | 'browser' | 'other';

export interface PlayerMeta {
  kind: 'player';
  /** 原始应用标识（AUMID 或 exe 名）。 */
  app: string;
  appName: string;
  title: string;
  artist?: string;
  album?: string;
  status?: string;
}

const PLAYERS: Array<{ match: RegExp; name: string }> = [
  { match: /cloudmusic|netease/i, name: '网易云音乐' },
  { match: /qqmusic/i, name: 'QQ 音乐' },
  { match: /spotify/i, name: 'Spotify' },
  { match: /wmplayer/i, name: 'Windows Media Player' },
  { match: /zunemusic|mediaplayer|music\.ui/i, name: 'Media Player' },
  { match: /foobar/i, name: 'foobar2000' },
  { match: /kugou/i, name: '酷狗音乐' },
  { match: /kuwo|kwmusic/i, name: '酷我音乐' },
  { match: /itunes/i, name: 'iTunes' },
];

export function classifyMediaApp(app: string): MediaKind {
  const s = String(app ?? '').toLowerCase();
  if (/(chrome|msedge|firefox|brave|opera|vivaldi|360se|qqbrowser)/.test(s)) return 'browser';
  if (PLAYERS.some((p) => p.match.test(s))) return 'player';
  return 'other';
}

export function playerName(app: string): string {
  return PLAYERS.find((p) => p.match.test(String(app ?? '')))?.name ?? String(app ?? '');
}

const WINDOW_TITLE_SUFFIX = /\s*[-–—|•]\s*(网易云音乐|QQ\s*音乐|QQMusic|Spotify|Windows Media Player|Microsoft Media Player|Media Player|酷狗音乐|酷我音乐|foobar2000|iTunes)\s*$/i;
const APP_ONLY = /^(网易云音乐|QQ\s*音乐|QQMusic|Spotify|Windows Media Player|Microsoft Media Player|Media Player|酷狗音乐|酷我音乐|foobar2000|iTunes|桌面歌词)$/i;

/** 播放器窗口标题兜底：GSMTC 没有会话时，从已知播放器窗口的标题里拆歌名/歌手。 */
export function parsePlayerWindowTitle(app: string, windowTitle: string): PlayerMeta | null {
  if (classifyMediaApp(app) !== 'player') return null;
  let clean = String(windowTitle ?? '').trim();
  if (!clean) return null;
  clean = clean.replace(WINDOW_TITLE_SUFFIX, '').trim();
  if (!clean || APP_ONLY.test(clean)) return null;
  const parts = clean.split(/\s+[-–—|•]\s+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const title = parts[0]!;
  const artist = parts[1];
  if (!title || APP_ONLY.test(title)) return null;
  return { kind: 'player', app, appName: playerName(app), title, artist, status: 'window-title' };
}

/** 已知播放器窗口的标题；GSMTC 不可用时的兜底。 */
export async function readWindowTitleMetadata(): Promise<PlayerMeta | null> {
  if (process.platform !== 'win32') return null;
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json -Compress',
  ].join('; ');
  let stdout = '';
  try {
    const result = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024 });
    stdout = String(result.stdout ?? '');
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim() || '[]');
  } catch {
    return null;
  }
  const rows = Array.isArray(data) ? data : [data];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const app = typeof row.ProcessName === 'string' ? row.ProcessName : '';
    const windowTitle = typeof row.MainWindowTitle === 'string' ? row.MainWindowTitle : '';
    const parsed = parsePlayerWindowTitle(app, windowTitle);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 读当前系统媒体会话。只认已知的桌面播放器；浏览器按「自己识别」处理，返回 null。
 * 没有会话、解析失败、应用不是播放器时都返回 null，交给音频识别兜底。
 */
export async function readPlayerMetadata(): Promise<PlayerMeta | null> {
  if (process.platform !== 'win32') return null;
  let stdout = '';
  try {
    const result = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GSMTS_SCRIPT,
    ], { timeout: 9000, windowsHide: true, maxBuffer: 1024 * 1024 });
    stdout = String(result.stdout ?? '');
  } catch {
    return readWindowTitleMetadata();
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout.trim() || '{}') as Record<string, unknown>;
  } catch {
    return readWindowTitleMetadata();
  }
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const app = typeof data.app === 'string' ? data.app : '';
  const status = typeof data.status === 'string' ? data.status : '';
  if (!title || !app) return readWindowTitleMetadata();
  if (status === 'Stopped' || status === 'Closed') return readWindowTitleMetadata();
  if (classifyMediaApp(app) !== 'player') return readWindowTitleMetadata();
  const artist = typeof data.artist === 'string' && data.artist.trim() ? data.artist.trim() : undefined;
  const album = typeof data.album === 'string' && data.album.trim() ? data.album.trim() : undefined;
  return { kind: 'player', app, appName: playerName(app), title, artist, album, status };
}
