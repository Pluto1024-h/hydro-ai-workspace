import { ObjectId, PRIV } from 'hydrooj';
import { registerTool } from '../registry';
import { getModel, state } from '../state';
import { ACCEPTED_VALUES, escapeRegExp, fmtDate, getDisplayNames, rangeStart, safeLimit } from './common';

function userFilter(extra: any = {}): any {
  return {
    _id: { $gte: 2 },
    priv: { $bitsAllClear: PRIV.PRIV_EDIT_SYSTEM },
    ...extra,
  };
}

function userStatus(priv: number): string {
  return priv === PRIV.PRIV_NONE ? 'banned' : 'normal';
}

/** Record documents use ObjectId as their timestamp; keep this tolerant. */
function recordTime(id: any): string {
  try {
    if (id?.getTimestamp) return fmtDate(id.getTimestamp());
    if (typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id)) {
      return fmtDate(new Date(parseInt(id.slice(0, 8), 16) * 1000));
    }
  } catch { /* ignore malformed ids */ }
  return '';
}

registerTool({
  name: 'search_users',
  description: '按用户名或 UID 检索普通用户（自动排除系统账号和管理员），返回脱敏摘要。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '用户名关键字或数字 UID' },
      group: { type: 'string', description: '用户组名称，可留空' },
      limit: { type: 'integer', description: '返回条数，默认 10，最多 20', minimum: 1, maximum: 20 },
    },
  },
  execute: async (ctx, args) => {
    const UserModel = getModel('user');
    if (!UserModel?.coll) throw new Error('无法获取用户模型');

    const filter: any = userFilter();
    if (args.keyword) {
      const text = String(args.keyword).trim();
      if (/^\d+$/.test(text)) filter._id = Number(text);
      else filter.unameLower = { $regex: `.*${escapeRegExp(text.toLowerCase())}.*` };
    }

    if (args.group) {
      const groups = await state.db.collection('user.group')
        .find({ domainId: ctx.domainId, name: String(args.group) })
        .project({ uids: 1 })
        .limit(5)
        .maxTimeMS(3000)
        .toArray();
      const uids: number[] = [];
      for (const g of groups) for (const uid of g.uids || []) uids.push(Number(uid));
      if (!uids.length) return { summary: `用户组「${args.group}」中没有匹配用户。`, data: [], columns: [], kind: 'table' };
      filter._id = { $in: uids, $gte: 2 };
    }

    const limit = safeLimit(args.limit, 10, 20);
    const docs = await UserModel.coll.find(filter)
      .project({ _id: 1, uname: 1, priv: 1, regat: 1, loginat: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .maxTimeMS(3000)
      .toArray();

    const uids = docs.map((d: any) => d._id);
    const displayNames = await getDisplayNames(ctx.domainId, uids);
    const rows = docs.map((doc: any) => ({
      uid: doc._id,
      uname: doc.uname,
      displayName: displayNames[doc._id] || doc.uname,
      status: userStatus(doc.priv),
      regat: fmtDate(doc.regat),
      loginat: fmtDate(doc.loginat),
    }));
    const listed = rows.slice(0, 20)
      .map((r: any) => `${r.uid}｜${r.uname}｜${r.status}`).join('；');
    return {
      summary: rows.length
        ? `找到 ${rows.length} 名普通用户。UID｜登录名｜状态：${listed}${rows.length > 20 ? '；其余见卡片' : ''}。结果不含邮箱、密码哈希与权限明细。`
        : '没有找到匹配的用户。',
      data: rows,
      columns: ['uid', 'uname', 'displayName', 'status', 'regat', 'loginat'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'get_user_info',
  description: '查看单个用户的资料摘要（UID、登录名、显示名、状态、注册与登录时间）。注意：get_user_profile 是分析档案，不是用户资料。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { uid: { type: 'integer', description: '用户 UID', minimum: 2 } },
    required: ['uid'],
  },
  execute: async (ctx, args) => {
    const UserModel = getModel('user');
    const doc = await UserModel.coll.findOne({ _id: Number(args.uid) }, {
      projection: { _id: 1, uname: 1, priv: 1, regat: 1, loginat: 1 },
      maxTimeMS: 3000,
    });
    if (!doc) return { summary: '该用户不存在。', data: null, kind: 'text' };
    const names = await getDisplayNames(ctx.domainId, [doc._id]);
    const data = {
      uid: doc._id,
      uname: doc.uname,
      displayName: names[doc._id] || doc.uname,
      status: userStatus(doc.priv),
      regat: fmtDate(doc.regat),
      loginat: fmtDate(doc.loginat),
    };
    return { summary: `用户 ${data.uname}（UID ${data.uid}），状态 ${data.status}。`, data, kind: 'text' };
  },
});

registerTool({
  name: 'get_submission',
  description: '按提交 ID 查看单条提交的代码与评测摘要（需有效 sudo，代码最多 4000 字）。只读。',
  risk: 'read',
  requireSudo: true,
  parameters: {
    type: 'object',
    properties: { rid: { type: 'string', description: '提交记录的 24 位 ID' } },
    required: ['rid'],
  },
  execute: async (ctx, args) => {
    if (!/^[a-fA-F0-9]{24}$/.test(String(args.rid))) throw new Error('提交 ID 格式不正确');
    const doc = await state.db.collection('record').findOne(
      { _id: new ObjectId(args.rid), domainId: ctx.domainId },
      { maxTimeMS: 3000 },
    );
    if (!doc) return { summary: '未找到该提交记录。', data: null, kind: 'text' };
    const code = String((doc as any).code || '');
    const flattenTexts = (value: any): string => {
      if (!Array.isArray(value)) return '';
      return value.map((x: any) => String(x?.text ?? x ?? '')).filter(Boolean).join('\n');
    };
    const compilerText = flattenTexts((doc as any).compilerTexts).slice(0, 300);
    const judgeText = flattenTexts((doc as any).judgeTexts).slice(0, 200);
    const CODE_LIMIT = 1200;
    const codeForModel = code.slice(0, CODE_LIMIT)
      + (code.length > CODE_LIMIT ? '\n…[代码已截断，完整版见卡片]' : '');
    const data = {
      rid: (doc as any)._id.toHexString(),
      uid: (doc as any).uid,
      pid: (doc as any).pid,
      lang: (doc as any).lang,
      status: (doc as any).status,
      score: (doc as any).score,
      time: (doc as any).time,
      memory: (doc as any).memory,
      judgeAt: fmtDate((doc as any).judgeAt),
      compilerTexts: compilerText,
      judgeTexts: judgeText,
      code: code.slice(0, 4000) + (code.length > 4000 ? '\n…[代码已截断]' : ''),
    };
    // Only `summary` is fed back to the model. Include the code and compiler
    // output here, otherwise the model can call this tool yet still cannot
    // perform the requested code-level analysis.
    const parts = [
      `提交 ${data.rid}：pid ${data.pid}，语言 ${data.lang}，状态 ${data.status}，分数 ${data.score}，用时 ${data.time}ms，内存 ${data.memory}。`,
    ];
    if (compilerText) parts.push(`编译错误/提示：\n${compilerText}`);
    if (judgeText) parts.push(`评测输出：\n${judgeText}`);
    parts.push(`代码（模型可见前 ${CODE_LIMIT} 字）：\n${codeForModel}`);
    return { summary: parts.join('\n'), data, kind: 'code' };
  },
});

registerTool({
  name: 'list_recent_submitters',
  description: '按时间范围列出全站有提交的用户及其提交数、AC 数、最近提交时间。实时从提交记录反查提交者，无需先猜 UID。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '查询天数，默认 7，最多 90', minimum: 1, maximum: 90 },
      limit: { type: 'integer', description: '最多返回用户数，默认 50，最多 100', minimum: 1, maximum: 100 },
    },
  },
  execute: async (ctx, args) => {
    const days = safeLimit(args.days, 7, 90);
    const limit = safeLimit(args.limit, 50, 100);
    const start = rangeStart(days);
    // Bounded scan: at most 500 records, matching the profile analysis budget.
    const records = await state.db.collection('record').find({
      domainId: ctx.domainId, _id: { $gte: start }, uid: { $gte: 2 },
    }).project({ uid: 1, status: 1, _id: 1 })
      .sort({ _id: -1 }).limit(500).maxTimeMS(3000).toArray();

    const grouped: Record<number, any> = {};
    for (const r of records) {
      const uid = Number((r as any).uid);
      if (!Number.isFinite(uid) || uid < 2) continue;
      const g = grouped[uid] || (grouped[uid] = { uid, submissions: 0, accepted: 0, lastAt: '' });
      g.submissions++;
      if (ACCEPTED_VALUES.includes((r as any).status)) g.accepted++;
      if (!g.lastAt) g.lastAt = recordTime((r as any)._id);
    }
    const all = Object.values(grouped).sort((a, b) => b.submissions - a.submissions || a.uid - b.uid);
    const rows = all.slice(0, limit);
    const uids = rows.map((r: any) => r.uid);

    const UserModel = getModel('user');
    const users = uids.length && UserModel?.coll
      ? await UserModel.coll.find({ _id: { $in: uids } })
        .project({ _id: 1, uname: 1 }).limit(uids.length).maxTimeMS(3000).toArray()
      : [];
    const unameByUid: Record<number, string> = {};
    for (const u of users) unameByUid[(u as any)._id] = String((u as any).uname || (u as any)._id);
    const displayNames = await getDisplayNames(ctx.domainId, uids);

    const data = rows.map((r: any) => ({
      uid: r.uid,
      uname: unameByUid[r.uid] || String(r.uid),
      displayName: displayNames[r.uid] || unameByUid[r.uid] || String(r.uid),
      submissions: r.submissions,
      accepted: r.accepted,
      acRate: r.submissions ? `${((r.accepted / r.submissions) * 100).toFixed(0)}%` : '0%',
      lastAt: r.lastAt,
    }));
    const listed = data.slice(0, 30)
      .map((r: any) => `${r.uid}｜${r.uname}｜${r.submissions}次/AC${r.acRate}｜${r.lastAt}`).join('；');
    return {
      summary: `最近 ${days} 天有提交的用户共 ${all.length} 人（扫描上限 500 条提交）。UID｜登录名｜提交数｜AC率｜最近提交：${listed || '暂无'}${all.length > 30 ? '；其余见卡片' : ''}。用 query_user_submissions(uid) 查该用户明细，再用其中的 rid 调 get_submission 取代码。`,
      data,
      columns: ['uid', 'uname', 'displayName', 'submissions', 'accepted', 'acRate', 'lastAt'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'list_users',
  description: '分页列出全站普通用户的 UID、登录名与最近 N 天提交数（实时查询，按 UID 升序）。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      offset: { type: 'integer', description: '从第几名开始，默认 0', minimum: 0 },
      limit: { type: 'integer', description: '本页条数，默认 50，最多 100', minimum: 1, maximum: 100 },
      days: { type: 'integer', description: '统计最近多少天提交，默认 7，最多 90', minimum: 1, maximum: 90 },
    },
  },
  execute: async (ctx, args) => {
    const UserModel = getModel('user');
    if (!UserModel?.coll) throw new Error('无法获取用户模型');
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = safeLimit(args.limit, 50, 100);
    const days = safeLimit(args.days, 7, 90);
    const docs = await UserModel.coll.find(userFilter())
      .project({ _id: 1, uname: 1, priv: 1, loginat: 1 })
      .sort({ _id: 1 }).limit(offset + limit).maxTimeMS(3000).toArray();
    const page = docs.slice(offset, offset + limit);
    const uids = page.map((d: any) => d._id);
    const start = rangeStart(days);
    const recent = uids.length
      ? await state.db.collection('record').find({
        domainId: ctx.domainId, uid: { $in: uids }, _id: { $gte: start },
      }).project({ uid: 1 }).limit(500).maxTimeMS(3000).toArray()
      : [];
    const countByUid: Record<number, number> = {};
    for (const r of recent) countByUid[(r as any).uid] = (countByUid[(r as any).uid] || 0) + 1;

    const displayNames = await getDisplayNames(ctx.domainId, uids);
    const rows = page.map((d: any) => ({
      uid: d._id,
      uname: d.uname,
      displayName: displayNames[d._id] || d.uname,
      status: userStatus(d.priv),
      recentSubmissions: countByUid[d._id] || 0,
      loginat: fmtDate(d.loginat),
    }));
    const listed = rows.slice(0, 50)
      .map((r: any) => `${r.uid}｜${r.uname}｜${r.recentSubmissions}次`).join('；');
    return {
      summary: `全站普通用户第 ${offset + 1}–${offset + rows.length} 名（实时查询，按 UID 升序）。UID｜登录名｜近${days}天提交数：${listed || '暂无'}。可用 offset 翻页；要直接找有提交的人优先用 list_recent_submitters。`,
      data: rows,
      columns: ['uid', 'uname', 'displayName', 'status', 'recentSubmissions', 'loginat'],
      kind: 'table',
    };
  },
});
