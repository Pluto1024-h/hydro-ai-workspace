/**
 * Offline, rule-based problem-bank analysis.
 * Runs entirely inside the plugin: no extra API calls, no heavy services.
 */
import { state } from './state';

export interface DuplicateMember {
  docId: number;
  pid: string;
  title: string;
  contentLength: number;
}
export interface DuplicateGroup {
  reason: string;
  score: number;
  members: DuplicateMember[];
}
export interface TagSuggestion {
  docId: number;
  pid: string;
  title: string;
  currentTags: string[];
  suggestedTags: string[];
  added: string[];
  gespLevel: string;
  knowledge: string[];
  evidence: string;
}

/** Keep only letters/numbers/CJK, drop markdown decoration and whitespace. */
export function normalizeContent(text: any): string {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[#*`~>|_\\]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

/** Remove GESP/year/month decorations and punctuation, for title comparison only. */
export function normalizeTitle(text: any): string {
  return String(text || '')
    .replace(/[\[【(（][^\]】)）]*[\]】)）]/g, '')
    .replace(/20\d{2}\s*年?\s*\d{1,2}\s*月?/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function shingles(text: string, width = 6): Set<string> {
  const out = new Set<string>();
  if (text.length <= width) {
    if (text) out.add(text);
    return out;
  }
  for (let i = 0; i <= text.length - width; i++) out.add(text.slice(i, i + width));
  return out;
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common++;
  return common / (a.size + b.size - common);
}

/** 32-bit FNV-1a hash for MinHash signatures (no crypto dependency). */
function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** MinHash signature: the k smallest shingle hashes; shared/k ≈ Jaccard. */
function signature(body: string, k = 64): number[] {
  const sig: number[] = [];
  for (const sh of shingles(body, 6)) sig.push(hash32(sh));
  sig.sort((a, b) => a - b);
  return sig.slice(0, k);
}

const CN_DIGITS: Record<string, string> = {
  '1': '一', '2': '二', '3': '三', '4': '四', '5': '五',
  '6': '六', '7': '七', '8': '八', '9': '九', '10': '十',
};

/** Detect "2026年3月GESP一级" / "[GESP202509 五级]" -> GESP一级 / GESP五级. */
export function detectGespLevel(text: any): string {
  const source = String(text || '');
  const patterns = [
    /GESP\s*20\d{2}\s*年?\s*\d{1,2}\s*月?\s*([一二三四五六七八九十]{1,3}|\d{1,2})\s*级/gi,
    /GESP\s*20\d{6}\s+([一二三四五六七八九十]{1,3}|\d{1,2})\s*级/gi,
    /GESP\s*(\d{6})\s+([一二三四五六七八九十]{1,3}|\d{1,2})\s*级/gi,
    /GESP\s*([一二三四五六七八九十]{1,3}|\d{1,2})\s*级/gi,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) {
      const level = match[1] || match[2];
      if (!level) continue;
      return `GESP${CN_DIGITS[level] || level}级`;
    }
  }
  return '';
}

const KNOWLEDGE_RULES: Array<{ tag: string; re: RegExp }> = [
  { tag: '旗帜法', re: /旗帜法|标记法|\bflag\b/i },
  { tag: '循环结构', re: /for\s*\(|while\s*\(|循环结构|for\s*循环|while\s*循环|\bfor\b|\bwhile\b/i },
  { tag: '二分', re: /二分|折半|binary\s*search/i },
  { tag: '贪心', re: /贪心|greedy/i },
  { tag: '动态规划', re: /动态规划|状态转移|\bdp\b|背包/i },
  { tag: '数论', re: /素数|质数|筛法|线性筛|\bgcd\b|最大公约数|取模|模运算/i },
  { tag: '排序', re: /排序|sort\s*\(|快速排序|归并排序/i },
  { tag: '搜索', re: /\bdfs\b|\bbfs\b|深度优先|广度优先|回溯|搜索/i },
  { tag: '字符串', re: /字符串|子串|字符数组/i },
  { tag: '前缀和', re: /前缀和|差分数组/i },
  { tag: '递归', re: /递归|recursion/i },
  { tag: '图论', re: /图论|最短路|并查集|dijkstra|floyd/i },
  { tag: '栈与队列', re: /\bstack\b|\bqueue\b|栈|队列/i },
  { tag: '模拟', re: /模拟/i },
];

export function detectKnowledge(text: any): string[] {
  const source = String(text || '');
  return KNOWLEDGE_RULES.filter((rule) => rule.re.test(source)).map((rule) => rule.tag);
}

export function suggestTagsFor(title: string, content: string, currentTags: string[]): {
  suggestedTags: string[]; added: string[]; gespLevel: string; knowledge: string[]; evidence: string;
} {
  const normalizedTitle = normalizeTitle(title);
  const body = normalizeContent(content);
  const gespLevel = detectGespLevel(`${title} ${content.slice(0, 600)}`);
  const knowledge = detectKnowledge(`${normalizedTitle} ${body.slice(0, 1200)}`);
  const suggestedTags: string[] = Array.isArray(currentTags) ? currentTags.map(String) : [];
  for (const tag of [gespLevel, ...knowledge]) {
    if (tag && !suggestedTags.includes(tag)) suggestedTags.push(tag);
  }
  const added = suggestedTags.filter((tag) => !(currentTags || []).includes(tag));
  const evidenceParts: string[] = [];
  if (gespLevel) evidenceParts.push(`标题/题面含 GESP 级别标记`);
  if (knowledge.length) evidenceParts.push(`题面命中知识点关键词：${knowledge.join('、')}`);
  return {
    suggestedTags,
    added,
    gespLevel,
    knowledge,
    evidence: evidenceParts.join('；') || '未识别到明确级别或知识点，建议人工复核',
  };
}

const MAX_SCAN = 5000; // hard ceiling to protect a 2G server

async function scanProblems(domainId: string, limit: number): Promise<any[]> {
  return state.db.collection('document').find({ domainId, docType: 10 })
    .project({ _id: 1, docId: 1, pid: 1, title: 1, tag: 1, content: 1 })
    .sort({ docId: -1 }).limit(Math.min(MAX_SCAN, Math.max(1, limit)))
    .maxTimeMS(20000).toArray();
}

export interface DuplicateScanResult {
  groups: DuplicateGroup[];
  scanned: number;
  total: number;
  truncated: boolean;
}

/** Find exact and near-duplicate problems by normalized statement, not just title. */
export async function findDuplicates(
  domainId: string, { limit = 2000, threshold = 0.82 }: { limit?: number; threshold?: number } = {},
): Promise<DuplicateScanResult> {
  const wanted = Math.min(MAX_SCAN, Math.max(10, limit));
  const coll = state.db.collection('document');
  const total = await coll.countDocuments({ domainId, docType: 10 }, { maxTimeMS: 5000 }).catch(() => wanted);
  const docs = await scanProblems(domainId, wanted);
  const scanned = docs.length;
  const truncated = total > scanned;
  const items = docs.map((doc: any) => {
    const body = normalizeContent(doc.content).slice(0, 1800);
    return {
      docId: Number(doc.docId) || 0,
      pid: String(doc.pid || doc.docId || ''),
      title: String(doc.title || ''),
      contentLength: body.length,
      titleKey: normalizeTitle(doc.title),
      body,
      sh: shingles(body),
      sig: signature(body),
      hash: body.slice(0, 300),
    };
  });

  const groups: DuplicateGroup[] = [];
  const claimed = new Set<number>();
  // Fast path: identical normalized statement prefix (linear).
  const byHash: Record<string, any[]> = {};
  for (const item of items) {
    if (!item.hash) continue;
    (byHash[item.hash] ||= []).push(item);
  }
  for (const bucket of Object.values(byHash)) {
    if (bucket.length < 2) continue;
    for (const item of bucket) claimed.add(item.docId);
    groups.push({
      reason: '题面正文归一化后完全一致',
      score: 1,
      members: bucket.map((i) => ({ docId: i.docId, pid: i.pid, title: i.title, contentLength: i.contentLength })),
    });
  }

  // Near duplicates via LSH banding: only pairs sharing a full band of
  // MinHash values become candidates. This is near-linear even for 5000 docs,
  // instead of the old O(n^2) loop that silently stopped after 20000 checks.
  // 32 bands x 2 rows over 64 MinHash values: favours recall near the 0.82
  // threshold (more bands = higher recall). Random collisions are cheap
  // because the exact Jaccard below filters them out.
  const BANDS = 32;
  const ROWS = 2;
  const bucketLimit = 200; // skip only pathologically common band keys
  const cand = new Map<string, [number, number]>();
  for (let band = 0; band < BANDS; band++) {
    const byBandKey: Record<string, number[]> = {};
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (claimed.has(item.docId) || item.body.length <= 60) continue;
      const part = item.sig.slice(band * ROWS, band * ROWS + ROWS);
      if (part.length < ROWS) continue;
      const key = part.join(',');
      (byBandKey[key] ||= []).push(idx);
    }
    for (const members of Object.values(byBandKey)) {
      if (members.length < 2 || members.length > bucketLimit) continue;
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) {
          const lo = Math.min(members[a], members[b]);
          const hi = Math.max(members[a], members[b]);
          if (!claimed.has(items[lo].docId) && !claimed.has(items[hi].docId)) {
            cand.set(`${lo}:${hi}`, [lo, hi]);
          }
        }
      }
    }
  }

  for (const [lo, hi] of cand.values()) {
    const left = items[lo]; const right = items[hi];
    if (claimed.has(left.docId) || claimed.has(right.docId)) continue;
    const ratio = Math.min(left.body.length, right.body.length) / Math.max(left.body.length, right.body.length);
    if (ratio < 0.7) continue;
    const score = similarity(left.sh, right.sh);
    if (score >= threshold) {
      claimed.add(left.docId); claimed.add(right.docId);
      groups.push({
        reason: `题面正文相似度 ${(score * 100).toFixed(0)}%`,
        score,
        members: [left, right].map((i) => ({ docId: i.docId, pid: i.pid, title: i.title, contentLength: i.contentLength })),
      });
    }
  }
  return { groups: groups.sort((a, b) => b.score - a.score), scanned, total, truncated };
}

/** Analyse tag suggestions across the whole bank without changing any data. */
export async function suggestProblemTags(
  domainId: string, { limit = 200, keyword = '' }: { limit?: number; keyword?: string } = {},
): Promise<TagSuggestion[]> {
  const docs = await scanProblems(domainId, Math.min(MAX_SCAN, Math.max(1, limit)));
  const filtered = keyword
    ? docs.filter((d: any) => String(d.title || '').includes(keyword) || String(d.pid || '').includes(keyword))
    : docs;
  return filtered.map((doc: any) => {
    const title = String(doc.title || '');
    const content = String(doc.content || '');
    const currentTags: string[] = Array.isArray(doc.tag) ? doc.tag.map(String) : [];
    const result = suggestTagsFor(title, content, currentTags);
    return {
      docId: Number(doc.docId) || 0,
      pid: String(doc.pid || doc.docId || ''),
      title,
      currentTags,
      suggestedTags: result.suggestedTags,
      added: result.added,
      gespLevel: result.gespLevel,
      knowledge: result.knowledge,
      evidence: result.evidence,
    };
  });
}
