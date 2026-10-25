/** DashScope OpenAI 兼容接口的音频理解调用；只负责一次窗口分析。 */
import type { MusicConfigSection } from './config.ts';
import { buildAnalysisPrompt, parseAnalysis, type ListeningContext, type MusicAnalysis } from './prompt.ts';

export interface AnalysisOutcome {
  analysis?: MusicAnalysis;
  error?: string;
}

export interface AnalyzeOptions {
  wav: Uint8Array;
  cfg: MusicConfigSection;
  apiKey: string;
  windowSec: number;
  context?: ListeningContext;
  fetchImpl?: typeof fetch;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** 解析 OpenAI 兼容的 SSE 流，返回拼接后的文本。 */
async function readSseText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n\n');
    while (cut >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as any;
          const content = json?.choices?.[0]?.delta?.content;
          if (typeof content === 'string') text += content;
        } catch {
          // 不是 JSON 的 data 行忽略
        }
      }
      cut = buffer.indexOf('\n\n');
    }
  }
  return text;
}

/** 从非流式或流式响应里取出正文。 */
async function readResponseText(res: Response): Promise<string> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) return readSseText(res);
  const raw = await res.text();
  try {
    const json = JSON.parse(raw) as any;
    const content = json?.choices?.[0]?.message?.content ?? json?.output?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
  } catch {
    // 纯文本
  }
  return raw;
}

export async function analyzeWithDashscope(opts: AnalyzeOptions): Promise<AnalysisOutcome> {
  const { cfg, apiKey, wav, windowSec } = opts;
  if (cfg.backend === 'off') return { error: '分析后端已关闭（backend=off）。' };
  if (!apiKey) return { error: `没有找到密钥（${cfg.apiKeySecret}）；请在部署 .env 里配置。` };

  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const prompt = buildAnalysisPrompt(cfg, windowSec, opts.context);
  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${b64(wav)}`, format: 'wav' } },
        { type: 'text', text: prompt },
      ],
    }],
    modalities: ['text'],
    stream: true,
  };

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `请求失败：${message}` };
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 600); } catch {}
    return { error: `接口返回 HTTP ${res.status}${detail ? '：' + detail : ''}` };
  }

  let text = '';
  try {
    text = await readResponseText(res);
  } catch (e) {
    return { error: `读取响应失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!text.trim()) return { error: '接口没有返回文本（可能是模型不支持音频或参数不对）。' };
  return { analysis: parseAnalysis(text) };
}
