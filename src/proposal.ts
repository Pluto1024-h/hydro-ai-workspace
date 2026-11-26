/**
 * Change proposals: the AI may only create a proposal. Execution requires an
 * admin clicking Confirm on the proposal page with a valid sudo session and a
 * single-use, user-bound token.
 */
import { randomBytes } from 'crypto';
import { ObjectId } from 'hydrooj';
import { coll } from './state';
import type { AuditDoc } from './types';

export type ProposalKind = 'delete_duplicates' | 'update_tags' | 'add_problems';

export interface ProposalItem {
  docId?: number;
  pid?: string;
  title?: string;
  reason?: string;
  currentTags?: string[];
  suggestedTags?: string[];
  [key: string]: any;
}

export interface ProposalDoc {
  _id?: any;
  uid: number;
  uname: string;
  domainId: string;
  kind: ProposalKind;
  status: 'pending' | 'done' | 'rejected' | 'expired';
  token: string;
  summary: string;
  items: ProposalItem[];
  payload?: any;
  createdAt: Date;
  expiresAt: Date;
  executedAt?: Date;
  executedBy?: number;
  result?: any;
}

const TTL_MS = 5 * 60 * 1000;

export async function createProposal(input: {
  uid: number; uname: string; domainId: string; kind: ProposalKind;
  summary: string; items: ProposalItem[]; payload?: any;
}): Promise<ProposalDoc> {
  if (!input.items?.length) throw new Error('清单为空，无需确认');
  if (input.items.length > 100) throw new Error('单次清单最多 100 项，请分批');
  const now = new Date();
  const doc: ProposalDoc = {
    uid: input.uid,
    uname: input.uname,
    domainId: input.domainId,
    kind: input.kind,
    status: 'pending',
    token: randomBytes(24).toString('hex'),
    summary: String(input.summary || '').slice(0, 500),
    items: input.items.slice(0, 100),
    payload: input.payload,
    createdAt: now,
    expiresAt: new Date(now.getTime() + TTL_MS),
  };
  const result = await coll('aiws_proposal').insertOne(doc as any);
  (doc as any)._id = result.insertedId;
  return doc;
}

export async function getProposal(id: string, uid?: number): Promise<ProposalDoc | null> {
  try {
    const filter: any = { _id: new ObjectId(id) };
    if (uid !== undefined) filter.uid = uid;
    return await coll('aiws_proposal').findOne(filter) as ProposalDoc | null;
  } catch {
    return null;
  }
}

export async function listProposals(uid: number, limit = 30): Promise<any[]> {
  return coll('aiws_proposal').find({ uid }).sort({ createdAt: -1 }).limit(Math.min(limit, 50)).toArray();
}

/** Validate a confirm request. Returns a reason string when invalid. */
export function validateConfirm(doc: ProposalDoc | null, token: string, uid: number, sudo: boolean): string {
  if (!doc) return '清单不存在或已失效';
  if (doc.uid !== uid) return '无权确认他人的清单';
  if (!sudo) return '身份已过期，请重新打开工作区完成 sudo 验证';
  if (doc.status !== 'pending') return `清单状态为 ${doc.status}，不能重复确认`;
  if (new Date(doc.expiresAt).getTime() < Date.now()) return '清单已超过 5 分钟有效期，请重新生成';
  if (!token || token !== doc.token) return '确认令牌不正确';
  return '';
}

export async function markProposal(
  doc: ProposalDoc, status: ProposalDoc['status'], result: any, uid: number, uname: string,
  selected?: number[],
): Promise<void> {
  await coll('aiws_proposal').updateOne({ _id: doc._id }, {
    $set: { status, result, executedAt: new Date(), executedBy: uid },
  });
  // Audit records which items were actually executed and which were skipped,
  // so a partial confirmation is fully traceable.
  const chosen = selected
    ? doc.items.map((i, idx) => ({ i, idx })).filter(({ idx }) => selected.includes(idx)).map(({ i }) => i)
    : doc.items;
  const skipped = selected
    ? doc.items.map((i, idx) => ({ i, idx })).filter(({ idx }) => !selected.includes(idx)).map(({ i }) => i)
    : [];
  const brief = (i: any) => ({ docId: i.docId, pid: i.pid, title: i.title });
  const entry: Omit<AuditDoc, '_id' | 'createdAt'> = {
    uid, uname, domainId: doc.domainId,
    action: `proposal_${status}`,
    detail: {
      proposalId: String(doc._id), kind: doc.kind,
      selectedCount: chosen.length,
      skippedCount: skipped.length,
      items: chosen.map(brief),
      skippedItems: skipped.map(brief),
      result,
    },
  };
  try {
    await coll('aiws_audit').insertOne({ ...entry, createdAt: new Date() } as any);
  } catch { /* audit must not block the result */ }
}

export function proposalCountLabel(kind: ProposalKind): string {
  if (kind === 'delete_duplicates') return '删除重复题';
  if (kind === 'add_problems') return '新增题目';
  return '优化标签';
}
