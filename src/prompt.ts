/**
 * 分析提示词与结果格式化。
 * 判断框架来自 Aaron Copland《如何听懂音乐》：三个层次（感官/表现/纯音乐）+ 四个要素，先描述再解释。
 */
import type { MusicConfigSection } from './config.ts';

export interface InstrumentGuess {
  name: string;
  confidence: number;
}

export interface MusicMood {
  valence: number;
  arousal: number;
  quality: string;
  confidence: number;
}

export interface MusicAnalysis {
  summary: string;
  /** 这段音频是不是音乐（歌曲/器乐/纯音乐/说唱伴奏算；播客/有声书/直播说话不算）。 */
  isMusic?: boolean;
  musicConfidence?: number;
  tempoBpm?: number;
  meter?: string;
  key?: string;
  mode?: string;
  instruments: InstrumentGuess[];
  melody?: string;
  rhythm?: string;
  dynamics?: string;
  texture?: string;
  structure?: string;
  mood?: MusicMood;
  lyrics?: { present: boolean; text: string; confidence: number };
  uncertain?: string[];
  raw?: string;
}

/** 受控乐器词表；提示词里给全，要求不确定就标低置信度。 */
export const INSTRUMENT_TAXONOMY: readonly string[] = [
  // 中国
  '古筝', '古琴', '琵琶', '二胡', '笛子', '箫', '笙', '唢呐', '扬琴', '阮', '柳琴', '箜篌', '编钟',
  '堂鼓', '排鼓', '木鱼', '梆子', '京胡', '板胡', '高胡', '埙', '排箫', '葫芦丝', '马头琴', '冬不拉',
  '热瓦普', '手鼓',
  // 日本
  '尺八', '三味线', '筝（koto）', '琵琶（biwa）', '太鼓', '能管', '筱笛', '龙笛', '笙（sho）',
  '篳篥', '胡弓', '神乐铃',
  // 西方
  '钢琴', '小提琴', '中提琴', '大提琴', '低音提琴', '长笛', '双簧管', '单簧管', '巴松', '萨克斯',
  '小号', '长号', '圆号', '大号', '竖琴', '古典吉他', '民谣吉他', '电吉他', '曼陀林', '班卓', '尤克里里',
  '鼓组', '定音鼓', '打击乐', '合成器', '管风琴', '手风琴', '口琴', '人声（男）', '人声（女）', '合唱',
];

const SCHEMA = `{
  "summary": "一两句中文，先说听到了什么，再说像什么",
  "isMusic": true,
  "musicConfidence": 0.0,
  "tempoBpm": 0,
  "meter": "4/4 等；不确定就空",
  "key": "如 A、C#；不确定就空",
  "mode": "大调/小调/多利亚/弗里吉亚等；不确定就空",
  "instruments": [{"name": "受控词表里的名字", "confidence": 0.0}],
  "melody": "旋律轮廓：上行/下行/级进/跳进/音域/乐句；没有就空",
  "rhythm": "直拍/切分/摇摆/附点/三连音等；没有就空",
  "dynamics": "弱/中/强/渐强/突强等",
  "texture": "单声/主调/复调/密集/稀疏",
  "structure": "重复/对比/发展/回归/段落感；没有就空",
  "mood": {"valence": 0.0, "arousal": 0.0, "quality": "情绪的质地，一句话", "confidence": 0.0},
  "lyrics": {"present": false, "text": "只写确实听清的短句；听不清就空", "confidence": 0.0},
  "uncertain": ["不确定的点"]
}`;

