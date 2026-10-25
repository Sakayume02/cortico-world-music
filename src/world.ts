/**
 * 一起感受音乐：系统环回采集 → 静音/换歌判断 → 播放器信息/歌词 → 云端音频理解 → 事件与工具。
 *
 * 这个 World 默认待命，只有用户明确说要一起听音乐（bot 调 music_watch start）才开始采集。
 * 事件正文先给「感受」，参数放在末尾的内部参考里，让 bot 用人的方式回应。
 */
import { fileURLToPath } from 'node:url';
import type {
  BlobInput, EventEnvelope, ToolDef, TriggerMode, World, WorldHost, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { MUSIC_CONFIG_GROUP, MUSIC_DEFAULTS, type MusicConfigSection } from './config.ts';
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
  storeSecret(name: string, value: string): void;
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
  startedPushed?: boolean;
  sceneCursors: number[];
  error?: string;
  infoPromise?: Promise<ListeningInfo>;
}

interface LastEnded {
  text: string;
  track?: string;
  artist?: string;
  cursor?: number;
  sceneCursors: number[];
  at: number;
  /** false = 最后一窗还在补，true = 最终完整总结。 */
  final: boolean;
}

const EMPTY_INFO: ListeningInfo = { context: {} };

interface SettingsState {
  backend: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyName: string;
  models: string[];
}

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
  private lastEnded?: LastEnded;
  private lastEnding?: LastEnded;
  private previousEndPromise?: Promise<void>;
  private callTimes: number[] = [];
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private metadataTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private polledTrackKey = '';
  private listeningStartedAt = 0;
  private logger: (level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown) => void;

  constructor(private readonly opts: MusicWorldOptions) {
    this.logger = opts.log ?? (() => {});
  }

  envPromptVars(): Record<string, string> {
    return {
      'music.mode': this.opts.cfg.mode,
      'music.afterSong': this.opts.cfg.afterSong,
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
        hint: this.running ? (this.lastTrack ? `正在听 ${this.lastTrack}` : '正在听系统声音') : this.lastError || '待命：等用户明确说想一起听音乐',
      }],
      panels: [{
        id: 'settings',
        title: '接口与密钥',
        description: '选择分析后端/模型、填写接口地址和 API Key。密钥只写入部署 .env，不会回显。',
      }],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      config: [MUSIC_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.music.envPrompt',
        title: '一起感受音乐 · 环境提示词',
        description: '这个 World 进 system 前缀的那一段：默认待命、明确指令才开始、用感受而不是参数回应。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'music.mode', description: '当前默认模式：end / live / both。' },
          { name: 'music.afterSong', description: '听完一首后：continue / stop。' },
          { name: 'music.backend', description: '当前分析后端：dashscope / openai-compatible / off。' },
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
    // 默认待命：不采集，等用户明确提出听音乐，bot 再调 music_watch start。
    this.running = false;
    this.lastError = '';
    this.lastEnded = undefined;
    this.lastEnding = undefined;
    this.previousEndPromise = undefined;
    await this.pushState('待命：还没有开始听。等用户明确说想一起听音乐（比如“听首歌”“一起听”）时，再调用 music_watch start；不要自己开始。');
  }

  async stop(): Promise<void> {
    this.stopCapture();
    this.segmenter?.reset();
    this.segmenter = null;
    this.segment = undefined;
    this.lastTrack = '';
    this.lastEnded = undefined;
    this.lastEnding = undefined;
    this.previousEndPromise = undefined;
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
    this.polledTrackKey = `${meta.title}|${meta.artist ?? ''}|${meta.album ?? ''}`;
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
        album: meta.album,
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
    this.lastEnded = undefined;
    this.lastEnding = undefined;
    this.previousEndPromise = undefined;
    this.polledTrackKey = '';
    this.stopTimer();
    this.silenceTimer = setInterval(() => this.segmenter?.tick(), 500);
    this.silenceTimer.unref?.();
    this.listeningStartedAt = Date.now();
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => { void this.pushHeartbeat(); }, 120_000);
    this.heartbeatTimer.unref?.();
    this.stopMetadataPoll();
    if (this.opts.cfg.readPlayerMeta) {
      this.metadataTimer = setInterval(() => { void this.pollPlayerTrack(); }, 3000);
      this.metadataTimer.unref?.();
    }
  }

  /** 播放器元数据轮询：没有静音间隙的切歌也要能被发现。 */
  private async pollPlayerTrack(): Promise<void> {
    if (!this.running || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const meta = this.opts.metadataReader ? await this.opts.metadataReader() : await readPlayerMetadata();
      if (!meta) return;
      const key = `${meta.title}|${meta.artist ?? ''}|${meta.album ?? ''}`;
      if (!this.polledTrackKey) {
        this.polledTrackKey = key;
        return;
      }
      if (key === this.polledTrackKey) return;
      this.polledTrackKey = key;
      if (this.segmenter?.hasActiveSegment) {
        this.logger('debug', '播放器曲目变了，强制切段', { to: `${meta.artist ?? ''} ${meta.title}`.trim() });
        this.segmenter.flush();
      }
    } catch (e) {
      this.logger('debug', '播放器元数据轮询失败', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.pollInFlight = false;
    }
  }

  private stopMetadataPoll(): void {
    if (this.metadataTimer) {
      clearInterval(this.metadataTimer);
      this.metadataTimer = null;
    }
  }

  /** 每两分钟给 bot 一条【在听】状态，让它有机会冒一个很小的气泡。 */
  private async pushHeartbeat(): Promise<void> {
    if (!this.running) return;
    const minutes = Math.max(1, Math.round((Date.now() - this.listeningStartedAt) / 60_000));
    const track = this.lastTrack ? `当前：${this.lastTrack}` : '在听系统声音';
    await this.pushState(`【在听】${track}；已经一起听了约 ${minutes} 分钟。`, 'info', { heartbeat: true });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    this.stopHeartbeat();
    this.stopMetadataPoll();
    this.segmenter = null;
    this.capture?.stop();
    this.capture = null;
  }

  private async onSegmentStart(startedAt: number): Promise<void> {
    const segment: ActiveSegment = { startedAt, analyses: [], pending: [], windows: 0, keyWarned: false, sceneCursors: [] };
    segment.infoPromise = this.loadInfo().catch(() => EMPTY_INFO);
    this.segment = segment;

    const previous = this.previousEndPromise;
    this.previousEndPromise = undefined;
    // 换歌不能等完整总结太久；最后一窗没回来就先用 ending 版收尾，ended 再补最终版。
    if (previous) await Promise.race([previous, new Promise((resolve) => setTimeout(resolve, 8000))]);

    const info = await (segment.infoPromise ?? Promise.resolve(EMPTY_INFO));
    if (this.segment !== segment || segment.dropped || !this.running) return;

    const prev = this.lastEnded && Date.now() - this.lastEnded.at < 15_000
      ? this.lastEnded
      : this.lastEnding && Date.now() - this.lastEnding.at < 15_000
        ? this.lastEnding
        : undefined;
    if (prev && info.context.track) {
      await this.withdrawPrevious(prev);
      await this.pushSwitch(prev, info, segment);
      this.lastEnded = undefined;
      this.lastEnding = undefined;
    } else if (info.context.track) {
      await this.pushStarted(segment, info);
    } else {
      this.logger('debug', '听到声音，等待第一个窗口确认是不是音乐；没有播放器曲目信息');
    }
  }

  /** 换歌时把上一首还没投递的零散总结撤回，只留下面 switch 里的完整总结。 */
  private async withdrawPrevious(prev: LastEnded): Promise<void> {
    const host = this.host;
    if (!host?.withdrawPending) return;
    if (prev.cursor) {
      try { await host.withdrawPending(prev.cursor); } catch {}
    }
    for (const cursor of prev.sceneCursors) {
      try { await host.withdrawPending(cursor); } catch {}
    }
  }

  /** 曲目已知时，一开始就报幕（不等第一个 30 秒窗口）。 */
  private async pushStarted(segment: ActiveSegment, info: ListeningInfo): Promise<void> {
    const track = info.context.track;
    const artist = info.context.artist;
    const trackLine = track
      ? `开始一起听：${track}${artist ? ' — ' + artist : ''}（来自播放器媒体信息）。`
      : '开始听到一段音乐（系统声音），歌名还没认出来。';
    const announce = track
      ? `先用一句话报个幕：“是${artist ? artist + ' 的 ' : ''}《${track}》呀，我来听一下。” 然后跟着听。`
      : '先用一句话报个幕：“新的一首，我来听一下；歌名还没认出来。” 不要硬报歌名。';
    const lines = [trackLine, announce, '跟着听；想动就动，用现有动作；不想动就安静听。听歌时别打盹/睡觉，专注一点。结束/暂停时再说感受。'];

    let screenshot: BlobInput | undefined;
    let note = '';
    if (!track && this.opts.cfg.screenFallback) {
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
    if (info.lyrics) lines.push('已经拿到完整可信歌词（LRCLIB），歌词不用你听写；引用只引短句。');

    this.lastTrack = [track, artist].filter(Boolean).join(' — ');
    segment.startedPushed = true;
    await this.pushEvent('music.started', lines.join('\n'), {
      origin: 'external',
      meta: {
        startedAt: segment.startedAt,
        mode: this.opts.cfg.mode,
        backend: this.opts.cfg.backend,
        model: this.opts.cfg.model,
        track,
        artist,
        album: info.context.album,
        lyricsSource: info.lyrics ? 'lrclib' : undefined,
      },
      blobs: screenshot ? [screenshot] : undefined,
    }, 'flush');
  }

  /** 换歌：上一首完整总结 + 新歌报幕，用 interrupt 把上一首没说完的话停掉。 */
  private async pushSwitch(prev: LastEnded, info: ListeningInfo, segment: ActiveSegment): Promise<void> {
    const track = info.context.track;
    const artist = info.context.artist;
    const newLine = track
      ? `现在开始：${track}${artist ? ' — ' + artist : ''}（来自播放器媒体信息）。`
      : '现在开始：新的一首（来源未知，歌名还没认出来）。';
    const announce = track
      ? `“是${artist ? artist + ' 的 ' : ''}《${track}》呀，我来听一下。”`
      : '“新的一首，我来听一下；歌名还没认出来。”';
    const lines = [
      '【换歌】',
      prev.track ? `上一首：${prev.track}` : '上一首：未知',
      prev.final ? '上一首完整总结：' : '上一首总结（最后一窗还在补，music.ended 会补最终版）：',
      prev.text,
      '',
      newLine,
      '先用一两句话把上一首收个尾（只取感受/歌词/主旨，不要念内部参考）；然后报新歌：' + announce,
      '不要继续上一首的细节；如果上一首已经收过尾，就只报新歌。',
    ];
    this.lastTrack = [track, artist].filter(Boolean).join(' — ');
    segment.startedPushed = true;
    await this.pushEvent('music.switch', lines.join('\n'), {
      origin: 'external',
      meta: {
        switchedAt: segment.startedAt,
        previousTrack: prev.track,
        track,
        artist,
        album: info.context.album,
        model: this.opts.cfg.model,
      },
    }, 'interrupt');
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
    const task = (async () => {
      try {
        const info = await (segment.infoPromise ?? Promise.resolve(EMPTY_INFO));
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
          if (!segment.startedPushed) {
            const prev = this.lastEnded && Date.now() - this.lastEnded.at < 15_000
              ? this.lastEnded
              : this.lastEnding && Date.now() - this.lastEnding.at < 15_000
                ? this.lastEnding
                : undefined;
            if (prev) {
              await this.withdrawPrevious(prev);
              await this.pushSwitch(prev, info, segment);
              this.lastEnded = undefined;
              this.lastEnding = undefined;
            } else {
              await this.pushStarted(segment, info);
            }
          }
        }
        segment.analyses.push(outcome.analysis);
        this.lastAnalysis = outcome.analysis;
        this.logger('debug', '窗口分析完成', { summary: outcome.analysis.summary, title: info.context.track });
        if (this.opts.cfg.mode === 'live' || this.opts.cfg.mode === 'both') {
          const scene = await this.pushEvent('music.scene', formatAnalysis(outcome.analysis, info.context), {
            origin: 'external',
            meta: { windowStartedAt: window.startedAt, durationMs: window.durationMs, model: this.opts.cfg.model, track: info.context.track },
          }, 'debounce');
          if (scene) segment.sceneCursors.push(scene.cursor);
        }
      } catch (e) {
        segment.error = e instanceof Error ? e.message : String(e);
        this.logger('warn', '窗口分析异常', { error: segment.error });
      }
    })();
    segment.pending.push(task);
  }

  private onSegmentEnd(end: SegmentEnd): void {
    this.previousEndPromise = this.finishSegment(end).catch((e) => {
      this.logger('warn', '总结这一段失败', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  private async finishSegment(end: SegmentEnd): Promise<void> {
    const segment = this.segment;
    this.segment = undefined;
    if (!segment) return;
    if (segment.dropped || segment.confirmed !== true) {
      this.logger('debug', '这一段没有确认是音乐，不总结');
      return;
    }
    const info = await (segment.infoPromise ?? Promise.resolve(EMPTY_INFO));
    // 先立刻给一版（最后一窗可能还在分析），让 bot 马上开始收尾；最终版等各窗口回来。
    if (segment.pending.length > 0) {
      const partial = combineAnalyses(segment.analyses, end.durationMs, this.opts.cfg.windowSec, info.context);
      this.lastEnding = {
        text: partial,
        track: info.context.track,
        artist: info.context.artist,
        sceneCursors: [...segment.sceneCursors],
        at: Date.now(),
        final: false,
      };
      await this.pushEvent(
        'music.ending',
        `【听完了】最后一窗还在补分析。先给你这一版；music.ended 是最终完整版，不要重复已经说过的。\n\n${partial}`,
        {
          origin: 'external',
          meta: {
            endedAt: end.endedAt,
            durationMs: end.durationMs,
            track: info.context.track,
            artist: info.context.artist,
            album: info.context.album,
            partial: true,
          },
        },
        'flush',
      );
    }
    // 等已发出的窗口分析回来；最多等 40 秒，避免一段永远不结束。
    await Promise.race([
      Promise.allSettled(segment.pending),
      new Promise((resolve) => setTimeout(resolve, 40_000)),
    ]);
    let text = combineAnalyses(segment.analyses, end.durationMs, this.opts.cfg.windowSec, info.context);
    if (segment.error) text += `\n（这次有分析失败：${segment.error}）`;
    const saved = await this.pushEvent('music.ended', text, {
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
        album: info.context.album,
        lyricsSource: info.lyrics ? 'lrclib' : undefined,
      },
    }, 'flush');
    this.lastEnded = {
      text,
      track: info.context.track,
      artist: info.context.artist,
      cursor: saved?.cursor,
      sceneCursors: [...segment.sceneCursors],
      at: Date.now(),
      final: true,
    };
    this.lastEnding = undefined;
    if (this.opts.cfg.afterSong === 'stop') {
      this.lastEnded = undefined;
      this.lastEnding = undefined;
      this.stopCapture();
      this.lastTrack = '';
      await this.pushState('按设置：听完这首就停，已经停止。想继续再让我听。');
    }
  }

  private allowCall(): boolean {
    const now = Date.now();
    const limit = Math.max(1, this.opts.cfg.maxCallsPerMinute);
    this.callTimes = this.callTimes.filter((t) => now - t < 60_000);
    if (this.callTimes.length >= limit) return false;
    this.callTimes.push(now);
    return true;
  }

  private async pushState(text: string, level: 'info' | 'warn' | 'error' = 'info', extra?: Record<string, unknown>): Promise<void> {
    await this.pushEvent('music.state', text, { origin: 'internal', meta: { level, ...(extra ?? {}) } }, 'flush');
  }

  private async pushEvent(
    type: string,
    text: string,
    extra?: { origin?: 'internal' | 'external'; meta?: Record<string, unknown>; blobs?: BlobInput[] },
    trigger?: TriggerMode,
  ): Promise<EventEnvelope | undefined> {
    const host = this.host;
    if (!host) return undefined;
    try {
      return await host.pushEvent({
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
      return undefined;
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

  private panelState(): SettingsState {
    const cfg = this.opts.cfg;
    const keyName = cfg.apiKeySecret || 'AUDIO_API_KEY';
    let hasKey = false;
    try { hasKey = !!this.opts.secret(keyName); } catch {}
    return {
      backend: cfg.backend,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      hasKey,
      keyName,
      models: ['qwen3.8-omni-flash', 'qwen3-omni-flash', 'qwen-omni-turbo'],
    };
  }

  private async saveSettings(raw: unknown): Promise<SettingsState> {
    const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const backend = String(input.backend ?? this.opts.cfg.backend);
    if (backend !== 'dashscope' && backend !== 'openai-compatible' && backend !== 'off') {
      throw new Error('后端只能是 dashscope / openai-compatible / off。');
    }
    const baseUrl = String(input.baseUrl ?? this.opts.cfg.baseUrl).trim().replace(/\/+$/, '');
    if (backend !== 'off' && !/^https?:\/\//i.test(baseUrl)) {
      throw new Error('接口地址需要以 http:// 或 https:// 开头。');
    }
    const model = String(input.model ?? this.opts.cfg.model).trim();
    if (backend !== 'off' && !model) throw new Error('模型名不能为空。');

    this.opts.cfg.backend = backend as MusicConfigSection['backend'];
    this.opts.cfg.baseUrl = baseUrl;
    this.opts.cfg.model = model;
    this.opts.persist({ backend: backend as MusicConfigSection['backend'], baseUrl, model });
    return this.panelState();
  }

  private async saveKey(raw: unknown): Promise<SettingsState> {
    const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const key = String(input.key ?? '').trim();
    if (key.length < 8) throw new Error('API Key 太短，至少 8 个字符。');
    this.opts.storeSecret(this.opts.cfg.apiKeySecret || 'AUDIO_API_KEY', key);
    return this.panelState();
  }

  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== 'settings') throw new Error('未知面板：' + panel);
    if (method === 'state') return this.panelState();
    if (method === 'save') return this.saveSettings(args[0]);
    if (method === 'save-key') return this.saveKey(args[0]);
    if (method === 'reset') {
      return this.saveSettings({
        backend: 'dashscope',
        baseUrl: MUSIC_DEFAULTS.baseUrl,
        model: MUSIC_DEFAULTS.model,
      });
    }
    throw new Error('未知方法：' + method);
  }

  private statusText(): string {
    const cfg = this.opts.cfg;
    const segment = this.segment;
    const parts = [
      this.running ? '正在一起听系统声音' : '待命：还没有开始听（需要用户明确说想一起听音乐）',
      `模式：${cfg.mode}`,
      `听完一首：${cfg.afterSong === 'stop' ? '停止' : '继续听下一首'}`,
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
