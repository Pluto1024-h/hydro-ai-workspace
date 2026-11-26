/*
 * Hydro AI Workspace Plugin
 * Copyright (C) 2026 chen hao
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
  Context,
  Handler,
  PRIV,
  requireSudo,
} from 'hydrooj';

import {
  ArtifactHandler,
  AuditHandler,
  ChatHandler,
  ProblemBankHandler,
  ProfileListHandler,
  ProposalConfirmHandler,
  ProposalListHandler,
  ProposalRejectHandler,
  ProposalViewHandler,
  ProfileViewHandler,
  SessionGetHandler,
  SessionNewHandler,
  WorkspaceSettingsHandler,
} from './src/handlers';
import { setCtx, state } from './src/state';
import './src/tools/problem.tools';
import './src/tools/contest.tools';
import './src/tools/user.tools';
import './src/tools/analytics.tools';
import './src/tools/profile.tools';
import './src/tools/change.tools';

const PLUGIN_NAME = 'hydro-ai-workspace';
const VERSION = '0.7.2';
const STAGE = 'S2';

function shortError(e: any): string {
  return String(e?.message || e).slice(0, 200);
}

class AiWorkspaceHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    const domainId = (this.args as any)?.domainId || 'system';
    this.response.template = 'manage_ai_workspace.html';
    this.response.body = {
      page_name: 'manage_ai_workspace',
      page_title: '智能管理平台',
      version: VERSION,
      stage: STAGE,
      domainId,
    };
  }
}

/** Admin-only API surface diagnostic. Field names only, never field values. */
class AiWorkspaceProbeHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    const hydro = (globalThis as any).Hydro || {};
    const db = state.ctx?.db;
    const model = hydro.model || {};

    const models: Record<string, any> = {};
    for (const name of ['user', 'domain', 'problem', 'contest', 'record', 'storage', 'token', 'system', 'setting', 'builtin']) {
      const m = model[name];
      if (!m) {
        models[name] = { available: false };
        continue;
      }
      models[name] = {
        available: true,
        methods: Object.keys(m).slice(0, 40),
        hasImport: typeof m.import === 'function',
        hasAdd: typeof m.add === 'function',
        hasGet: typeof m.get === 'function',
        hasEdit: typeof m.edit === 'function',
        hasDel: typeof m.del === 'function',
        ...(name === 'contest' ? { rules: Object.keys(m.RULES || {}) } : {}),
      };
    }

    const sampleKeys: Record<string, string[] | string> = {};
    if (db?.collection) {
      for (const name of ['record', 'document', 'user', 'domain.user']) {
        try {
          const doc = await db.collection(name).findOne({});
          sampleKeys[name] = doc ? Object.keys(doc) : ['<empty collection>'];
        } catch (e) {
          sampleKeys[name] = `error: ${shortError(e)}`;
        }
      }
    } else {
      sampleKeys.error = 'ctx.db.collection is unavailable';
    }

    this.response.body = {
      plugin: { name: PLUGIN_NAME, version: VERSION, stage: STAGE },
      runtime: {
        node: process.version,
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        hydroVersion: hydro.version || null,
        sessionKeys: Object.keys((this as any).session || {}),
      },
      context: {
        Route: typeof state.ctx?.Route,
        injectUI: typeof state.ctx?.injectUI,
        dbCollection: typeof db?.collection,
        setting: typeof state.ctx?.setting,
        addScript: typeof state.ctx?.addScript,
      },
      models,
      sampleKeys,
      note: 'Field names only; no field values are returned.',
    };
  }
}

async function ensureIndexes(db: any): Promise<void> {
  if (!db?.collection) return;
  const jobs: Array<() => Promise<any>> = [
    () => db.collection('aiws_session').createIndex({ uid: 1, updatedAt: -1 }),
    () => db.collection('aiws_artifact').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    () => db.collection('aiws_artifact').createIndex({ uid: 1, createdAt: -1 }),
    () => db.collection('aiws_audit').createIndex({ uid: 1, createdAt: -1 }),
    () => db.collection('aiws_cache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    () => db.collection('aiws_profile').createIndex({ domainId: 1, uid: 1 }, { unique: true }),
    () => db.collection('aiws_profile').createIndex({ domainId: 1, updatedAt: -1 }),
    () => db.collection('aiws_proposal').createIndex({ uid: 1, createdAt: -1 }),
    () => db.collection('aiws_proposal').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ];
  for (const job of jobs) {
    try {
      await job();
    } catch {
      // Index creation may fail on restricted MongoDB accounts; plugin still works.
    }
  }
}

export async function apply(ctx: Context) {
  setCtx(ctx);
  await ensureIndexes(ctx.db);

  ctx.Route('manage_ai_workspace', '/manage/ai-workspace', AiWorkspaceHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('manage_ai_workspace_probe', '/manage/ai-workspace/probe', AiWorkspaceProbeHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('manage_ai_workspace_settings', '/manage/ai-workspace/settings', WorkspaceSettingsHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('ai_workspace_chat', '/-/ai-workspace/chat', ChatHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('ai_workspace_session_new', '/-/ai-workspace/sessions/new', SessionNewHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('ai_workspace_session_get', '/-/ai-workspace/session/:id', SessionGetHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('ai_workspace_artifact', '/-/ai-workspace/artifact/:id', ArtifactHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('ai_workspace_audit', '/-/ai-workspace/audit', AuditHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('manage_ai_profiles', '/manage/ai-workspace/profiles', ProfileListHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('manage_ai_profile_view', '/manage/ai-workspace/profile/:uid', ProfileViewHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('manage_ai_problems', '/manage/ai-workspace/problems', ProblemBankHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('manage_ai_proposals', '/manage/ai-workspace/proposals', ProposalListHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('manage_ai_proposal_view', '/manage/ai-workspace/proposal/:id', ProposalViewHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('ai_workspace_proposal_confirm', '/-/ai-workspace/proposal/:id/confirm', ProposalConfirmHandler, PRIV.PRIV_EDIT_SYSTEM);
  ctx.Route('ai_workspace_proposal_reject', '/-/ai-workspace/proposal/:id/reject', ProposalRejectHandler, PRIV.PRIV_EDIT_SYSTEM);

  ctx.injectUI(
    'ControlPanel',
    'manage_ai_workspace',
    { icon: 'cog', before: 'manage_setting' },
    PRIV.PRIV_EDIT_SYSTEM,
  );
}