export function buildAnalysisPrompt(cfg: MusicConfigSection, windowSec: number): string {
  const hints = cfg.instrumentHints.trim();
  return [
    '你是一个严谨的音乐分析器。听这段音频，按下面框架分析，只返回一个 JSON 对象，不要 markdown、不要解释。',
    '',
    '框架（Aaron Copland《如何听懂音乐》）：',
    '1. 感官层：音色、音区、力度、织体、录音质感。',
    '2. 表现层：情绪/心理状态。音乐表达的是情绪状态，不是固定情节；同一种情绪有不同质地（悲观的悲伤 / 哀而不伤 / 带微笑的悲伤），不要只给一个标签。',
    '3. 纯音乐层：节奏、旋律、和声/调式、形式（重复/对比/发展/回归）。',
    '',
    '硬性规则：',
    '- 只写你确实能从音频里听到的；不确定就写进 uncertain，并把 confidence 降低。',
    '- 不要用「某调 = 某情绪」的硬映射；调式只是线索之一，必须结合速度、节奏、音色、力度、旋律一起判断。',
    '- 乐器必须从受控词表里选；不确定是古筝还是 koto、尺八还是箫时，给最可能的 1–2 个并标低置信度，不要默认钢琴。',
    '- 歌词只写确实听清的短句（最多两句），听不清就 present=false、text 空；不要编造歌词。',
    '- 这是纯音乐或人声都可能；如果没有人声，lyrics.present=false。',
    '- 先判断这段音频是不是音乐：歌曲、器乐、纯音乐、说唱伴奏算音乐；播客、有声书、直播里纯说话、ASMR 说话不算。不是音乐就把 isMusic 设为 false（仍返回完整 JSON），musicConfidence 给判断置信度。',
    '- 分析窗口约 ' + windowSec + ' 秒，看不到整首的段落就如实说。',
    hints ? '- 额外提示：' + hints : '',
    '',
    '受控乐器词表（只能从这里选；也可以写「不确定」）：',
    INSTRUMENT_TAXONOMY.join('、'),
    '',
    '返回 JSON，字段如下：',
    SCHEMA,
  ].filter(Boolean).join('\n');
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 把模型返回的文本解析成分析结果；解析失败时保留原文当 summary。 */
export function parseAnalysis(text: string): MusicAnalysis {
  const raw = text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { summary: raw.slice(0, 2000) || '没有返回分析内容', instruments: [], uncertain: ['模型没有返回 JSON'] };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { summary: raw.slice(0, 2000), instruments: [], uncertain: ['JSON 解析失败'], raw };
  }
  const instruments = Array.isArray(obj.instruments)
    ? obj.instruments
      .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
      .map((i) => ({ name: str(i.name) ?? '不确定', confidence: clamp(num(i.confidence) ?? 0.5, 0, 1) }))
      .slice(0, 12)
    : [];
  const moodObj = obj.mood && typeof obj.mood === 'object' ? obj.mood as Record<string, unknown> : undefined;
  const lyricsObj = obj.lyrics && typeof obj.lyrics === 'object' ? obj.lyrics as Record<string, unknown> : undefined;
  return {
    summary: str(obj.summary) ?? '（模型没有给 summary）',
    isMusic: obj.isMusic === true,
    musicConfidence: clamp(num(obj.musicConfidence) ?? 0, 0, 1),
    tempoBpm: num(obj.tempoBpm),
    meter: str(obj.meter),
    key: str(obj.key),
    mode: str(obj.mode),
    instruments,
    melody: str(obj.melody),
    rhythm: str(obj.rhythm),
    dynamics: str(obj.dynamics),
    texture: str(obj.texture),
    structure: str(obj.structure),
    mood: moodObj ? {
      valence: clamp(num(moodObj.valence) ?? 0, -1, 1),
      arousal: clamp(num(moodObj.arousal) ?? 0, 0, 1),
      quality: str(moodObj.quality) ?? '说不清',
      confidence: clamp(num(moodObj.confidence) ?? 0.4, 0, 1),
    } : undefined,
    lyrics: lyricsObj ? {
      present: lyricsObj.present === true,
      text: str(lyricsObj.text) ?? '',
      confidence: clamp(num(lyricsObj.confidence) ?? 0, 0, 1),
    } : undefined,
    uncertain: Array.isArray(obj.uncertain) ? obj.uncertain.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
    raw: cfgRaw(obj),
  };
}

function cfgRaw(obj: Record<string, unknown>): string | undefined {
  const unknown = obj as { raw?: unknown };
  return typeof unknown.raw === 'string' ? unknown.raw : undefined;
}

