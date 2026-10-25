import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MUSIC_DEFAULTS, type MusicConfigSection } from './config.ts';
import { loadLoopback } from './capture.ts';
import { MUSIC_TOOL_DECLS, MusicWorld } from './world.ts';

export const MUSIC: WorldDefinition<MusicConfigSection> = {
  id: 'music',
  label: '一起感受音乐',
  defaults: () => ({ ...MUSIC_DEFAULTS }),
  preflight: () => {
    if (process.platform !== 'win32') throw new Error('一起感受音乐目前只支持 Windows（WASAPI 系统环回）。');
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
      music_watch: { zh: '只有在用户明确要求一起听音乐时才开始；停止会总结当前一段。', en: 'Start only when the user explicitly asks to listen together; stop summarizes the current segment.' },
      music_now: { zh: '查看是否在听、当前一段、当前曲目与最近一次感受。', en: 'Read listening state, the current segment, track and latest feeling.' },
      music_mode: { zh: '切换 end / live / both 投递模式。', en: 'Set end / live / both delivery mode.' },
    }),
    events: [
      {
        type: 'music.started',
        description: { zh: '用户明确要求一起听后，确认一段音乐开始；可能带播放器曲目信息或屏幕截图。', en: 'After the user explicitly asked to listen, a music segment is confirmed; may carry track info or a screenshot.' },
        trigger: 'flush',
      },
      {
        type: 'music.scene',
        description: { zh: '实时模式下，一个窗口的沉浸式感受（参数放在内部参考里）。', en: 'One immersive window note in live mode; parameters sit in the internal reference.' },
        trigger: 'debounce',
      },
      {
        type: 'music.ended',
        description: { zh: '一段结束或暂停；正文是整体感受、可信歌词与内部参考，适合让 bot 用人的方式总结。', en: 'A segment ended or paused; the text is the overall feeling, trusted lyrics and an internal reference for the bot.' },
        trigger: 'flush',
      },
      {
        type: 'music.state',
        description: { zh: 'World 自己的状态：待命、开始听、停止、错误。', en: 'The World state: standby, listening, stopped, error.' },
        trigger: 'flush',
      },
    ],
  },
};
