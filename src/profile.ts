/**
 * User profile store and analysis helpers.
 * All analysis runs inside the plugin; only aggregates and short samples are
 * persisted. Full submission code is never written into a profile.
 */
import { ObjectId } from 'hydrooj';
import { coll, getModel, state } from './state';
import { ACCEPTED_VALUES, fmtDate, rangeStart } from './tools/common';

const STATUS_FALLBACK: Record<number, string> = {
  0: '等待', 1: '通过', 2: '答案错误', 3: '时间超限', 4: '内存超限',
  5: '运行错误', 6: '系统错误', 7: '已取消', 8: '输出超限', 9: '编译错误',
  10: '测试失败', 11: '评测中', 12: '部分正确', 13: '已忽略', 14: '未知',
};

export function statusLabel(status: any): string {
  const builtin = getModel('builtin') || {};
  const short = builtin.STATUS_SHORT_TEXTS || {};
  const texts = builtin.STATUS_TEXTS || {};
  if (short[status]) return String(short[status]);
  if (texts[status]) return String(texts[status]);
  return STATUS_FALLBACK[Number(status)] || String(status);
}

export function difficultyInfo(difficulty: any, tags: string[] = []): { value: any; label: string } {
  const n = Number(difficulty);
  let label = '';
  if (Number.isFinite(n) && n > 0) {
    if (n >= 8) label = '困难';
    else if (n >= 5) label = '中等';
    else if (n >= 2) label = '简单';
    else label = '入门';
  } else {
    const text = tags.join(' ');
    if (/困难|提高|NOI|省选|hard|expert/i.test(text)) label = '困难';
    else if (/中等|普及\+|medium/i.test(text)) label = '中等';
    else if (/入门|简单|easy/i.test(text)) label = '简单';
    else label = '未知';
  }
  return { value: difficulty ?? null, label };
}

export function oidToTime(id: any): Date {
  try {
    if (id && typeof id === 'object' && typeof (id as any).getTimestamp === 'function') {
      return (id as any).getTimestamp();
    }
    if (typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id)) {
      return (new ObjectId(id) as any).getTimestamp();
    }
  } catch {
    // fall through
  }
  return new Date(0);
}

/** Local date parts for UTC+8 without depending on server timezone. */
function localParts(date: Date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
    dateKey: shifted.toISOString().slice(0, 10),
  };
}

