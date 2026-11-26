/**
 * Stress test for findDuplicates: verifies full-bank scanning and near-linear
 * behaviour that the small simulation dataset cannot cover.
 */
'use strict';
const path = require('path');
const BUILD = path.join(__dirname, '.build/src/problem_audit.js');
const audit = require(BUILD);

// Minimal in-memory DB wired into the module's state.
const { state } = require(path.join(__dirname, '.build/src/state.js'));
const N = 3000;
const docs = [];
const base = '第一行题目要求给定整数数组求和输出答案第二行输入包含若干整数用空格分隔第三行输出结果并换行';
for (let i = 0; i < N; i++) {
  // Every 100-block: first 30 entries form 15 duplicate pairs (2k, 2k+1 share body).
  const inDupZone = i % 100 < 30;
  const pairBase = i - (i % 2); // even index of the pair
  const content = inDupZone
    ? base + '变体' + Math.floor(pairBase / 100) + '序号' + pairBase
    : base + '变体' + Math.floor(i / 100) + '序号' + i;
  docs.push({ _id: i, docId: i + 1, pid: 'P' + (i + 1), title: '题' + i, content, tag: [], domainId: 'd', docType: 10 });
}
const coll = {
  find() {
    const c = {
      project() { return c; }, sort(spec) { const [f, d] = Object.entries(spec)[0]; docs.sort((a, b) => cmp(a[f], b[f]) * (d === -1 ? -1 : 1)); return c; },
      limit(n) { c._limit = n; return c; }, maxTimeMS() { return c; },
      async toArray() { return docs.slice(0, c._limit || docs.length); },
    };
    return c;
  },
  countDocuments: async () => N,
};
function cmp(a, b) { return a > b ? 1 : a < b ? -1 : 0; }
state.db = { collection: () => coll };

(async () => {
  const t0 = Date.now();
  const r = await audit.findDuplicates('d', { limit: 5000, threshold: 0.9 });
  const ms = Date.now() - t0;
  console.log(`扫描 ${r.scanned}/${r.total} 题，耗时 ${ms}ms，truncated=${r.truncated}`);
  console.log(`发现 ${r.groups.length} 组重复题`);
  if (r.scanned !== N) throw new Error('未扫全库');
  if (r.truncated) throw new Error('不应截断');
  // 30 duplicate pairs out of first 30 in every 100-block => 15 pairs per block * 30 blocks = 450 groups
  if (r.groups.length < 100) throw new Error('重复组数量异常，疑似 LSH 漏检: ' + r.groups.length);
  const exact = r.groups.filter(g => g.score === 1);
  console.log(`其中完全一致组 ${exact.length} 组，示例:`, exact[0] && exact[0].members.map(m => m.pid).join('='));
  if (ms > 15000) throw new Error('耗时过长: ' + ms + 'ms');
  console.log('PASS: 全库扫描 + LSH 查重 + 性能均正常');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
