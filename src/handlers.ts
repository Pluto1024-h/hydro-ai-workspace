import { Handler, PRIV, requireSudo } from 'hydrooj';
import { listAudit } from './audit';
import { createProposal, getProposal, listProposals, markProposal, validateConfirm } from './proposal';
import { executeProposal, normalizeSelection } from './executor';
import { runChatTurn, getToolNames } from './registry';
import { getPublicSettings, loadSettings, saveSettings, setApiKey } from './settings';
import { getSearchConfig, saveSearchConfig } from './websearch';
import { getArtifact, getSession, listSessions, saveSession } from './session';
import { getUserProfile, listProfiles } from './profile';
import { state } from './state';

const SUDO_WINDOW_MS = 60 * 60 * 1000;

function isSudo(session: any): boolean {
  return !!(session?.sudo && Date.now() - Number(session.sudo) < SUDO_WINDOW_MS);
}

function identity(handler: any) {
  return {
    uid: Number(handler.user?._id || 0),
    uname: String(handler.user?.uname || ''),
    domainId: String(handler.args?.domainId || 'system'),
  };
}

function denyWithoutSudo(handler: any): boolean {
  if (isSudo(handler.session)) return false;
  handler.response.status = 403;
  handler.response.body = {
    error: 'sudo_required',
    message: '身份已过期，请重新打开工作区页面完成验证。',
  };
  return true;
}

function notice(type: string, message: string) {
  return { type, message };
}

export class WorkspaceSettingsHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    const publicSettings = await getPublicSettings();
    const searchConfig = await getSearchConfig();
    this.response.template = 'manage_ai_workspace_settings.html';
    this.response.body = {
      page_name: 'manage_ai_workspace_settings',
      page_title: '智能管理平台 · 配置',
      ...publicSettings,
      searchProvider: searchConfig.provider,
      searchApiBase: searchConfig.apiBase,
      searchKeySet: searchConfig.keySet,
      searchKeyMasked: searchConfig.keyMasked,
      searchKeyFromEnv: searchConfig.keyFromEnv,
      toolNames: getToolNames(),
      notice: (this.request.query?.saved === '1') ? notice('success', '配置已保存。') : null,
    };
  }

  @requireSudo
  async post() {
    const body = this.request.body || {};
    const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 'on' || body.enabled === 1;
    const apiBase = String(body.apiBase || 'https://api.deepseek.com').trim().slice(0, 200);
    // Form uses `chatModel` to avoid shadowing Hydro's template-global `model`.
    // Accept legacy `model` key as well for older saved forms.
    const model = String(body.chatModel || body.model || 'deepseek-flash').trim().slice(0, 64);
    const validationAlias = String(body.validationAlias || 'deepseek_pro').trim().slice(0, 64);
    const validationTarget = String(body.validationTarget || model).trim().slice(0, 64);
    const timeoutMs = Math.max(5000, Math.min(120000, Number(body.timeoutMs) || 30000));
    const maxRetries = Math.max(0, Math.min(3, Number(body.maxRetries) || 2));
    const maxContextMessages = Math.max(4, Math.min(16, Number(body.maxContextMessages) || 8));

    await saveSettings({ enabled, apiBase, model, validationAlias, validationTarget, timeoutMs, maxRetries, maxContextMessages });
    const apiKey = String(body.apiKey || '').trim();
    if (apiKey) await setApiKey(apiKey);
    await saveSearchConfig({
      provider: String(body.searchProvider || 'bocha'),
      apiBase: String(body.searchApiBase || ''),
      apiKey: String(body.searchApiKey || ''),
    });

    const publicSettings = await getPublicSettings();
    const searchConfig = await getSearchConfig();
    this.response.template = 'manage_ai_workspace_settings.html';
    this.response.body = {
      page_name: 'manage_ai_workspace_settings',
      page_title: '智能管理平台 · 配置',
      ...publicSettings,
      searchProvider: searchConfig.provider,
      searchApiBase: searchConfig.apiBase,
      searchKeySet: searchConfig.keySet,
      searchKeyMasked: searchConfig.keyMasked,
      searchKeyFromEnv: searchConfig.keyFromEnv,
      toolNames: getToolNames(),
      notice: notice('success', apiKey ? '配置与 API Key 已保存；Key 不会再次显示。' : '配置已保存。'),
    };
  }
}

export class ChatHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  async post() {
    if (denyWithoutSudo(this)) return;

