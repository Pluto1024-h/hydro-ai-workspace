import { state } from '../state';
import { registerTool } from '../registry';
import { findDuplicates, suggestProblemTags } from '../problem_audit';
import { escapeRegExp, safeLimit, shortTitle } from './common';

registerTool({
  name: 'search_problems',
  description: '按标题关键字或标签检索题库，返回题号、标题、标签与提交统计。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '标题关键字，可留空' },
      tags: { type: 'array', description: '标签列表，需全部匹配', items: { type: 'string' } },
      limit: { type: 'integer', description: '返回条数，默认 10，最多 20', minimum: 1, maximum: 20 },
    },
  },
  execute: async (ctx, args) => {
    const limit = safeLimit(args.limit, 10, 20);
    const filter: any = { domainId: ctx.domainId, docType: 10 };
    if (args.keyword) filter.title = { $regex: `.*${escapeRegExp(args.keyword)}.*`, $options: 'i' };
    if (Array.isArray(args.tags) && args.tags.length) filter.tag = { $all: args.tags.map(String) };

    const docs = await state.db.collection('document').find(filter)
      .project({ _id: 1, pid: 1, docId: 1, title: 1, tag: 1, difficulty: 1, nSubmit: 1, nAccept: 1 })
      .sort({ docId: -1 })
      .limit(limit)
      .maxTimeMS(3000)
      .toArray();

    const rows = docs.map((doc: any) => ({
      id: String(doc._id),
      pid: doc.pid || doc.docId,
      docId: doc.docId,
      title: doc.title,
      tags: doc.tag || [],
      difficulty: doc.difficulty,
      nSubmit: doc.nSubmit || 0,
      nAccept: doc.nAccept || 0,
    }));
    // Show docId explicitly: many problems have no custom pid, so the number is
    // a docId. Both forms work as get_problem_detail / targetPid input.
    const listed = rows.slice(0, 20)
      .map((r: any) => `${r.pid}${r.docId && String(r.docId) !== String(r.pid) ? `(docId=${r.docId})` : ''}｜${shortTitle(r.title)}`)
      .join('；');
    return {
      summary: rows.length
        ? `找到 ${rows.length} 道题目（下列编号可直接传给 get_problem_detail 查看题面，或作为 add_problem_draft 的 targetPid 写入原题）。编号｜标题：${listed}${rows.length > 20 ? '；其余见卡片' : ''}。`
        : '没有找到匹配的题目。',
      data: rows,
      columns: ['pid', 'title', 'tags', 'difficulty', 'nSubmit', 'nAccept'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'get_problem_detail',
  description: '查看单道题的题面、标签、难度和测试数据文件清单。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'string', description: '题目编号，支持字符串 pid 或纯数字 docId，可直接用其它工具摘要里的编号' },
      docId: { type: 'string', description: '题目文档 ID，优先于 pid' },
    },
  },
  execute: async (ctx, args) => {
    const filter: any = { domainId: ctx.domainId, docType: 10 };
    const docId = String(args.docId || '');
    const pid = String(args.pid || '');
    if (/^\d+$/.test(docId)) {
      filter.docId = Number(docId);
    } else if (/^\d+$/.test(pid)) {
      // Contest pids and record pids are usually docId numbers. Accept both
      // representations so a pid copied from another tool summary always works.
      filter.$or = [{ docId: Number(pid) }, { pid }, { _id: Number(pid) }];
    } else if (pid) {
      filter.pid = pid;
    } else if (docId) {
      filter.pid = docId;
    } else {
      throw new Error('请提供 pid 或 docId');
    }

    const doc = await state.db.collection('document').findOne(filter, {
      projection: { title: 1, pid: 1, docId: 1, tag: 1, content: 1, difficulty: 1, data: 1, config: 1, nSubmit: 1, nAccept: 1 },
      maxTimeMS: 3000,
    });
    if (!doc) return { summary: '未找到该题目。', data: null, kind: 'text' };

    const content = String((doc as any).content || '');
    const shown = content.slice(0, 6000);
    const files = Array.isArray((doc as any).data)
      ? (doc as any).data.map((f: any) => f?.name || f?.filename || String(f)).slice(0, 50)
      : [];
    const data = {
      pid: (doc as any).pid || (doc as any).docId,
      docId: (doc as any).docId,
      title: (doc as any).title,
      tags: (doc as any).tag || [],
      difficulty: (doc as any).difficulty,
      nSubmit: (doc as any).nSubmit || 0,
      nAccept: (doc as any).nAccept || 0,
      testdata: files,
      content: shown,
    };
    // The model can only see `summary`; the statement MUST live here.
    return {
      summary: `题目《${data.title}》（pid=${data.pid}，docId=${data.docId}）：标签 ${data.tags.join('、') || '无'}，`
        + `测试数据 ${files.length} 个${files.length ? `（${files.slice(0, 12).join('、')}${files.length > 12 ? ' 等' : ''}）` : '（当前没有测试文件）'}。\n`
        + `—— 题面正文（Markdown，${content.length} 字${content.length > shown.length ? '，以下为前 6000 字' : '，已完整给出'}）——\n`
        + (shown || '（该题题面为空）'),
      data,
      kind: 'text',
    };
  },
});

