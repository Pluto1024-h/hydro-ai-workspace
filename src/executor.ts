/** Executes a confirmed proposal. Never called by the AI directly. */
import { getModel } from './state';
import type { ProposalDoc } from './proposal';
import { validatePackage, buildTestdataFiles, type ProblemPackage } from './problem_package';
import { buildCases } from './solution_runner';

export interface ExecOutcome {
  ok: number;
  failed: number;
  details: any[];
  total: number;
  executed: number;
  skipped: number;
  selectedIndices: number[];
  skippedItems: any[];
}

/**
 * Validate and normalise the checked item indices coming from the browser.
 * Never trust the client: indices must be integers inside [0, count).
 * Missing selection means "select all" for backwards compatibility.
 */
export function normalizeSelection(count: number, raw: any): number[] {
  if (raw === undefined || raw === null) return Array.from({ length: count }, (_, i) => i);
  if (!Array.isArray(raw)) throw new Error('勾选项格式不正确');
  const set = new Set<number>();
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n >= count) throw new Error('勾选项包含无效索引');
    set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

function briefItem(item: any): any {
  return {
    docId: item?.docId,
    pid: item?.pid,
    title: item?.title,
    group: item?.group,
    memberPids: Array.isArray(item?.members) ? item.members.map((m: any) => m?.pid) : undefined,
  };
}

