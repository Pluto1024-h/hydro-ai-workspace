/**
 * Verifies per-item selection: only checked items execute, invalid indices are
 * rejected, and skipped items are recorded for audit.
 */
'use strict';
const path = require('path');
const { normalizeSelection } = require(path.join(__dirname, '.build/src/executor.js'));
const { executeProposal } = require(path.join(__dirname, '.build/src/executor.js'));
const { state } = require(path.join(__dirname, '.build/src/state.js'));

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  // --- normalizeSelection ---
  assert(JSON.stringify(normalizeSelection(3, undefined)) === '[0,1,2]', '未传应视为全选');
  assert(JSON.stringify(normalizeSelection(3, [2, 0, 2])) === '[0,2]', '应去重并排序');
  for (const bad of [[-1], [3], [1.5], ['1x'], 'notarray', [999]]) {
    let threw = false;
    try { normalizeSelection(3, bad); } catch { threw = true; }
    assert(threw, `非法索引未拦截: ${JSON.stringify(bad)}`);
  }
  assert(JSON.stringify(normalizeSelection(3, [])) === '[]', '空选择应返回空数组');
  console.log('PASS 索引规范化与越界拦截');

  // --- executeProposal with a subset ---
  const deleted = [], edited = [];
  state.Hydro = undefined;
  global.Hydro = { model: { problem: {
    del: async (domainId, docId) => { deleted.push(docId); },
    edit: async (domainId, docId, patch) => { edited.push({ docId, tag: patch.tag }); },
  } } };

  const delDoc = {
    domainId: 'd', kind: 'delete_duplicates',
    items: [
      { group: 'G1', members: [{ docId: 11, pid: 'A' }, { docId: 12, pid: 'B' }] },
      { group: 'G2', members: [{ docId: 21, pid: 'C' }, { docId: 22, pid: 'D' }, { docId: 23, pid: 'E' }] },
      { group: 'G3', members: [{ docId: 31, pid: 'F' }, { docId: 32, pid: 'G' }] },
    ],
  };
  const r1 = await executeProposal(delDoc, [1]);
  assert(JSON.stringify(deleted) === '[22,23]', `只应删第2组，实际 ${JSON.stringify(deleted)}`);
  assert(r1.executed === 1 && r1.skipped === 2 && r1.total === 3, '计数错误');
  assert(r1.skippedItems.length === 2, '跳过项未记录');
  assert(r1.ok === 2 && r1.failed === 0, '执行结果错误');
  console.log('PASS 仅执行勾选组，未勾选组完全不动');

  deleted.length = 0;
  const r2 = await executeProposal(delDoc, [0, 2]);
  assert(JSON.stringify(deleted) === '[12,32]', `实际删除 ${JSON.stringify(deleted)}`);
  assert(r2.skippedItems.length === 1, '跳过项计数错误');
  console.log('PASS 多组勾选');

  const tagDoc = {
    domainId: 'd', kind: 'update_tags',
    items: [
      { docId: 1, pid: 'P1', suggestedTags: ['a'] },
      { docId: 2, pid: 'P2', suggestedTags: ['b'] },
    ],
  };
  edited.length = 0;
  const r3 = await executeProposal(tagDoc, [1]);
  assert(edited.length === 1 && edited[0].docId === 2, '标签只应改选中题');
  assert(r3.skipped === 1, '标签跳过计数错误');
  console.log('PASS 标签优化仅执行选中项');

  // Backward-compatible full execution when selection omitted.
  deleted.length = 0;
  const r4 = await executeProposal(delDoc);
  assert(deleted.length === 4, `全选应删4题，实际 ${deleted.length}`);
  assert(r4.skipped === 0, '全选不应有跳过');
  console.log('PASS 不传 selected 时向后兼容全选');

  console.log('\n全部通过');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