registerTool({
  name: 'browse_problems',
  description: '分页完整浏览题库（按题号排序），可指定起始 DocId 与页大小。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      offset: { type: 'integer', description: '跳过多少道题，默认 0', minimum: 0 },
      limit: { type: 'integer', description: '本页条数，默认 20，最多 50', minimum: 1, maximum: 50 },
      hidden: { type: 'boolean', description: '是否只看隐藏题；不填则全部' },
    },
  },
  execute: async (ctx, args) => {
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = safeLimit(args.limit, 20, 50);
    const filter: any = { domainId: ctx.domainId, docType: 10 };
    if (args.hidden === true || args.hidden === 'true') filter.hidden = true;
    if (args.hidden === false || args.hidden === 'false') filter.hidden = { $ne: true };
    const docs = await state.db.collection('document').find(filter)
      .project({ _id: 1, docId: 1, pid: 1, title: 1, tag: 1, difficulty: 1, nSubmit: 1, nAccept: 1, hidden: 1 })
      .sort({ docId: -1 }).limit(offset + limit).maxTimeMS(3000).toArray();
    const rows = docs.slice(offset, offset + limit).map((doc: any) => ({
      docId: doc.docId,
      pid: doc.pid || doc.docId,
      title: doc.title,
      tags: doc.tag || [],
      difficulty: doc.difficulty,
      hidden: !!doc.hidden,
      nSubmit: doc.nSubmit || 0,
      nAccept: doc.nAccept || 0,
    }));
    const listed = rows.slice(0, 30)
      .map((r: any) => `${r.pid}${r.docId && String(r.docId) !== String(r.pid) ? `(docId=${r.docId})` : ''}｜${shortTitle(r.title)}｜${(r.tags || []).slice(0, 3).join(',')}`)
      .join('；');
    return {
      summary: `题库第 ${offset + 1}–${offset + rows.length} 题（共取回 ${docs.length} 条）。编号｜标题｜标签：${listed || '暂无'}${rows.length > 30 ? '；其余见卡片' : ''}。用 offset 翻页；get_problem_full 可看完整题面（会把题面正文直接放进返回内容）。`,
      data: rows,
      columns: ['docId', 'pid', 'title', 'tags', 'difficulty', 'hidden', 'nSubmit', 'nAccept'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'get_problem_full',
  description: '读取单道题的完整题面与标签（最多 12000 字），用于查重、标签优化或生成标准题包。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'string', description: '题目编号，支持字符串 pid 或数字 docId' },
    },
    required: ['pid'],
  },
  execute: async (ctx, args) => {
    const pid = String(args.pid || '');
    if (!pid) throw new Error('请提供 pid');
    const filter: any = { domainId: ctx.domainId, docType: 10 };
    if (/^\d+$/.test(pid)) filter.$or = [{ docId: Number(pid) }, { pid }, { _id: Number(pid) }];
    else filter.pid = pid;
    const doc = await state.db.collection('document').findOne(filter, {
      projection: { title: 1, pid: 1, docId: 1, tag: 1, content: 1, difficulty: 1, data: 1, config: 1, nSubmit: 1, nAccept: 1 },
      maxTimeMS: 3000,
    });
    if (!doc) return { summary: '未找到该题目。', data: null, kind: 'text' };
    const content = String((doc as any).content || '');
    const shown = content.slice(0, 12000);
    const files = Array.isArray((doc as any).data)
      ? (doc as any).data.map((f: any) => f?.name || f?.filename || String(f)).slice(0, 50)
      : [];
    const data = {
      docId: (doc as any).docId,
      pid: (doc as any).pid || (doc as any).docId,
      title: (doc as any).title,
      tags: (doc as any).tag || [],
      difficulty: (doc as any).difficulty,
      nSubmit: (doc as any).nSubmit || 0,
      nAccept: (doc as any).nAccept || 0,
      testdata: files,
      content: shown,
      truncated: content.length > shown.length,
    };
    // Previously this summary CLAIMED the statement was included but omitted it,
    // so the model never saw the text. It is now actually embedded.
    return {
      summary: `题目《${data.title}》（pid=${data.pid}，docId=${data.docId}）：标签 ${data.tags.join('、') || '无'}，`
        + `测试数据 ${files.length} 个。\n`
        + `—— 题面正文（Markdown，共 ${content.length} 字${data.truncated ? '，以下为前 12000 字' : '，已完整给出'}）——\n`
        + (shown || '（该题题面为空）'),
      data,
      kind: 'text',
    };
  },
});

