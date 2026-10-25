import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MUSIC_DEFAULTS, type MusicConfigSection } from './config.ts';
import { loadLoopback } from './capture.ts';
import { MUSIC_TOOL_DECLS, MusicWorld } from './world.ts';

export const MUSIC: WorldDefinition<MusicConfigSection> = {
  id: 'music',
  label: '音乐',
  defaults: () => ({ ...MUSIC_DEFAULTS }),
  preflight: () => {
    if (process.platform !== 'win32') throw new Error('音乐 World 目前只支持 Windows（WASAPI 系统环回）。');
    // 原生件载不进来时提前给出人话，而不是等挂载后才报错。
    loadLoopback();
  },
  create: (ctx) => new MusicWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    secret: (name) => ctx.secret(name),
    persist: (patch) => ctx.persist(patch),
  }),
  describe: {
    tools: describeTools(MUSIC_TOOL_DECLS, {
      music_watch: { zh: '开始/停止听系统声音，或查看当前状态。', en: 'Start or stop listening to system audio, or read the current state.' },
      music_now: { zh: '查看是否在听、当前一段与最近一次分析。', en: 'Read listening state, the current segment and the latest analysis.' },
      music_mode: { zh: '切换 end / live / both 投递模式。', en: 'Set end / live / both delivery mode.' },
    }),
    events: [
      {
        type: 'music.started',
        description: { zh: '听到一段新的音乐（换歌/开始）；可能附带一张屏幕截图用于识别播放器。', en: 'A new music segment started; may carry a screenshot for identifying the player.' },
        trigger: 'flush',
      },
      {
        type: 'music.scene',
        description: { zh: '实时模式下，一个分析窗口的结果。', en: 'One analyzed window in live mode.' },
        trigger: 'debounce',
      },
      {
        type: 'music.ended',
        description: { zh: '一段音乐结束或暂停；正文是整段汇总，适合让 bot 总结。', en: 'A music segment ended or paused; the text is a whole-segment summary for the bot.' },
        trigger: 'flush',
      },
      {
        type: 'music.state',
        description: { zh: 'World 自己报告的采集状态：开始、停止、错误。', en: 'The World reports its own capture state: started, stopped, error.' },
        trigger: 'flush',
      },
    ],
  },
};
