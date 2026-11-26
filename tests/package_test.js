/**
 * Standard problem package: category coverage, config generation, restricted
 * runner (including generator-produced large input), and the import path.
 */
'use strict';
const path = require('path');
const B = (f) => require(path.join(__dirname, '.build/src', f));
const pkgLib = B('problem_package.js');
const { state } = B('state.js');
const executor = B('executor.js');

function assert(c, m) { if (!c) throw new Error(m); }

const SUM_SOLUTION = [
  'import sys',
  'data = sys.stdin.read().split()',
  'n = int(data[0])',
  'a = list(map(int, data[1:1+n]))',
  'print(sum(a))',
  '',
].join('\n');

const BASE = {
  title: '数组求和', content: '给定 n 个整数，输出它们的和。第一行 n，第二行 n 个整数。'.repeat(2),
  constraints: '1≤n≤100000，-10^9≤a_i≤10^9',
  tags: ['GESP二级', '循环结构'], timeLimit: '1s', memoryLimit: '256m',
  score: 100, referenceLang: 'python', referenceCode: SUM_SOLUTION,
  samples: [{ input: '3\n1 2 3\n', output: '6\n' }],
};

const GOOD_DATA = [
  { category: 'boundary', purpose: 'n=1 最小规模', input: '1\n5\n' },
  { category: 'boundary', purpose: 'n=2 临界', input: '2\n-1 1\n' },
  { category: 'extreme', purpose: 'n=100000 极限规模', generator: 'n = 100000\nprint(n)\nprint(" ".join(["1"] * n))\n' },
  { category: 'tricky', purpose: '全为负数，检查符号处理', input: '3\n-1 -2 -3\n' },
  { category: 'normal', purpose: '典型中等规模', input: '5\n1 2 3 4 5\n' },
  { category: 'special', purpose: '全部为 0', input: '4\n0 0 0 0\n' },
];

