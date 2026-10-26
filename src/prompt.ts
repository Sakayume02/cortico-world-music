/**
 * 分析提示词与结果格式化。
 * 判断框架来自 Aaron Copland《如何听懂音乐》：三个层次（感官/表现/纯音乐）+ 四个要素。
 * 但写给 bot 的正文分成「感受」和「内部参考」：术语给 bot 理解，不给孩子照念。
 */
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

export type LyricsSource = 'asr' | 'lrclib' | 'metadata';

export interface MusicAnalysis {
  summary: string;
  /** 风格：摇滚/流行/民谣/电子/古典…，给动作和感受参考。 */
  genre?: string;
  /** 沉浸式感受：第一人称/画面/身体，不说参数。 */
  listenerSummary?: string;
  /** 情绪质地，一句话。 */
  feeling?: string;
  /** 脑海里的画面/场景。 */
  imagery?: string;
  /** 身体反应。 */
  body?: string;
  /** 情绪走向：从…到… */
  arc?: string;
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
  lyrics?: { present: boolean; text: string; confidence: number; source?: LyricsSource; complete?: boolean };
  /** 歌曲背景：歌手风格、年代、出处（游戏/动漫/电影）、作品场景、想表达的主旨；不知道就空。 */
  songContext?: {
    artistStyle?: string;
    era?: string;
    sourceMedia?: string;
    scene?: string;
    meaning?: string;
    confidence: number;
  };
  /** 贴切的历史典故/名著联想；不贴切就不给。 */
  reference?: { work: string; connection: string; confidence: number };
  uncertain?: string[];
  raw?: string;
}

export interface ListeningContext {
  track?: string;
  artist?: string;
  album?: string;
  lyrics?: string;
  lyricsSource?: LyricsSource;
  /** 声音来源：桌面播放器 / 浏览器 / 没认出来。 */
  sourceKind?: 'player' | 'browser' | 'unknown';
  sourceApp?: string;
  /** 浏览器标签页标题，只是参考，不是已确认歌名。 */
  tabTitle?: string;
}

