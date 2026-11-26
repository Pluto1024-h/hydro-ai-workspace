import { ObjectId } from 'hydrooj';
import { registerTool } from '../registry';
import {
  buildUserProfile, getUserProfile, listProfiles,
  loadProblemMap, oidToTime, statusLabel, updateProfileNotes,
} from '../profile';
import { state } from '../state';
import { ACCEPTED_VALUES, fmtDate, rangeStart, safeLimit, shortTitle } from './common';

const STATUS_NAME_MAP: Record<string, any[]> = {
  accepted: ACCEPTED_VALUES,
  '通过': ACCEPTED_VALUES,
  wrong_answer: [2], '答案错误': [2], wa: [2],
  time_limit_exceeded: [3], '时间超限': [3], tle: [3],
  memory_limit_exceeded: [4], '内存超限': [4], mle: [4],
  runtime_error: [5], '运行错误': [5], re: [5],
  compile_error: [9], '编译错误': [9], ce: [9],
};

registerTool({
  name: 'get_contest_problems',
  description: '查看某场比赛/作业的题目清单，含标题、标签、难度与站内通过率。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      tid: { type: 'string', description: '比赛/作业的 24 位 ID' },
    },
    required: ['tid'],
  },
  execute: async (ctx, args) => {
    const tid = String(args.tid || '');
    if (!/^[a-fA-F0-9]{24}$/.test(tid)) throw new Error('比赛 ID 格式不正确');
    const contest = await state.db.collection('document').findOne(
      { _id: new ObjectId(tid), domainId: ctx.domainId, docType: 30 },
      { maxTimeMS: 3000 },
    );
    if (!contest) return { summary: '未找到该比赛或作业。', data: null, kind: 'text' };

    const pids: any[] = Array.isArray((contest as any).pids) ? (contest as any).pids : [];
    const problemMap = await loadProblemMap(ctx.domainId, pids);
    const rows = pids.map((pid: any, index: number) => {
      const info = problemMap.get(String(pid));
      return {
        order: index + 1,
        pid: String(pid),
        title: info?.title || String(pid),
        tags: info?.tags || [],
        difficulty: info?.value ?? null,
        difficultyLabel: info?.label || '未知',
        nSubmit: info?.nSubmit || 0,
        nAccept: info?.nAccept || 0,
        acceptRate: info?.nSubmit ? `${((info.nAccept / info.nSubmit) * 100).toFixed(1)}%` : '—',
      };
    });
    const listed = rows.slice(0, 20)
      .map((r: any) => `${r.pid}｜${shortTitle(r.title)}｜${r.difficultyLabel}｜通过率${r.acceptRate}`).join('；');
    const dist = Object.entries(
      rows.reduce((acc: any, r: any) => { acc[r.difficultyLabel] = (acc[r.difficultyLabel] || 0) + 1; return acc; }, {}),
    ).map(([k, v]) => `${k} ${v}`).join('、');
    return {
      summary: `${(contest as any).title || '比赛'} 共 ${rows.length} 道题。编号｜标题｜难度｜通过率：${listed}${rows.length > 20 ? '；其余见卡片' : ''}。难度分布：${dist}。编号可直接传给 get_problem_detail 查题面。`,
      data: { contestId: tid, title: (contest as any).title || '', rule: (contest as any).rule || '', problems: rows },
      columns: ['order', 'pid', 'title', 'difficultyLabel', 'tags', 'acceptRate'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'query_user_submissions',
  description: '查询用户的提交明细：每条是哪道题、难度、结果状态、失败原因与时间。只读，不返回完整代码。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      uid: { type: 'integer', description: '用户 UID', minimum: 2 },
      days: { type: 'integer', description: '查询天数，默认 30，最多 90', minimum: 1, maximum: 90 },
      status: { type: 'string', description: '只看某种状态，如 accepted/wrong_answer/compile_error，可留空看全部' },
      limit: { type: 'integer', description: '返回条数，默认 20，最多 50', minimum: 1, maximum: 50 },
    },
    required: ['uid'],
  },
  execute: async (ctx, args) => {
    const uid = Number(args.uid);
    const days = safeLimit(args.days, 30, 90);
    const limit = safeLimit(args.limit, 20, 50);
    const start = rangeStart(days);
    const filter: any = { uid, domainId: ctx.domainId, _id: { $gte: start } };
    const wanted = String(args.status || '').trim().toLowerCase();
    if (wanted && STATUS_NAME_MAP[wanted]) {
      filter.status = { $in: STATUS_NAME_MAP[wanted] };
    }
    const records = await state.db.collection('record').find(filter)
      .project({ _id: 1, pid: 1, status: 1, statusText: 1, lang: 1, score: 1, time: 1, memory: 1 })
      .sort({ _id: -1 }).limit(limit).maxTimeMS(3000).toArray();
    const problemMap = await loadProblemMap(ctx.domainId, records.map((r: any) => r.pid));

    const rows = records.map((r: any) => {
      const info = problemMap.get(String(r.pid));
      return {
        rid: r._id.toHexString(),
        pid: String(r.pid ?? ''),
        title: info?.title || String(r.pid ?? ''),
        difficultyLabel: info?.label || '未知',
        tags: info?.tags || [],
        status: r.status,
        result: r.statusText ? String(r.statusText) : statusLabel(r.status),
        accepted: ACCEPTED_VALUES.includes(r.status),
        score: r.score,
        lang: r.lang,
        time: r.time,
        memory: r.memory,
        submittedAt: fmtDate(oidToTime(r._id)),
      };
    });
    const failed = rows.filter((r: any) => !r.accepted).length;
    const listed = rows.slice(0, 20)
      .map((r: any) => `${r.rid}｜${r.pid}｜${r.result}｜${r.submittedAt}`).join('；');
    return {
      summary: `查到 ${rows.length} 条提交（失败/未通过 ${failed} 条）。提交ID(rid)｜pid｜结果｜时间：${listed}${rows.length > 20 ? '；其余见卡片' : ''}。pid 可传给 get_problem_detail 查题面；rid 是 24 位提交编号，可直接传给 get_submission 查看并分析源码（需 sudo）。`,
      data: rows,
      columns: ['submittedAt', 'pid', 'title', 'difficultyLabel', 'result', 'lang'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'get_user_profile',
  description: '读取某个用户已建立的个性化档案（刷题清单、活跃时间、失败原因、代码习惯、实力评估、AI 结论）。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { uid: { type: 'integer', description: '用户 UID', minimum: 2 } },
    required: ['uid'],
  },
  execute: async (ctx, args) => {
    const doc = await getUserProfile(ctx.domainId, Number(args.uid));
    if (!doc) return { summary: '该用户尚未建立档案，请先调用 refresh_user_profile 生成。', data: null, kind: 'text' };
    const d: any = doc;
    const data = {
      uid: d.uid,
      uname: d.uname,
      status: d.status,
      registerAt: d.registerAt,
      overview: d.overview,
      ability: d.ability,
      solvedProblems: d.solvedProblems,
      studyTimeline: d.studyTimeline,
      failureAnalysis: d.failureAnalysis,
      codeHabits: d.codeHabits,
      aiNotes: d.aiNotes,
      generatedAt: d.generatedAt,
    };
    const solvedPids = (d.solvedProblems || []).slice(0, 20).map((p: any) => p.pid).join(', ');
    return {
      summary: `${d.uname} 的档案：${d.ability?.level || '未知'}（${d.ability?.score ?? 0} 分），提交 ${d.overview?.totalSubmissions ?? 0} 次，通过 ${d.overview?.problemsSolved ?? 0} 题。刷过题目编号：${solvedPids || '暂无'}${Array.isArray(d.solvedProblems) && d.solvedProblems.length > 20 ? ' 等' : ''}；编号可传给 get_problem_detail。`,
      data,
      kind: 'stats',
    };
  },
});

registerTool({
  name: 'list_user_profiles',
  description: '列出已建立档案的用户及实力等级，便于快速查找。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'integer', description: '返回条数，默认 20，最多 50', minimum: 1, maximum: 50 } },
  },
  execute: async (ctx, args) => {
    const rows = await listProfiles(ctx.domainId, safeLimit(args.limit, 20, 50));
    return {
      summary: rows.length ? `已有 ${rows.length} 份用户档案。` : '还没有建立任何用户档案。',
      data: rows.map((r: any) => ({
        uid: r.uid, uname: r.uname, level: r.ability?.level || '', score: r.ability?.score || 0,
        updatedAt: fmtDate(r.updatedAt),
      })),
      columns: ['uid', 'uname', 'level', 'score', 'updatedAt'],
      kind: 'table',
    };
  },
});