/** Map problem pids (string or numeric) to document title/tags/difficulty. */
export async function loadProblemMap(domainId: string, pids: any[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  const unique = Array.from(new Set(pids.map(String))).slice(0, 200);
  if (!unique.length) return map;
  const strPids = unique.filter((p) => !/^\d+$/.test(p));
  const numPids = unique.filter((p) => /^\d+$/.test(p)).map(Number);
  let docs: any[] = [];
  try {
    docs = await state.db.collection('document').find({
      domainId,
      docType: 10,
      $or: [
        { pid: { $in: strPids } },
        { docId: { $in: numPids } },
        { _id: { $in: numPids } },
      ],
    }).project({ _id: 1, pid: 1, docId: 1, title: 1, tag: 1, difficulty: 1, nSubmit: 1, nAccept: 1 })
      .limit(200).maxTimeMS(3000).toArray();
  } catch {
    return map;
  }
  for (const doc of docs) {
    const info = {
      title: String(doc.title || ''),
      tags: Array.isArray(doc.tag) ? doc.tag.map(String) : [],
      ...difficultyInfo(doc.difficulty, Array.isArray(doc.tag) ? doc.tag : []),
      nSubmit: Number(doc.nSubmit || 0),
      nAccept: Number(doc.nAccept || 0),
    };
    for (const key of [doc.pid, doc.docId, doc._id]) {
      if (key !== undefined && key !== null) map.set(String(key), info);
    }
  }
  return map;
}

const COMPILE_PATTERNS = [
  { re: /undeclared|not declared|was not declared/i, label: '变量未声明' },
  { re: /no matching function|too many arguments|cannot convert|invalid conversion/i, label: '函数签名/类型不匹配' },
  { re: /expected|syntax error|stray/i, label: '语法错误' },
  { re: /undefined reference|multiple definition/i, label: '链接错误' },
  { re: /segmentation fault|out of bounds|stack overflow/i, label: '越界或空指针' },
];

export async function buildUserProfile(domainId: string, uid: number, days: number): Promise<any> {
  const UserModel = getModel('user');
  if (!UserModel?.coll) throw new Error('无法获取用户模型');
  const userDoc = await UserModel.coll.findOne(
    { _id: Number(uid) },
    { projection: { _id: 1, uname: 1, priv: 1, regat: 1, loginat: 1 }, maxTimeMS: 3000 },
  );
  if (!userDoc) throw new Error('用户不存在');

  const start = rangeStart(days);
  const records = await state.db.collection('record').find({
    uid: Number(uid), domainId, _id: { $gte: start },
  }).project({
    _id: 1, pid: 1, status: 1, lang: 1, code: 1, score: 1,
    time: 1, memory: 1, compilerTexts: 1, judgeTexts: 1,
  }).sort({ _id: -1 }).limit(500).maxTimeMS(5000).toArray();

  const problemMap = await loadProblemMap(domainId, records.map((r: any) => r.pid));

  // Per-problem aggregation
  const perProblem = new Map<string, any>();
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const byDate: Record<string, { count: number; accepted: number }> = {};
  const statusCount: Record<string, number> = {};
  const failSamples: Record<string, string[]> = {};
  const patternCount: Record<string, number> = {};
  const featureCount: Record<string, number> = {};
  const tagStats: Record<string, { count: number; accepted: number }> = {};
  const languages: Record<string, { count: number; accepted: number }> = {};
  let acceptedCount = 0;
  let codeLengthSum = 0;
  let codeSamples = 0;

  for (const record of records) {
    const r: any = record;
    const pid = String(r.pid ?? '');
    const isAccepted = ACCEPTED_VALUES.includes(r.status);
    if (isAccepted) acceptedCount++;

    const problem = problemMap.get(pid) || { title: '', tags: [], label: '未知', value: null };
    let entry = perProblem.get(pid);
    if (!entry) {
      entry = {
        pid,
        title: problem.title || pid,
        tags: problem.tags || [],
        difficulty: problem.value,
        difficultyLabel: problem.label || '未知',
        attempts: 0,
        accepted: 0,
        firstAt: '',
        lastAt: '',
      };
      perProblem.set(pid, entry);
    }
    entry.attempts++;
    if (isAccepted) entry.accepted++;
    const when = fmtDate(oidToTime(r._id));
    if (!entry.firstAt) entry.firstAt = when;
    entry.lastAt = when;

    const parts = localParts(oidToTime(r._id));
    byHour[parts.hour]++;
    byWeekday[parts.weekday]++;
    if (!byDate[parts.dateKey]) byDate[parts.dateKey] = { count: 0, accepted: 0 };
    byDate[parts.dateKey].count++;
    if (isAccepted) byDate[parts.dateKey].accepted++;

    const statusName = statusLabel(r.status);
    statusCount[statusName] = (statusCount[statusName] || 0) + 1;
    if (!isAccepted && (failSamples[statusName] || []).length < 3) {
      (failSamples[statusName] ||= []).push(pid);
    }

    const lang = String(r.lang || 'unknown');
    if (!languages[lang]) languages[lang] = { count: 0, accepted: 0 };
    languages[lang].count++;
    if (isAccepted) languages[lang].accepted++;

    for (const tag of entry.tags || []) {
      if (!tagStats[tag]) tagStats[tag] = { count: 0, accepted: 0 };
      tagStats[tag].count++;
      if (isAccepted) tagStats[tag].accepted++;
    }

    const code = typeof r.code === 'string' ? r.code : '';
    if (code) {
      codeLengthSum += code.length;
      codeSamples++;
      if (/#include/.test(code)) featureCount['包含头文件'] = (featureCount['包含头文件'] || 0) + 1;
      if (/scanf|cin\s*>>|getline/.test(code)) featureCount['标准输入读取'] = (featureCount['标准输入读取'] || 0) + 1;
      if (/\bfor\s*\(|\bwhile\s*\(/.test(code)) featureCount['使用循环'] = (featureCount['使用循环'] || 0) + 1;
      if (/\bstrcpy\b|\bstrcat\b|\bgets\b/.test(code)) featureCount['使用不安全字符串函数'] = (featureCount['使用不安全字符串函数'] || 0) + 1;
    }
    const compilerText = Array.isArray(r.compilerTexts)
      ? r.compilerTexts.join(' ')
      : String(r.compilerTexts || '');
    if (compilerText) {
      for (const pattern of COMPILE_PATTERNS) {
        if (pattern.re.test(compilerText)) {
          patternCount[pattern.label] = (patternCount[pattern.label] || 0) + 1;
        }
      }
    }
  }

  const problems = Array.from(perProblem.values()).sort((a, b) => b.attempts - a.attempts).slice(0, 100);
  const solvedCount = problems.filter((p) => p.accepted > 0).length;
  const acRate = records.length ? acceptedCount / records.length : 0;

  const difficultyCoverage: Record<string, number> = { 入门: 0, 简单: 0, 中等: 0, 困难: 0, 未知: 0 };
  for (const p of problems) {
    const label = p.difficultyLabel in difficultyCoverage ? p.difficultyLabel : '未知';
    difficultyCoverage[label]++;
  }
  const weightedDifficulty =
    (difficultyCoverage['入门'] * 1 + difficultyCoverage['简单'] * 2 +
      difficultyCoverage['中等'] * 5 + difficultyCoverage['困难'] * 9) / Math.max(1, problems.length);

  const strengthTags: string[] = [];
  const weaknessTags: string[] = [];
  for (const [tag, stat] of Object.entries(tagStats)) {
    if (stat.count < 3) continue;
    const rate = stat.accepted / stat.count;
    if (rate >= 0.7) strengthTags.push(tag);
    else if (rate < 0.4) weaknessTags.push(tag);
  }

  const score = Math.round(
    Math.min(30, acRate * 30) +
    Math.min(30, solvedCount / 20 * 30) +
    Math.min(20, records.length / 50 * 20) +
    Math.min(20, weightedDifficulty / 9 * 20),
  );
  const level = score >= 80 ? '高级' : score >= 60 ? '中级' : score >= 40 ? '初级' : '入门';
  const reasons: string[] = [
    `提交 ${records.length} 次，AC 率 ${(acRate * 100).toFixed(1)}%`,
    `尝试 ${problems.length} 道题，其中 ${solvedCount} 道通过`,
    `主要涉及难度：${Object.entries(difficultyCoverage).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).join('、') || '暂无'}`,
  ];
  if (weaknessTags.length) reasons.push(`薄弱标签：${weaknessTags.slice(0, 4).join('、')}`);

  const now = new Date();
  const profile: any = {
    domainId,
    uid: Number(uid),
    uname: String(userDoc.uname || ''),
    status: Number(userDoc.priv) === 0 ? 'banned' : 'normal',
    registerAt: fmtDate(userDoc.regat),
    lastLoginAt: fmtDate(userDoc.loginat),
    analysisWindowDays: days,
    overview: {
      totalSubmissions: records.length,
      accepted: acceptedCount,
      acRate: `${(acRate * 100).toFixed(1)}%`,
      problemsTried: problems.length,
      problemsSolved: solvedCount,
      avgCodeLength: codeSamples ? Math.round(codeLengthSum / codeSamples) : 0,
      languages: Object.entries(languages)
        .map(([lang, stat]) => ({ lang, ...stat }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    },
    solvedProblems: problems,
    studyTimeline: {
      byHour: byHour.map((count, hour) => ({ hour, count })).filter((x) => x.count > 0),
      byWeekday: byWeekday.map((count, day) => ({ day, count })).filter((x) => x.count > 0),
      activeDays: Object.keys(byDate).length,
      recentActivity: Object.entries(byDate)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 30)
        .map(([date, stat]) => ({ date, ...stat })),
    },
    failureAnalysis: {
      statusDistribution: Object.entries(statusCount)
        .map(([status, count]) => ({
          status,
          count,
          ratio: `${(count / Math.max(1, records.length) * 100).toFixed(1)}%`,
          samplePids: failSamples[status] || [],
        }))
        .sort((a, b) => b.count - a.count),
    },
    codeHabits: {
      avgCodeLength: codeSamples ? Math.round(codeLengthSum / codeSamples) : 0,
      patterns: Object.entries(patternCount)
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count),
      features: Object.entries(featureCount)
        .map(([feature, count]) => ({ feature, count }))
        .sort((a, b) => b.count - a.count),
    },
    ability: {
      level,
      score,
      reasons,
      difficultyCoverage,
      strengthTags: strengthTags.sort().slice(0, 10),
      weaknessTags: weaknessTags.sort().slice(0, 10),
    },
    aiNotes: '',
    generatedAt: fmtDate(now),
    updatedAt: now,
  };

  const existing = await coll('aiws_profile').findOne({ domainId, uid: Number(uid) });
  profile.createdAt = (existing as any)?.createdAt || now;
  if (existing?._id) {
    await coll('aiws_profile').updateOne({ _id: existing._id }, { $set: profile });
    profile._id = existing._id;
  } else {
    const result = await coll('aiws_profile').insertOne(profile as any);
    profile._id = result.insertedId;
  }
  return profile;
}

export async function getUserProfile(domainId: string, uid: number): Promise<any | null> {
  return coll('aiws_profile').findOne({ domainId, uid: Number(uid) }, { maxTimeMS: 3000 });
}

export async function updateProfileNotes(domainId: string, uid: number, notes: string): Promise<boolean> {
  const text = String(notes || '').trim().slice(0, 6000);
  if (!text) return false;
  const result = await coll('aiws_profile').updateOne(
    { domainId, uid: Number(uid) },
    { $set: { aiNotes: text, updatedAt: new Date() } },
  );
  return result.matchedCount > 0;
}

export async function listProfiles(domainId: string, limit = 20): Promise<any[]> {
  return coll('aiws_profile').find({ domainId })
    .project({ uid: 1, uname: 1, 'ability.level': 1, 'ability.score': 1, updatedAt: 1 })
    .sort({ updatedAt: -1 })
    .limit(Math.min(50, Math.max(1, limit)))
    .maxTimeMS(3000)
    .toArray();
}