/** 一段分析的紧凑中文描述，用于实时事件。 */
export function formatAnalysis(a: MusicAnalysis): string {
  const lines: string[] = [];
  lines.push('音乐分析：' + a.summary);
  const facts: string[] = [];
  if (a.tempoBpm) facts.push(`${Math.round(a.tempoBpm)} BPM`);
  if (a.meter) facts.push(a.meter);
  if (a.key || a.mode) facts.push([a.key, a.mode].filter(Boolean).join(' '));
  if (a.instruments.length) facts.push('乐器：' + a.instruments.map((i) => `${i.name}(${i.confidence.toFixed(2)})`).join('、'));
  if (a.melody) facts.push('旋律：' + a.melody);
  if (a.rhythm) facts.push('节奏：' + a.rhythm);
  if (a.dynamics) facts.push('力度：' + a.dynamics);
  if (a.texture) facts.push('织体：' + a.texture);
  if (a.structure) facts.push('结构：' + a.structure);
  if (a.mood) facts.push(`情绪：${a.mood.quality}（valence ${a.mood.valence.toFixed(2)}，arousal ${a.mood.arousal.toFixed(2)}，置信 ${a.mood.confidence.toFixed(2)}）`);
  if (a.lyrics?.present) facts.push(`听到的歌词：${a.lyrics.text}（置信 ${a.lyrics.confidence.toFixed(2)}）`);
  if (a.uncertain?.length) facts.push('不确定：' + a.uncertain.join('；'));
  if (facts.length) lines.push(facts.join('\n'));
  return lines.join('\n');
}

/** 一段结束时的汇总，供 bot 做总结。 */
export function combineAnalyses(analyses: readonly MusicAnalysis[], durationMs: number, windowSec: number): string {
  if (!analyses.length) {
    return `一段音乐结束了（约 ${Math.round(durationMs / 1000)} 秒），但这次没有拿到分析结果（可能是 Key 没配、接口失败或音频太短）。`;
  }
  const instruments = new Map<string, number>();
  for (const a of analyses) {
    for (const i of a.instruments) instruments.set(i.name, Math.max(instruments.get(i.name) ?? 0, i.confidence));
  }
  const bpm = analyses.map((a) => a.tempoBpm).filter((x): x is number => typeof x === 'number');
  const keys = [...new Set(analyses.flatMap((a) => [a.key, a.mode].filter((x): x is string => !!x)))];
  const qualities = analyses.map((a) => a.mood?.quality).filter((x): x is string => !!x);
  const lyrics = analyses.map((a) => a.lyrics).filter((l): l is NonNullable<MusicAnalysis['lyrics']> => !!l?.present && !!l.text);
  const uncertain = [...new Set(analyses.flatMap((a) => a.uncertain ?? []))];
  const summary = analyses.map((a) => a.summary).filter(Boolean).slice(-4).join(' / ');

  const lines = [
    `一段音乐结束了，约 ${Math.round(durationMs / 1000)} 秒，共分析 ${analyses.length} 个窗口（每窗约 ${windowSec} 秒）。`,
    '整段听感：' + summary,
  ];
  const facts: string[] = [];
  if (bpm.length) facts.push('速度：' + `${Math.round(Math.min(...bpm))}–${Math.round(Math.max(...bpm))} BPM`);
  if (keys.length) facts.push('调式线索：' + keys.join('、'));
  if (instruments.size) facts.push('乐器：' + [...instruments.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}(${c.toFixed(2)})`).join('、'));
  if (qualities.length) facts.push('情绪质地：' + [...new Set(qualities)].slice(-3).join(' / '));
  if (lyrics.length) facts.push('听到的歌词：' + [...new Set(lyrics.map((l) => l.text))].slice(0, 3).join(' / '));
  if (uncertain.length) facts.push('不确定：' + uncertain.slice(0, 6).join('；'));
  if (facts.length) lines.push(facts.join('\n'));
  lines.push('按这个框架说感受：先说听到什么，再说像什么；不确定的地方留余地，不要硬报歌名或乐器。');
  return lines.join('\n');
}
