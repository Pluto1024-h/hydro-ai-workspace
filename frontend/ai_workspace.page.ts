import { addPage, AutoloadPage } from '@hydrooj/ui-default';
import { renderMarkdown } from './markdown';

let root: HTMLElement | null = null;
let sessionId = '';
let busy = false;
let controller: AbortController | null = null;

const STORE_DRAFT = 'aiws.draft.v1';
const STORE_SESSION = 'aiws.session.v1';

function readStore(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function writeStore(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

function select(selector: string): HTMLElement | null {
  return root ? root.querySelector(selector) as HTMLElement | null : null;
}

function make(tag: string, className = '', text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setBodyText(body: HTMLElement, text: string, markdown: boolean): void {
  body.dataset.raw = text;
  if (markdown) body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
}

/* Tool calls are kept in a collapsed details block so they never push the
   actual answer off-screen. Failures still surface as normal message bubbles. */
let currentProcess: HTMLElement | null = null;
let processCount = 0;

function createProcess(): HTMLElement | null {
  const box = select('#aiws-messages');
  if (!box) return null;
  const details = document.createElement('details');
  details.className = 'aiws__process';
  const summary = make('summary', 'aiws__process-summary', '工具调用过程');
  details.appendChild(summary);
  const body = make('div', 'aiws__process-body');
  details.appendChild(body);
  box.appendChild(details);
  return body;
}

function noteProcess(body: HTMLElement): void {
  processCount++;
  const summary = body.parentElement?.querySelector('summary');
  if (summary) summary.textContent = `工具调用过程（${processCount}）`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path: string, options: any = {}): Promise<any> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data: any = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) throw data;
  return data;
}

function scrollToBottom(): void {
  const box = select('#aiws-messages');
  if (box) box.scrollTop = box.scrollHeight;
}

function addBubble(role: string, text: string, markdown = false): HTMLElement {
  const box = select('#aiws-messages');
  if (!box) return make('div');
  const empty = box.querySelector('.aiws__empty');
  if (empty) empty.remove();
  const wrap = make('div', `aiws__bubble aiws__bubble--${role}`);
  wrap.appendChild(make('div', 'aiws__bubble-role', role === 'user' ? '我' : role === 'tool' ? '工具' : 'AI'));
  const body = make('div', 'aiws__bubble-body');
  setBodyText(body, text, markdown || role === 'assistant');
  wrap.appendChild(body);
  box.appendChild(wrap);
  scrollToBottom();
  return body;
}

function addChip(name: string, args: any): void {
  const box = select('#aiws-messages');
  if (!box) return;
  const chip = make('div', 'aiws__chip');
  chip.appendChild(make('span', 'aiws__chip-name', name));
  chip.appendChild(make('span', 'aiws__chip-args', JSON.stringify(args || {}).slice(0, 180)));
  (currentProcess || box).appendChild(chip);
  if (currentProcess) noteProcess(currentProcess);
  scrollToBottom();
}

function addResultCard(artifactId: string, kind: string): void {
  const box = select('#aiws-messages');
  if (!box) return;
  const card = make('div', 'aiws__card');
  card.appendChild(make('span', 'aiws__card-tag', kind === 'stats' ? '统计' : kind === 'code' ? '代码' : '数据'));
  card.appendChild(make('span', 'aiws__card-text', `结果编号 ${artifactId.slice(0, 8)}…`));
  const button = make('button', 'button aiws__card-btn', '查看详情') as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', async () => {
    try {
      const data = await api(`/-/ai-workspace/artifact/${artifactId}`);
      showModal('结果详情', JSON.stringify(data.data, null, 2));
    } catch (e: any) {
      showModal('结果详情', e?.message || '结果已过期');
    }
  });
  card.appendChild(button);
  (currentProcess || box).appendChild(card);
  if (currentProcess) noteProcess(currentProcess);
  scrollToBottom();
}

