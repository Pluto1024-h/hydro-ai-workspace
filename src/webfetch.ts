/**
 * Direct URL fetcher for reading a single page's text (e.g. a Luogu problem
 * page or a GESP statement). No headless browser, no resident process: one
 * HTTP request with hard size/time limits, then HTML is reduced to text.
 *
 * Security: this is a server-side request, so SSRF is a real risk. We only
 * allow http(s), reject loopback/private/link-local/metadata addresses (both
 * literal IPs and DNS-resolved ones), follow redirects manually and re-check
 * every hop, and cap response bytes.
 */
import { lookup } from 'dns/promises';

export interface FetchPageResult {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  contentType: string;
  truncated: boolean;
  bytes: number;
  challenge: boolean;   // page looks like a bot-check wall, not real content
}

const CHALLENGE_HINTS = [
  '验证您是真人', '请完成安全验证', '安全检查', '人机验证',
  'just a moment', 'attention required', 'checking your browser',
  'enable javascript and cookies', 'cf-challenge', 'cloudflare',
  'ddos protection', 'verify you are human', 'access denied',
];

/** Detect anti-bot interstitial pages so the model is not fed a fake statement. */
export function looksLikeChallenge(title: string, text: string): boolean {
  const sample = `${title}\n${text.slice(0, 1200)}`.toLowerCase();
  if (text.length > 3000) return false; // real pages are usually longer
  return CHALLENGE_HINTS.some((h) => sample.includes(h.toLowerCase()));
}

const MAX_BYTES = 2 * 1024 * 1024;     // 2 MB hard cap
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_CHARS = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function normalizeUrl(raw: string): URL {
  const text = String(raw || '').trim();
  if (!text) throw new Error('链接不能为空');
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error('链接格式不正确，需要完整的 http(s) 地址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 链接');
  return u;
}

function isPrivateIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]); const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT
    if (a >= 224) return true;                             // multicast/reserved
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;  // unique local
  if (v6.startsWith('fe80')) return true;                        // link-local
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('链接缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('禁止访问内网地址');
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error('禁止访问内网地址');
  }
  // Resolve and re-check: blocks hostnames that point at internal services.
  const infos = await lookup(host, { all: true }).catch(() => [] as any[]);
  for (const info of infos) {
    if (isPrivateIp(String(info?.address || ''))) throw new Error('该链接解析到内网地址，已拒绝访问');
  }
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…',
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_m, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] ?? m);
}

/** Reduce HTML to readable text; prefer the main article container. */
export function htmlToText(html: string): string {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|canvas|template)\b[\s\S]*?<\/\1>/gi, ' ');
  // Prefer a main content container when present. article/main are semantic,
  // so trust them even when short; class-based guesses need enough content.
  const semantic = /<article\b[\s\S]*?<\/article>/i.exec(s) || /<main\b[\s\S]*?<\/main>/i.exec(s);
  if (semantic) {
    s = semantic[0];
  } else {
    const guessed = /<div[^>]+class=["'][^"']*(?:problem|content|markdown|article)[^"']*["'][\s\S]*?<\/div>/i.exec(s);
    if (guessed && guessed[0].length > 400) s = guessed[0];
  }
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n');
  s = s.replace(/<(li|tr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[ \t\f\v\u00a0]+/g, ' ');
  s = s.split('\n').map((line) => line.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function pickCharset(contentType: string, head: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head || '');
  let cs = (fromHeader?.[1] || fromMeta?.[1] || 'utf-8').toLowerCase();
  if (cs === 'gb2312' || cs === 'gbk') cs = 'gb18030';
  if (cs === 'utf8') cs = 'utf-8';
  return cs;
}

async function readCapped(body: any): Promise<{ buf: any; bytes: number; truncated: boolean }> {
  if (!body || typeof body.getReader !== 'function') {
    const ab = await body?.arrayBuffer?.();
    const buf = Buffer.from(ab || []);
    return { buf, bytes: buf.length, truncated: buf.length > MAX_BYTES };
  }
  const reader = body.getReader();
  const chunks: any[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength || 0;
    chunks.push(Buffer.from(value));
    if (total >= MAX_BYTES) { truncated = true; try { await reader.cancel(); } catch { /* ignore */ } break; }
  }
  return { buf: Buffer.concat(chunks), bytes: total, truncated };
}

function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return m ? decodeEntities(String(m[1]).replace(/\s+/g, ' ').trim()).slice(0, 200) : '';
}

export async function fetchPage(rawUrl: string, options: { maxChars?: number; timeoutMs?: number } = {}): Promise<FetchPageResult> {
  const maxChars = Math.max(500, Math.min(30000, Number(options.maxChars) || DEFAULT_MAX_CHARS));
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const first = normalizeUrl(rawUrl);

  let current = first;
  let res: any = null;
  const visited = new Set<string>();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const key = current.toString();
    if (visited.has(key)) {
      throw new Error('该站点存在重定向循环（通常需要登录或 Cookie 校验），无法直接抓取，请粘贴题面');
    }
    visited.add(key);
    await assertPublicHost(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        },
      });
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === 'AbortError') throw new Error('请求超时，站点响应过慢');
      throw new Error(`请求失败：${String(e?.message || e).slice(0, 160)}`);
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`站点返回 ${res.status} 但没有跳转地址`);
      current = normalizeUrl(new URL(loc, current).toString());
      continue;
    }
    break;
  }

  if (!res) throw new Error('请求失败');
  if (res.status < 200 || res.status >= 300) {
    const hint = res.status === 401 || res.status === 403
      ? '（站点有反爬或需要登录，无法直接抓取，请粘贴题面）'
      : res.status === 429
        ? '（请求过于频繁被限流，请稍后重试或粘贴题面）'
        : res.status >= 300 && res.status < 400
          ? '（重定向过多，站点可能需要登录/Cookie，请粘贴题面）'
          : '';
    throw new Error(`站点返回 HTTP ${res.status}${hint}`);
  }
  const contentType = String(res.headers.get('content-type') || '');
  if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)) {
    throw new Error(`不支持的内容类型：${contentType.split(';')[0]}（PDF/图片等请直接上传或贴文本）`);
  }

  const { buf, bytes, truncated } = await readCapped(res.body);
  const head = buf.slice(0, 4096).toString('latin1');
  const charset = pickCharset(contentType, head);
  let bodyText: string;
  try {
    bodyText = new TextDecoder(charset).decode(buf);
  } catch {
    bodyText = buf.toString('utf8');
  }

  const isHtml = /html|xhtml/i.test(contentType) || /<html|<body|<div|<p\b/i.test(bodyText.slice(0, 2000));
  const title = isHtml ? extractTitle(bodyText) : '';
  const text = (isHtml ? htmlToText(bodyText) : bodyText.trim()).slice(0, maxChars);
  return {
    url: first.toString(),
    finalUrl: current.toString(),
    title: title || current.hostname,
    text,
    contentType: contentType.split(';')[0] || 'text/html',
    truncated: truncated || text.length >= maxChars,
    bytes,
    challenge: looksLikeChallenge(title, text),
  };
}
