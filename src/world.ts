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
import { combineAnalyses, formatAnalysis, styleShift, type ListeningContext, type MusicAnalysis } from './prompt.ts';
import { analyzeWithDashscope, type AnalysisOutcome } from './analysis.ts';
import { capturePrimaryScreen, type ScreenShot } from './screen.ts';
import { SystemAudioCapture, type CaptureLike } from './capture.ts';
import { readPlayerMetadata, type PlayerMeta } from './metadata.ts';
import { lookupLyrics, type LyricsResult } from './lyrics.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 没有可听音乐这么久就自动停，省 token 和反复截图。 */
const IDLE_STOP_MS = 30_000;
const IDLE_CHECK_MS = 5_000;

export const MUSIC_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'music_watch',
    description: 'Start listening only when the user explicitly asks to listen to music together. Calling start again while already listening drops the old round (including pending summaries) and starts a new round. stop summarizes the current piece; status reads the state.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start = user explicitly asked to listen (again = new round, drop the old); stop = stop and summarize; status = read state.' },
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
  /** 第几轮听歌；用户重新下听歌指令时递增，旧一轮的分析/事件全部作废。 */
  generation: number;
  analyses: MusicAnalysis[];
  pending: Promise<void>[];
  windows: number;
  keyWarned: boolean;
  confirmed?: boolean;
  dropped?: boolean;
  superseded?: boolean;
  startedPushed?: boolean;
  sceneCursors: number[];
  error?: string;
  /** 风格突变后最后一次排查播放器信息的时间，防止连续窗口反复截图。 */
  lastRecheckAt?: number;
  /** 先解析出曲目（不等歌词），让报幕/换歌尽快发出。 */
  trackPromise?: Promise<ListeningInfo>;
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
  /** 原始段；换歌后标记 superseded，阻止它再补发结束总结/实时短评。 */
  segment?: ActiveSegment;
}