registerTool({
  name: 'find_duplicate_problems',
  description: '按题面正文（而不只是标题）检测重复或高度相似的题目，输出重复组与相似度。默认扫描最近 2000 题，最多 5000 题。只读，不删除任何题目。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '扫描题数，默认 2000，最多 5000；传 5000 可覆盖全库', minimum: 20, maximum: 5000 },
      threshold: { type: 'number', description: '相似度阈值 0.5–0.99，默认 0.82', minimum: 0.5, maximum: 0.99 },
    },
  },
  execute: async (ctx, args) => {
    const threshold = Math.max(0.5, Math.min(0.99, Number(args.threshold) || 0.82));
    const result = await findDuplicates(ctx.domainId, { limit: safeLimit(args.limit, 2000, 5000), threshold });
    const groups = result.groups;
    const listed = groups.slice(0, 20)
      .map((g: any) => `[${g.reason}] ${g.members.map((m: any) => `${m.pid}(${m.title})`).join(' ≈ ')}`).join('；');
    const scope = `已扫描 ${result.scanned}/${result.total} 题${result.truncated ? '（未覆盖全库，可加大 limit 到 5000）' : '（全库）'}`;
    return {
      summary: groups.length
        ? `${scope}，发现 ${groups.length} 组疑似重复题：${listed}${groups.length > 20 ? '；其余见卡片' : ''}。请核对清单后再决定是否删除。`
        : `${scope}，未发现重复题（阈值 ${(threshold * 100).toFixed(0)}%）。`,
      data: { groups, ...result },
      kind: 'table',
    };
  },
});

registerTool({
  name: 'suggest_problem_tags',
  description: '分析题库标签：识别 GESP 年份级别（如 2026年3月GESP一级→GESP一级）与知识点（for循环、旗帜法、贪心、二分等），输出每题原标签→建议标签。只读，不修改任何题目。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '分析题数，默认 2000，最多 5000（可覆盖全库）', minimum: 1, maximum: 5000 },
      keyword: { type: 'string', description: '只看标题/编号含该关键字的题，可留空看全部' },
    },
  },
  execute: async (ctx, args) => {
    const rows = await suggestProblemTags(ctx.domainId, {
      limit: safeLimit(args.limit, 2000, 5000),
      keyword: String(args.keyword || '').slice(0, 80),
    });
    const changed = rows.filter((r: any) => r.added.length);
    const listed = changed.slice(0, 20)
      .map((r: any) => `${r.pid}｜${shortTitle(r.title)}｜${r.currentTags.join(',') || '无'}→${r.suggestedTags.join(',')}`).join('；');
    const gespCount = changed.filter((r: any) => r.gespLevel).length;
    return {
      summary: changed.length
        ? `分析 ${rows.length} 题，${changed.length} 题建议补标签（其中 GESP 级别 ${gespCount} 题）。编号｜标题｜原标签→建议标签：${listed}${changed.length > 20 ? '；其余见卡片' : ''}。请核对清单后再决定是否应用。`
        : `分析 ${rows.length} 题，标签已完整，无需优化。`,
      data: rows,
      columns: ['pid', 'title', 'currentTags', 'suggestedTags', 'added', 'gespLevel', 'evidence'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'list_tags',
  description: '统计题库中所有标签及题目数量，用于归一化标签词表。只读。',
  risk: 'read',
  parameters: { type: 'object', properties: {} },
  execute: async (ctx) => {
    const rows = await state.db.collection('document').aggregate([
      { $match: { domainId: ctx.domainId, docType: 10 } },
      { $unwind: '$tag' },
      { $group: { _id: '$tag', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 100 },
    ], { maxTimeMS: 3000 }).toArray();
    const data = rows.map((row: any) => ({ tag: row._id, count: row.count }));
    return {
      summary: data.length ? `题库共有 ${data.length} 个标签。` : '题库暂无标签。',
      data,
      columns: ['tag', 'count'],
      kind: 'table',
    };
  },
});
