import type { ConfigGroup } from 'cortico/core/types.ts';

/** config.json 的 worlds.music 段。默认禁用，由部署或 bot 开启。 */
export interface MusicConfigSection {
  enabled: boolean;
  /** 分析后端；dashscope = 内置 Qwen-Omni，openai-compatible = 任意 OpenAI 兼容音频接口，off = 只采集。 */
  backend: 'dashscope' | 'openai-compatible' | 'off';
  /** DashScope 的 OpenAI 兼容地址；不同工作空间可能要用自己的地址。 */
  baseUrl: string;
  /** 模型名；qwen3.8-omni-flash 支持音频理解并只输出文本。 */
  model: string;
  /** 密钥的环境变量名；值放在部署的 .env 里，不从配置读。 */
  apiKeySecret: string;
  /** 默认投递方式：一段结束总结 / 实时短评 / 两者都要。 */
  mode: 'end' | 'live' | 'both';
  /** 一段结束后：继续听下一首，还是就此停止。 */
  afterSong: 'continue' | 'stop';
  /** 每个分析窗口的秒数；上传前会降为 16k 单声道。 */
  windowSec: number;
  /** 每分钟最多几次云端分析，防止刷接口。 */
  maxCallsPerMinute: number;
  /** 换歌时没有媒体信息或信息不确定，是否截一张屏幕给 bot 看播放器界面。 */
  screenFallback: boolean;
  /** 是否从 Windows 媒体会话读桌面播放器的曲目/歌手（浏览器不走这条）。 */
  readPlayerMeta: boolean;
  /** 有准确曲目信息时，是否去 LRCLIB 查完整歌词。 */
  lookupLyrics: boolean;
  /** 在运行日志里记录每段分析的调试信息。 */
  debug: boolean;
}

export const MUSIC_DEFAULTS: MusicConfigSection = {
  enabled: false,
  backend: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-omni-flash',
  apiKeySecret: 'AUDIO_API_KEY',
  mode: 'both',
  afterSong: 'continue',
  windowSec: 20,
  maxCallsPerMinute: 3,
  screenFallback: true,
  readPlayerMeta: true,
  lookupLyrics: true,
  debug: false,
};

/** World 配置的 JSON Schema；WebUI 按它渲染，改完就地生效。 */
export const MUSIC_CONFIG_GROUP: ConfigGroup = {
  id: 'world:music',
  owner: 'world:music',
  schema: {
    type: 'object',
    title: '音乐',
    properties: {
      'worlds.music.mode': {
        type: 'string',
        title: '默认模式',
        description: 'end = 一段结束/暂停时总结；live = 每段短评；both = 两者都要。',
        enum: ['end', 'live', 'both'],
        'x-hot': true,
      },
      'worlds.music.afterSong': {
        type: 'string',
        title: '听完一首后',
        description: 'continue = 一直听，直到你说停；stop = 这首结束、总结完就自动停。',
        enum: ['continue', 'stop'],
        'x-hot': true,
      },
      'worlds.music.windowSec': {
        type: 'number',
        title: '分析窗口（秒）',
        description: '每个窗口的音频秒数，建议 20–45；窗口越短越实时，调用越多。',
        minimum: 15,
        maximum: 60,
        'x-hot': true,
      },
      'worlds.music.maxCallsPerMinute': {
        type: 'number',
        title: '每分钟最多分析次数',
        description: '限流用；超过的窗口会跳过。',
        minimum: 1,
        maximum: 12,
        'x-hot': true,
      },
      'worlds.music.screenFallback': {
        type: 'boolean',
        title: '截屏识别播放器',
        description: '拿不到媒体信息、或曲目信息来自窗口标题不确定时，截一张主屏给 bot 确认；会包含屏幕内容。',
        'x-hot': true,
      },
      'worlds.music.readPlayerMeta': {
        type: 'boolean',
        title: '读播放器/浏览器信息',
        description: '先用 WASAPI 每进程峰值判断谁在发声，再读媒体会话/窗口标题；浏览器标题只作参考。',
        'x-hot': true,
      },
      'worlds.music.lookupLyrics': {
        type: 'boolean',
        title: '查完整歌词',
        description: '有准确曲目信息时从 LRCLIB 查完整歌词；查不到就只听写，保守处理。',
        'x-hot': true,
      },
      'worlds.music.debug': {
        type: 'boolean',
        title: '调试日志',
        description: '在运行日志里记录窗口、请求与解析结果。',
        'x-hot': true,
      },
    },
  },
};
