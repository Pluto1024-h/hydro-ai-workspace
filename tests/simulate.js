/**
 * Offline simulation for hydro-ai-workspace.
 *
 * Runs the REAL tool functions against an in-memory Hydro-like database so we
 * can catch regressions (tool-name collisions, missing identifiers in tool
 * summaries, sudo bypass, bad argument validation) before packaging.
 *
 * Usage (from the plugin directory):  node tests/simulate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(__dirname, '.build');

// ---------------------------------------------------------------------------
// 1. Compile the plugin sources to plain CommonJS.
// ---------------------------------------------------------------------------
fs.rmSync(BUILD, { recursive: true, force: true });
try {
  const cfg = JSON.stringify(path.join(__dirname, 'tsconfig.sim.json'));
  // execSync uses the platform shell, which is required to launch npx.cmd on Windows.
  execSync(`npx -y -p typescript@5.4.5 tsc -p ${cfg}`, { cwd: ROOT, stdio: 'pipe' });
} catch (err) {
  console.error('TypeScript compilation failed:\n' + String(err.stderr || err.stdout || err));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Minimal Hydro mocks.
// ---------------------------------------------------------------------------
function randomHex() {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

class ObjectId {
  constructor(value) {
    if (value instanceof ObjectId) this.hex = value.hex;
    else if (typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value)) this.hex = value.toLowerCase();
    else this.hex = randomHex();
  }
  toHexString() { return this.hex; }
  toString() { return this.hex; }
  valueOf() { return this.hex; }
  getTimestamp() { return new Date(parseInt(this.hex.slice(0, 8), 16) * 1000); }
}
function oidFromTime(ms) {
  return new ObjectId(Math.floor(ms / 1000).toString(16).padStart(8, '0') + '0000000000000000');
}

const PRIV = { PRIV_NONE: 0, PRIV_EDIT_SYSTEM: 2, PRIV_VIEW_ALL: 4 };

const keyOf = (v) => (v instanceof ObjectId || v instanceof Date ? String(v) : v);
function cmp(a, b) {
  const ka = keyOf(a); const kb = keyOf(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}
function matchOne(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;
  for (const [field, expected] of Object.entries(cond)) {
    const actual = doc[field];
    if (field === '$or') {
      if (!Array.isArray(expected) || !expected.some((c) => matchOne(doc, c))) return false;
      continue;
    }
    if (field === '$and') {
      if (!Array.isArray(expected) || !expected.every((c) => matchOne(doc, c))) return false;
      continue;
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected)
      && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      const ops = Object.keys(expected);
      for (const op of ops) {
        const val = expected[op];
        if (op === '$gte' && !(cmp(actual, val) >= 0)) return false;
        else if (op === '$lte' && !(cmp(actual, val) <= 0)) return false;
        else if (op === '$in' && !val.some((x) => keyOf(x) === keyOf(actual))) return false;
        else if (op === '$nin' && val.some((x) => keyOf(x) === keyOf(actual))) return false;
        else if (op === '$ne' && keyOf(val) === keyOf(actual)) return false;
        else if (op === '$bitsAllClear' && (Number(actual) & Number(val)) !== 0) return false;
        else if (op === '$regex' && !new RegExp(val, expected.$options || '').test(String(actual ?? ''))) return false;
        else if (op === '$all' && !val.every((x) => (actual || []).some((a) => keyOf(a) === keyOf(x)))) return false;
        else if (op === '$options') continue;
      }
      continue;
    }
    if (keyOf(actual) !== keyOf(expected)) return false;
  }
  return true;
}
const matchAll = (docs, filter) => (docs || []).filter((d) => matchOne(d, filter));

function evalCond(cond, doc) {
  if (Array.isArray(cond)) return cond.some((c) => evalCond(c, doc));
  if (!cond || typeof cond !== 'object') return !!cond;
  if (cond.$in && Array.isArray(cond.$in)) {
    const field = String(cond.$in[0]).replace(/^\$/, '');
    return cond.$in[1].some((v) => keyOf(v) === keyOf(doc[field]));
  }
  return !!cond;
}

function aggregate(docs, pipeline) {
  let out = docs.slice();
  for (const stage of pipeline || []) {
    if (stage.$match) out = matchAll(out, stage.$match);
    else if (stage.$unwind) {
      const field = String(stage.$unwind).replace(/^\$/, '');
      const next = [];
      for (const doc of out) {
        const value = doc[field];
        if (Array.isArray(value) && value.length) for (const item of value) next.push({ ...doc, [field]: item });
        else if (value !== undefined) next.push({ ...doc, [field]: value });
      }
      out = next;
    } else if (stage.$group) {
      const grouped = new Map();
      for (const doc of out) {
        let gk = stage.$group._id;
        if (typeof gk === 'string' && gk.startsWith('$')) gk = doc[gk.slice(1)];
        else if (gk && gk.$dateToString) {
          const raw = doc._id;
          const date = raw?.getTimestamp ? raw.getTimestamp() : new Date(raw || Date.now());
          gk = date.toISOString().slice(0, 10);
        }
        gk = String(gk);
        if (!grouped.has(gk)) grouped.set(gk, []);
        grouped.get(gk).push(doc);
      }
      out = Array.from(grouped.entries()).map(([gk, rows]) => {
        const result = { _id: gk };
        for (const [field, expr] of Object.entries(stage.$group)) {
          if (field === '_id') continue;
          if (expr && typeof expr === 'object' && expr.$sum !== undefined) {
            const sum = expr.$sum;
            if (typeof sum === 'number') result[field] = rows.length * sum;
            else if (sum && sum.$cond) result[field] = rows.filter((r) => evalCond(sum.$cond[0], r)).length * (sum.$cond[1] ?? 1);
            else if (typeof sum === 'string' && sum.startsWith('$')) {
              result[field] = rows.reduce((acc, r) => acc + (Number(r[sum.slice(1)]) || 0), 0);
            }
          } else if (typeof expr === 'number') result[field] = expr;
        }
        return result;
      });
    } else if (stage.$sort) {
      const [field, dir] = Object.entries(stage.$sort)[0];
      out.sort((a, b) => cmp(a[field], b[field]) * (dir === -1 ? -1 : 1));
    } else if (stage.$limit) out = out.slice(0, stage.$limit);
  }
  return out;
}

class Cursor {
  constructor(docs) { this.docs = docs.slice(); }
  project() { return this; }
  sort(spec) {
    const [field, dir] = Object.entries(spec)[0];
    this.docs.sort((a, b) => cmp(a[field], b[field]) * (dir === -1 ? -1 : 1));
    return this;
  }
  limit(n) { this.docs = this.docs.slice(0, n); return this; }
  skip(n) { this.docs = this.docs.slice(n); return this; }
  maxTimeMS() { return this; }
  async toArray() { return this.docs; }
}

const collections = {
  document: [], record: [], user: [], 'domain.user': [], 'user.group': [],
  aiws_settings: [], aiws_session: [], aiws_artifact: [], aiws_audit: [],
  aiws_profile: [], aiws_cache: [],
};
function makeColl(name) {
  const list = () => (collections[name] ||= []);
  return {
    find: (filter = {}) => new Cursor(matchAll(list(), filter)),
    findOne: async (filter = {}) => matchAll(list(), filter)[0] || null,
    countDocuments: async (filter = {}) => matchAll(list(), filter).length,
    aggregate: (pipeline = []) => new Cursor(aggregate(list(), pipeline)),
    createIndex: async () => 'index',
    insertOne: async (doc) => {
      const insertedId = doc._id ?? new ObjectId();
      list().push({ ...doc, _id: insertedId });
      return { insertedId };
    },
    updateOne: async (filter, update) => {
      const found = matchAll(list(), filter);
      if (!found.length) return { matchedCount: 0 };
      for (const doc of found) {
        if (update?.$set) Object.assign(doc, update.$set);
        if (update?.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
      }
      return { matchedCount: found.length };
    },
    deleteOne: async () => ({ deletedCount: 0 }),
  };
}
const mockDb = { collection: makeColl };

const contestId = oidFromTime(Date.now() - 3 * 86400000).toHexString();
const contestOid = new ObjectId(contestId);
const rid = oidFromTime(Date.now() - 3600000).toHexString();
const now = Date.now();
const recent = (minutes) => oidFromTime(now - minutes * 60000);

collections.document.push(
  { _id: oidFromTime(now - 30 * 86400000), domainId: 'test', docType: 10, docId: 1, pid: 'P1', title: '两数之和', tag: ['入门', '数组'], difficulty: 2, nSubmit: 100, nAccept: 40, content: '## 题目描述\n求两数之和。', data: [{ filename: '1.in' }, { filename: '1.out' }] },
  { _id: oidFromTime(now - 28 * 86400000), domainId: 'test', docType: 10, docId: 2, pid: 'P2', title: '最长子序列', tag: ['动态规划', '中等'], difficulty: 6, nSubmit: 80, nAccept: 12, content: '## 题目描述\n最长递增子序列。', data: [] },
  { _id: oidFromTime(now - 26 * 86400000), domainId: 'test', docType: 10, docId: 3, pid: '', title: '排序模板', tag: ['排序'], difficulty: 1, nSubmit: 50, nAccept: 30, content: '## 题目描述\n实现排序。', data: [] },
  { _id: contestOid, domainId: 'test', docType: 30, docId: 100, title: '测试赛', rule: 'acm', pids: [1, 2, 3], content: '测试说明', beginAt: new Date(now - 2 * 86400000), endAt: new Date(now + 86400000), hidden: false },
);
collections.record.push(
  { _id: new ObjectId(rid), domainId: 'test', uid: 42, pid: 1, status: 1, statusText: 'Accepted', lang: 'cpp', score: 100, time: 12, memory: 1024, code: '#include <bits/stdc++.h>\nint main(){}', compilerTexts: [], judgeTexts: [] },
  { _id: recent(120), domainId: 'test', uid: 42, pid: 2, status: 2, statusText: 'Wrong Answer', lang: 'cpp', score: 0, time: 30, memory: 2048, code: '#include <bits/stdc++.h>\nint main(){}', compilerTexts: [], judgeTexts: [] },
  { _id: recent(180), domainId: 'test', uid: 42, pid: 3, status: 9, statusText: 'Compile Error', lang: 'cpp', score: 0, time: 0, memory: 0, code: '#include <bits/stdc++.h>\nint main(){ undeclared x; }', compilerTexts: ['error: undeclared identifier'], judgeTexts: [] },
  { _id: recent(240), domainId: 'test', uid: 43, pid: 1, status: 1, lang: 'cpp', score: 100, code: 'int main(){}' },
);
collections.user.push(
  { _id: 1, uname: 'system', unameLower: 'system', priv: 0 },
  { _id: 2, uname: 'admin', unameLower: 'admin', priv: PRIV.PRIV_EDIT_SYSTEM },
  { _id: 42, uname: 'zhangsan', unameLower: 'zhangsan', priv: 1, regat: new Date(now - 10 * 86400000), loginat: new Date(now - 3600000) },
  { _id: 43, uname: 'lisi', unameLower: 'lisi', priv: 1, regat: new Date(now - 5 * 86400000), loginat: new Date(now - 7200000) },
);

const ContestModel = {
  RULES: { acm: {}, oi: {}, homework: {}, ioi: {}, ledo: {}, strictioi: {} },
  getMulti: (domainId, filter) => ({
    limit: (n) => ({ toArray: async () => matchAll(collections.document, { ...filter, docType: 30 }).slice(0, n) }),
    toArray: async () => matchAll(collections.document, { ...filter, docType: 30 }),
  }),
  get: async (domainId, oid) => matchAll(collections.document, { _id: oid, docType: 30 })[0] || null,
};
const hydroMock = { ObjectId, PRIV, PERM: {}, ContestModel, ProblemModel: {}, UserModel: {}, DomainModel: {}, Handler: class {}, requireSudo: () => () => {} };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'hydrooj') return hydroMock;
  return originalLoad.apply(this, arguments);
};
globalThis.Hydro = {
  model: {
    user: { coll: makeColl('user') },
    domain: { collUser: makeColl('domain.user'), getMultiUserInDomain: () => new Cursor([]) },
    builtin: { STATUS_SHORT_TEXTS: {}, STATUS_TEXTS: {}, PRIV, PERM: {} },
  },
};

const { state } = require('./.build/src/state.js');
state.db = mockDb;
state.ctx = { db: mockDb, setting: {} };

for (const file of ['problem', 'contest', 'user', 'analytics', 'profile', 'change']) {
  require(`./.build/src/tools/${file}.tools.js`);
}
const { invokeTool, getToolNames } = require('./.build/src/registry.js');
const { renderMarkdown } = require('./.build/frontend/markdown.js');

// ---------------------------------------------------------------------------
// 3. Common admin scenarios.
// ---------------------------------------------------------------------------
const ctx = {
  uid: 2, uname: 'admin', domainId: 'test', scopeId: 'test', sessionId: 'session',
  sudo: false, db: mockDb, user: { _id: 2, uname: 'admin' },
};
const auditLib = require('./.build/src/problem_audit.js');
const proposalLib = require('./.build/src/proposal.js');

const summaries = [];
const results = [];

function assert(condition, message) { if (!condition) throw new Error(message); }
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error.message || error) });
  }
}
async function call(name, args, overrides = {}) {
  const result = await invokeTool(name, args, { ...ctx, ...overrides });
  if (result.summary) summaries.push({ name, summary: result.summary });
  return result;
}

(async () => {
  await check('01 比赛列表摘要含比赛 ID', async () => {
    const r = await call('list_contests', { kind: 'all', limit: 5 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(new RegExp(`\\b${contestId}\\b`).test(r.summary), `摘要缺少比赛 ID：${r.summary}`);
    return r.summary;
  });

  await check('02 比赛题目摘要含 pid、难度与通过率', async () => {
    const r = await call('get_contest_problems', { tid: contestId });
    assert(r.ok, `工具失败：${r.summary}`);
    for (const pid of ['1', '2', '3']) assert(r.summary.includes(`${pid}｜`), `摘要缺少题目 ${pid}：${r.summary}`);
    assert(r.summary.includes('通过率'), '摘要缺少通过率');
    assert(r.summary.includes('get_problem_detail'), '摘要未说明如何继续查题面');
    return r.summary;
  });

  await check('03 用纯数字 pid 查题面', async () => {
    const r = await call('get_problem_detail', { pid: '2' });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('最长子序列'), `未匹配 docId：${r.summary}`);
    return r.summary;
  });

  await check('04 用字符串 pid 查题面', async () => {
    const r = await call('get_problem_detail', { pid: 'P1' });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('两数之和'), `未匹配 pid：${r.summary}`);
    return r.summary;
  });

  await check('05 搜题摘要含编号与标题', async () => {
    const r = await call('search_problems', { keyword: '子序列' });
    assert(r.ok && r.summary.includes('P2'), `摘要缺少编号：${r.summary}`);
    assert(r.summary.includes('docId=2'), `摘要缺少 docId 标注：${r.summary}`);
    assert(r.summary.includes('最长子序列'), '摘要缺少标题');
    return r.summary;
  });

  await check('06 用户检索摘要含 UID 与登录名', async () => {
    const r = await call('search_users', { keyword: 'zhang' });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('42') && r.summary.includes('zhangsan'), `摘要缺少 UID/登录名：${r.summary}`);
    return r.summary;
  });

  await check('07 get_user_info 返回用户资料而非档案', async () => {
    const r = await call('get_user_info', { uid: 42 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('zhangsan') && r.summary.includes('UID'), `工具被覆盖或返回错误内容：${r.summary}`);
    return r.summary;
  });

  await check('08 提交明细摘要含 rid、pid、结果与失败原因', async () => {
    const r = await call('query_user_submissions', { uid: 42, days: 30, limit: 20 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('提交ID(rid)'), `摘要缺少 rid 列头：${r.summary}`);
    assert(r.summary.includes(rid), `摘要缺少 24 位提交 ID，AI 将无法调用 get_submission：${r.summary}`);
    assert(/Compile Error|编译错误/.test(r.summary), `摘要缺少失败原因：${r.summary}`);
    assert(r.summary.includes('｜1｜'), '摘要缺少题目编号');
    return r.summary;
  });

  await check('09 用户分析摘要含常做题编号', async () => {
    const r = await call('analyze_user', { uid: 42, days: 30 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(/[1-3]｜/.test(r.summary), `摘要缺少题目编号：${r.summary}`);
    return r.summary;
  });

  await check('10 生成用户档案', async () => {
    const r = await call('refresh_user_profile', { uid: 42, days: 90 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('档案') || r.summary.includes('生成'), `摘要异常：${r.summary}`);
    assert(collections.aiws_profile.length === 1, '档案未写入集合');
    return r.summary;
  });

  await check('11 get_user_profile 档案摘要含刷过题目的编号', async () => {
    const r = await call('get_user_profile', { uid: 42 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('刷过题目编号'), `工具名可能被覆盖：${r.summary}`);
    return r.summary;
  });

  await check('12 写入 AI 个性化结论', async () => {
    const r = await call('update_profile_notes', { uid: 42, notes: '基础扎实，动态规划偏弱，建议先补一维 DP。' });
    assert(r.ok && collections.aiws_profile[0].aiNotes.includes('动态规划'), `结论未写入：${r.summary}`);
    return r.summary;
  });

  await check('13 未 sudo 时查看提交代码被拒绝', async () => {
    const r = await call('get_submission', { rid });
    assert(!r.ok && r.error === 'sudo_required', `sudo 校验失效：${JSON.stringify(r)}`);
    return r.summary;
  });

  await check('14 sudo 后摘要含提交代码正文（模型可见）', async () => {
    const r = await call('get_submission', { rid }, { sudo: true });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('#include <bits/stdc++.h>'), `摘要仍未回喂源码：${r.summary}`);
    assert(r.summary.includes('代码（模型可见'), '摘要缺少代码说明');
    return r.summary;
  });

  await check('14b CE 提交摘要含编译错误文本', async () => {
    const ce = collections.record.find((d) => d.status === 9);
    assert(ce, 'fixture 缺少 CE 提交');
    const r = await call('get_submission', { rid: ce._id.toHexString() }, { sudo: true });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('undeclared identifier'), `摘要缺少编译错误：${r.summary}`);
    assert(r.summary.includes('编译错误/提示'), '摘要缺少编译错误段');
    return r.summary;
  });

  await check('15 非法比赛 ID 被参数校验拦截', async () => {
    const r = await call('get_contest_problems', { tid: 'not-an-id' });
    assert(!r.ok, `非法参数未被拦截：${JSON.stringify(r)}`);
    return r.error || r.summary;
  });

  await check('16 工具名无重复（后注册会静默覆盖）', async () => {
    const found = [];
    const dir = path.join(ROOT, 'src', 'tools');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const match of text.matchAll(/name:\s*'([a-z_]+)'/g)) found.push({ name: match[1], file });
    }
    const byName = new Map();
    for (const item of found) {
      assert(!byName.has(item.name), `重复工具名 ${item.name}：${byName.get(item.name)} 与 ${item.file}`);
      byName.set(item.name, item.file);
    }
    assert(byName.size === getToolNames().length, '源码工具数与注册表不一致');
    return `${byName.size} 个工具名，无重名`;
  });

  await check('17 所有摘要长度不超过 2000 字', async () => {
    const tooLong = summaries.filter((s) => s.summary.length > 2000);
    assert(tooLong.length === 0, `过长摘要：${tooLong.map((s) => `${s.name}(${s.summary.length})`).join(', ')}`);
    return `${summaries.length} 条摘要，最长 ${Math.max(0, ...summaries.map((s) => s.summary.length))} 字`;
  });

  await check('18 模板未使用保留变量 model', async () => {
    for (const file of fs.readdirSync(path.join(ROOT, 'templates'))) {
      const text = fs.readFileSync(path.join(ROOT, 'templates', file), 'utf8');
      assert(!/\{\{\s*model\s*(\}\||\})/.test(text), `${file} 使用了保留变量 model`);
    }
    return '模板变量检查通过';
  });

  await check('19 对话历史只回放干净问答对', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'registry.ts'), 'utf8');
    assert(source.includes("msg.role !== 'user' && msg.role !== 'assistant'"), '历史回放逻辑被改动，可能重现 DeepSeek 400');
    assert(source.includes('msg.tool_call_id || msg.name'), '未过滤残留 tool 消息');
    return '历史回放检查通过';
  });

  await check('20 Markdown 表格正确渲染', async () => {
    const html = renderMarkdown('| 编号 | 标题 |\n|---|---|\n| 10921 | 数字选取 |\n| 10898 | 纪念品分组 |');
    assert(html.includes('<table class="aiws__md-table">'), '未生成表格元素');
    assert(html.includes('<th>编号</th>') && html.includes('<th>标题</th>'), '表头缺失');
    assert(html.includes('<td>10921</td>') && html.includes('<td>数字选取</td>'), '表格数据缺失');
    assert(!html.includes('|---'), '分隔行被当成数据渲染');
    return html.slice(0, 160);
  });

  await check('21 Markdown 渲染转义 HTML 注入', async () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n**加粗** 与 `代码`');
    assert(!html.includes('<script>'), '存在脚本注入风险');
    assert(html.includes('&lt;script&gt;'), '原始标签未被转义');
    assert(html.includes('<strong>加粗</strong>') && html.includes('<code>代码</code>'), '行内格式丢失');
    return 'HTML 已转义，行内格式正常';
  });

  await check('22 从提交记录反查提交者 UID（无需猜用户）', async () => {
    const r = await call('list_recent_submitters', { days: 7 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('42｜zhangsan'), `摘要缺少有提交的用户：${r.summary}`);
    assert(/42｜zhangsan｜\d+次\/AC\d+%/.test(r.summary), `摘要缺少提交数/AC：${r.summary}`);
    assert(r.summary.includes('query_user_submissions'), '摘要未给出下一步工具');
    return r.summary;
  });

  await check('23 全站用户 UID 清单分页且带近期提交数', async () => {
    const r = await call('list_users', { offset: 0, limit: 50, days: 7 });
    assert(r.ok, `工具失败：${r.summary}`);
    assert(r.summary.includes('42｜zhangsan'), `摘要缺少 UID/登录名：${r.summary}`);
    assert(/42｜zhangsan｜[1-9]\d*次/.test(r.summary), `摘要缺少近期提交数：${r.summary}`);
    assert(r.summary.includes('offset'), '未提示可翻页');
    const page2 = await call('list_users', { offset: 1, limit: 1, days: 7 });
    assert(page2.ok && !page2.summary.includes('42｜'), 'offset 分页未生效');
    return r.summary;
  });

  await check('24 GESP 级别识别（标题与题面）', async () => {
    assert(auditLib.detectGespLevel('[GESP202509 五级] 数字选取') === 'GESP五级', '方括号标题未识别');
    assert(auditLib.detectGespLevel('2026年3月GESP一级真题') === 'GESP一级', '中文年月未识别');
    assert(auditLib.detectGespLevel('普通题目') === '', '普通题误判为 GESP');
    return 'GESP 级别识别正确';
  });

  await check('25 知识点识别（循环/旗帜法/贪心/二分）', async () => {
    const found = auditLib.detectKnowledge('使用 for 循环与旗帜法标记，再用贪心和二分查找求解');
    for (const tag of ['循环结构', '旗帜法', '贪心', '二分']) assert(found.includes(tag), `缺少知识点 ${tag}：${found.join(',')}`);
    return found.join('、');
  });

  await check('26 题面级查重（标题不同但题面相同）', async () => {
    const a = auditLib.normalizeContent('第一行 1 2 3\n第二行 for 循环');
    const b = auditLib.normalizeContent('第一行，1、2、3。第二行 for 循环！');
    assert(a === b, `归一化失败：${a} != ${b}`);
    assert(auditLib.similarity(new Set(a.split('')), new Set(b.split(''))) > 0.9, '相似度计算异常');
    return `归一化题面长度 ${a.length}`;
  });

  await check('27 清单令牌校验（sudo/过期/错令牌/越权）', async () => {
    const doc = {
      uid: 42, uname: 'zhangsan', domainId: 'test', kind: 'update_tags', status: 'pending',
      token: 'abc123', summary: '', items: [], createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    };
    assert(proposalLib.validateConfirm(doc, 'abc123', 42, true) === '', '合法确认被拒绝');
    assert(proposalLib.validateConfirm(doc, 'wrong', 42, true).includes('令牌'), '错令牌未被拦截');
    assert(proposalLib.validateConfirm(doc, 'abc123', 42, false).includes('sudo'), '无 sudo 未被拦截');
    assert(proposalLib.validateConfirm(doc, 'abc123', 43, true).includes('无权'), '越权未被拦截');
    doc.expiresAt = new Date(Date.now() - 1000);
    assert(/过期|有效期/.test(proposalLib.validateConfirm(doc, 'abc123', 42, true)), '过期未被拦截');
    return '令牌校验五项通过';
  });

  await check('28 propose_* 工具只生成清单不改题库', async () => {
    const before = JSON.stringify(collections.document);
    const r = await call('suggest_problem_tags', { limit: 200 });
    assert(r.ok, `标签分析失败：${r.summary}`);
    assert(JSON.stringify(collections.document) === before, '只读分析竟然修改了题库');
    return r.summary.slice(0, 120);
  });

  await check('29 题面正文必须出现在工具摘要中（模型可见）', async () => {
    // Regression guard: the model can only read `summary`; a tool that puts the
    // statement only in `data` makes the AI claim it "cannot get the text".
    const a = await call('get_problem_detail', { pid: 'P1' });
    assert(a.ok, `get_problem_detail 失败：${a.summary}`);
    assert(a.summary.includes('求两数之和'), `摘要缺少题面正文：${a.summary.slice(0, 160)}`);
    assert(a.summary.includes('pid=P1') && a.summary.includes('docId=1'), '摘要缺少 pid/docId 标注');

    const b = await call('get_problem_full', { pid: 'P1' });
    assert(b.ok, `get_problem_full 失败：${b.summary}`);
    assert(b.summary.includes('求两数之和'), `get_problem_full 摘要缺少题面：${b.summary.slice(0, 160)}`);
    assert(!/完整题面已在摘要中/.test(b.summary) || b.summary.includes('求两数之和'), '摘要谎称含题面但实际没有');

    // Problem without a custom pid: the number is a docId and must still work.
    const c = await call('get_problem_detail', { pid: '3' });
    assert(c.ok && c.summary.includes('实现排序'), `无 pid 题目读取失败：${c.summary.slice(0, 160)}`);
    return '题面正文已进入摘要，pid/docId 均已标注';
  });

  const passed = results.filter((r) => r.ok).length;
  console.log('\n=== 模拟测试结果 ===');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${String(r.detail).slice(0, 220)}` : ''}`);
  }
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
