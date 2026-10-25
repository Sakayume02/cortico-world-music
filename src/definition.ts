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
    storeSecret: (name, value) => ctx.storeSecret(name, value),
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
        description: { zh: '第一首或来源未知时确认音乐开始；带曲目或截图，bot 应先报幕。', en: 'The first song or an unknown source is confirmed; carries track or screenshot, and the bot should announce it.' },
        trigger: 'flush',
      },
      {
        type: 'music.switch',
        description: { zh: '换歌：上一首完整总结 + 新歌报幕，interrupt 掉上一首没说完的话。', en: 'Song change: the full previous summary plus the new track, interrupting unfinished old talk.' },
        trigger: 'interrupt',
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
        description: { zh: 'World 自己的状态：待命、开始听、停止、错误，以及每两分钟的【在听】心跳。', en: 'The World state: standby, listening, stopped, error, and a two-minute listening heartbeat.' },
        trigger: 'flush',
      },
    ],
  },
};