function showModal(title: string, body: string): void {
  const modal = select('#aiws-modal');
  if (!modal) return;
  const titleNode = select('#aiws-modal-title');
  const bodyNode = select('#aiws-modal-body');
  if (titleNode) titleNode.textContent = title;
  if (bodyNode) bodyNode.textContent = body.slice(0, 30000);
  modal.removeAttribute('hidden');
}

function hideModal(): void {
  const modal = select('#aiws-modal');
  if (modal) modal.setAttribute('hidden', '');
}

async function refreshAudit(): Promise<void> {
  const target = select('#aiws-audit');
  if (!target) return;
  try {
    const data = await api('/-/ai-workspace/audit');
    const logs = data.logs || [];
    target.textContent = '';
    if (!logs.length) {
      target.appendChild(make('div', 'aiws__muted', '暂无审计记录'));
      return;
    }
    for (const log of logs.slice(0, 10)) {
      const row = make('div', 'aiws__audit-row');
      row.appendChild(make('span', 'aiws__audit-action', String(log.action || '')));
      row.appendChild(make('span', 'aiws__audit-time', String(log.createdAt || '').slice(0, 16).replace('T', ' ')));
      target.appendChild(row);
    }
  } catch {
    target.textContent = '审计载入失败';
  }
}

function applySessionList(sessions: any[]): void {
  const target = select('#aiws-sessions');
  if (!target) return;
  target.textContent = '';
  if (!sessions.length) {
    target.appendChild(make('span', 'aiws__muted', '暂无历史会话'));
    return;
  }
  for (const item of sessions.slice(0, 20)) {
    const id = String(item._id || item.id || '');
    const button = make('button', 'aiws__session-item', `${String(item.updatedAt || '').slice(5, 16).replace('T', ' ')} · ${id.slice(0, 6)}`) as HTMLButtonElement;
    button.type = 'button';
    if (id === sessionId) button.classList.add('active');
    button.addEventListener('click', () => {
      if (!busy) openSession(id).catch((e) => addBubble('assistant', e?.message || '载入会话失败'));
    });
    target.appendChild(button);
  }
}

function renderMessages(messages: any[]): void {
  const box = select('#aiws-messages');
  if (!box) return;
  box.textContent = '';
  currentProcess = null;
  processCount = 0;
  if (!messages.length) {
    box.appendChild(make('div', 'aiws__empty', '新会话已创建，请输入问题。'));
    return;
  }
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    addBubble(msg.role === 'user' ? 'user' : 'assistant', String(msg.content || ''), msg.role === 'assistant');
  }
  scrollToBottom();
}

async function openSession(id: string): Promise<void> {
  const data = await api(`/-/ai-workspace/session/${encodeURIComponent(id)}`);
  sessionId = data.sessionId || id;
  writeStore(STORE_SESSION, sessionId);
  renderMessages(data.messages || []);
  applySessionList(data.sessions || []);
  const context = select('#aiws-context');
  if (context) context.textContent = `会话 ${sessionId.slice(0, 8)}…（${(data.messages || []).length} 条历史消息）`;
}

async function newSession(): Promise<void> {
  const data = await api('/-/ai-workspace/sessions/new', { method: 'POST', body: '{}' });
  sessionId = data.sessionId || '';
  writeStore(STORE_SESSION, sessionId);
  writeStore(STORE_DRAFT, '');
  currentProcess = null;
  processCount = 0;
  const box = select('#aiws-messages');
  if (box) box.innerHTML = '<div class="aiws__empty">新会话已创建，请输入问题。</div>';
  const context = select('#aiws-context');
  if (context) context.textContent = `会话 ${sessionId.slice(0, 8)}…（只读工具）`;
  const input = select('#aiws-input') as HTMLTextAreaElement | null;
  if (input) input.value = '';
  try { const list = await api('/-/ai-workspace/session/' + encodeURIComponent(sessionId)); applySessionList(list.sessions || []); } catch { /* ignore */ }
}

