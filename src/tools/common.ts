import { ObjectId } from 'hydrooj';
import { getModel } from '../state';

export const ACCEPTED_VALUES: any[] = [1, 'accepted'];

/** Hydro records often have no createdAt; the ObjectId prefix is the timestamp. */
export function oidFromTime(ms: number): ObjectId {
  const seconds = Math.floor(ms / 1000);
  const prefix = seconds.toString(16).padStart(8, '0');
  return new ObjectId(`${prefix}0000000000000000`);
}

export function rangeStart(days: number): ObjectId {
  const safeDays = Math.max(1, Math.min(90, Number(days) || 30));
  return oidFromTime(Date.now() - safeDays * 24 * 60 * 60 * 1000);
}

export function escapeRegExp(input: string): string {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shorten a title so tool summaries stay small enough for the model context. */
export function shortTitle(value: any, max = 24): string {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function fmtDate(value: any): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 24);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function contestStatus(beginAt: any, endAt: any): string {
  const now = Date.now();
  const begin = beginAt ? new Date(beginAt).getTime() : 0;
  const end = endAt ? new Date(endAt).getTime() : 0;
  if (end && end <= now) return 'done';
  if (begin && begin > now) return 'upcoming';
  return 'ongoing';
}

export function maskMail(mail: any): string {
  const text = String(mail || '');
  const at = text.indexOf('@');
  if (at <= 1) return text ? '***' : '';
  return `${text[0]}***${text.slice(at)}`;
}

export async function getDisplayNames(domainId: string, uids: number[]): Promise<Record<number, string>> {
  const result: Record<number, string> = {};
  if (!uids.length) return result;
  const domain = getModel('domain');
  try {
    if (domain?.getMultiUserInDomain) {
      const docs = await domain.getMultiUserInDomain(domainId, { uid: { $in: uids } })
        .project({ uid: 1, displayName: 1 })
        .toArray();
      for (const doc of docs || []) {
        if (doc?.displayName && doc.displayName !== (doc as any).uname) {
          result[doc.uid] = doc.displayName;
        }
      }
    }
  } catch {
    // displayName is optional in domain.user; fall back to uname.
  }
  return result;
}

export function isAccepted(status: any): boolean {
  return ACCEPTED_VALUES.includes(status);
}

export function safeLimit(raw: any, fallback = 10, max = 20): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.round(n));
}
