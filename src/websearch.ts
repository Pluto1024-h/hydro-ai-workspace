/**
 * Generic web-search adapter. No crawler, no resident process: a single HTTP
 * request to a search API, then results are trimmed before reaching the model.
 */
import { coll } from './state';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}
export interface SearchResult {
  provider: string;
  query: string;
  hits: SearchHit[];
  answer: string;
}

const KEY_ENV = 'HYDRO_AI_SEARCH_KEY';
export const SEARCH_PROVIDERS = ['bocha', 'tavily', 'serper'] as const;

export async function getSearchConfig(): Promise<{ provider: string; apiBase: string; keySet: boolean; keyMasked: string; keyFromEnv: boolean }> {
  const doc = await coll('aiws_settings').findOne({ _id: 'global' });
  const key = await getSearchKey();
  const provider = String((doc as any)?.searchProvider || 'bocha');
  return {
    provider,
    apiBase: String((doc as any)?.searchApiBase || defaultBase(provider)),
    keySet: !!key,
    keyMasked: key ? `${key.slice(0, 3)}****${key.slice(-4)}` : '',
    keyFromEnv: !!process.env[KEY_ENV],
  };
}

export async function getSearchKey(): Promise<string> {
  if (process.env[KEY_ENV]) return String(process.env[KEY_ENV]).trim();
  try {
    const doc = await coll('aiws_settings').findOne({ _id: 'global' });
    return String((doc as any)?.searchApiKey || '').trim();
  } catch {
    return '';
  }
}

export async function saveSearchConfig(patch: { provider?: string; apiBase?: string; apiKey?: string }): Promise<void> {
  const clean: any = { updatedAt: new Date() };
  if (patch.provider !== undefined) clean.searchProvider = String(patch.provider).slice(0, 32);
  if (patch.apiBase !== undefined) clean.searchApiBase = String(patch.apiBase).trim().slice(0, 200);
  if (patch.apiKey !== undefined && String(patch.apiKey).trim()) clean.searchApiKey = String(patch.apiKey).trim();
  await coll('aiws_settings').updateOne({ _id: 'global' }, { $set: clean }, { upsert: true });
}

export function defaultBase(provider: string): string {
  if (provider === 'tavily') return 'https://api.tavily.com';
  if (provider === 'serper') return 'https://google.serper.dev';
  return 'https://api.bochaai.com';
}

function clean(text: any, max = 400): string {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseHits(provider: string, data: any): SearchHit[] {
  if (provider === 'tavily') {
    return (Array.isArray(data?.results) ? data.results : []).map((r: any) => ({
      title: clean(r.title, 160), url: clean(r.url, 300), snippet: clean(r.content), source: 'tavily',
    }));
  }
  if (provider === 'serper') {
    return (Array.isArray(data?.organic) ? data.organic : []).map((r: any) => ({
      title: clean(r.title, 160), url: clean(r.link, 300), snippet: clean(r.snippet), source: 'serper',
    }));
  }
  const pages = data?.data?.webPages?.value || data?.webPages?.value || data?.data?.webPages || [];
  return (Array.isArray(pages) ? pages : []).map((r: any) => ({
    title: clean(r.name || r.title, 160), url: clean(r.url, 300),
    snippet: clean(r.summary || r.snippet || r.content), source: 'bocha',
  }));
}

export async function webSearch(query: string, options: { count?: number; timeoutMs?: number } = {}): Promise<SearchResult> {
  const text = String(query || '').trim().slice(0, 300);
  if (!text) throw new Error('搜索关键词不能为空');
  const config = await getSearchConfig();
  const apiKey = await getSearchKey();
  if (!apiKey) throw new Error('尚未配置搜索 API Key，请在配置页填写，或设置环境变量 HYDRO_AI_SEARCH_KEY。');
  const provider = SEARCH_PROVIDERS.includes(config.provider as any) ? config.provider : 'bocha';
  const base = (config.apiBase || defaultBase(provider)).replace(/\/+$/, '');
  const count = Math.max(1, Math.min(10, Number(options.count) || 5));
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 10000));

  let url = base;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: any = {};
  if (provider === 'tavily') {
    url = `${base}/search`;
    body = { api_key: apiKey, query: text, max_results: count, search_depth: 'basic', include_answer: true };
  } else if (provider === 'serper') {
    url = `${base}/search`;
    headers = { ...headers, 'X-API-KEY': apiKey };
    body = { q: text, num: count };
  } else {
    url = `${base}/v1/web-search`;
    headers = { ...headers, Authorization: `Bearer ${apiKey}` };
    body = { query: text, count, summary: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`搜索 API 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
    }
    const data = await res.json();
    return {
      provider,
      query: text,
      hits: parseHits(provider, data).slice(0, count),
      answer: clean(data?.answer, 600),
    };
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') throw new Error('搜索 API 超时，请稍后重试');
    throw e;
  }
}

/** Compact text for the model: titles + snippets only, capped in length. */
export function formatSearchForModel(result: SearchResult): string {
  const lines = result.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`);
  const answer = result.answer ? `搜索摘要：${result.answer}\n` : '';
  const text = `${answer}检索结果（来源 ${result.provider}）：\n${lines.join('\n')}`;
  return text.slice(0, 5000);
}
