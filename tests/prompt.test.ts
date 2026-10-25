import { describe, it, expect } from 'vitest';
import { combineAnalyses, formatAnalysis, parseAnalysis, reactionHint, buildAnalysisPrompt, type MusicAnalysis } from '../src/prompt.ts';
import { MUSIC_DEFAULTS } from '../src/config.ts';

const analysis: MusicAnalysis = {
  summary: '慢速的小调钢琴，听起来像克制的惆怅。',
  listenerSummary: '像傍晚的空房间，钢琴声一层层落下来；我坐着没动，呼吸变轻了。',
  feeling: '克制的惆怅，像有话没说出口',
  imagery: '傍晚的空房间、窗边的光',
  body: '肩膀松下来，想安静坐着',
  arc: '从平静到有点鼻酸',
  isMusic: true,
  musicConfidence: 0.9,
  tempoBpm: 72,
  meter: '4/4',
  key: 'A',
  mode: '小调',
  instruments: [{ name: '钢琴', confidence: 0.8 }, { name: '大提琴', confidence: 0.6 }],
  melody: '下行级进',
  rhythm: '慢速',
  mood: { valence: -0.5, arousal: 0.3, quality: '克制的惆怅', confidence: 0.7 },
  lyrics: { present: true, text: '再见', confidence: 0.4, source: 'asr', complete: false },
  uncertain: ['人声是否真的出现'],
};

describe('prompt', () => {
  it('parses a fenced JSON answer with immersive fields', () => {
    const parsed = parseAnalysis('```json\n' + JSON.stringify(analysis) + '\n```');
    expect(parsed.listenerSummary).toContain('空房间');
    expect(parsed.feeling).toContain('惆怅');
    expect(parsed.instruments[0]!.name).toBe('钢琴');
    expect(parsed.mood?.valence).toBeCloseTo(-0.5);
    expect(parsed.lyrics?.source).toBe('asr');
  });

  it('falls back to raw text when JSON is missing', () => {
    const parsed = parseAnalysis('这段听起来很安静');
    expect(parsed.summary).toContain('安静');
    expect(parsed.uncertain).toContain('模型没有返回 JSON');
  });

  it('formats a window as feeling first and internal reference last', () => {
    const text = formatAnalysis(analysis);
    expect(text).toContain('【这段的感受】');
    expect(text).toContain('傍晚的空房间');
    expect(text).toContain('克制的惆怅');
    expect(text).toContain('动作参考');
    expect(text).toContain('内部参考');
    expect(text).toContain('72 BPM');
  });

  it('suggests only existing actions by mood', () => {
    expect(reactionHint(analysis)).toContain('坐着发呆');
    const happy: MusicAnalysis = {
      ...analysis,
      mood: { valence: 0.8, arousal: 0.8, quality: '开心得想跳', confidence: 0.8 },
    };
    expect(reactionHint(happy)).toContain('在屏幕底边走动');
    expect(reactionHint(happy)).toContain('开心');
  });

  it('combines with trusted lyrics and keeps parameters internal', () => {
    const all = combineAnalyses([analysis], 90_000, 30, {
      track: '记忆点',
      artist: '陈卓璇',
      lyrics: '所以你才选择离开\n别不说话我的亲爱',
      lyricsSource: 'lrclib',
    });
    expect(all).toContain('90 秒');
    expect(all).toContain('记忆点');
    expect(all).toContain('LRCLIB');
    expect(all).toContain('别不说话我的亲爱');
    expect(all).toContain('动作参考');
    expect(all).toContain('傻白甜');
    expect(all).toContain('内部参考');
    expect(all).toContain('不要照念');
  });

  it('includes the immersive schema, taxonomy and Copland cautions', () => {
    const p = buildAnalysisPrompt(MUSIC_DEFAULTS, 30, { track: '记忆点', artist: '陈卓璇', lyrics: '第一句\n第二句' });
    expect(p).toContain('listenerSummary');
    expect(p).toContain('已知完整歌词');
    expect(p).toContain('古筝');
    expect(p).toContain('尺八');
    expect(p).toContain('不要用「某调 = 某情绪」');
  });
});