    const body = this.request.body || {};
    const message = String(body.message || '').trim().slice(0, 4000);
    if (!message) {
      this.response.status = 400;
      this.response.body = { error: 'empty_message', message: '请输入问题。' };
      return;
    }

    const who = identity(this);
    const settings = await loadSettings();
    if (!settings.enabled) {
      this.response.status = 400;
      this.response.body = { error: 'disabled', message: 'AI 功能未启用，请先在配置页开启。' };
      return;
    }

    try {
      const sessionDoc = await getSession(who.uid, who.domainId, body.sessionId);
      const turn = await runChatTurn({
        ...who,
        sessionId: String(sessionDoc._id),
        sudo: isSudo(this.session),
        user: this.user,
        message,
        history: sessionDoc.messages || [],
      });

      sessionDoc.messages = turn.newMessages;
      await saveSession(sessionDoc, settings.maxContextMessages);

      this.response.body = {
        ok: true,
        sessionId: sessionDoc._id.toHexString(),
        events: turn.events,
        assistantContent: turn.assistantContent,
      };
    } catch (e: any) {
      this.response.status = 400;
      this.response.body = {
        error: 'chat_failed',
        message: String(e?.message || e).slice(0, 500),
      };
    }
  }
}

export class SessionNewHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  async post() {
    if (denyWithoutSudo(this)) return;
    const who = identity(this);
    const sessionDoc = await getSession(who.uid, who.domainId);
    this.response.body = { ok: true, sessionId: sessionDoc._id.toHexString() };
  }
}

export class SessionGetHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  async get() {
    if (denyWithoutSudo(this)) return;
    const who = identity(this);
    const sessionDoc = await getSession(who.uid, who.domainId, this.args?.id);
    const sessions = await listSessions(who.uid);
    this.response.body = {
      ok: true,
      sessionId: sessionDoc._id.toHexString(),
      // Always return the requested session's messages, not the latest one.
      messages: sessionDoc.messages || [],
      sessions,
    };
  }
}

export class ArtifactHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  async get() {
    if (denyWithoutSudo(this)) return;
    const who = identity(this);
    const doc = await getArtifact(String(this.args?.id || ''), who.uid);
    if (!doc) {
      this.response.status = 404;
      this.response.body = { error: 'not_found', message: '结果已过期或不存在。' };
      return;
    }
    this.response.body = {
      ok: true,
      kind: doc.kind,
      columns: doc.columns || [],
      data: doc.data,
      createdAt: doc.createdAt,
    };
  }
}

export class AuditHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  async get() {
    if (denyWithoutSudo(this)) return;
    const who = identity(this);
    this.response.body = { ok: true, logs: await listAudit(who.uid, 20) };
  }
}

export class ProfileListHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    this.response.template = 'manage_ai_profiles.html';
    this.response.body = {
      page_name: 'manage_ai_profiles',
      page_title: '用户档案',
      profiles: await listProfiles(String(this.args?.domainId || 'system'), 50),
    };
  }
}

export class ProfileViewHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    const uid = Number(this.args?.uid || 0);
    const doc = uid >= 2 ? await getUserProfile(String(this.args?.domainId || 'system'), uid) : null;
    this.response.template = 'manage_ai_profile_view.html';
    this.response.body = {
      page_name: 'manage_ai_profile_view',
      page_title: '用户档案详情',
      profile: doc ? JSON.parse(JSON.stringify(doc)) : null,
      uid,
    };
  }
}

export class ProblemBankHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    const domainId = String(this.args?.domainId || 'system');
    const offset = Math.max(0, Number(this.request.query?.offset) || 0);
    const docs = await state.db.collection('document').find({ domainId, docType: 10 })
      .project({ _id: 1, docId: 1, pid: 1, title: 1, tag: 1, difficulty: 1, nSubmit: 1, nAccept: 1 })
      .sort({ docId: -1 }).limit(offset + 50).maxTimeMS(3000).toArray();
    this.response.template = 'manage_ai_problems.html';
    this.response.body = {
      page_name: 'manage_ai_problems',
      page_title: '题库浏览',
      problems: docs.slice(offset, offset + 50).map((d: any) => ({
        docId: d.docId, pid: d.pid || d.docId, title: d.title,
        tags: d.tag || [], difficulty: d.difficulty, nSubmit: d.nSubmit || 0, nAccept: d.nAccept || 0,
      })),
      offset,
      nextOffset: docs.length > offset + 50 ? offset + 50 : null,
      prevOffset: offset > 0 ? Math.max(0, offset - 50) : null,
    };
  }
}

