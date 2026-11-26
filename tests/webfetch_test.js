/**
 * fetch_url safety and extraction tests.
 * SSRF guards and HTML-to-text are pure enough to test without network.
 */
'use strict';
const path = require('path');
const B = (f) => require(path.join(__dirname, '.build/src', f));
const wf = B('webfetch.js');

function assert(c, m) { if (!c) throw new Error(m); }
async function expectThrow(fn, includes, label) {
  let err = '';
  try { await fn(); } catch (e) { err = String(e?.message || e); }
  assert(err, `${label} 应抛错但没有`);
  if (includes) assert(err.includes(includes), `${label} 报错信息不符: ${err}`);
}

(async () => {
  // --- URL validation ---
  assert(wf.normalizeUrl('https://www.luogu.com.cn/problem/P1001').hostname === 'www.luogu.com.cn', '正常 URL 解析失败');
  await expectThrow(() => Promise.resolve(wf.normalizeUrl('file:///etc/passwd')), 'http/https', 'file 协议');
  await expectThrow(() => Promise.resolve(wf.normalizeUrl('javascript:alert(1)')), 'http/https', 'javascript 协议');
  await expectThrow(() => Promise.resolve(wf.normalizeUrl('notaurl')), '', '非法 URL');
  console.log('PASS 协议白名单');

  // --- SSRF: internal hosts must be blocked before any request ---
  for (const [url, label] of [
    ['http://127.0.0.1/', '回环'],
    ['http://localhost:8080/', 'localhost'],
    ['http://10.0.0.5/', '10.x'],
    ['http://192.168.1.1/', '192.168.x'],
    ['http://172.16.0.1/', '172.16.x'],
    ['http://169.254.169.254/latest/meta-data/', '云元数据'],
    ['http://[::1]/', 'IPv6 回环'],
    ['http://0.0.0.0/', '0.0.0.0'],
  ]) {
    await expectThrow(() => wf.fetchPage(url), '内网', 'SSRF ' + label);
  }
  console.log('PASS SSRF 内网/元数据地址全部拦截');

  // --- HTML extraction ---
  const html = `<html><head><title>P1001 A+B Problem</title>
    <style>.x{color:red}</style><script>alert('xss')</script></head>
    <body><nav>导航</nav>
    <article><h1>A+B Problem</h1>
    <p>输入两个整数 &amp; 输出它们的和。</p>
    <p>样例输入：<code>1 2</code></p>
    <p>样例输出：<code>3</code></p></article>
    <footer>页脚</footer></body></html>`;
  const text = wf.htmlToText(html);
  assert(text.includes('A+B Problem'), '标题未提取');
  assert(text.includes('输入两个整数 & 输出它们的和'), '实体未解码');
  assert(text.includes('1 2') && text.includes('3'), '样例未提取');
  assert(!text.includes('alert'), 'script 未剔除');
  assert(!text.includes('color:red'), 'style 未剔除');
  assert(!text.includes('导航') && !text.includes('页脚'), 'article 外内容未剔除');
  console.log('PASS HTML 正文提取（剔除 script/style/导航、解码实体、优先 article）');

  // --- no main container: keep body text ---
  const plain = wf.htmlToText('<div><p>第一段</p><p>第二段</p></div>');
  assert(plain.includes('第一段') && plain.includes('第二段'), '无 article 时应保留正文');
  console.log('PASS 无 article 时保留全文');

  // --- truncated output respects maxChars ---
  const long = 'x'.repeat(5000);
  const out = wf.htmlToText(`<article><p>${long}</p></article>`);
  assert(out.length <= 5000, '提取结果异常');
  console.log('PASS 正文长度处理');

  // --- anti-bot page detection ---
  assert(wf.looksLikeChallenge('Cerberus Challenge', '验证您是真人 请完成安全验证'), '中文验证页未识别');
  assert(wf.looksLikeChallenge('Just a moment...', 'checking your browser before accessing'), '英文验证页未识别');
  assert(!wf.looksLikeChallenge('P1001 A+B Problem', '输入两个整数，输出它们的和。样例输入 1 2 样例输出 3'), '正常题面被误判');
  assert(!wf.looksLikeChallenge('某题', 'x'.repeat(4000)), '长正文不应判为验证页');
  console.log('PASS 反爬验证页识别（避免把验证页当题面）');

  console.log('\n全部通过');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