async function playEvents(events: any[], bubble: HTMLElement): Promise<void> {
  for (const event of events || []) {
    if (controller?.signal.aborted) break;
    if (event.type === 'delta') {
      setBodyText(bubble, (bubble.dataset.raw || '') + (event.content || ''), true);
    } else if (event.type === 'tool_call') {
      addChip(event.name, event.arguments);
    } else if (event.type === 'artifact') {
      addResultCard(event.artifactId, event.kind);
    } else if (event.type === 'tool_result' && event.result && !event.result.ok) {
      addBubble('tool', event.result.summary || '工具执行失败');
    }
    scrollToBottom();
    await sleep(90);
  }
}

async function sendMessage(): Promise<void> {
  if (busy) return;
  const input = select('#aiws-input') as HTMLTextAreaElement | null;
  const message = (input?.value || '').trim();
  if (!message) return;
  if (!sessionId) {
    addBubble('assistant', '会话尚未就绪，请刷新页面重试。');
    return;
  }

  busy = true;
  controller = new AbortController();
  const sendButton = select('#aiws-send') as HTMLButtonElement | null;
  const stopButton = select('#aiws-stop') as HTMLButtonElement | null;
  if (sendButton) sendButton.disabled = true;
  if (stopButton) stopButton.disabled = false;
  if (input) { input.value = ''; writeStore(STORE_DRAFT, ''); }
  addBubble('user', message);
  const bubble = addBubble('assistant', '正在分析…', true);
  currentProcess = createProcess();
  processCount = 0;

  try {
    const data = await api('/-/ai-workspace/chat', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ sessionId, message }),
    });
    setBodyText(bubble, '', true);
    await playEvents(data.events || [], bubble);
    if (!(bubble.dataset.raw || '').trim()) setBodyText(bubble, data.assistantContent || '已完成。', true);
    sessionId = data.sessionId || sessionId;
    writeStore(STORE_SESSION, sessionId);
    await refreshAudit();
  } catch (e: any) {
    if (e?.error === 'sudo_required') {
      setBodyText(bubble, '身份已过期，请点击下方按钮重新验证。', false);
      const link = make('a', 'button aiws__sudo-link', '重新验证');
      link.setAttribute('href', '/manage/ai-workspace');
      bubble.appendChild(link);
    } else if (e?.name === 'AbortError') {
      setBodyText(bubble, '已停止。', false);
    } else {
      setBodyText(bubble, `错误：${e?.message || e?.error || '未知错误'}`, false);
    }
  } finally {
    if (currentProcess && !currentProcess.childElementCount) currentProcess.parentElement?.remove();
    currentProcess = null;
    busy = false;
    controller = null;
    if (sendButton) sendButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
  }
}

function init(element: HTMLElement): void {
  if ((element as any).__aiwsReady) return;
  (element as any).__aiwsReady = true;
  root = element;

  const sendButton = select('#aiws-send');
  const stopButton = select('#aiws-stop');
  const newButton = select('#aiws-new');
  const input = select('#aiws-input') as HTMLTextAreaElement | null;
  const closeButton = select('#aiws-modal-close');

  sendButton?.addEventListener('click', sendMessage);
  newButton?.addEventListener('click', () => {
    if (!busy) newSession().catch((e) => addBubble('assistant', e?.message || '新建会话失败'));
  });
  stopButton?.addEventListener('click', () => controller?.abort());
  closeButton?.addEventListener('click', hideModal);
  input?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  input?.addEventListener('input', () => writeStore(STORE_DRAFT, input.value));

  const savedDraft = readStore(STORE_DRAFT);
  if (input && savedDraft) { input.value = savedDraft; input.focus(); }

  const savedSession = readStore(STORE_SESSION);
  if (savedSession) {
    openSession(savedSession).catch(() => newSession().catch((e) => {
      const box = select('#aiws-messages');
      if (box) box.textContent = e?.message || '会话初始化失败';
    }));
  } else {
    newSession().catch((e) => {
      const box = select('#aiws-messages');
      if (box) box.textContent = e?.message || '会话初始化失败';
    });
  }
  refreshAudit();
}

addPage(new AutoloadPage('ai_workspace', () => {
  const element = document.querySelector('#ai-workspace-root') as HTMLElement | null;
  if (element) init(element);
}));
