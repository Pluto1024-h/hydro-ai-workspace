import { ContestModel, ObjectId } from 'hydrooj';
import { registerTool } from '../registry';
import { contestStatus, fmtDate, safeLimit, shortTitle } from './common';

function getVisibleRules(): string[] {
  const rules = Object.keys(ContestModel.RULES || {}).filter((rule) => !(ContestModel.RULES as any)[rule]?.hidden);
  return rules.length ? rules : ['acm', 'oi', 'ioi', 'ledo'];
}

function mapContest(doc: any) {
  return {
    id: doc._id?.toHexString ? doc._id.toHexString() : String(doc._id),
    title: doc.title,
    rule: doc.rule,
    status: contestStatus(doc.beginAt, doc.endAt),
    beginAt: fmtDate(doc.beginAt),
    endAt: fmtDate(doc.endAt),
    pids: (doc.pids || []).length,
  };
}

registerTool({
  name: 'list_contests',
  description: '列出比赛或作业，支持按状态和类型筛选。kind 取 contest/homework/all。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'contest=比赛（不含作业），homework=作业，all=全部', enum: ['contest', 'homework', 'all'] },
      status: { type: 'string', description: '状态筛选：upcoming/ongoing/done', enum: ['upcoming', 'ongoing', 'done'] },
      limit: { type: 'integer', description: '返回条数，默认 10，最多 20', minimum: 1, maximum: 20 },
    },
  },
  execute: async (ctx, args) => {
    const kind = args.kind || 'contest';
    const filter: any = {};
    if (kind === 'homework') filter.rule = 'homework';
    else if (kind === 'contest') filter.rule = { $in: getVisibleRules() };

    const limit = safeLimit(args.limit, 10, 20);
    const docs = await ContestModel.getMulti(ctx.domainId, filter).limit(limit).toArray();
    let rows = docs.map(mapContest);
    if (args.status) rows = rows.filter((row: any) => row.status === args.status);

    const listed = rows.slice(0, 20)
      .map((r: any) => `${r.id}｜${shortTitle(r.title)}｜${r.status}`).join('；');
    return {
      summary: rows.length
        ? `找到 ${rows.length} 个${kind === 'homework' ? '作业' : '比赛/活动'}。比赛ID｜标题｜状态：${listed}${rows.length > 20 ? '；其余见卡片' : ''}。用 get_contest_problems 可查某场比赛的题目。`
        : '没有找到匹配的比赛或作业。',
      data: rows,
      columns: ['title', 'rule', 'status', 'beginAt', 'endAt', 'pids'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'get_contest_detail',
  description: '查看单场比赛或作业的标题、说明、赛制、时间与题目列表。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      tid: { type: 'string', description: '比赛/作业的 24 位 ID' },
    },
    required: ['tid'],
  },
  execute: async (ctx, args) => {
    if (!/^[a-fA-F0-9]{24}$/.test(String(args.tid))) throw new Error('比赛 ID 格式不正确');
    const doc = await ContestModel.get(ctx.domainId, new ObjectId(args.tid));
    if (!doc) return { summary: '未找到该比赛或作业。', data: null, kind: 'text' };

    const content = String((doc as any).content || '');
    const data = {
      id: (doc as any)._id.toHexString(),
      title: (doc as any).title,
      rule: (doc as any).rule,
      status: contestStatus((doc as any).beginAt, (doc as any).endAt),
      beginAt: fmtDate((doc as any).beginAt),
      endAt: fmtDate((doc as any).endAt),
      pids: (doc as any).pids || [],
      hidden: !!(doc as any).hidden,
      content: content.slice(0, 4000) + (content.length > 4000 ? '\n…[说明已截断]' : ''),
    };
    const pidsText = data.pids.slice(0, 20).map(String).join(', ');
    return {
      summary: `${data.title}（${data.rule}，${data.status}），共 ${data.pids.length} 道题，题目编号：${pidsText}${data.pids.length > 20 ? ' 等' : ''}。传编号给 get_problem_detail 可查题面。`,
      data,
      kind: 'text',
    };
  },
});
