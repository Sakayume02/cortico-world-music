import { describe, it, expect } from 'vitest';
import { combineAnalyses, formatAnalysis, parseAnalysis, buildAnalysisPrompt, type MusicAnalysis } from '../src/prompt.ts';
import { MUSIC_DEFAULTS } from '../src/config.ts';

const analysis: MusicAnalysis = {
  summary: '慢速的小调钢琴，听起来像克制的惆怅。',
  tempoBpm: 72,
  meter: '4/4',
  key: 'A',
  mode: '小调',
  instruments: [{ name: '钢琴', confidence: 0.8 }, { name: '大提琴', confidence: 0.6 }],
  melody: '下行级进',
  rhythm: '慢速',
  mood: { valence: -0.5, arousal: 0.3, quality: '克制的惆怅', confidence: 0.7 },
  lyrics: { present: true, text: '再见', confidence: 0.4 },
  uncertain: ['人声是否真的出现'],
};

describe('prompt', () => {
  it('parses a fenced JSON answer', () => {
    const parsed = parseAnalysis('```json\n' + JSON.stringify(analysis) + '\n```');
    expect(parsed.summary).toContain('惆怅');
    expect(parsed.instruments[0]!.name).toBe('钢琴');
    expect(parsed.mood?.valence).toBeCloseTo(-0.5);
  });

  it('falls back to raw text when JSON is missing', () => {
    const parsed = parseAnalysis('这段听起来很安静');
    expect(parsed.summary).toContain('安静');
    expect(parsed.uncertain).toContain('模型没有返回 JSON');
  });

  it('formats and combines analyses', () => {
    const text = formatAnalysis(analysis);
    expect(text).toContain('72 BPM');
    expect(text).toContain('钢琴');
    const all = combineAnalyses([analysis], 90_000, 30);
    expect(all).toContain('90 秒');
    expect(all).toContain('克制的惆怅');
    expect(all).toContain('再见');
  });

  it('includes the instrument taxonomy and Copland cautions', () => {
    const p = buildAnalysisPrompt(MUSIC_DEFAULTS, 30);
    expect(p).toContain('古筝');
    expect(p).toContain('尺八');
    expect(p).toContain('不要用「某调 = 某情绪」');
  });
});