export async function executeProposal(doc: ProposalDoc, selected?: number[]): Promise<ExecOutcome> {
  const total = doc.items.length;
  const indices = selected === undefined
    ? Array.from({ length: total }, (_, i) => i)
    : selected;
  const chosenSet = new Set(indices);
  const outcome: ExecOutcome = {
    ok: 0, failed: 0, details: [], total,
    executed: indices.length,
    skipped: total - indices.length,
    selectedIndices: indices.slice(),
    skippedItems: doc.items
      .map((item, i) => ({ item, i }))
      .filter(({ i }) => !chosenSet.has(i))
      .map(({ item }) => briefItem(item)),
  };
  const items = indices.map((i) => doc.items[i]).filter(Boolean);
  const ProblemModel = getModel('problem');
  if (!ProblemModel) throw new Error('无法获取题目模型（Hydro 未加载）');

  if (doc.kind === 'delete_duplicates') {
    for (const group of items) {
      const members = Array.isArray(group.members) ? group.members : [];
      // Keep the first problem of each group; delete the rest.
      for (const member of members.slice(1)) {
        const docId = Number(member.docId);
        try {
          if (!docId || docId <= 0) throw new Error('缺少有效 docId');
          await ProblemModel.del(doc.domainId, docId);
          outcome.ok++;
          outcome.details.push({ docId, pid: member.pid, action: 'deleted', ok: true });
        } catch (e: any) {
          outcome.failed++;
          outcome.details.push({ docId, pid: member.pid, action: 'deleted', ok: false, error: String(e?.message || e).slice(0, 200) });
        }
      }
    }
    return outcome;
  }

  if (doc.kind === 'update_tags') {
    for (const item of items) {
      const docId = Number(item.docId);
      try {
        if (!docId || docId <= 0) throw new Error('缺少有效 docId');
        const tags = Array.isArray(item.suggestedTags) ? item.suggestedTags.map(String).slice(0, 12) : [];
        if (!tags.length) throw new Error('建议标签为空');
        await ProblemModel.edit(doc.domainId, docId, { tag: tags });
        outcome.ok++;
        outcome.details.push({ docId, pid: item.pid, action: 'tags', tags, ok: true });
      } catch (e: any) {
        outcome.failed++;
        outcome.details.push({ docId, pid: item.pid, action: 'tags', ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    }
    return outcome;
  }

  // add_problems: create real problems from validated standard packages.
  // Outputs are computed by running the reference program; nothing is invented.
  for (const item of items) {
    const v = validatePackage(item?.pkg || {});
    if (!v.ok) {
      outcome.failed++;
      outcome.details.push({ title: item?.title, action: 'import', ok: false, error: `题包校验失败：${v.errors.join('；')}` });
      continue;
    }
    const pkg: ProblemPackage = v.pkg;
    try {
      const created = await importProblem(doc, pkg);
      outcome.ok++;
      outcome.details.push({
        title: pkg.title, action: created.mode === 'existing' ? 'update_testdata' : 'create', ok: true,
        docId: created.docId, pid: created.pid, mode: created.mode,
        cases: created.caseCount, generated: created.generated,
        removed: created.removed, warnings: created.warnings,
      });
    } catch (e: any) {
      outcome.failed++;
      outcome.details.push({ title: pkg.title, action: 'import', ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return outcome;
}

/**
 * Write one package's testdata. Two modes:
 *  - new: create a hidden problem via ProblemModel.add.
 *  - existing: write onto an existing problem (pid/docId given), replacing its
 *    testdata. New files are written FIRST and stale files removed only after
 *    that succeeds, so a mid-way failure never wipes the original data.
 */
async function importProblem(doc: ProposalDoc, pkg: ProblemPackage): Promise<{
  docId: number; pid: string; caseCount: number; generated: number;
  warnings: string[]; mode: 'new' | 'existing'; removed: number;
}> {
  const ProblemModel = getModel('problem');
  if (!ProblemModel?.add || !ProblemModel.addTestdata || !ProblemModel.edit) {
    throw new Error('题目模型缺少 add/addTestdata/edit，Hydro 版本不兼容');
  }
  const run = await buildCases(pkg);
  const files = buildTestdataFiles(pkg, run.cases);
  const warnings = [...run.warnings];

  let id: number;
  let pid = '';
  let mode: 'new' | 'existing' = 'new';
  let oldNames: string[] = [];

  if (pkg.target?.mode === 'existing' && String(pkg.target.pid || '').trim()) {
    mode = 'existing';
    const target = String(pkg.target.pid).trim();
    const found = await ProblemModel.get(doc.domainId, target);
    if (!found) throw new Error(`题库中找不到题目「${target}」，请确认编号后重试（不要为此新建重复题）`);
    id = Number(found.docId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('目标题目 docId 无效');
    pid = String(found.pid || id);
    oldNames = (Array.isArray(found.data) ? found.data : [])
      .map((f: any) => String(f?.name || '')).filter(Boolean);
  } else {
    // ProblemModel.add returns the numeric docId (document.add: docId || insertedId).
    const createdDocId = await ProblemModel.add(
      doc.domainId, '', pkg.title, pkg.content, doc.uid, pkg.tags,
      { hidden: true },
    );
    id = Number(createdDocId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('建题返回的 docId 无效');
    pid = String(id);
  }

  const written: string[] = [];
  try {
    for (const f of files) {
      await ProblemModel.addTestdata(doc.domainId, id, f.name, Buffer.from(f.content, 'utf8'), doc.uid);
      written.push(f.name);
    }
    // addTestdata('config.yaml') triggers Hydro's hook that writes pdoc.config.
    // Set it explicitly as a fallback in case that hook is unavailable.
    const cfg = files.find((f) => f.name === 'config.yaml');
    if (cfg) await ProblemModel.edit(doc.domainId, id, { config: cfg.content });
  } catch (e) {
    if (mode === 'new') {
      // Remove the half-created problem so no broken entry stays in the bank.
      try { await ProblemModel.del(doc.domainId, id); } catch { /* best effort */ }
      throw new Error(`写入测试数据失败（已回滚建题）：${String((e as any)?.message || e).slice(0, 180)}`);
    }
    // Existing problem: never delete it. Remove only the newly added files that
    // did not exist before, so the original testdata stays as intact as possible.
    const added = written.filter((n) => !oldNames.includes(n));
    if (added.length && ProblemModel.delTestdata) {
      try { await ProblemModel.delTestdata(doc.domainId, id, added, doc.uid); } catch { /* best effort */ }
    }
    throw new Error(`写入原题测试数据失败（已尽力回滚新文件，原题数据保留）：${String((e as any)?.message || e).slice(0, 160)}`);
  }

  // Only after a successful write, drop stale files the new set no longer uses.
  let removed = 0;
  if (mode === 'existing' && oldNames.length && ProblemModel.delTestdata) {
    const keep = new Set(files.map((f) => f.name));
    const stale = oldNames.filter((n) => !keep.has(n));
    if (stale.length) {
      try {
        await ProblemModel.delTestdata(doc.domainId, id, stale, doc.uid);
        removed = stale.length;
      } catch {
        warnings.push(`有 ${stale.length} 个旧测试文件未能删除，可能残留（不影响判题）`);
      }
    }
  }

  if (!run.cases.length) warnings.push('该题没有任何测试点，入库后无法判题，请尽快补充官方数据');
  return { docId: id, pid, caseCount: run.cases.length, generated: run.generated, warnings, mode, removed };
}