(async () => {
  // --- validation ---
  assert(!pkgLib.validatePackage({ title: 'x', content: 'short' }).ok, '过短题面应被拒');
  assert(!pkgLib.validatePackage({ ...BASE, timeLimit: '10秒', testData: GOOD_DATA }).ok, '非法时限应被拒');

  const missingCat = GOOD_DATA.filter((d) => d.category !== 'extreme');
  const vMissing = pkgLib.validatePackage({ ...BASE, testData: missingCat });
  assert(!vMissing.ok, '缺极限类应被拒');
  assert(vMissing.errors.some((e) => e.includes('极限')), '错误信息应指出缺极限: ' + vMissing.errors.join(';'));

  const tooFew = GOOD_DATA.slice(0, 3).concat([{ category: 'extreme', purpose: 'x', input: '1\n1\n' }]);
  const vFew = pkgLib.validatePackage({ ...BASE, testData: tooFew });
  assert(!vFew.ok, '数据过少应被拒');

  const v = pkgLib.validatePackage({ ...BASE, testData: GOOD_DATA });
  assert(v.ok, '合法题包应通过: ' + v.errors.join(';'));
  assert(v.pkg.testData.length === 6, '应保留 6 个测试数据');
  assert(pkgLib.coverageText(v.pkg.testData).includes('边界2'), '覆盖率统计错误: ' + pkgLib.coverageText(v.pkg.testData));
  console.log('PASS 分类覆盖校验（缺类别/数量不足均拦截）');

  // --- backward compatibility: old testInputs still parsed ---
  const legacy = pkgLib.validatePackage({ ...BASE, testData: undefined, testInputs: ['1\n1\n'] });
  assert(!legacy.ok, '旧 testInputs 不满足分类覆盖，应被拒（提示补数据）');
  assert(legacy.pkg.testData.length === 1, '旧 testInputs 应被解析为 1 条 normal');
  console.log('PASS 旧 testInputs 兼容解析（但需补齐分类）');

  // --- config.yaml ---
  const cfg = pkgLib.buildConfigYaml(v.pkg, 7);
  assert(cfg.includes('time: 1s') && cfg.includes('memory: 256m'), 'config 缺时限/内存');
  const scores = [...cfg.matchAll(/score: (\d+)/g)].map((m) => Number(m[1]));
  assert(scores.length === 7 && scores.reduce((a, b) => a + b, 0) === 100, '分数总和应为 100');
  console.log('PASS config.yaml（7 个测试点，分数总和 100）');

  // --- runner: samples + categorised data + generator ---
  const runner = B('solution_runner.js');
  const r1 = await runner.buildCases(v.pkg);
  assert(r1.passedSamples === true, '参考程序应通过样例校验: ' + JSON.stringify(r1.logs));
  assert(r1.generated === 6, '应生成 6 个分类数据，实际 ' + r1.generated + ' / ' + JSON.stringify(r1.warnings));
  const extreme = r1.cases.find((c) => c.category === 'extreme');
  assert(extreme, '缺少极限数据');
  assert(extreme.input.split('\n')[0] === '100000', '极限数据规模应为 100000，实际 ' + extreme.input.split('\n')[0]);
  assert(pkgLib.normalizeOutput(extreme.output) === '100000', '极限输出应为 100000，实际 ' + extreme.output);
  const tricky = r1.cases.find((c) => c.category === 'tricky');
  assert(pkgLib.normalizeOutput(tricky.output) === '-6', '负数求和应为 -6');
  assert(r1.cases.some((c) => c.category === 'sample'), '样例应保留为测试点');
  assert(r1.cases.every((c) => c.purpose), '每个测试点都应有 purpose');
  console.log('PASS 生成器产出 10 万规模极限数据并真实计算输出');

  // --- wrong solution rejected ---
  const bad = { ...v.pkg, referenceCode: 'print(9999)\n' };
  const r2 = await runner.buildCases(bad);
  assert(r2.passedSamples === false && r2.generated === 0, '错误题解必须被拒');
  assert(r2.warnings.some((w) => w.includes('不一致')), '应有明确警告');
  console.log('PASS 错误题解被拦截');

  // --- generator failure is skipped, others survive ---
  const withBadGen = {
    ...v.pkg,
    testData: GOOD_DATA.map((d) => (d.category === 'extreme'
      ? { category: 'extreme', purpose: '坏生成器', generator: 'raise RuntimeError("boom")\n' }
      : d)),
  };
  const r3 = await runner.buildCases(withBadGen);
  assert(r3.generated === 5, '坏生成器应只跳过该项，实际生成 ' + r3.generated);
  assert(r3.warnings.some((w) => w.includes('生成器运行失败')), '应提示生成器失败');
  console.log('PASS 生成器失败仅跳过该项');

  // --- infinite loop times out ---
  const hang = { ...v.pkg, referenceCode: 'while True: pass\n' };
  const t0 = Date.now();
  const r4 = await runner.buildCases(hang);
  assert(Date.now() - t0 < 10000, '死循环应被超时终止');
  assert(r4.generated === 0, '超时不应生成数据');
  console.log('PASS 死循环题解被超时终止（' + (Date.now() - t0) + 'ms）');

  // --- import with mocked ProblemModel ---
  const created = { added: [], testdata: [], edited: [] };
  global.Hydro = { model: { problem: {
    async add(domainId, pid, title, content, owner, tag, meta) {
      created.added.push({ title, tag, meta });
      return 12345;
    },
    async addTestdata(domainId, docId, name, buf) { created.testdata.push({ name, text: buf.toString('utf8') }); },
    async edit(domainId, docId, patch) { created.edited.push(patch); },
    async del() { created.deleted = true; },
  } } };
  const doc = { uid: 42, uname: 'admin', domainId: 'system', kind: 'add_problems', items: [{ title: '数组求和', pkg: v.pkg }] };
  const out = await executor.executeProposal(doc, [0]);
  assert(out.ok === 1 && out.failed === 0, '入库应成功: ' + JSON.stringify(out.details));
  assert(created.added[0].meta.hidden === true, '新题必须默认隐藏');
  assert(created.testdata.some((f) => f.name === 'config.yaml'), '应写 config.yaml');
  assert(created.testdata.filter((f) => f.name.endsWith('.in')).length === 7, '应有 7 个 .in（1 样例 + 6 分类）');
  assert(created.testdata.some((f) => f.name.endsWith('.in') && f.text.split('\n')[0] === '100000'), '极限数据应写入');
  console.log('PASS 真实入库（7 个测试点 + config + 默认隐藏）');

  // --- rollback ---
  created.testdata.length = 0; created.deleted = false;
  global.Hydro.model.problem.addTestdata = async () => { throw new Error('storage down'); };
  const out2 = await executor.executeProposal(doc, [0]);
  assert(out2.failed === 1 && created.deleted === true, '写入失败应回滚删题');
  console.log('PASS 写入失败回滚建题');

  // === existing target: write onto an existing problem, never create ===
  const ex = { added: 0, testdata: [], removed: [], deleted: 0, edited: 0 };
  let addTestdataFails = false;
  global.Hydro.model.problem = {
    async add() { ex.added++; return 999; },
    async get(domainId, pid) {
      if (String(pid) === 'B4579') {
        return { docId: 777, pid: 'B4579', title: '新汉诺塔',
          data: [{ name: '1.in' }, { name: '1.out' }, { name: '2.in' }, { name: '2.out' }, { name: 'legacy.txt' }] };
      }
      return null;
    },
    async addTestdata(domainId, docId, name, buf) {
      if (addTestdataFails) throw new Error('storage down');
      ex.testdata.push({ docId, name });
    },
    async delTestdata(domainId, docId, names) { ex.removed.push(...names); },
    async edit() { ex.edited++; },
    async del() { ex.deleted++; },
  };
  const exPkg = { ...v.pkg, target: { mode: 'existing', pid: 'B4579' } };
  const exDoc = { uid: 42, uname: 'admin', domainId: 'system', kind: 'add_problems', items: [{ title: '新汉诺塔', pkg: exPkg }] };
  const out3 = await executor.executeProposal(exDoc, [0]);
  assert(out3.ok === 1, '写原题应成功: ' + JSON.stringify(out3.details));
  assert(ex.added === 0, '绝不应新建题目，实际 add 调用 ' + ex.added);
  assert(ex.testdata.length === 15, '应写 7 组 in/out + config = 15 个文件，实际 ' + ex.testdata.length);
  assert(ex.testdata.every((f) => f.docId === 777), '文件应写到原题 docId 777');
  assert(ex.removed.includes('legacy.txt'), '应清理多余旧文件 legacy.txt');
  assert(!ex.removed.includes('1.in'), '不应删除会被新数据覆盖的 1.in');
  assert(ex.deleted === 0, '绝不能删除原题');
  assert(out3.details[0].mode === 'existing' && out3.details[0].docId === 777, '结果应标明写入原题');
  console.log('PASS 写入原题：不新建、写到 docId 777、只清理多余旧文件');

  // --- existing target: write failure must not delete or wipe the original ---
  addTestdataFails = true;
  ex.testdata.length = 0; ex.removed.length = 0; ex.deleted = 0;
  const out4 = await executor.executeProposal(exDoc, [0]);
  assert(out4.failed === 1, '写入失败应记 failed');
  assert(ex.deleted === 0, '写原题失败时绝不能删除原题');
  assert(ex.removed.length === 0, '写失败时不应清理旧文件');
  console.log('PASS 写原题失败：不删原题、不清理旧数据');

  // --- existing target missing -> clear error ---
  addTestdataFails = false;
  const missDoc = { ...exDoc, items: [{ title: 'x', pkg: { ...v.pkg, target: { mode: 'existing', pid: 'NOT_EXIST' } } }] };
  const out5 = await executor.executeProposal(missDoc, [0]);
  assert(out5.failed === 1, '目标不存在应失败');
  assert(String(out5.details[0].error).includes('找不到'), '应提示找不到题目: ' + out5.details[0].error);
  assert(ex.added === 0, '目标不存在时也不应新建');
  console.log('PASS 目标题目不存在时明确报错且不新建');

  console.log('\n全部通过');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
