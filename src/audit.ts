import { coll } from './state';
import type { AuditDoc } from './types';

export async function writeAudit(entry: Omit<AuditDoc, '_id' | 'createdAt'>): Promise<void> {
  try {
    await coll('aiws_audit').insertOne({ ...entry, createdAt: new Date() } as any);
  } catch {
    // Audit failure must not break a read-only query, but it is visible in logs.
  }
}

export async function listAudit(uid: number, limit = 20): Promise<any[]> {
  return coll('aiws_audit')
    .find({ uid })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 50))
    .toArray();
}