export class ProposalListHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    const who = identity(this);
    const rows = await listProposals(who.uid, 30);
    // 日期在服务端格式化：模板引擎不保证支持 String() 构造函数调用
    const proposals = rows.map((p: any) => ({
      ...p,
      createdAtText: String(p.createdAt || '').slice(0, 16).replace('T', ' '),
    }));
    this.response.template = 'manage_ai_proposals.html';
    this.response.body = {
      page_name: 'manage_ai_proposals',
      page_title: '待确认修改清单',
      proposals,
    };
  }
}

export class ProposalViewHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  @requireSudo
  async get() {
    const who = identity(this);
    const doc = await getProposal(String(this.args?.id || ''), who.uid);
    const proposal = doc ? JSON.parse(JSON.stringify(doc)) : null;
    let items: any[] = [];
    if (proposal) {
      proposal.expiresAtText = String(proposal.expiresAt || '').slice(0, 16).replace('T', ' ');
      // Precompute every display string server-side so templates stay dumb.
      items = (proposal.items || []).map((it: any, idx: number) => {
        const base = { idx };
        if (proposal.kind === 'delete_duplicates') {
          const members = Array.isArray(it.members) ? it.members : [];
          return {
            ...base,
            pidText: members.map((m: any) => String(m?.pid || '')).filter(Boolean).join('、') || '—',
            titleText: String(it.group || it.reason || '重复题组'),
            currentText: `${members.length} 题并存`,
            targetText: `保留第 1 题，删除其余 ${Math.max(0, members.length - 1)} 题`,
            reason: '',
            memberLines: members.map((m: any, i: number) => ({
              pid: String(m?.pid || ''), title: String(m?.title || ''),
              action: i === 0 ? '保留' : '删除', danger: i !== 0,
            })),
          };
        }
        if (proposal.kind === 'update_tags') {
          return {
            ...base,
            pidText: String(it.pid || it.docId || '—'),
            titleText: String(it.title || ''),
            currentText: (Array.isArray(it.currentTags) ? it.currentTags : []).join('、') || '无',
            targetText: (Array.isArray(it.suggestedTags) ? it.suggestedTags : []).join('、'),
            reason: String(it.reason || ''),
            memberLines: [],
          };
        }
        // add_problems: show the full standard package for review.
        const pkg = it?.pkg || {};
        const esc = (s: any) => String(s ?? '')
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const tags = (Array.isArray(pkg.tags) ? pkg.tags : []).join('、') || '无';
        const samples = Array.isArray(pkg.samples) ? pkg.samples : [];
        const testData = Array.isArray(pkg.testData) ? pkg.testData : [];
        const sampleText = samples.map((s: any, i: number) =>
          `样例 ${i + 1} 输入:\n${String(s?.input || '')}\n样例 ${i + 1} 输出:\n${String(s?.output || '')}`).join('\n\n');
        const catLabel: Record<string, string> = {
          boundary: '边界', extreme: '极限', tricky: '易错', normal: '普通', special: '特殊',
        };
        const dataRows = testData.map((d: any, i: number) => {
          const key = String(d?.category || 'normal');
          const generated = !!String(d?.generator || '').trim();
          const rawInput = String(d?.input || '');
          const preview = generated
            ? '（由生成器脚本产出，确认时运行）'
            : (rawInput.length > 120 ? `${rawInput.slice(0, 120)}…` : rawInput || '（空）');
          return {
            no: i + 1,
            key,
            category: catLabel[key] || key,
            purpose: String(d?.purpose || '未说明'),
            preview,
            generated,
            genCode: generated ? esc(String(d.generator).slice(0, 2000)) : '',
          };
        });
        const catCounts: Record<string, number> = {};
        for (const d of testData) {
          const k = String(d?.category || 'normal');
          catCounts[k] = (catCounts[k] || 0) + 1;
        }
        const coverage = ['boundary', 'extreme', 'tricky', 'normal', 'special']
          .filter((k) => catCounts[k])
          .map((k) => `${catLabel[k]}${catCounts[k]}`).join(' / ') || '无';
        const isExisting = pkg?.target?.mode === 'existing' && String(pkg?.target?.pid || '').trim();
        const targetPid = isExisting ? String(pkg.target.pid).trim() : '';
        return {
          ...base,
          pidText: isExisting ? targetPid : '新建',
          titleText: String(it?.title || pkg.title || '未命名题目'),
          currentText: isExisting ? '已存在' : '不存在',
          targetText: isExisting ? '替换该题测试数据（原数据将被覆盖）' : '建题 + 写入测试数据（默认隐藏）',
          reason: String(it?.reason || ''), memberLines: [],
          pkgView: {
            isExisting: !!isExisting,
            targetPid,
            paramsText: `时限 ${pkg.timeLimit || '1s'} · 内存 ${pkg.memoryLimit || '256m'} · 满分 ${pkg.score || 100} · 测评 ${pkg.judgeType || 'default'} · 标签 ${tags}`,
            constraintsText: String(pkg.constraints || '（未填写数据范围）'),
            contentHtml: esc(pkg.content || '（未提供题面）'),
            codeHtml: esc(pkg.referenceCode || '（未提供参考程序，将仅使用题面样例）'),
            sampleHtml: esc(sampleText || '（未提供样例，无法校验参考程序）'),
            dataRows,
            countsText: `样例 ${samples.length} 组 · 分类数据 ${testData.length} 个（${coverage}）`,
            sourceText: String(pkg.source || '—'),
            notesText: String(pkg.notes || '—'),
            hasCode: !!String(pkg.referenceCode || '').trim(),
          },
        };
      });
    }
    // Precompute skipped-item labels too (Nunjucks has no `||` / `+`).
    let skippedLines: string[] = [];
    if (proposal?.result?.skippedItems) {
      skippedLines = proposal.result.skippedItems.map((s: any) => {
        const label = String(s?.pid || s?.title || (s?.docId ? `#${s.docId}` : '未命名'));
        return s?.group ? `${label} · ${s.group}` : label;
      });
    }
    // Execution detail so the admin knows exactly where the data landed.
    let resultLines: string[] = [];
    if (Array.isArray(proposal?.result?.details)) {
      resultLines = proposal.result.details.map((d: any) => {
        if (!d?.ok) return `✗ ${String(d?.title || '')}：${String(d?.error || '失败')}`;
        const where = d.mode === 'existing'
          ? `已写入原题 ${String(d.pid || '')}（docId ${String(d.docId)}）`
          : `已新建题目 docId ${String(d.docId)}（默认隐藏）`;
        const parts = [`测试文件 ${String(d.cases ?? 0)} 组`];
        if (d.removed) parts.push(`清理旧文件 ${d.removed} 个`);
        if (Array.isArray(d.warnings) && d.warnings.length) parts.push(`提示：${d.warnings.join('；')}`);
        return `✓ ${String(d?.title || '')}：${where}，${parts.join('，')}`;
      });
    }
    this.response.template = 'manage_ai_proposal_view.html';
    this.response.body = {
      page_name: 'manage_ai_proposal_view',
      page_title: '修改清单详情',
      proposal,
      items,
      skippedLines,
      resultLines,
      sudo: isSudo(this.session),
      notice: (this.request.query?.error) ? notice('error', String(this.request.query.error)) : null,
    };
  }
}

