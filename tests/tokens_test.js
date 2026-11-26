/**
 * Regression tests for the "missing title" failure: it was caused by a 2048
 * max_tokens cap truncating large tool-call payloads, and by the parser
 * silently turning broken JSON into {}.
 */
'use strict';
const path = require('path');
const Module = require('module');

// registry -> session -> hydrooj; stub it for offline runs.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'hydrooj') {
    return {
      ObjectId: class { constructor() {} toHexString() { return '0'.repeat(24); } },
      PRIV: {}, PERM: {}, ContestModel: {}, ProblemModel: {}, UserModel: {},
      DomainModel: {}, Handler: class {}, requireSudo: () => () => {},
    };
  }
  return originalLoad.apply(this, arguments);
};

const { state } = require(path.join(__dirname, '.build/src/state.js'));
const ds = require(path.join(__dirname, '.build/src/deepseek.js'));

function assert(c, m) { if (!c) throw new Error(m); }

// Minimal DB so settings lookups never throw.
state.db = {
  collection: () => ({
    findOne: async () => null,
    updateOne: async () => ({}),
    insertOne: async () => ({ insertedId: 1 }),
  }),
};

const baseSettings = { apiBase: 'https://api.deepseek.com', model: 'deepseek-chat' };
let captured = null;

function mockReply(payload) {
  global.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => payload };
  };
}

(async () => {
  // 1. Default output budget must be large enough for a whole package.
  mockReply({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  await ds.deepseekChat({ messages: [{ role: 'user', content: 'hi' }], settings: baseSettings, apiKey: 'k' });
  assert(captured.max_tokens === 8192, `默认 max_tokens 应为 8192，实际 ${captured.max_tokens}`);
  console.log('PASS 默认 max_tokens = 8192（旧版 2048 会截断题包）');

  // 2. Custom budget is honoured and clamped to the provider ceiling.
  mockReply({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  await ds.deepseekChat({ messages: [{ role: 'user', content: 'hi' }], settings: { ...baseSettings, maxTokens: 4096 }, apiKey: 'k' });
  assert(captured.max_tokens === 4096, `自定义 max_tokens 未生效：${captured.max_tokens}`);
  mockReply({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  await ds.deepseekChat({ messages: [{ role: 'user', content: 'hi' }], settings: { ...baseSettings, maxTokens: 999999 }, apiKey: 'k' });
  assert(captured.max_tokens === 8192, `超限应截到 8192，实际 ${captured.max_tokens}`);
  console.log('PASS max_tokens 可配置并限制在 8192 以内');

  // 3. Truncated tool-call JSON must raise a clear error, not silently {}.
  mockReply({
    choices: [{
      message: {
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'add_problem_draft', arguments: '{"title":"A","content":"很长很长的题面' },
        }],
      },
      finish_reason: 'length',
    }],
  });
  let err = null;
  try {
    await ds.deepseekChat({ messages: [{ role: 'user', content: 'go' }], settings: baseSettings, apiKey: 'k' });
  } catch (e) { err = e; }
  assert(err, '截断的 JSON 应抛错，不应静默返回 {}');
  assert(err.name === 'ToolArgsParseError', `应为 ToolArgsParseError，实际 ${err.name}`);
  assert(/截断|max_tokens/.test(err.message), `错误信息应指明截断原因：${err.message}`);
  console.log('PASS 截断的 tool-call JSON 明确报错（不再误报“缺少 title”）');

  // 4. Malformed (not truncated) JSON also surfaces a clear error.
  mockReply({
    choices: [{
      message: { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'x', arguments: '{bad json}' } }] },
      finish_reason: 'stop',
    }],
  });
  let err2 = null;
  try {
    await ds.deepseekChat({ messages: [{ role: 'user', content: 'go' }], settings: baseSettings, apiKey: 'k' });
  } catch (e) { err2 = e; }
  assert(err2 && err2.name === 'ToolArgsParseError', '格式错误的 JSON 也应明确报错');
  console.log('PASS 格式错误的参数 JSON 明确报错');

  // 5. Missing required args message lists what was received (helps diagnose).
  process.env.HYDRO_AI_DEEPSEEK_KEY = 'k';
  const registry = require(path.join(__dirname, '.build/src/registry.js'));
  require(path.join(__dirname, '.build/src/tools/change.tools.js'));
  const r = await registry.invokeTool('add_problem_draft', { constraints: '1≤n≤10' }, {
    uid: 1, uname: 'admin', domainId: 'test', scopeId: 'test', sessionId: 's', sudo: true, db: state.db, user: {},
  });
  assert(!r.ok, '缺参数应失败');
  assert(/缺少必填参数/.test(r.error || ''), `错误应指出缺参数：${r.error}`);
  assert(/实际收到/.test(r.error || ''), `错误应列出已收到字段：${r.error}`);
  assert(/max_tokens|截断/.test(r.error || ''), `错误应提示可能是截断：${r.error}`);
  console.log('PASS 缺参数报错含“收到哪些字段 + 可能截断”提示');

  console.log('\n全部通过');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