registerTool({
  name: 'refresh_user_profile',
  description: '根据最近提交重新计算并保存用户档案（统计聚合，不写入任何提交代码）。管理员主动分析某用户时使用。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      uid: { type: 'integer', description: '用户 UID', minimum: 2 },
      days: { type: 'integer', description: '分析窗口天数，默认 90，最多 180', minimum: 7, maximum: 180 },
    },
    required: ['uid'],
  },
  execute: async (ctx, args) => {
    const profile = await buildUserProfile(ctx.domainId, Number(args.uid), safeLimit(args.days, 90, 180));
    return {
      summary: `已为 ${profile.uname}（UID ${profile.uid}）生成档案：${profile.ability.level}（${profile.ability.score} 分），分析 ${profile.overview.totalSubmissions} 条提交、${profile.overview.problemsTried} 道题。`,
      data: profile,
      kind: 'stats',
    };
  },
});

registerTool({
  name: 'update_profile_notes',
  description: '把 AI 对某用户的个性化分析结论写入其档案的「AI 结论」字段（最多 6000 字）。先完成分析再调用。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      uid: { type: 'integer', description: '用户 UID', minimum: 2 },
      notes: { type: 'string', description: '中文分析结论：优势、薄弱点、常犯错误、提升建议' },
    },
    required: ['uid', 'notes'],
  },
  execute: async (ctx, args) => {
    const ok = await updateProfileNotes(ctx.domainId, Number(args.uid), String(args.notes || ''));
    if (!ok) return { summary: '该用户尚未建立档案，请先调用 refresh_user_profile。', data: null, kind: 'text' };
    return { summary: `已将分析结论写入 UID ${args.uid} 的档案。`, data: { uid: args.uid, saved: true }, kind: 'text' };
  },
});