export class ProposalConfirmHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  async post() {
    if (denyWithoutSudo(this)) return;
    const who = identity(this);
    const body = this.request.body || {};
    const doc = await getProposal(String(this.args?.id || ''), who.uid);
    const reason = validateConfirm(doc, String(body.token || ''), who.uid, isSudo(this.session));
    if (reason || !doc) {
      this.response.status = 400;
      this.response.body = { ok: false, error: reason || '清单不存在' };
      return;
    }
    try {
      // Never trust the browser: indices are re-validated server-side.
      const selected = normalizeSelection(doc.items.length, body.selected);
      if (!selected.length) {
        this.response.status = 400;
        this.response.body = { ok: false, error: '请至少勾选一项；若整单都不做请点“拒绝此清单”。' };
        return;
      }
      const result = await executeProposal(doc, selected);
      await markProposal(doc, 'done', result, who.uid, who.uname, selected);
      this.response.body = { ok: true, result };
    } catch (e: any) {
      this.response.status = 400;
      this.response.body = { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  }
}

export class ProposalRejectHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
  }

  async post() {
    if (denyWithoutSudo(this)) return;
    const who = identity(this);
    const doc = await getProposal(String(this.args?.id || ''), who.uid);
    if (!doc || doc.uid !== who.uid || doc.status !== 'pending') {
      this.response.status = 400;
      this.response.body = { ok: false, error: '清单不存在或已处理' };
      return;
    }
    await markProposal(doc, 'rejected', { reason: '管理员拒绝' }, who.uid, who.uname);
    this.response.body = { ok: true };
  }
}

/** Kept for compatibility with the type import in S0. */
export function hasDatabase(): boolean {
  return !!state.db;
}
