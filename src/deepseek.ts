import { resolveValidationModel } from './settings';
import type { AiSettings } from './types';

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

interface ChatOptions {
  messages: any[];
  tools?: any[];
  toolChoice?: any;
  model?: string;
  jsonMode?: boolean;
  settings: AiSettings;
  apiKey: string;
}

// Single admin, low-memory server: never run more than one request at a time.
let tail: Promise<any> = Promise.resolve();

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readError(res: any): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

/** Output token budget: 8192 by default, bounded by provider limits. */
function bodyMaxTokens(options: ChatOptions): number {
  const raw = Number(options.settings?.maxTokens ?? 8192);
  if (!Number.isFinite(raw) || raw <= 0) return 8192;
  return Math.max(1024, Math.min(8192, Math.round(raw)));
}

async function requestCompletion(options: ChatOptions): Promise<any> {
  const base = String(options.settings.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const body: any = {
    model: options.model || options.settings.model || 'deepseek-flash',
    messages: options.messages,
    temperature: 0.3,
    max_tokens: bodyMaxTokens(options),
    // Official tool-call examples use non-thinking mode. Avoids reasoning_content
    // replay requirements and tool_choice restrictions in thinking mode.
    thinking: { type: 'disabled' },
    stream: false,
  };
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice || 'auto';
  }
  if (options.jsonMode) body.response_format = { type: 'json_object' };

  const maxRetries = Math.max(0, Math.min(3, Number(options.settings.maxRetries ?? 2)));
  const timeoutMs = Math.max(5000, Number(options.settings.timeoutMs ?? 30000));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (retryableStatus(res.status)) {
        if (attempt === maxRetries) throw new Error(`DeepSeek 返回 ${res.status}，已重试 ${maxRetries} 次`);
        await sleep(300 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const detail = await readError(res);
        throw new Error(`DeepSeek 请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
      }
      return await res.json();
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === 'AbortError') throw new Error('DeepSeek 请求超时，请稍后重试');
      if (attempt === maxRetries) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw new Error('DeepSeek 请求失败');
}

export class ToolArgsParseError extends Error {
  raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'ToolArgsParseError';
    this.raw = raw;
  }
}

function parseToolArguments(raw: any, maxTokens?: number): any {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw);
  try {
    return JSON.parse(text);
  } catch (e: any) {
    // Never silently return {}: that produced a misleading "missing title"
    // error. A broken payload almost always means the output hit max_tokens.
    const looksTruncated = !/\}\s*$/.test(text);
    throw new ToolArgsParseError(
      looksTruncated
        ? `工具参数 JSON 不完整，很可能输出超过 max_tokens（当前上限 ${maxTokens ?? '未知'}）被截断。`
          + '请精简后重试：测试数据里大规模输入改用 generator 脚本（不要硬写长文本），必要时把题面与测试数据分两次提交。'
        : `工具参数 JSON 格式错误：${String(e?.message || e).slice(0, 120)}`,
      text,
    );
  }
}

export async function deepseekChat(options: ChatOptions): Promise<ChatCompletionResult> {
  return enqueue(async () => {
    const data = await requestCompletion(options);
    const message = data?.choices?.[0]?.message || {};
    const toolCalls: ToolCall[] = [];
    for (const call of message.tool_calls || []) {
      toolCalls.push({
        id: String(call.id || `call_${toolCalls.length}`),
        name: String(call.function?.name || ''),
        arguments: parseToolArguments(call.function?.arguments, bodyMaxTokens(options)),
      });
    }
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      finishReason: String(data?.choices?.[0]?.finish_reason || ''),
    };
  });
}

/**
 * Second-pass format validation. "deepseek_pro" is an internal alias kept for
 * the admin's existing workflow; it is resolved to a real model before send.
 */
export async function validateGeneratedProblem(payload: any, settings: AiSettings, apiKey: string): Promise<any> {
  const prompt = [
    '你是 OJ 题面格式校验器。请检查下面的 json 数据，输出严格 json 对象：',
    '{"ok":boolean,"issues":string[],"normalized":object}',
    '检查项：title 非空；statement 非空且不含 script 标签或外链图片；tags 为字符串数组且不超过 8 个；samples 为数组且每项含 input/output 字符串。',
    `待校验 json：${JSON.stringify(payload).slice(0, 12000)}`,
  ].join('\n');
  const result = await deepseekChat({
    messages: [{ role: 'user', content: prompt }],
    model: resolveValidationModel(settings),
    jsonMode: true,
    settings,
    apiKey,
  });
  try {
    return JSON.parse(result.content || '{}');
  } catch {
    return { ok: false, issues: ['二次校验返回内容不是合法 json'], normalized: payload };
  }
}
