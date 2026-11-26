import { registerTool } from '../registry';
import { getModel, state } from '../state';
import { ACCEPTED_VALUES, fmtDate, rangeStart, safeLimit, shortTitle } from './common';

registerTool({
  name: 'query_site_stats',
  description: '统计全站用户数、题目数、比赛数与最近 N 天提交趋势、AC 率、热门标签。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '统计天数，默认 30，最多 90', minimum: 1, maximum: 90 },
    },
  },
  execute: async (ctx, args) => {
    const days = safeLimit(args.days, 30, 90);
    const start = rangeStart(days);
    const UserModel = getModel('user');

    const [userCount, problemCount, contestCount, submitCount, acceptedCount] = await Promise.all([
      UserModel.coll.countDocuments({ _id: { $gte: 2 } }, { maxTimeMS: 3000 }),
      state.db.collection('document').countDocuments({ domainId: ctx.domainId, docType: 10 }, { maxTimeMS: 3000 }),
      state.db.collection('document').countDocuments({ domainId: ctx.domainId, docType: 30 }, { maxTimeMS: 3000 }),
      state.db.collection('record').countDocuments({ domainId: ctx.domainId, _id: { $gte: start } }, { maxTimeMS: 3000 }),
      state.db.collection('record').countDocuments({ domainId: ctx.domainId, _id: { $gte: start }, status: { $in: ACCEPTED_VALUES } }, { maxTimeMS: 3000 }),
    ]);

    const trend = await state.db.collection('record').aggregate([
      { $match: { domainId: ctx.domainId, _id: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { date: { $toDate: '$_id' }, format: '%Y-%m-%d' } },
          count: { $sum: 1 },
          accepted: { $sum: { $cond: [{ $in: ['$status', ACCEPTED_VALUES] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 90 },
    ], { maxTimeMS: 3000 }).toArray();

    const tags = await state.db.collection('document').aggregate([
      { $match: { domainId: ctx.domainId, docType: 10 } },
      { $unwind: '$tag' },
      { $group: { _id: '$tag', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ], { maxTimeMS: 3000 }).toArray();

    const data = {
      days,
      users: userCount,
      problems: problemCount,
      contests: contestCount,
      submissions: submitCount,
      accepted: acceptedCount,
      acRate: submitCount ? `${((acceptedCount / submitCount) * 100).toFixed(1)}%` : '0%',
      trend: trend.map((row: any) => ({ date: row._id, count: row.count, accepted: row.accepted })),
      topTags: tags.map((row: any) => ({ tag: row._id, count: row.count })),
    };
    return {
      summary: `${days} 天内：用户 ${data.users}、题库 ${data.problems}、比赛/作业 ${data.contests}、提交 ${data.submissions}，AC 率 ${data.acRate}。`,
      data,
      kind: 'stats',
    };
  },
});

registerTool({
  name: 'analyze_user',
  description: '分析单个用户最近 N 天的题目类型分布、AC 率、语言与代码长度趋势。只读。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      uid: { type: 'integer', description: '用户 UID', minimum: 2 },
      days: { type: 'integer', description: '分析天数，默认 30，最多 90', minimum: 1, maximum: 90 },
    },
    required: ['uid'],
  },
  execute: async (ctx, args) => {
    const uid = Number(args.uid);
    const days = safeLimit(args.days, 30, 90);
    const start = rangeStart(days);
    const recordColl = state.db.collection('record');

    const groups = await recordColl.aggregate([
      { $match: { uid, domainId: ctx.domainId, _id: { $gte: start } } },
      {
        $group: {
          _id: '$pid',
          count: { $sum: 1 },
          accepted: { $sum: { $cond: [{ $in: ['$status', ACCEPTED_VALUES] }, 1, 0] } },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ], { maxTimeMS: 3000 }).toArray();

    const recent = await recordColl.find({ uid, domainId: ctx.domainId, _id: { $gte: start } })
      .project({ pid: 1, status: 1, lang: 1, code: 1, _id: 1 })
      .sort({ _id: -1 })
      .limit(50)
      .maxTimeMS(3000)
      .toArray();

    const total = groups.reduce((sum: number, row: any) => sum + row.count, 0);
    const accepted = groups.reduce((sum: number, row: any) => sum + row.accepted, 0);
    const languages: Record<string, number> = {};
    let codeLengthSum = 0;
    let codeSamples = 0;
    for (const row of recent) {
      const lang = String((row as any).lang || 'unknown');
      languages[lang] = (languages[lang] || 0) + 1;
      const code = (row as any).code;
      if (typeof code === 'string') {
        codeLengthSum += code.length;
        codeSamples++;
      }
    }

    const pids = groups.map((row: any) => row._id);
    const strPids = pids.filter((p: any) => !/^\d+$/.test(String(p))).map(String);
    const numPids = pids.filter((p: any) => /^\d+$/.test(String(p))).map(Number);
    const docs = pids.length ? await state.db.collection('document').find({
      domainId: ctx.domainId,
      docType: 10,
      $or: [{ pid: { $in: strPids } }, { docId: { $in: numPids } }, { _id: { $in: numPids } }],
    }).project({ _id: 1, pid: 1, docId: 1, title: 1, tag: 1 }).limit(100).maxTimeMS(3000).toArray() : [];

    const titleByKey: Record<string, string> = {};
    const tagByKey: Record<string, string[]> = {};
    for (const doc of docs) {
      const keys = [String((doc as any).pid || ''), String((doc as any).docId || ''), String((doc as any)._id || '')];
      for (const key of keys) {
        if (!key) continue;
        titleByKey[key] = (doc as any).title || '';
        tagByKey[key] = (doc as any).tag || [];
      }
    }

    const tagCount: Record<string, number> = {};
    const topProblems = groups.map((row: any) => {
      const key = String(row._id);
      const tags = tagByKey[key] || [];
      for (const tag of tags) tagCount[tag] = (tagCount[tag] || 0) + row.count;
      return {
        pid: row._id,
        title: titleByKey[key] || '',
        tags,
        count: row.count,
        accepted: row.accepted,
        acRate: row.count ? `${((row.accepted / row.count) * 100).toFixed(0)}%` : '0%',
      };
    });
    const tagDistribution = Object.keys(tagCount)
      .map((tag) => ({ tag, submissions: tagCount[tag] }))
      .sort((a, b) => b.submissions - a.submissions)
      .slice(0, 20);

    const data = {
      uid,
      days,
      submissions: total,
      accepted,
      acRate: total ? `${((accepted / total) * 100).toFixed(1)}%` : '0%',
      languages: Object.keys(languages).map((lang) => ({ lang, count: languages[lang] })),
      avgCodeLength: codeSamples ? Math.round(codeLengthSum / codeSamples) : 0,
      recentSampleCount: recent.length,
      topProblems,
      tagDistribution,
      generatedAt: fmtDate(new Date()),
    };
    const topList = data.topProblems.slice(0, 10)
      .map((p: any) => `${p.pid}｜${shortTitle(p.title)}｜${p.count}次/AC${p.acRate}`).join('；');
    return {
      summary: `用户 ${uid} 最近 ${days} 天提交 ${total} 次，AC 率 ${data.acRate}；常做题（编号｜标题｜次数/AC率）：${topList || '暂无'}；最常见标签 ${tagDistribution[0]?.tag || '暂无'}。编号可传给 get_problem_detail。`,
      data,
      kind: 'stats',
    };
  },
});