const EMPTY_INFO: ListeningInfo = { context: { sourceKind: 'unknown' } };

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
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;
  private pollInFlight = false;
  private polledTrackKey = '';
  private pendingTrackMeta?: { meta: PlayerMeta; at: number };
  private playerPaused = false;
  private lastPauseAt = 0;
  private listeningStartedAt = 0;
  private listenGeneration = 0;
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
    this.pendingTrackMeta = undefined;
    this.playerPaused = false;
    this.lastPauseAt = 0;
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
    this.pendingTrackMeta = undefined;
    this.playerPaused = false;
    this.lastPauseAt = 0;
  }

  /** 读曲目（不查歌词，尽量快），优先用轮询刚发现的曲目，避免元数据更新滞后的旧曲目。 */
  private async loadMeta(): Promise<PlayerMeta | null> {
    if (!this.opts.cfg.readPlayerMeta) return null;
    const pending = this.pendingTrackMeta;
    if (pending && Date.now() - pending.at < 10_000) {
      this.pendingTrackMeta = undefined;
      return pending.meta;
    }
    try {
      return this.opts.metadataReader ? await this.opts.metadataReader() : await readPlayerMetadata();
    } catch {
      return null;
    }
  }

  private async loadTrack(): Promise<ListeningInfo> {
    const meta = await this.loadMeta();
    if (!meta) return { context: { sourceKind: 'unknown' } };
    this.polledTrackKey = `${meta.app}|${meta.title}|${meta.artist ?? ''}|${meta.album ?? ''}`;
    if (meta.kind === 'browser') {
      return {
        context: { sourceKind: 'browser', sourceApp: meta.appName, tabTitle: meta.title || undefined },
        meta,
      };
    }
    return {
      context: { sourceKind: 'player', sourceApp: meta.appName, track: meta.title || undefined, artist: meta.artist, album: meta.album },
      meta,
    };
  }

  /** 歌词/背景在后台补，不挡报幕和换歌；浏览器不查歌词。 */
  private async loadFullInfo(trackInfo: ListeningInfo): Promise<ListeningInfo> {
    const meta = trackInfo.meta;
    if (!meta || meta.kind !== 'player' || !meta.title || !this.opts.cfg.lookupLyrics) return trackInfo;
    let lyrics: LyricsResult | null = null;
    try {
      lyrics = this.opts.lyricsResolver ? await this.opts.lyricsResolver(meta) : await lookupLyrics(meta);
    } catch {
      lyrics = null;
    }
    if (!lyrics) return trackInfo;
    return {
      context: { ...trackInfo.context, lyrics: lyrics.text, lyricsSource: 'lrclib' },
      meta,
      lyrics,
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
    this.pendingTrackMeta = undefined;
    this.playerPaused = false;
    this.lastPauseAt = 0;
    this.stopTimer();
    this.silenceTimer = setInterval(() => this.segmenter?.tick(), 500);
    this.silenceTimer.unref?.();
    this.listeningStartedAt = Date.now();
    this.stopIdle();
    this.lastActivityAt = Date.now();
    this.idleTimer = setInterval(() => { void this.checkIdle(); }, IDLE_CHECK_MS);
    this.idleTimer.unref?.();
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => { void this.pushHeartbeat(); }, 60_000);
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
      if (meta.status === 'Paused') {
        if (!this.playerPaused) {
          this.playerPaused = true;
          this.lastPauseAt = Date.now();
          const label = [meta.title, meta.artist].filter(Boolean).join(' — ');
          await this.pushState(`播放器暂停了${label ? `：${label}` : ''}。我把刚才那段收一下。`, 'info', { paused: true, track: label || undefined });
        }
      } else {
        this.playerPaused = false;
      }
      const key = `${meta.app}|${meta.title}|${meta.artist ?? ''}|${meta.album ?? ''}`;
      if (!this.polledTrackKey) {
        this.polledTrackKey = key;
        return;
      }
      if (key === this.polledTrackKey) return;
      this.polledTrackKey = key;
      this.pendingTrackMeta = { meta, at: Date.now() };
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

  /** 每分钟给 bot 一条【在听】状态：让它定期冒一个很小的“还在听”，用户能看到持续提示。 */
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

  /** 连续 30 秒没有可听音乐就自动停，避免 token 白花和反复截图。 */
  private async checkIdle(): Promise<void> {
    if (!this.running || this.segmenter?.hasActiveSegment) return;
    if (Date.now() - this.lastActivityAt < IDLE_STOP_MS) return;
    this.stopIdle();
    this.stopCapture();
    this.segment = undefined;
    this.lastTrack = '';
    this.lastError = '';
    await this.pushState('连续 30 秒没有听到音乐，先自动停止听；想继续再让我听。', 'info', { idleStop: true });
  }

  private stopIdle(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
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
    this.stopIdle();
    this.segmenter = null;
    this.capture?.stop();
    this.capture = null;
  }

  /** 用户重新下听歌指令：丢掉上一轮的分析、总结和还没投递的事件，换新一轮。 */
  private async resetListening(): Promise<void> {
    const old = this.segment;
    if (old) old.superseded = true;
    this.listenGeneration++;
    const cursors: number[] = old ? [...old.sceneCursors] : [];
    for (const prev of [this.lastEnding, this.lastEnded]) {
      if (!prev) continue;
      if (prev.cursor) cursors.push(prev.cursor);
      cursors.push(...prev.sceneCursors);
    }
    this.stopCapture();
    this.segment = undefined;
    this.lastEnded = undefined;
    this.lastEnding = undefined;
    this.previousEndPromise = undefined;
    this.lastTrack = '';
    this.lastAnalysis = undefined;
    this.lastError = '';
    this.callTimes = [];
    this.pendingTrackMeta = undefined;
    this.polledTrackKey = '';
    this.playerPaused = false;
    this.lastPauseAt = 0;
    const host = this.host;
    for (const cursor of [...new Set(cursors)]) {
      try { await host?.withdrawPending?.(cursor); } catch {}
    }
  }

  private async onSegmentStart(startedAt: number): Promise<void> {
    this.lastActivityAt = Date.now();
    const segment: ActiveSegment = { startedAt, generation: this.listenGeneration, analyses: [], pending: [], windows: 0, keyWarned: false, sceneCursors: [] };
    segment.trackPromise = this.loadTrack().catch(() => EMPTY_INFO);
    segment.infoPromise = segment.trackPromise.then((track) => this.loadFullInfo(track)).catch(() => EMPTY_INFO);
    this.segment = segment;

    const previous = this.previousEndPromise;
    this.previousEndPromise = undefined;
    // 换歌不能等完整总结太久；最后一窗没回来就先用 ending 版收尾，ended 再补最终版。
    if (previous) await Promise.race([previous, new Promise((resolve) => setTimeout(resolve, 8000))]);

    const trackInfo = await (segment.trackPromise ?? Promise.resolve(EMPTY_INFO));
    if (this.segment !== segment || segment.dropped || segment.generation !== this.listenGeneration || !this.running) return;

    const prev = this.lastEnded && Date.now() - this.lastEnded.at < 15_000
      ? this.lastEnded
      : this.lastEnding && Date.now() - this.lastEnding.at < 15_000
        ? this.lastEnding
        : undefined;
    if (prev && trackInfo.context.track) {
      await this.withdrawPrevious(prev);
      await this.pushSwitch(prev, trackInfo, segment);
      this.lastEnded = undefined;
      this.lastEnding = undefined;
    } else if (trackInfo.context.track) {
      await this.pushStarted(segment, trackInfo);
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

  /** 截一张主屏，给 bot 确认播放器/歌名；拿不到就返回说明。 */
  private async captureScreen(): Promise<{ blob?: BlobInput; note?: string }> {
    if (!this.opts.cfg.screenFallback) return {};
    const acceptsImage = this.host?.modelFacts.accepts('image/png') ?? false;
    if (!acceptsImage) return { note: '（当前模型不接受图片，无法用截图识别播放器。）' };
    try {
      const shot = await (this.opts.screenCapture ?? (() => capturePrimaryScreen(this.opts.dataDir)))();
      if (!shot) return { note: '（截屏失败，拿不到播放器画面。）' };
      return { blob: { bytes: shot.bytes, mime: shot.mime, name: shot.name, fallbackText: '确认是音乐时的主屏截图，用来识别播放器/歌名' } };
    } catch {
      return { note: '（截屏失败，拿不到播放器画面。）' };
    }
  }

  /** 曲目已知时，一开始就报幕（不等第一个窗口）；浏览器/来源未知用标签页或截图确认。 */
  private async pushStarted(segment: ActiveSegment, info: ListeningInfo): Promise<void> {
    const track = info.context.track;
    const artist = info.context.artist;
    const tabTitle = info.context.tabTitle;
    const sourceApp = info.context.sourceApp;
    const browser = info.context.sourceKind === 'browser';
    const player = info.context.sourceKind === 'player';
    const trackLine = track
      ? `开始一起听：${track}${artist ? ' — ' + artist : ''}（来自播放器媒体信息）。`
      : browser
        ? `浏览器在放：${tabTitle ?? '标签页标题没拿到'}${sourceApp ? `（${sourceApp}）` : ''}；这只是标签页参考，不是已确认歌名。`
        : player
          ? `播放器正在放：${sourceApp ?? '未知播放器'}；歌名没拿到，先听，不硬报。`
          : '没认出来是哪个程序/歌名；先正常听，不要猜。';
    const announce = track
      ? `先用一句话报个幕：“是${artist ? artist + ' 的 ' : ''}《${track}》呀，我来听一下。” 然后跟着听。`
      : browser
        ? '先用一句话说“浏览器里在放，我先听着；歌名还没确认，不硬报。” 然后跟着听。'
        : player
          ? '先用一句话说“播放器里在放，我先听着；歌名没拿到，不硬报。” 然后跟着听。'
          : '先用一句话说“我没认出来是什么，先听着；不乱猜。” 然后跟着听。';
    const lines = [trackLine, announce, '跟着听；想动就动，用现有动作；不想动就安静听。听歌时别打盹/睡觉，专注一点。结束/暂停时再说感受。'];

    const uncertain = !track || info.meta?.status === 'window-title';
    let screenshot: BlobInput | undefined;
    let note = '';
    if (uncertain) {
      const shot = await this.captureScreen();
      screenshot = shot.blob;
      note = shot.note ?? '';
    }
    if (screenshot) {
      lines.push(browser
        ? '附一张当前屏幕，供你确认浏览器标签页/歌名；标签页标题只是参考，以屏幕和音频为准；还是认不出就说不知道，别猜。'
        : '附一张当前屏幕，供你确认播放器/歌名；如果播放器信息和屏幕不一致，以屏幕为准；识别不出就只说听感。');
    }
    if (note) lines.push(note);
    if (info.lyrics) lines.push('已经拿到完整可信歌词（LRCLIB），歌词不用你听写；引用只引短句。');

    this.lastTrack = track
      ? [track, artist].filter(Boolean).join(' — ')
      : browser
        ? [tabTitle ?? '浏览器', sourceApp].filter(Boolean).join(' — ')
        : player
          ? [sourceApp ?? '播放器', '播放器'].filter(Boolean).join(' — ')
          : '来源未知';
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
        sourceKind: info.context.sourceKind,
        sourceApp,
        tabTitle,
        trackSource: info.meta?.status,
        lyricsSource: info.lyrics ? 'lrclib' : undefined,
      },
      blobs: screenshot ? [screenshot] : undefined,
    }, 'flush');
  }

  /** 换歌：上一首完整总结 + 新歌报幕，用 interrupt 把上一首没说完的话停掉。 */
  private async pushSwitch(prev: LastEnded, info: ListeningInfo, segment: ActiveSegment): Promise<void> {
    // 换歌后旧段彻底收口：不再补发最终总结/实时短评，避免新歌已经在放还聊上一首。
    if (prev.segment) prev.segment.superseded = true;
    const track = info.context.track;
    const artist = info.context.artist;
    const tabTitle = info.context.tabTitle;
    const sourceApp = info.context.sourceApp;
    const browser = info.context.sourceKind === 'browser';
    const player = info.context.sourceKind === 'player';
    const newLine = track
      ? `现在开始：${track}${artist ? ' — ' + artist : ''}（来自播放器媒体信息）。`
      : browser
        ? `现在开始：浏览器里的一首（${tabTitle ?? '标题没拿到'}；只是标签页参考，不是已确认歌名）。`
        : player
          ? `现在开始：播放器（${sourceApp ?? '未知播放器'}）里的一首；歌名没拿到，不硬报。`
          : '现在开始：新的一首（没认出来是哪个程序/歌名）。';
    const announce = track
      ? `“是${artist ? artist + ' 的 ' : ''}《${track}》呀，我来听一下。”`
      : browser
        ? '“浏览器里在放，我先听着；歌名还没确认，不硬报。”'
        : player
          ? '“播放器里在放，我先听着；歌名没拿到，不硬报。”'
          : '“我没认出来是什么，先听着；不乱猜。”';
    const lines = [
      '【换歌】',
      prev.track ? `上一首：${prev.track}` : '上一首：未知',
      prev.final ? '上一首完整总结：' : '上一首总结（最后一窗没赶上，就以这版为准）：',
      prev.text,
      '',
      newLine,
      '先用一两句话把上一首收个尾（只取感受/歌词/主旨，不要念内部参考）；然后报新歌：' + announce,
      '不要继续上一首的细节；如果上一首已经收过尾，就只报新歌。',
    ];
    const uncertain = !track || info.meta?.status === 'window-title';
    let screenshot: BlobInput | undefined;
    if (uncertain) {
      const shot = await this.captureScreen();
      screenshot = shot.blob;
      if (screenshot) lines.push(browser
        ? '附一张当前屏幕，供你确认浏览器标签页/新歌；标签页标题只是参考，以屏幕和音频为准；还是认不出就说不知道。'
        : '附一张当前屏幕，供你确认新歌；如果播放器信息和屏幕不一致，以屏幕为准。');
      else if (shot.note) lines.push(shot.note);
    }
    this.lastTrack = track
      ? [track, artist].filter(Boolean).join(' — ')
      : browser
        ? [tabTitle ?? '浏览器', sourceApp].filter(Boolean).join(' — ')
        : player
          ? [sourceApp ?? '播放器', '播放器'].filter(Boolean).join(' — ')
          : '来源未知';
    segment.startedPushed = true;
    await this.pushEvent('music.switch', lines.join('\n'), {
      origin: 'external',
      meta: {
        switchedAt: segment.startedAt,
        previousTrack: prev.track,
        track,
        artist,
        album: info.context.album,
        sourceKind: info.context.sourceKind,
        sourceApp,
        tabTitle,
        trackSource: info.meta?.status,
        model: this.opts.cfg.model,
      },
      blobs: screenshot ? [screenshot] : undefined,
    }, 'interrupt');
  }

  private async onWindow(window: WindowChunk): Promise<void> {
    this.lastActivityAt = Date.now();
    const segment = this.segment;
    if (!segment) return;
    if (segment.generation !== this.listenGeneration) return;
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
        if (segment.dropped || segment.superseded || segment.generation !== this.listenGeneration) return;

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
          const hasTrack = !!info.context.track;
          if (outcome.analysis.isMusic !== true && !hasTrack) {
            segment.confirmed = false;
            segment.dropped = true;
            this.logger('debug', '不是音乐，丢弃这一段', { summary: outcome.analysis.summary, confidence: outcome.analysis.musicConfidence });
            if (this.segment === segment) {
              this.segment = undefined;
              this.segmenter?.reset();
            }
            return;
          }
          if (outcome.analysis.isMusic !== true && hasTrack) {
            this.logger('debug', '第一窗判成非音乐，但有播放器曲目信息，继续听', { track: info.context.track });
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
        const prevAnalysis = segment.analyses.length > 1 ? segment.analyses[segment.analyses.length - 2] : undefined;
        if (prevAnalysis && styleShift(prevAnalysis, outcome.analysis)) {
          void this.recheckStyle(segment, info);
        }
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

  /** 风格/音调突变时再确认一次播放器：变了就切段报新歌；没变不反应；没有播放器信息就截图让 bot 确认。 */
  private async recheckStyle(segment: ActiveSegment, info: ListeningInfo): Promise<void> {
    if (!this.running || this.segment !== segment || segment.dropped || segment.superseded || segment.generation !== this.listenGeneration) return;
    const now = Date.now();
    if (now - (segment.lastRecheckAt ?? 0) < 30_000) return;
    segment.lastRecheckAt = now;

    let meta: PlayerMeta | null = null;
    try {
      meta = this.opts.metadataReader ? await this.opts.metadataReader() : await readPlayerMetadata();
    } catch {
      meta = null;
    }
    if (meta) {
      const key = `${meta.app}|${meta.title}|${meta.artist ?? ''}|${meta.album ?? ''}`;
      if (key === this.polledTrackKey) {
        this.logger('debug', '风格/音调变了，但播放器曲目没变，不反应', { track: info.context.track });
        return;
      }
      this.polledTrackKey = key;
      this.pendingTrackMeta = { meta, at: now };
      this.logger('debug', '风格/音调突变且曲目变了，强制切段', { to: `${meta.artist ?? ''} ${meta.title}`.trim() });
      this.segmenter?.flush();
      return;
    }

    // 没有播放器信息：截图让 bot 自己确认，不直接报切歌。
    const shot = await this.captureScreen();
    const lines = [
      '【风格/音调突变】刚才这段音乐的风格或调式突然变了，可能已经切歌。',
      shot.blob
        ? '附一张当前屏幕，请确认现在播放的是什么：如果换成新歌，就直接报新歌；如果还是同一首，就继续听，不要硬说切歌。'
        : '没有播放器信息，也拿不到截图；先不要硬说切歌，继续听。',
    ];
    await this.pushEvent('music.state', lines.join('\n'), {
      origin: 'internal',
      meta: { recheck: true, track: info.context.track },
      blobs: shot.blob ? [shot.blob] : undefined,
    }, 'flush');
  }

  private onSegmentEnd(end: SegmentEnd): void {
    this.lastActivityAt = Date.now();
    const segment = this.segment;
    this.previousEndPromise = this.finishSegment(end, segment).catch((e) => {
      this.logger('warn', '总结这一段失败', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  private async finishSegment(end: SegmentEnd, knownSegment?: ActiveSegment): Promise<void> {
    const segment = knownSegment ?? this.segment;
    if (this.segment === segment) this.segment = undefined;
    if (!segment) return;
    if (segment.generation !== this.listenGeneration) return;
    if (segment.dropped || segment.confirmed !== true) {
      // 播放器曲目已经报过幕，但这一段还没等到确认窗口就停了：暂停/结束都要给个反馈。
      if (!segment.dropped && segment.startedPushed && Date.now() - this.lastPauseAt > 10_000) {
        this.lastPauseAt = Date.now();
        await this.pushState('音乐停下来了（暂停或结束）；这一段还没确认是音乐，我先不总结。', 'info', { paused: true });
      }
      this.logger('debug', '这一段没有确认是音乐，不总结');
      return;
    }
    if (segment.superseded) {
      this.logger('debug', '这一段已经被换歌取代，不补总结');
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
        segment,
      };
      const ending = await this.pushEvent(
        'music.ending',
        `【这一段结束了${this.playerPaused ? '（暂停）' : ''}】最后一窗还在补分析。先给你这一版；music.ended 是最终完整版，不要重复已经说过的。\n\n${partial}`,
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
      if (ending && this.lastEnding) this.lastEnding.cursor = ending.cursor;
    }
    // 等已发出的窗口分析回来；最多等 40 秒，避免一段永远不结束。
    await Promise.race([
      Promise.allSettled(segment.pending),
      new Promise((resolve) => setTimeout(resolve, 40_000)),
    ]);
    if (segment.superseded || segment.generation !== this.listenGeneration) {
      this.logger('debug', '这一段已经被换歌取代，最终总结不再投递', { track: info.context.track });
      this.lastEnding = undefined;
      return;
    }
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
      segment,
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
          const wasRunning = this.running;
          await this.resetListening();
          try {
            this.startCapture();
            await this.pushState(wasRunning
              ? '重新开始听新的一轮；上一轮的音乐任务已经丢掉。'
              : '开始一起听系统声音。');
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.lastError = message;
            throw new Error('无法开始采集：' + message);
          }
          return wasRunning ? '已重新开始听；上一轮的音乐任务已经丢掉。' : this.statusText();
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
