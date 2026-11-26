import { ObjectId } from 'hydrooj';
import { coll } from './state';
import type { ArtifactDoc, ChatMessage, ChatSessionDoc } from './types';

const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export function isValidObjectId(value: any): boolean {
  if (!value || typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value)) return false;
  try {
    new ObjectId(value);
    return true;
  } catch {
    return false;
  }
}

export async function getSession(uid: number, domainId: string, sessionId?: string): Promise<ChatSessionDoc> {
  if (sessionId && isValidObjectId(sessionId)) {
    const doc = await coll('aiws_session').findOne({ _id: new ObjectId(sessionId), uid });
    if (doc) return doc as ChatSessionDoc;
  }

  const now = new Date();
  const doc: ChatSessionDoc = {
    uid,
    domainId,
    scopeId: domainId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const result = await coll('aiws_session').insertOne(doc as any);
  doc._id = result.insertedId;
  return doc;
}

export async function saveSession(session: ChatSessionDoc, maxMessages: number): Promise<void> {
  const messages = trimMessages(session.messages, maxMessages);
  session.messages = messages;
  await coll('aiws_session').updateOne(
    { _id: session._id },
    { $set: { messages, updatedAt: new Date() } },
  );
}

export function trimMessages(messages: ChatMessage[], max: number): ChatMessage[] {
  if (messages.length <= max) return messages;
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const keep = Math.max(1, max - system.length);
  return [...system, ...rest.slice(rest.length - keep)];
}

export async function listSessions(uid: number, limit = 20): Promise<any[]> {
  return coll('aiws_session')
    .find({ uid })
    .project({ _id: 1, domainId: 1, updatedAt: 1, createdAt: 1 })
    .sort({ updatedAt: -1 })
    .limit(Math.min(limit, 50))
    .toArray();
}

export async function storeArtifact(
  uid: number,
  domainId: string,
  kind: string,
  data: any,
  columns?: string[],
): Promise<string> {
  const now = new Date();
  const doc: ArtifactDoc = {
    uid,
    domainId,
    kind,
    data,
    columns,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ARTIFACT_TTL_MS),
  };
  const result = await coll('aiws_artifact').insertOne(doc as any);
  return result.insertedId.toHexString();
}

export async function getArtifact(artifactId: string, uid: number): Promise<any | null> {
  if (!isValidObjectId(artifactId)) return null;
  return coll('aiws_artifact').findOne({ _id: new ObjectId(artifactId), uid });
}
