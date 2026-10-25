import type { ConfigGroup } from 'cortico/core/types.ts';

/** config.json 的 worlds.music 段。默认禁用，由部署或 bot 开启。 */
export interface MusicConfigSection {
  enabled: boolean;
  /** 分析后端；v1 只有云端 DashScope，off 表示只采集不分析。 */
  backend: 'dashscope' | 'off';
  /** DashScope 的 OpenAI 兼容地址；不同工作空间可能要用自己的地址。 */
  baseUrl: string;
  /** 模型名；qwen3.8-omni-flash 支持音频理解并只输出文本。 */
  model: string;
  /** 密钥的环境变量名；值放在部署的 .env 里，不从配置读。 */
  apiKeySecret: string;
  /** 默认投递方式：一段结束总结 / 实时短评 / 两者都要。 */
  mode: 'end' | 'live' | 'both';
  /** 每个分析窗口的秒数；上传前会降为 16k 单声道。 */
  windowSec: number;
  /** 每分钟最多几次云端分析，防止刷接口。 */
  maxCallsPerMinute: number;
  /** 换歌时没有媒体信息，是否截一张屏幕给 bot 看播放器界面。 */
  screenFallback: boolean;
  /** 额外的乐器提示（自由文本，会拼进分析提示词）。 */
  instrumentHints: string;
  /** 在运行日志里记录每段分析的调试信息。 */
  debug: boolean;
}

export const MUSIC_DEFAULTS: MusicConfigSection = {
  enabled: false,
  backend: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-omni-flash',
  apiKeySecret: 'AUDIO_API_KEY',
  mode: 'end',
  windowSec: 30,
  maxCallsPerMinute: 4,
  screenFallback: false,
  instrumentHints: '',
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
      'worlds.music.backend': {
        type: 'string',
        title: '分析后端',
        description: 'dashscope = 云端 Qwen-Omni；off = 只采集不分析。',
        enum: ['dashscope', 'off'],
        'x-hot': true,
      },
      'worlds.music.baseUrl': {
        type: 'string',
        title: '接口地址',
        description: 'DashScope 的 OpenAI 兼容地址；不同业务空间的地址可能不同。',
        'x-hot': true,
      },
      'worlds.music.model': {
        type: 'string',
        title: '模型',
        description: '支持音频输入、只输出文本的模型名，例如 qwen3.8-omni-flash。',
        'x-hot': true,
      },
      'worlds.music.apiKeySecret': {
        type: 'string',
        title: '密钥变量名',
        description: '部署 .env 里的环境变量名；密钥本身不写进配置。',
        'x-hot': true,
      },
      'worlds.music.mode': {
        type: 'string',
        title: '默认模式',
        description: 'end = 一段结束/暂停时总结；live = 每段短评；both = 两者都要。',
        enum: ['end', 'live', 'both'],
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
        description: '拿不到媒体信息时截一张主屏给 bot 看；会包含屏幕内容。',
        'x-hot': true,
      },
      'worlds.music.instrumentHints': {
        type: 'string',
        title: '额外乐器提示',
        description: '常见的乐器/风格提示，会拼进分析提示词。',
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
