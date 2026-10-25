/**
 * 一起感受音乐：系统环回采集 → 静音/换歌判断 → 播放器信息/歌词 → 云端音频理解 → 事件与工具。
 *
 * 这个 World 默认待命，只有老大明确说要一起听音乐（bot 调 music_watch start）才开始采集。
 * 事件正文先给「感受」，参数放在末尾的内部参考里，让 bot 用人的方式回应。
 */
import { fileURLToPath } from 'node:url';
import type {
  BlobInput, ToolDef, TriggerMode, World, WorldHost, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { MUSIC_CONFIG_GROUP, type MusicConfigSection } from './config.ts';
import { MusicSegmenter, type SegmentEnd, type WindowChunk } from './segment.ts';
import { encodeWav } from './wav.ts';
import { combineAnalyses, formatAnalysis, type ListeningContext, type MusicAnalysis } from './prompt.ts';
import { analyzeWithDashscope, type AnalysisOutcome } from './analysis.ts';
import { capturePrimaryScreen, type ScreenShot } from './screen.ts';
import { SystemAudioCapture, type CaptureLike } from './capture.ts';
import { readPlayerMetadata, type PlayerMeta } from './metadata.ts';
import { lookupLyrics, type LyricsResult } from './lyrics.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export const MUSIC_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'music_watch',
    description: 'Start listening only when the user explicitly asks to listen to music together, stop and summarize the current piece, or read the current state. This World stays on standby and never starts by itself.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start = the user explicitly asked to listen together; stop = stop and summarize; status = read state.' },
        mode: { type: 'string', enum: ['end', 'live', 'both'], description: 'Optional; switch the default delivery mode while starting.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'music_now',
    description: 'Read whether listening, the current segment, the current track (if the player exposes it) and the most recent analysis.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'music_mode',
    description: 'Set how analyses are delivered: end (summarize when a piece ends or pauses), live (a short immersive note per window), or both.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['end', 'live', 'both'] },
      },
      required: ['mode'],
    },
  },
];

interface ListeningInfo {
  context: ListeningContext;
  meta?: PlayerMeta;
  lyrics?: LyricsResult;
}

export interface MusicWorldOptions {
  cfg: MusicConfigSection;
  timezone: string;
  dataDir: string;
  secret(name: string): string;
  persist(patch: Partial<MusicConfigSection>): void;
  captureFactory?: () => CaptureLike;
  analyze?: (wav: Uint8Array, cfg: MusicConfigSection, key: string, windowSec: number, context?: ListeningContext) => Promise<AnalysisOutcome>;
  metadataReader?: () => Promise<PlayerMeta | null>;
  lyricsResolver?: (meta: PlayerMeta) => Promise<LyricsResult | null>;
  screenCapture?: () => Promise<ScreenShot | null>;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown) => void;
}

interface ActiveSegment {
  startedAt: number;
  analyses: MusicAnalysis[];
  pending: Promise<void>[];
  windows: number;
  keyWarned: boolean;
  confirmed?: boolean;
  dropped?: boolean;
  error?: string;
  infoPromise?: Promise<ListeningInfo>;
}

const EMPTY_INFO: ListeningInfo = { context: {} };

export class MusicWorld implements World {
  readonly id = 'music';

  private host?: WorldHost;
  private capture: CaptureLike | null = null;
  private segmenter: MusicSegmenter | null = null;
  private running = false;
  private lastError = '';
  private lastAnalysis?: MusicAnalysis;
  private lastTrack = '';
  private segment?: ActiveSegment;
  private callTimes: number[] = [];
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private logger: (level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown) => void;

  constructor(private readonly opts: MusicWorldOptions) {
    this.logger = opts.log ?? (() => {});
  }

  envPromptVars(): Record<string, string> {
    return {
      'music.mode': this.opts.cfg.mode,
      'music.backend': this.opts.cfg.backend,
      'music.model': this.opts.cfg.model,
    };
  }

  tools(): ToolDef[] {
    return [this.watchTool(), this.nowTool(), this.modeTool()];
  }