function sourceLine(context?: ListeningContext): string {
  if (!context?.sourceKind) return '';
  if (context.sourceKind === 'browser') {
    return `声音来源：浏览器（${context.sourceApp ?? '未知浏览器'}）；标签页标题：${context.tabTitle ?? '没拿到'}（只是标签页参考，不是已确认歌名；以音频和屏幕为准）。`;
  }
  if (context.sourceKind === 'unknown') return '声音来源：没认出来是哪个程序；不要猜歌名/来源，只写听感。';
  return `声音来源：播放器（${context.sourceApp ?? '未知播放器'}）。`;
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
  "summary": "一句话听感，给 bot 看的摘要",
  "listenerSummary": "2-4 句沉浸式感受：像一个人正听着这段音乐，写氛围、画面、身体和情绪；不要报 BPM/调式/乐器清单",
  "feeling": "情绪的质地与温度，一句话，例如「脆弱而克制的悲伤，带着不舍」",
  "imagery": "脑海里的画面/场景，一两句",
  "body": "身体反应：呼吸、胸口、肩膀、想不想动、起鸡皮疙瘩、想闭眼等",
  "arc": "这段音乐的情绪走向：从…到…",
  "isMusic": true,
  "musicConfidence": 0.0,
  "genre": "摇滚/流行/民谣/电子/古典…；不确定就空",
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
  "lyrics": {"present": false, "text": "只写确实听清的短句；有可信歌词时照抄；听不清就空", "confidence": 0.0},
  "songContext": {"artistStyle": "歌手/作者风格；不确定就空", "era": "创作/发行年代；不确定就空", "sourceMedia": "游戏/动漫/电影/剧集/独立…；不确定就空", "scene": "这首歌在作品/场景里想表达什么；不确定就空", "meaning": "歌词/歌名想表达的主旨，两三句，贴歌词", "confidence": 0.0},
  "reference": {"work": "贴切的历史典故/名著小说名；不贴切就空", "connection": "为什么贴切，一两句；不贴切就空", "confidence": 0.0},
  "uncertain": ["不确定的点"]
}`;

export function buildAnalysisPrompt(
  windowSec: number,
  context?: ListeningContext,
): string {
  const known = context?.lyrics?.trim();
  const source = sourceLine(context);
  const trackLine = context?.track
    ? `你正在听的曲目（来自播放器媒体信息）：${context.track}${context.artist ? ' — ' + context.artist : ''}${context.album ? '，专辑：' + context.album : ''}。`
    : '';
  return [
    '你是一个真正爱音乐的人，也是一个懂音乐的音乐人。你正在和听音乐的人一起听音乐。',
    '先用身体和情绪去听，再用术语核对；术语只放在技术字段里给 bot 理解，不要写进 listenerSummary，也不要在感受里列参数。',
    '',
    '框架（Aaron Copland《如何听懂音乐》）：',
    '1. 感官层：音色、音区、力度、织体、录音质感。',
    '2. 表现层：情绪/心理状态。音乐表达的是情绪状态，不是固定情节；同一种情绪有不同质地（悲观的悲伤 / 哀而不伤 / 带微笑的悲伤）。',
    '3. 纯音乐层：节奏、旋律、和声/调式、形式（重复/对比/发展/回归）。',
    '',
    '写「感受」的规则：',
    '- listenerSummary 要像一个真正在听的人：可以写呼吸、画面、身体反应、想做什么；不要写「BPM 多少」「什么调」「乐器置信度」。',
    '- 感受要具体、有温度，不要套话；宁可说「像傍晚空房间里的一架旧钢琴」，不要写「情绪悲伤」。',
    '- 情绪要质地：不是「悲伤」，而是「克制的惆怅 / 哀而不伤 / 带微笑的悲伤」。',
    '- 纯音乐没有人声就写画面和身体，不要假装听到了歌词。',
    '- **感受要贴着歌名和歌词想表达的内容与场景**：有可信歌名/歌词时，先理解它在说什么，再写感受；不要脱离歌词另编一个故事，也不要自己瞎猜人物/情节。',
    '- 没有可信歌词、纯音乐或歌词听不清时，只写音乐本身的氛围和画面；不要把听错的词当成歌词内容。',
    '- 可以联想贴切的历史典故或名著小说（国内外都行），但必须和歌词/情绪/场景对得上；不贴切就不写，不要掉书袋、不要编引文。',
    '- 如果知道歌手风格、创作/发行年代、出处（游戏/动漫/电影/剧集）或在作品里的场景，写进 songContext，先用它理解这首歌想表达什么；**只有确定才写，不确定就留空**，不要猜作品/年代。',
    '- 如果这首歌出自某个作品/场景，感受要贴着那个场景和歌词，不要脱离作品另编故事。',
    '- 听歌时保持专注：不要写成想睡觉/打盹，也不要假装睡着。',
    '- 你回应时已经有延迟：说“刚才那句/刚才那段”，不要说“现在这句”。',
    '- 声音来源是浏览器时，标签页标题只是参考，不是已确认歌名；不确定就只说听感/画面，不要硬报。',
    '- 声音来源未知、或截图也认不出时，直接说“我没认出来是哪个程序/什么歌”，不要猜；正常听。',
    '',
    '判断与术语（这些只给 bot 理解，不要照念给用户）：',
    '- 先判断这段音频是不是音乐：歌曲、器乐、纯音乐、说唱伴奏算音乐；播客、有声书、直播里纯说话、ASMR 说话不算。不是音乐就把 isMusic 设为 false（仍返回完整 JSON），musicConfidence 给判断置信度。',
    '- 不要用「某调 = 某情绪」的硬映射；调式只是线索之一，必须结合速度、节奏、音色、力度、旋律一起判断。',
    '- 乐器必须从受控词表里选；不确定是古筝还是 koto、尺八还是箫时，给最可能的 1–2 个并标低置信度，不要默认钢琴。',
    `- 分析窗口约 ${windowSec} 秒，看不到整首的段落就如实说。`,
    '',
    '歌词规则：',
    known
      ? '- 下面给出了来自播放器信息 + LRCLIB 的完整歌词，可信；不要改写、不要补全、不要整段复述。用它理解歌曲在说什么，lyrics.text 可以照抄；如果不确定就别改。'
      : '- 没有可信歌词：只写确实听清的短句（最多两句），听不清就 present=false、text 空；不要编造。',
    '- 歌词可能听错；在感受里引用时只用短句，并留余地。',
    '',
    source,
    trackLine,
    known ? '已知完整歌词（可信，用来理解内容；不要整段复述）：\n' + known : '',
    '',
    '受控乐器词表（只能从这里选；也可以写「不确定」）：',
    INSTRUMENT_TAXONOMY.join('、'),
    '',
    '只返回一个 JSON 对象，不要 markdown、不要解释。字段如下：',
    SCHEMA,
  ].filter(Boolean).join('\n');
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

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
  const refObj = obj.reference && typeof obj.reference === 'object' ? obj.reference as Record<string, unknown> : undefined;
  const refWork = refObj ? str(refObj.work) : undefined;
  const refConnection = refObj ? str(refObj.connection) : undefined;
  const songObj = obj.songContext && typeof obj.songContext === 'object' ? obj.songContext as Record<string, unknown> : undefined;
  const songArtist = songObj ? str(songObj.artistStyle) : undefined;
  const songEra = songObj ? str(songObj.era) : undefined;
  const songSource = songObj ? str(songObj.sourceMedia) : undefined;
  const songScene = songObj ? str(songObj.scene) : undefined;
  const songMeaning = songObj ? str(songObj.meaning) : undefined;
  const hasSongContext = !!(songArtist || songEra || songSource || songScene || songMeaning);
  return {
    summary: str(obj.summary) ?? '（模型没有给 summary）',
    listenerSummary: str(obj.listenerSummary),
    feeling: str(obj.feeling),
    imagery: str(obj.imagery),
    body: str(obj.body),
    arc: str(obj.arc),
    isMusic: obj.isMusic === true,
    musicConfidence: clamp(num(obj.musicConfidence) ?? 0, 0, 1),
    genre: str(obj.genre),
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
      source: 'asr',
      complete: false,
    } : undefined,
    reference: refWork && refConnection ? {
      work: refWork,
      connection: refConnection,
      confidence: clamp(num(refObj?.confidence) ?? 0.4, 0, 1),
    } : undefined,
    songContext: hasSongContext ? {
      artistStyle: songArtist,
      era: songEra,
      sourceMedia: songSource,
      scene: songScene,
      meaning: songMeaning,
      confidence: clamp(num(songObj?.confidence) ?? 0.4, 0, 1),
    } : undefined,
    uncertain: Array.isArray(obj.uncertain) ? obj.uncertain.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
    raw: typeof obj.raw === 'string' ? obj.raw : undefined,
  };
}

const lyricsSourceLabel = (s?: LyricsSource): string => {
  if (s === 'lrclib') return 'LRCLIB（完整可信）';
  if (s === 'metadata') return '播放器信息（可信）';
  return '听写（可能听错）';
};

function technicalLines(a: MusicAnalysis): string[] {
  const facts: string[] = [];
  if (a.genre) facts.push('风格：' + a.genre);
  if (a.tempoBpm) facts.push(`速度：${Math.round(a.tempoBpm)} BPM${a.meter ? ' / ' + a.meter : ''}`);
  if (a.key || a.mode) facts.push('调式：' + [a.key, a.mode].filter(Boolean).join(' '));
  if (a.instruments.length) facts.push('乐器：' + a.instruments.map((i) => `${i.name}(${i.confidence.toFixed(2)})`).join('、'));
  if (a.melody) facts.push('旋律：' + a.melody);
  if (a.rhythm) facts.push('节奏：' + a.rhythm);
  if (a.dynamics) facts.push('力度：' + a.dynamics);
  if (a.texture) facts.push('织体：' + a.texture);
  if (a.structure) facts.push('结构：' + a.structure);
  if (a.uncertain?.length) facts.push('不确定：' + a.uncertain.join('；'));
  return facts;
}

/**
 * 给 bot 的动作参考。只用桌宠现有的动作/表情；没有对应动作时用最接近的现有动作 + 表情/文字，
 * 不要凭空写「跳了一支舞」「真的流泪了」。
 */
export function reactionHint(a: MusicAnalysis): string {
  const valence = a.mood?.valence ?? 0;
  const arousal = a.mood?.arousal ?? 0.35;
  const style = [a.genre, a.songContext?.artistStyle, a.songContext?.sourceMedia].filter(Boolean).join(' ');
  const rocky = /摇滚|rock|金属|metal|朋克|punk|电子|electronic|舞曲|dance|funk|放克|嘻哈|hip.?hop/i.test(style);
  if (valence < -0.25) {
    return '安静、有点难过：有哭/委屈表情就用，没有就用【坐着发呆】+😢/🥲；别硬逗，也别假装真的流泪；听歌时别打盹/睡觉，保持专注。';
  }
  if (rocky || arousal > 0.72) {
    return '很燃/有推动力：可以跟着点头、蹦跶、在屏幕底边跑来跑去；有跑/跳动作就用，没有就用【在屏幕底边走动】+兴奋/开心表情+颜文字；别装酷。';
  }
  if (valence > 0.25 && arousal > 0.45) {
    return '开心、想动：有跳舞/跑动动作就用，没有就用【在屏幕底边走动】+开心表情+颜文字，别写不存在的动作。';
  }
  if (arousal > 0.55) {
    return '节奏有推动力：可以轻轻晃/点头，用现有动作，别打盹。';
  }
  return '适合安静听、轻轻晃；用现有动作，别打盹/睡觉。';
}

const GENRE_TAGS = ['摇滚', '流行', '民谣', '电子', '古典', '爵士', '说唱', '嘻哈', '金属', '朋克', '乡村', '国风', '古风', '游戏', '动漫', '原声', '纯音乐', 'R&B', '放克', '灵魂', '蓝调', '雷鬼', '拉丁', '实验', 'lo-fi'];

function broadGenres(genre?: string): string[] {
  if (!genre) return [];
  const s = genre.toLowerCase();
  return GENRE_TAGS.filter((tag) => s.includes(tag.toLowerCase()));
}

/** 相邻窗口是不是风格/音调突然变了；只用来触发“再确认播放器”，不直接报切歌。 */
export function styleShift(prev: MusicAnalysis, next: MusicAnalysis): boolean {
  const a = broadGenres(prev.genre);
  const b = broadGenres(next.genre);
  if (a.length && b.length && !a.some((tag) => b.includes(tag))) return true;
  if (prev.tempoBpm && next.tempoBpm && Math.abs(prev.tempoBpm - next.tempoBpm) >= 25) return true;
  if (prev.key && next.key && prev.key.toLowerCase() !== next.key.toLowerCase()) return true;
  if (prev.mode && next.mode && prev.mode.toLowerCase() !== next.mode.toLowerCase()) return true;
  if (prev.mood && next.mood) {
    if (Math.abs(prev.mood.arousal - next.mood.arousal) >= 0.45) return true;
    if (Math.abs(prev.mood.valence - next.mood.valence) >= 0.5) return true;
  }
  return false;
}

function songContextLines(s?: MusicAnalysis['songContext']): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.artistStyle) parts.push('歌手/作者风格：' + s.artistStyle);
  if (s.era) parts.push('年代：' + s.era);
  if (s.sourceMedia) parts.push('出处：' + s.sourceMedia);
  if (s.scene) parts.push('场景：' + s.scene);
  if (s.meaning) parts.push('想表达：' + s.meaning);
  return parts.join('；');
}

/** 一个窗口的正文：先感受，后内部参考。 */
export function formatAnalysis(a: MusicAnalysis, context?: ListeningContext): string {
  const lines: string[] = [];
  const source = sourceLine(context);
  if (source) lines.push(source);
  if (context?.track) lines.push(`曲目：${context.track}${context.artist ? ' — ' + context.artist : ''}${context.album ? '（专辑：' + context.album + '）' : ''}`);
  const background = songContextLines(a.songContext);
  if (background) lines.push('歌曲背景（如果知道）：' + background);
  lines.push('【这段的感受】');
  lines.push(a.listenerSummary || a.summary);
  const feeling = a.feeling || a.mood?.quality;
  if (feeling) lines.push('情绪：' + feeling);
  if (a.imagery) lines.push('画面：' + a.imagery);
  if (a.body) lines.push('身体：' + a.body);
  if (a.arc) lines.push('走向：' + a.arc);
  if (a.reference?.work && a.reference.connection) lines.push(`联想：${a.reference.work} —— ${a.reference.connection}`);
  lines.push('动作参考（用现有动作）：' + reactionHint(a));
  if (a.lyrics?.present && a.lyrics.text) {
    lines.push(`歌词（来源：${lyricsSourceLabel(a.lyrics.source)}）：${a.lyrics.text}`);
  }
  const tech = technicalLines(a);
  if (tech.length) {
    lines.push('');
    lines.push('—— 内部参考（给 bot 理解音乐用，不要照念给用户）——');
    lines.push(tech.join('\n'));
  }
  lines.push('回应时用“刚才那句/刚才那段”；不要说“现在这句”，因为你回应时已经有延迟。');
  return lines.join('\n');
}

/** 一段结束时的正文：整体感受 + 歌词 + 内部参考。 */
export function combineAnalyses(
  analyses: readonly MusicAnalysis[],
  durationMs: number,
  windowSec: number,
  context?: ListeningContext,
): string {
  if (!analyses.length) {
    return `这一段听了约 ${Math.round(durationMs / 1000)} 秒，但这次没有拿到分析结果（可能是 Key 没配、接口失败或音频太短）。`;
  }
  const listeners = [...new Set(analyses.map((a) => a.listenerSummary).filter((x): x is string => !!x))];
  const feelings = [...new Set(analyses.map((a) => a.feeling ?? a.mood?.quality).filter((x): x is string => !!x))];
  const images = [...new Set(analyses.map((a) => a.imagery).filter((x): x is string => !!x))];
  const bodies = [...new Set(analyses.map((a) => a.body).filter((x): x is string => !!x))];
  const arcs = [...new Set(analyses.map((a) => a.arc).filter((x): x is string => !!x))];
  const references = analyses.map((a) => a.reference).filter((r): r is NonNullable<MusicAnalysis['reference']> => !!r?.work && !!r.connection);
  const backgrounds = analyses.map((a) => a.songContext).filter((s): s is NonNullable<MusicAnalysis['songContext']> => !!songContextLines(s));
  const summaries = [...new Set(analyses.map((a) => a.summary).filter(Boolean))];
  const lyrics = [...new Set(analyses.map((a) => a.lyrics).filter((l): l is NonNullable<MusicAnalysis['lyrics']> => !!l?.present && !!l.text))];
  const uncertain = [...new Set(analyses.flatMap((a) => a.uncertain ?? []))];
  const bpm = analyses.map((a) => a.tempoBpm).filter((x): x is number => typeof x === 'number');
  const keys = [...new Set(analyses.flatMap((a) => [a.key, a.mode].filter((x): x is string => !!x)))];
  const instruments = new Map<string, number>();
  for (const a of analyses) for (const i of a.instruments) instruments.set(i.name, Math.max(instruments.get(i.name) ?? 0, i.confidence));

  const lines: string[] = [`【一起听完这一段】约 ${Math.round(durationMs / 1000)} 秒，共 ${analyses.length} 个窗口（每窗约 ${windowSec} 秒）。`];
  const source = sourceLine(context);
  if (source) lines.push(source);
  if (context?.track) lines.push(`曲目：${context.track}${context.artist ? ' — ' + context.artist : ''}（来自播放器媒体信息）`);
  if (backgrounds.length) {
    const background = songContextLines(backgrounds[backgrounds.length - 1]);
    if (background) lines.push('歌曲背景（如果知道）：' + background);
  }
  lines.push('');
  lines.push('【整体感受】');
  if (listeners.length) lines.push(listeners.slice(-3).join('\n'));
  else lines.push(summaries.slice(-3).join(' / '));
  if (feelings.length) lines.push('情绪：' + [...new Set(feelings)].slice(-3).join(' / '));
  if (images.length) lines.push('画面：' + [...new Set(images)].slice(-2).join(' / '));
  if (bodies.length) lines.push('身体：' + [...new Set(bodies)].slice(-2).join(' / '));
  if (arcs.length) lines.push('走向：' + arcs.slice(-1)[0]);
  if (references.length) lines.push(`联想：${references[0]!.work} —— ${references[0]!.connection}`);
  lines.push('动作参考（用现有动作）：' + reactionHint(analyses[analyses.length - 1]!));

  if (context?.lyrics) {
    lines.push('');
    lines.push('歌词（来源：' + lyricsSourceLabel(context.lyricsSource ?? 'lrclib') + '）：');
    lines.push(context.lyrics);
  } else if (lyrics.length) {
    lines.push('');
    lines.push('歌词（来源：听写，可能听错）：');
    lines.push([...new Set(lyrics.map((l) => l.text))].slice(0, 4).join('\n'));
  }

  const tech: string[] = [];
  if (bpm.length) tech.push(`速度：${Math.round(Math.min(...bpm))}–${Math.round(Math.max(...bpm))} BPM`);
  if (keys.length) tech.push('调式线索：' + keys.join('、'));
  if (instruments.size) tech.push('乐器：' + [...instruments.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}(${c.toFixed(2)})`).join('、'));
  if (uncertain.length) tech.push('不确定：' + uncertain.slice(0, 6).join('；'));
  if (tech.length) {
    lines.push('');
    lines.push('—— 内部参考（给 bot 理解音乐用，不要照念给用户；不要报参数）——');
    lines.push(tech.join('\n'));
  }
  lines.push('');
  lines.push('用你平时那种傻白甜的语气说，像一个人，可以带一个现有动作；不要像分析报告，也不要念内部参考。');
  lines.push('总结时说“刚才那句/刚才那段”，不要说“现在这句”，因为你回答时已经有延迟。');
  return lines.join('\n');
}
