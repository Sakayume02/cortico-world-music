/** 常驻 GSMTC 音源监控：每 300ms 读所有媒体会话，挑正在 Playing 的那个。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyMediaApp, mediaAppName } from './metadata.ts';

export interface SourceSession {
  app: string;
  appName: string;
  title?: string;
  artist?: string;
  album?: string;
  status: string;
}

export interface SourceSnapshot {
  at: number;
  source: SourceSession | null;
  sessions: SourceSession[];
}

export interface SourceMonitorLike {
  start(onSnapshot: (snapshot: SourceSnapshot) => void): void;
  stop(): void;
}

const SCRIPT = fileURLToPath(new URL('./scripts/gsmtc-watch.ps1', import.meta.url));

export class GsmTcSourceMonitor implements SourceMonitorLike {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private onSnapshot: ((snapshot: SourceSnapshot) => void) | null = null;

  start(onSnapshot: (snapshot: SourceSnapshot) => void): void {
    if (this.proc) return;
    this.onSnapshot = onSnapshot;
    this.buffer = '';
    try {
      this.proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc.stdout?.setEncoding('utf8');
      this.proc.stdout?.on('data', (chunk: string) => this.consume(chunk));
      this.proc.on('close', () => { this.proc = null; this.buffer = ''; });
    } catch {
      this.proc = null;
    }
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.buffer = '';
    try { proc?.kill(); } catch {}
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.parseLine(line);
      index = this.buffer.indexOf('\n');
    }
    // 防止 helper 输出异常时无限涨。
    if (this.buffer.length > 64 * 1024) this.buffer = '';
  }

  private parseLine(line: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const raw = Array.isArray(data.sessions) ? data.sessions : [];
    const sessions: SourceSession[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const app = typeof row.app === 'string' ? row.app : '';
      if (!app) continue;
      const status = typeof row.status === 'string' ? row.status : '';
      if (status === 'Closed') continue;
      sessions.push({
        app,
        appName: mediaAppName(app),
        title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined,
        artist: typeof row.artist === 'string' && row.artist.trim() ? row.artist.trim() : undefined,
        album: typeof row.album === 'string' && row.album.trim() ? row.album.trim() : undefined,
        status,
      });
    }
    const playing = sessions.filter((s) => s.status === 'Playing');
    // 多个 Playing 时优先真实播放器；没有再取第一个正在播的（浏览器等）。
    const source = playing.find((s) => classifyMediaApp(s.app) === 'player') ?? playing[0] ?? null;
    this.onSnapshot?.({ at: typeof data.at === 'number' ? data.at : Date.now(), source, sessions });
  }
}
