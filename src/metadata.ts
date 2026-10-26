/** 媒体来源：GSMTC 媒体会话 + 默认输出设备的 WASAPI 音频会话峰值。 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GSMTS_SCRIPT = fileURLToPath(new URL('./scripts/gsmts.ps1', import.meta.url));
const AUDIO_SESSIONS_SCRIPT = fileURLToPath(new URL('./scripts/audio-sessions.ps1', import.meta.url));

export type MediaKind = 'player' | 'browser' | 'other';

export interface PlayerMeta {
  kind: 'player' | 'browser';
  /** 原始应用标识（AUMID 或 exe 名）。 */
  app: string;
  appName: string;
  title: string;
  artist?: string;
  album?: string;
  status?: string;
  /** 来自 WASAPI 音频会话时的峰值。 */
  peak?: number;
  source?: 'gsmtc' | 'window-title' | 'audio-session';
}

export interface AudioSource {
  app: string;
  appName: string;
  peak: number;
  pid: number;
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

const BROWSERS: Array<{ match: RegExp; name: string }> = [
  { match: /chrome/i, name: 'Chrome' },
  { match: /msedge|edge/i, name: 'Edge' },
  { match: /firefox/i, name: 'Firefox' },
  { match: /brave/i, name: 'Brave' },
  { match: /vivaldi/i, name: 'Vivaldi' },
  { match: /opera/i, name: 'Opera' },
  { match: /360se/i, name: '360 浏览器' },
  { match: /qqbrowser/i, name: 'QQ 浏览器' },
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

export function browserName(app: string): string {
  return BROWSERS.find((b) => b.match.test(String(app ?? '')))?.name ?? String(app ?? '');
}

export function mediaAppName(app: string): string {
  return classifyMediaApp(app) === 'browser' ? browserName(app) : playerName(app);
}

const WINDOW_TITLE_SUFFIX = /\s*[-–—|•]\s*(网易云音乐|QQ\s*音乐|QQMusic|Spotify|Windows Media Player|Microsoft Media Player|Media Player|酷狗音乐|酷我音乐|foobar2000|iTunes|Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Vivaldi|Opera|360 安全浏览器|QQ 浏览器)\s*$/i;
const APP_ONLY = /^(网易云音乐|QQ\s*音乐|QQMusic|Spotify|Windows Media Player|Microsoft Media Player|Media Player|酷狗音乐|酷我音乐|foobar2000|iTunes|桌面歌词|Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Vivaldi|Opera|360 安全浏览器|QQ 浏览器|Idle)$/i;

function sameAppName(a: string, b: string): boolean {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** 播放器/浏览器窗口标题兜底：GSMTC 或音频会话没有标题时，从已知窗口的标题里拆歌名/歌手。 */
export function parsePlayerWindowTitle(app: string, windowTitle: string): PlayerMeta | null {
  const kind = classifyMediaApp(app);
  if (kind === 'other') return null;
  let clean = String(windowTitle ?? '').trim();
  if (!clean) return null;
  clean = clean.replace(WINDOW_TITLE_SUFFIX, '').trim();
  if (!clean || APP_ONLY.test(clean)) return null;
  const parts = clean.split(/\s+[-–—|•]\s+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const title = parts[0]!;
  const artist = parts[1];
  if (!title || APP_ONLY.test(title)) return null;
  return { kind, app, appName: mediaAppName(app), title, artist, status: 'window-title', source: 'window-title' };
}

/** 已知播放器/浏览器窗口的标题；可只查某个进程。 */
export async function readWindowTitleMetadata(appFilter?: string): Promise<PlayerMeta | null> {
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
    if (appFilter && !sameAppName(app, appFilter)) continue;
    const parsed = parsePlayerWindowTitle(app, windowTitle);
    if (parsed) return parsed;
  }
  return null;
}

/** 默认输出设备上各音频会话的峰值，挑最高的活动应用（跳过系统声音/Idle）。 */
export async function readAudioSessionSource(): Promise<AudioSource | null> {
  if (process.platform !== 'win32') return null;
  let stdout = '';
  try {
    const result = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', AUDIO_SESSIONS_SCRIPT,
    ], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 });
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
  let best: AudioSource | null = null;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const app = typeof row.app === 'string' ? row.app : '';
    const pid = typeof row.pid === 'number' ? row.pid : 0;
    const peak = typeof row.peak === 'number' ? row.peak : 0;
    const state = typeof row.state === 'number' ? row.state : 0;
    // 1 = AudioSessionState.Active；pid 0 是系统声音，跳过。
    if (!app || app.toLowerCase() === 'idle' || pid <= 0 || state !== 1 || peak < 0.005) continue;
    if (!best || peak > best.peak) {
      best = { app, appName: mediaAppName(app), peak, pid };
    }
  }
  return best;
}

/** 当前 GSMTC 媒体会话（只读一个当前会话，不再做窗口兜底）。 */
async function readGsmtcSession(): Promise<PlayerMeta | null> {
  if (process.platform !== 'win32') return null;
  let stdout = '';
  try {
    const result = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GSMTS_SCRIPT,
    ], { timeout: 9000, windowsHide: true, maxBuffer: 1024 * 1024 });
    stdout = String(result.stdout ?? '');
  } catch {
    return null;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout.trim() || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const app = typeof data.app === 'string' ? data.app : '';
  const status = typeof data.status === 'string' ? data.status : '';
  if (!title || !app) return null;
  if (status === 'Stopped' || status === 'Closed') return null;
  const kind = classifyMediaApp(app);
  if (kind === 'other') return null;
  const artist = typeof data.artist === 'string' && data.artist.trim() ? data.artist.trim() : undefined;
  const album = typeof data.album === 'string' && data.album.trim() ? data.album.trim() : undefined;
  return { kind, app, appName: mediaAppName(app), title, artist, album, status, source: 'gsmtc' };
}

function sameMediaApp(meta: PlayerMeta, source: AudioSource): boolean {
  if (classifyMediaApp(meta.app) !== classifyMediaApp(source.app)) return false;
  if (meta.appName === source.appName) return true;
  return sameAppName(meta.app, source.app);
}

/**
 * 读当前真正在发声的来源：先看 WASAPI 每进程峰值，再匹配 GSMTC/窗口标题。
 * 这样后台挂着的播放器不会抢当前浏览器；浏览器标题只作标签页参考。
 */
export async function readPlayerMetadata(): Promise<PlayerMeta | null> {
  const audio = await readAudioSessionSource();
  if (audio) {
    const kind = classifyMediaApp(audio.app);
    // 游戏/其它程序：不硬套播放器信息，交给截图/未知来源。
    if (kind === 'other') return null;

    const gsmtc = await readGsmtcSession();
    if (gsmtc && sameMediaApp(gsmtc, audio)) {
      return { ...gsmtc, peak: audio.peak, source: 'audio-session' };
    }

    const win = await readWindowTitleMetadata(audio.app);
    if (win) return { ...win, peak: audio.peak, source: 'audio-session' };

    // 音频会话确认了来源，但窗口没有标题：仍返回来源，让 bot 走截图/不猜。
    return {
      kind,
      app: audio.app,
      appName: audio.appName,
      title: '',
      status: 'audio-session',
      peak: audio.peak,
      source: 'audio-session',
    };
  }

  return (await readGsmtcSession()) ?? (await readWindowTitleMetadata());
}
