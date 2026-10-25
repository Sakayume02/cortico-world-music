/**
 * 音乐分段：从 48k 立体声 PCM 里判断「有没有在放」「一段结束没有」「窗口满没满」。
 * 判定全部基于样本数与 RMS，不依赖墙上时钟；事件的 startedAt 才用 Date.now()。
 */
import { FRAME_SAMPLES, OUT_RATE, downsampleStereo48ToMono16, joinInt16, rmsDb } from './wav.ts';

export interface WindowChunk {
  pcm: Int16Array<ArrayBufferLike>;
  /** 这个窗口开始时的墙上时间。 */
  startedAt: number;
  durationMs: number;
}

export interface SegmentEnd {
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface SegmenterOptions {
  windowSec: number;
  /** 连续静音多久算一段结束，默认 2500ms。 */
  silenceMs?: number;
  /** 低于这个分贝算静音，默认 -55。 */
  thresholdDb?: number;
  /** 一段最长多久强制结束，默认 300s。 */
  maxSegmentSec?: number;
  /** 窗口短于这个秒数就丢弃，默认 4s。 */
  minWindowSec?: number;
  now?: () => number;
  onStart?: (info: { startedAt: number }) => void;
  onWindow?: (window: WindowChunk) => void;
  onEnd?: (end: SegmentEnd) => void;
}

export class MusicSegmenter {
  private readonly opts: Required<Omit<SegmenterOptions, 'onStart' | 'onWindow' | 'onEnd'>> & Pick<SegmenterOptions, 'onStart' | 'onWindow' | 'onEnd'>;
  private carry: Int16Array<ArrayBufferLike> = new Int16Array(0);
  private pending: Int16Array<ArrayBufferLike> = new Int16Array(0);
  private active = false;
  private segStartedAt = 0;
  private segSamples = 0;
  private windowParts: Int16Array<ArrayBufferLike>[] = [];
  private windowSamples = 0;
  private windowStartedAt = 0;
  private silenceSamples = 0;
  private lastFrameAt = 0;

  constructor(options: SegmenterOptions) {
    this.opts = {
      windowSec: Math.max(1, options.windowSec),
      silenceMs: options.silenceMs ?? 2500,
      thresholdDb: options.thresholdDb ?? -55,
      maxSegmentSec: options.maxSegmentSec ?? 300,
      minWindowSec: options.minWindowSec ?? 4,
      now: options.now ?? (() => Date.now()),
      onStart: options.onStart,
      onWindow: options.onWindow,
      onEnd: options.onEnd,
    };
  }

  /** 送入一块 48k 立体声 interleaved PCM。 */
  push48Stereo(input: Int16Array<ArrayBufferLike>): void {
    const { pcm, carry } = downsampleStereo48ToMono16(input, this.carry);
    this.carry = carry;
    if (!pcm.length) return;
    this.lastFrameAt = this.opts.now();
    if (this.pending.length) {
      const merged = new Int16Array(this.pending.length + pcm.length);
      merged.set(this.pending, 0);
      merged.set(pcm, this.pending.length);
      this.pending = merged;
    } else {
      this.pending = pcm;
    }
    let offset = 0;
    while (this.pending.length - offset >= FRAME_SAMPLES) {
      const frame = this.pending.subarray(offset, offset + FRAME_SAMPLES);
      this.onFrame(frame);
      offset += FRAME_SAMPLES;
    }
    this.pending = this.pending.slice(offset);
  }

  /** 主动结束当前段（暂停/关闭时）。 */
  flush(): void {
    const end = this.finish();
    if (end) this.opts.onEnd?.(end);
  }

  /**
   * 静音看门狗：原生采集在低于 -70dBFS 时直接不回调，安静表现为「没有帧」，
   * 不能只靠样本数收尾。World 每隔 500ms 调一次，超过 silenceMs 没新帧就结束这一段。
   */
  tick(): void {
    if (!this.active) return;
    if (this.opts.now() - this.lastFrameAt < this.opts.silenceMs) return;
    const end = this.finish();
    if (end) this.opts.onEnd?.(end);
  }

  /** 只清空状态，不发事件。 */
  reset(): void {
    this.carry = new Int16Array(0);
    this.pending = new Int16Array(0);
    this.active = false;
    this.segStartedAt = 0;
    this.segSamples = 0;
    this.windowParts = [];
    this.windowSamples = 0;
    this.windowStartedAt = 0;
    this.silenceSamples = 0;
  }

  get hasActiveSegment(): boolean {
    return this.active;
  }

  private onFrame(frame: Int16Array<ArrayBufferLike>): void {
    const level = rmsDb(frame);
    const playing = level > this.opts.thresholdDb;

    if (playing) {
      this.silenceSamples = 0;
      if (!this.active) {
        this.active = true;
        this.segStartedAt = this.opts.now();
        this.segSamples = 0;
        this.windowParts = [];
        this.windowSamples = 0;
        this.windowStartedAt = this.segStartedAt;
        this.opts.onStart?.({ startedAt: this.segStartedAt });
      }
    } else {
      this.silenceSamples += frame.length;
    }

    if (this.active) {
      // 留 400ms 尾巴，之后不再把静音收进 WAV。
      if (playing || this.silenceSamples <= (400 / 1000) * OUT_RATE) {
        this.windowParts.push(frame);
        this.windowSamples += frame.length;
        this.segSamples += frame.length;
      }
      if (this.windowSamples >= this.opts.windowSec * OUT_RATE) this.flushWindow();
      if (this.segSamples >= this.opts.maxSegmentSec * OUT_RATE) {
        const end = this.finish();
        if (end) this.opts.onEnd?.(end);
        return;
      }
      if (this.silenceSamples >= (this.opts.silenceMs / 1000) * OUT_RATE) {
        const end = this.finish();
        if (end) this.opts.onEnd?.(end);
      }
    }
  }

  private flushWindow(): void {
    if (this.windowSamples >= this.opts.minWindowSec * OUT_RATE) {
      this.opts.onWindow?.({
        pcm: joinInt16(this.windowParts),
        startedAt: this.windowStartedAt,
        durationMs: Math.round((this.windowSamples / OUT_RATE) * 1000),
      });
    }
    this.windowParts = [];
    this.windowSamples = 0;
    this.windowStartedAt = this.opts.now();
  }

  private finish(): SegmentEnd | null {
    if (!this.active) return null;
    this.flushWindow();
    const end: SegmentEnd = {
      startedAt: this.segStartedAt,
      endedAt: this.opts.now(),
      durationMs: Math.round((this.segSamples / OUT_RATE) * 1000),
    };
    this.active = false;
    this.segStartedAt = 0;
    this.segSamples = 0;
    this.windowParts = [];
    this.windowSamples = 0;
    this.windowStartedAt = 0;
    this.silenceSamples = 0;
    return end;
  }
}