  webUi(): WorldWebUiDecl {
    return {
      label: '一起感受音乐',
      lamps: [{
        label: '一起听',
        state: this.running ? 'online' : this.lastError ? 'error' : 'offline',
        hint: this.running ? (this.lastTrack ? `正在听 ${this.lastTrack}` : '正在听系统声音') : this.lastError || '待命：等老大明确说想一起听音乐',
      }],
      config: [MUSIC_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.music.envPrompt',
        title: '一起感受音乐 · 环境提示词',
        description: '这个 World 进 system 前缀的那一段：默认待命、明确指令才开始、用感受而不是参数回应。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'music.mode', description: '当前默认模式：end / live / both。' },
          { name: 'music.backend', description: '当前分析后端：dashscope / off。' },
          { name: 'music.model', description: '当前云端模型名。' },
        ],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.logger = (level, message, data) => {
      if (level === 'debug' && !this.opts.cfg.debug) return;
      try { host.log[level](message, data); } catch {}
    };
    // 默认待命：不采集，等老大明确提出听音乐，bot 再调 music_watch start。
    this.running = false;
    this.lastError = '';
    await this.pushState('待命：还没有开始听。等老大明确说想一起听音乐（比如“听首歌”“一起听”）时，再调用 music_watch start；不要自己开始。');
  }

  async stop(): Promise<void> {
    this.stopCapture();
    this.segmenter?.reset();
    this.segmenter = null;
    this.segment = undefined;
    this.lastTrack = '';
  }

  private async loadInfo(): Promise<ListeningInfo> {
    const cfg = this.opts.cfg;
    if (!cfg.readPlayerMeta) return EMPTY_INFO;
    let meta: PlayerMeta | null = null;
    try {
      meta = this.opts.metadataReader ? await this.opts.metadataReader() : await readPlayerMetadata();
    } catch {
      meta = null;
    }
    if (!meta) return EMPTY_INFO;
    let lyrics: LyricsResult | null = null;
    if (cfg.lookupLyrics) {
      try {
        lyrics = this.opts.lyricsResolver ? await this.opts.lyricsResolver(meta) : await lookupLyrics(meta);
      } catch {
        lyrics = null;
      }
    }
    return {
      context: {
        track: meta.title,
        artist: meta.artist,
        lyrics: lyrics?.text,
        lyricsSource: lyrics ? 'lrclib' : undefined,
      },
      meta,
      lyrics: lyrics ?? undefined,
    };
  }

  private startCapture(): void {
    if (this.running) return;
    const capture = this.opts.captureFactory?.() ?? new SystemAudioCapture();
    const segmenter = new MusicSegmenter({
      windowSec: this.opts.cfg.windowSec,
      minWindowSec: Math.min(4, Math.max(1, this.opts.cfg.windowSec)),
      onStart: (info) => { void this.onSegmentStart(info.startedAt); },
      onWindow: (window) => { void this.onWindow(window); },
      onEnd: (end) => { void this.onSegmentEnd(end); },
    });
    capture.start((pcm) => segmenter.push48Stereo(pcm));
    this.capture = capture;
    this.segmenter = segmenter;
    this.running = true;
    this.lastError = '';
    this.stopTimer();
    this.silenceTimer = setInterval(() => this.segmenter?.tick(), 500);
    this.silenceTimer.unref?.();
  }

  private stopTimer(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private stopCapture(): void {
    this.running = false;
    this.stopTimer();
    this.segmenter = null;
    this.capture?.stop();
    this.capture = null;
  }

  private async onSegmentStart(startedAt: number): Promise<void> {
    const segment: ActiveSegment = { startedAt, analyses: [], pending: [], windows: 0, keyWarned: false };
    segment.infoPromise = this.loadInfo().catch(() => EMPTY_INFO);
    this.segment = segment;
    this.logger('debug', '听到声音，等待第一个窗口确认是不是音乐；同时读播放器信息和歌词');
  }

  private async onWindow(window: WindowChunk): Promise<void> {
    const segment = this.segment;
    if (!segment) return;
    if (this.opts.cfg.backend === 'off') return;
    if (!this.allowCall()) {
      this.logger('warn', '分析请求超过每分钟上限，跳过一个窗口');
      return;
    }
    const key = this.opts.secret(this.opts.cfg.apiKeySecret);
    if (!key) {
      this.lastError = `缺少密钥（${this.opts.cfg.apiKeySecret}），请配置部署 .env。`;
      if (!segment.keyWarned) {
        segment.keyWarned = true;
        await this.pushState('没有找到分析密钥，先只采集不分析。配置后重启 World 生效。', 'error');
      }
      return;
    }

    segment.windows++;
    const wav = encodeWav(window.pcm);
    const info = await (segment.infoPromise ?? Promise.resolve(EMPTY_INFO));
    const task = (async () => {
      try {
        const outcome = this.opts.analyze
          ? await this.opts.analyze(wav, this.opts.cfg, key, this.opts.cfg.windowSec, info.context)
          : await analyzeWithDashscope({
            wav, cfg: this.opts.cfg, apiKey: key, windowSec: this.opts.cfg.windowSec, context: info.context,
          });
        if (outcome.error) {
          segment.error = outcome.error;
          this.lastError = outcome.error;
          this.logger('warn', '窗口分析失败', { error: outcome.error });
          return;
        }
        if (!outcome.analysis) return;
        if (segment.dropped) return;

        // 有可信歌词时以 LRCLIB 为准，模型听写的歌词只作参考。
        if (info.lyrics?.text) {
          outcome.analysis.lyrics = {
            present: true,
            text: info.lyrics.text,
            confidence: 0.95,
            source: 'lrclib',
            complete: true,
          };
        }

        if (segment.confirmed === undefined) {
          if (outcome.analysis.isMusic !== true) {
            segment.confirmed = false;
            segment.dropped = true;
            this.logger('debug', '不是音乐，丢弃这一段', { summary: outcome.analysis.summary, confidence: outcome.analysis.musicConfidence });
            if (this.segment === segment) {
              this.segment = undefined;
              this.segmenter?.reset();
            }
            return;
          }
          segment.confirmed = true;
          const trackLine = info.context.track
            ? `开始一起听：${info.context.track}${info.context.artist ? ' — ' + info.context.artist : ''}（来自播放器媒体信息）。`
            : '开始听到一段音乐（系统声音）。';
          const lines = [trackLine, '先别急着报参数，跟着听；想动就动，用你现有的动作；不想动就安静听。结束/暂停时再说你听到了什么、想到了什么。'];

          let screenshot: BlobInput | undefined;
          let note = '';
          // 播放器已经给了曲目就不截屏；浏览器/来源未知时才用屏幕兜底。
          if (!info.context.track && this.opts.cfg.screenFallback) {
            const acceptsImage = this.host?.modelFacts.accepts('image/png') ?? false;
            if (!acceptsImage) {
              note = '（当前模型不接受图片，无法用截图识别播放器。）';
            } else {
              try {
                const shot = await (this.opts.screenCapture ?? (() => capturePrimaryScreen(this.opts.dataDir)))();
                if (shot) screenshot = { bytes: shot.bytes, mime: shot.mime, name: shot.name, fallbackText: '确认是音乐时的主屏截图，用来识别播放器/歌名' };
                else note = '（截屏失败，拿不到播放器画面。）';
              } catch {
                note = '（截屏失败，拿不到播放器画面。）';
              }
            }
          }
          if (screenshot) lines.push('附一张当前屏幕，供你识别播放器/歌名；识别不出就只说听感。');
          if (note) lines.push(note);
          if (info.lyrics) lines.push('已经拿到完整可信歌词（LRCLIB），歌词不用你听写；先用感受听，引用只引短句。');

          this.lastTrack = [info.context.track, info.context.artist].filter(Boolean).join(' — ');
          await this.pushEvent('music.started', lines.join('\n'), {
            origin: 'external',
            meta: {
              startedAt: segment.startedAt,
              mode: this.opts.cfg.mode,
              backend: this.opts.cfg.backend,
              model: this.opts.cfg.model,
              musicConfidence: outcome.analysis.musicConfidence,
              track: info.context.track,
              artist: info.context.artist,
              lyricsSource: info.lyrics ? 'lrclib' : undefined,
            },
            blobs: screenshot ? [screenshot] : undefined,
          }, 'flush');
        }
        segment.analyses.push(outcome.analysis);
        this.lastAnalysis = outcome.analysis;
        this.logger('debug', '窗口分析完成', { summary: outcome.analysis.summary, title: info.context.track });
        if (this.opts.cfg.mode === 'live' || this.opts.cfg.mode === 'both') {
          await this.pushEvent('music.scene', formatAnalysis(outcome.analysis, info.context), {
            origin: 'external',
            meta: { windowStartedAt: window.startedAt, durationMs: window.durationMs, model: this.opts.cfg.model, track: info.context.track },
          }, 'debounce');
        }
      } catch (e) {
        segment.error = e instanceof Error ? e.message : String(e);
        this.logger('warn', '窗口分析异常', { error: segment.error });
      }
    })();
    segment.pending.push(task);
  }

  private async onSegmentEnd(end: SegmentEnd): Promise<void> {
    const segment = this.segment;
    this.segment = undefined;
    if (!segment) return;
    if (segment.dropped || segment.confirmed !== true) {
      this.logger('debug', '这一段没有确认是音乐，不总结');
      return;
    }
    const info = await (segment.infoPromise ?? Promise.resolve(EMPTY_INFO));
    // 等已发出的窗口分析回来；最多等 65 秒，避免一段永远不结束。
    await Promise.race([
      Promise.allSettled(segment.pending),
      new Promise((resolve) => setTimeout(resolve, 65_000)),
    ]);
    let text = combineAnalyses(segment.analyses, end.durationMs, this.opts.cfg.windowSec, info.context);
    if (segment.error) text += `\n（这次有分析失败：${segment.error}）`;
    await this.pushEvent('music.ended', text, {
      origin: 'external',
      meta: {
        startedAt: end.startedAt,
        endedAt: end.endedAt,
        durationMs: end.durationMs,
        windows: segment.windows,
        analyses: segment.analyses.map((a) => a.summary),
        model: this.opts.cfg.model,
        track: info.context.track,
        artist: info.context.artist,
        lyricsSource: info.lyrics ? 'lrclib' : undefined,
      },
    }, 'flush');
  }

  private allowCall(): boolean {
    const now = Date.now();
    const limit = Math.max(1, this.opts.cfg.maxCallsPerMinute);
    this.callTimes = this.callTimes.filter((t) => now - t < 60_000);
    if (this.callTimes.length >= limit) return false;
    this.callTimes.push(now);
    return true;
  }

  private async pushState(text: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    await this.pushEvent('music.state', text, { origin: 'internal', meta: { level } }, 'flush');
  }

  private async pushEvent(
    type: string,
    text: string,
    extra?: { origin?: 'internal' | 'external'; meta?: Record<string, unknown>; blobs?: BlobInput[] },
    trigger?: TriggerMode,
  ): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type,
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: extra?.origin ?? 'external',
        senderKey: this.id,
        text,
        meta: extra?.meta,
        blobs: extra?.blobs,
      }, trigger ? { trigger } : undefined);
    } catch (e) {
      this.logger('warn', '推送事件失败', { type, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private watchTool(): ToolDef {
    return {
      ...MUSIC_TOOL_DECLS[0]!,
      handler: async (args: Record<string, unknown>) => {
        const action = String(args.action ?? '');
        const mode = args.mode === 'end' || args.mode === 'live' || args.mode === 'both' ? args.mode : undefined;
        if (action === 'start') {
          if (mode) { this.opts.cfg.mode = mode; this.opts.persist({ mode }); }
          if (!this.running) {
            try {
              this.startCapture();
              await this.pushState('开始一起听系统声音。');
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              this.lastError = message;
              throw new Error('无法开始采集：' + message);
            }
          }
          return this.statusText();
        }
        if (action === 'stop') {
          const hadSegment = this.segmenter?.hasActiveSegment ?? false;
          if (hadSegment) this.segmenter?.flush();
          this.stopCapture();
          this.segment = undefined;
          await this.pushState('已停止一起听。');
          return hadSegment ? '已停止；刚才那段会在分析完成后作为 music.ended 送来。' : '已停止。';
        }
        if (action === 'status') return this.statusText();
        throw new Error('music_watch 需要 action = start / stop / status。');
      },
    };
  }

  private nowTool(): ToolDef {
    return {
      ...MUSIC_TOOL_DECLS[1]!,
      handler: async () => {
        const lines = [this.statusText()];
        if (this.lastAnalysis) lines.push('最近一次分析：\n' + formatAnalysis(this.lastAnalysis));
        else lines.push('还没拿到过分析。');
        return lines.join('\n');
      },
    };
  }

  private modeTool(): ToolDef {
    return {
      ...MUSIC_TOOL_DECLS[2]!,
      handler: async (args: Record<string, unknown>) => {
        const mode = String(args.mode ?? '');
        if (mode !== 'end' && mode !== 'live' && mode !== 'both') throw new Error('mode 只能是 end / live / both。');
        this.opts.cfg.mode = mode;
        this.opts.persist({ mode });
        return `模式已切到 ${mode}。`;
      },
    };
  }

  private statusText(): string {
    const cfg = this.opts.cfg;
    const segment = this.segment;
    const parts = [
      this.running ? '正在一起听系统声音' : '待命：还没有开始听（需要老大明确说想一起听音乐）',
      `模式：${cfg.mode}`,
      `后端：${cfg.backend}（${cfg.model}）`,
    ];
    if (this.lastTrack) parts.push('当前曲目：' + this.lastTrack);
    if (segment) {
      const sec = Math.round((Date.now() - segment.startedAt) / 1000);
      parts.push(`当前一段：约 ${sec} 秒，已分析 ${segment.analyses.length} 个窗口`);
    }
    if (this.lastError) parts.push(`最近错误：${this.lastError}`);
    return parts.join('\n');
  }
}
