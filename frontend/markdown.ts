/**
 * Tiny dependency-free Markdown renderer for AI answers.
 * Pure string functions only (no DOM), so it can be unit-tested offline.
 * All source text is HTML-escaped before any markup is generated.
 */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => {
    const map: any = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[ch] || ch;
  });
}

export function inlineMd(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return out;
}

export function mdTable(rows: string[][]): string {
  if (!rows.length) return '';
  const head = rows[0];
  let html = '<div class="aiws__md-table-wrap"><table class="aiws__md-table"><thead><tr>';
  for (const cell of head) html += `<th>${inlineMd(cell)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of rows.slice(1)) {
    html += '<tr>';
    for (const cell of row) html += `<td>${inlineMd(cell)}</td>`;
    html += '</tr>';
  }
  return `${html}</tbody></table></div>`;
}

export function renderMarkdown(text: string): string {
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  let inCode = false;
  const code: string[] = [];
  let table: string[][] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  const flushTable = () => {
    if (table.length) { out.push(mdTable(table)); table = []; }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      flushTable(); closeList();
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code.length = 0;
        inCode = false;
      } else inCode = true;
      continue;
    }
    if (inCode) { code.push(line); continue; }

    if (/^\|.*\|\s*$/.test(trimmed)) {
      closeList();
      if (/^\|[\s:|-]+\|$/.test(trimmed) && trimmed.includes('-')) continue;
      table.push(trimmed.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
      continue;
    }
    flushTable();

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (bullet || ordered) {
      const type = bullet ? 'ul' : 'ol';
      if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type; }
      out.push(`<li>${inlineMd((bullet || ordered)![1])}</li>`);
      continue;
    }
    closeList();
    if (/^>\s?/.test(trimmed)) {
      out.push(`<blockquote>${inlineMd(trimmed.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (!trimmed) continue;
    out.push(`<p>${inlineMd(trimmed)}</p>`);
  }
  flushTable();
  closeList();
  if (inCode && code.length) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return out.join('');
}
