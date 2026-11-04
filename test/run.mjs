import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = path.join(import.meta.dirname, 'fixtures');
const SCRIPT = readFileSync(path.join(ROOT, 'trxs-reader.user.js'), 'utf8');

/** 样本是站点原始 GB2312 字节，必须走脚本自带的解码器，不能按 UTF-8 直读 */
let _decoder = null;
function decoder() {
  if (_decoder) return _decoder;
  const dom = new JSDOM('<html><body></body></html>', {
    url: 'http://trxs.cc/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  w.GM_addStyle = () => {};
  w.GM_getValue = (k, d) => d;
  w.GM_setValue = () => {};
  w.GM_registerMenuCommand = () => {};
  w.GM_xmlhttpRequest = () => {};
  w.eval(SCRIPT);
  _decoder = w.__TRX__;
  return _decoder;
}
const readFix = (n) => decoder().decodeBytes(new Uint8Array(readFileSync(path.join(FIX, n))));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

function makeDom(html, url) {
  const dom = new JSDOM(html, {
    url: url || 'http://trxs.cc/tongren/12573/1.html',
    runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const store = new Map();
  w.GM_addStyle = (css) => {
    const st = w.document.createElement('style');
    st.textContent = css;
    (w.document.head || w.document.documentElement).appendChild(st);
  };
  w.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  w.GM_setValue = (k, v) => { store.set(k, v); };
  w.GM_registerMenuCommand = () => {};
  w.GM_xmlhttpRequest = () => {};
  w.__store__ = store;
  w.eval(SCRIPT);
  return dom;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 40));
async function makeReadyDom(html, url) { const d = makeDom(html, url); await tick(40); return d; }

/* ------------------------------------------------------------------ */
console.log('\n[1] 章节正文解析');
/* ------------------------------------------------------------------ */
const cases = [
  { file: '12573_1.html', url: 'http://trxs.cc/tongren/12573/1.html', index: 1, total: 98, minP: 60 },
  { file: '12573_50.html', url: 'http://trxs.cc/tongren/12573/50.html', index: 50, total: 98, minP: 60 },
  { file: '12573_98.html', url: 'http://trxs.cc/tongren/12573/98.html', index: 98, total: 98, minP: 60 },
  { file: '12554_338.html', url: 'http://trxs.cc/tongren/12554/338.html', index: 338, total: 338, minP: 10 }
];

for (const c of cases) {
  const raw = readFix(c.file);
  const dom = makeDom(raw, c.url);
  const api = dom.window.__TRX__;
  if (!api) { ok(c.file + ' 脚本可执行', false, '__TRX__ 未定义'); continue; }
  ok(c.file + ' 脚本可执行', true);

  const data = api.parseChapter(raw, c.url);
  ok(c.file + ' 解析成功', !!data);
  if (!data) continue;

  ok(c.file + ' 章节序号', data.index === c.index, 'got ' + data.index);
  ok(c.file + ' 总章数', data.total === c.total, 'got ' + data.total);
  ok(c.file + ' bookId', data.bookId === String(c.url.match(/tongren\/(\d+)/)[1]), 'got ' + data.bookId);
  ok(c.file + ' 书名提取', data.bookTitle.length > 0 && !/第\s*\d+\s*章/.test(data.bookTitle), data.bookTitle);
  ok(c.file + ' 段落数 >= ' + c.minP, data.nodes.length >= c.minP, 'got ' + data.nodes.length);

  const text = data.nodes.map((n) => n.textContent).join('\n');
  ok(c.file + ' 无「上一篇/下一篇」', !/上一篇|下一篇/.test(text));
  ok(c.file + ' 无「首章/尾章/目录」', !/(^|\n)(首章|尾章|目录)(\n|$)/.test(text));
  ok(c.file + ' 无段首全角空格', !data.nodes.some((n) => /^\u3000/.test(n.textContent)));
  ok(c.file + ' 无空段残留(尾部)',
    !(data.nodes.length > 0 && /trx-blank/.test(data.nodes[data.nodes.length - 1].className)));
  ok(c.file + ' 章节短标题', (api.shortTitle(data) || '').length > 0, api.shortTitle(data));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[2] 目录解析');
/* ------------------------------------------------------------------ */
{
  const raw = readFix('12573.html');
  const dom = makeDom(raw, 'http://trxs.cc/tongren/12573.html');
  const doc = new dom.window.DOMParser().parseFromString(raw, 'text/html');
  const re = /^\/tongren\/(\d+)\/(\d+)\.html$/i;
  const ns = Array.from(doc.querySelectorAll('.book_list a[href]'))
    .map((a) => { const m = re.exec(a.getAttribute('href') || ''); return m ? parseInt(m[2], 10) : null; })
    .filter(Boolean);
  ok('目录链接数 = 98', ns.length === 98, 'got ' + ns.length);
  ok('目录首项 = 1', ns[0] === 1, 'got ' + ns[0]);
  ok('目录末项 = 98', ns[ns.length - 1] === 98, 'got ' + ns[ns.length - 1]);
  ok('目录连续', ns.every((v, i) => i === 0 || v === ns[i - 1] + 1));
  dom.window.close();
}
{
  const raw = readFix('12554.html');
  const dom = makeDom(raw, 'http://trxs.cc/tongren/12554.html');
  const doc = new dom.window.DOMParser().parseFromString(raw, 'text/html');
  const re = /^\/tongren\/(\d+)\/(\d+)\.html$/i;
  const ns = Array.from(doc.querySelectorAll('.book_list a[href]'))
    .map((a) => { const m = re.exec(a.getAttribute('href') || ''); return m ? parseInt(m[2], 10) : null; })
    .filter(Boolean);
  ok('大书目录链接数 = 338', ns.length === 338, 'got ' + ns.length);
  ok('大书目录末项 = 338', ns[ns.length - 1] === 338, 'got ' + ns[ns.length - 1]);
  const h1 = doc.querySelector('.book_info h1');
  const clean = (h1.textContent || '').replace(/[（(]\s*\d+\s*[-~]\s*\d+\s*[)）]/, '').trim();
  ok('书名去掉 (1-1018)', !/1018/.test(clean), clean);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[3] 广告清理 / 标记');
/* ------------------------------------------------------------------ */
{
  const html = readFix('12573_1.html').replace(
    '</body>',
    '<div class="membershow" id="membershow">注册 登陆</div>' +
    '<div id="div-gpt-ad-1">AD</div>' +
    '<script src="https://cpt.geniee.jp/hb/v1/237488/3583/wrapper.min.js"></script>' +
    '<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>' +
    '<script src="https://www.googletagmanager.com/gtag/js?id=G-x"></script>' +
    '<ins class="adsbygoogle"></ins>' +
    '<div class="hotlist"><h3>推荐阅读!</h3></div>' +
    '<iframe style="position:absolute;height:1px;width:1px" src="about:blank"></iframe>' +
    '</body>'
  );
  const dom = await makeReadyDom(html, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  ok('root 有 trxs-noads', w.document.documentElement.classList.contains('trxs-noads'));
  ok('root 有 trxs-nohot', w.document.documentElement.classList.contains('trxs-nohot'));
  ok('无 geniee 脚本', w.document.querySelectorAll('script[src*="geniee"]').length === 0);
  ok('无 gpt.js 脚本', w.document.querySelectorAll('script[src*="doubleclick"]').length === 0);
  ok('无 gtag 脚本', w.document.querySelectorAll('script[src*="googletagmanager"]').length === 0);
  ok('无 div-gpt-ad', w.document.querySelectorAll('[id^="div-gpt-ad"]').length === 0);
  ok('无 adsbygoogle', w.document.querySelectorAll('ins.adsbygoogle').length === 0);
  ok('保留 Cloudflare iframe', w.document.querySelectorAll('iframe').length === 1,
    'got ' + w.document.querySelectorAll('iframe').length);
  const css = Array.from(w.document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
  ok('CSS 隐藏 membershow', /trxs-noads .membershow/.test(css));
  ok('CSS 隐藏 hotlist', /trxs-nohot .hotlist/.test(css));
  ok('CSS 有夜间覆盖 body', /html\.trxs-dark body[^}]*15161a/i.test(css));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[4] document.write 广告拦截');
/* ------------------------------------------------------------------ */
{
  const dom = makeDom(readFix('12573_1.html'), 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  ok('isAdUrl 识别 geniee', api.isAdUrl('https://cpt.geniee.jp/hb/v1/x/wrapper.min.js') === true);
  ok('isAdUrl 识别 gpt.js', api.isAdUrl('https://securepubads.g.doubleclick.net/tag/js/gpt.js') === true);
  ok('isAdUrl 识别 gtag', api.isAdUrl('https://www.googletagmanager.com/gtag/js?id=G-x') === true);
  ok('isAdUrl 放行站内脚本', api.isAdUrl('/skin/default/js/hbao.js') === false);
  ok('isAdUrl 放行 CF', api.isAdUrl('cloudflareinsights.com/cdn-cgi/rum') === false);
  ok('isAdUrl 空值安全', api.isAdUrl(null) === false && api.isAdUrl(undefined) === false);

  w.document.write('<script src="https://cpt.geniee.jp/hb/v1/x/wrapper.min.js"><\/script>');
  ok('document.write 拦掉广告脚本',
    w.document.querySelectorAll('script[src*="geniee"]').length === 0);
  w.document.write('<span id="legit-write">ok</span>');
  ok('正常 document.write 放行', !!w.document.querySelector('#legit-write'));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[5] 夜间模式切换');
/* ------------------------------------------------------------------ */
{
  const dom = await makeReadyDom('<html><body class="reading"></body></html>', 'http://trxs.cc/');
  const w = dom.window;
  const api = w.__TRX__;
  ok('初始无 trxs-dark', !w.document.documentElement.classList.contains('trxs-dark'));
  api.settings.darkNative = true;
  api.applyNativeFlags();
  ok('开启后有 trxs-dark', w.document.documentElement.classList.contains('trxs-dark'));
  api.settings.darkNative = false;
  api.applyNativeFlags();
  ok('关闭后无 trxs-dark', !w.document.documentElement.classList.contains('trxs-dark'));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[6] URL 识别');
/* ------------------------------------------------------------------ */
{
  const dom = makeDom('<html><body></body></html>', 'http://trxs.cc/tongren/12573/1.html');
  ok('章节页识别', dom.window.__TRX__.pageInfo().kind === 'chapter',
    JSON.stringify(dom.window.__TRX__.pageInfo()));
  dom.window.close();
}
{
  const dom = makeDom('<html><body></body></html>', 'http://trxs.cc/tongren/12573.html');
  const info = dom.window.__TRX__.pageInfo();
  ok('目录页识别', info.kind === 'book' && info.bookId === '12573', JSON.stringify(info));
  dom.window.close();
}
{
  const dom = makeDom('<html><body></body></html>', 'http://trxs.cc/tongren/');
  ok('列表页不误判', dom.window.__TRX__.pageInfo().kind === 'other',
    JSON.stringify(dom.window.__TRX__.pageInfo()));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[7] 阅读器 DOM 构建');
/* ------------------------------------------------------------------ */
{
  const dom = makeDom(readFix('12573_1.html'), 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  w.__TRX__.openReader(1);
  await tick(60);
  const doc = w.document;
  ok('reader 存在', !!doc.querySelector('#trx-reader'));
  ok('bar 存在', !!doc.querySelector('#trx-bar'));
  ok('toc 面板存在', !!doc.querySelector('#trx-toc'));
  ok('settings 面板存在', !!doc.querySelector('#trx-set'));
  ok('pager 存在', !!doc.querySelector('#trx-pager'));
  ok('主题按钮 5 个', doc.querySelectorAll('.trx-theme-btn').length === 5,
    'got ' + doc.querySelectorAll('.trx-theme-btn').length);
  ok('字号滑块范围 14-34',
    doc.querySelector('#set-font').min === '14' && doc.querySelector('#set-font').max === '34');
  ok('默认主题 light', doc.querySelector('#trx-reader').dataset.theme === 'light');
  ok('html 有 trx-open', doc.documentElement.classList.contains('trx-open'));

  // 固定行为不做成开关：设置面板里不应再出现这 4 项
  ok('无「去广告」开关', !doc.querySelector('#set-noads'));
  ok('无「隐藏推荐」开关', !doc.querySelector('#set-nohot'));
  ok('无「悬浮按钮」开关', !doc.querySelector('#set-fab'));
  ok('无「跟随系统」开关', !doc.querySelector('#set-autodark'));
  ok('保留「自动连读」开关', !!doc.querySelector('#set-auto'));

  // 字号改为 A+ / A− 两个独立按钮
  ok('有 A+ 放大按钮', !!doc.querySelector('#trx-btn-font-up'),
    doc.querySelector('#trx-btn-font-up') && doc.querySelector('#trx-btn-font-up').textContent);
  ok('有 A− 缩小按钮', !!doc.querySelector('#trx-btn-font-down'),
    doc.querySelector('#trx-btn-font-down') && doc.querySelector('#trx-btn-font-down').textContent);
  ok('旧 A± 按钮已移除', !doc.querySelector('#trx-btn-font'));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[7b] A+ / A− 字号增减');
/* ------------------------------------------------------------------ */
{
  const dom = makeDom(readFix('12573_1.html'), 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const doc = w.document;
  w.__TRX__.openReader(1);
  await tick(60);
  const reader = doc.querySelector('#trx-reader');

  doc.querySelector('#trx-btn-font-up').dispatchEvent(new w.Event('click', { bubbles: true }));
  await tick(20);
  ok('A+ 放大到 21px', w.__TRX__.settings.fontSize === 21, 'got ' + w.__TRX__.settings.fontSize);
  ok('A+ 后 CSS 变量同步', reader.style.getPropertyValue('--trx-fs') === '21px',
    reader.style.getPropertyValue('--trx-fs'));

  doc.querySelector('#trx-btn-font-down').dispatchEvent(new w.Event('click', { bubbles: true }));
  await tick(20);
  ok('A− 缩回 19px', w.__TRX__.settings.fontSize === 19, 'got ' + w.__TRX__.settings.fontSize);
  doc.querySelector('#trx-btn-font-down').dispatchEvent(new w.Event('click', { bubbles: true }));
  await tick(20);
  ok('A− 继续缩到 18px', w.__TRX__.settings.fontSize === 18, 'got ' + w.__TRX__.settings.fontSize);
  ok('A− 同步滑块值', doc.querySelector('#set-font').value === '18',
    doc.querySelector('#set-font').value);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[7c] 字号边界不越界');
/* ------------------------------------------------------------------ */
{
  const dom = makeDom(readFix('12573_1.html'), 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  w.__TRX__.openReader(1);
  await tick(60);

  api.settings.fontSize = 16; // 最小档
  for (let i = 0; i < 6; i++) api.stepFontSize(-1);
  ok('已是最小档时 A− 不越界', api.settings.fontSize === 16, 'got ' + api.settings.fontSize);

  api.settings.fontSize = 29; // 最大档
  for (let i = 0; i < 6; i++) api.stepFontSize(1);
  ok('已是最大档时 A+ 不越界', api.settings.fontSize === 29, 'got ' + api.settings.fontSize);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[8] 设置持久化');
/* ------------------------------------------------------------------ */
{
  const dom = makeDom(readFix('12573_1.html'), 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  api.settings.fontSize = 26;
  api.settings.theme = 'sepia';
  w.GM_setValue('trxs:settings', api.settings);
  const raw = w.__store__.get('trxs:settings');
  ok('设置写入 store', typeof raw === 'object' && raw.fontSize === 26, JSON.stringify(raw.fontSize));
  const dom2 = makeDom(readFix('12573_1.html'), 'http://trxs.cc/tongren/12573/1.html');
  ok('新实例用默认值', dom2.window.__TRX__.settings.fontSize === 19,
    'got ' + dom2.window.__TRX__.settings.fontSize);
  dom.window.close();
  dom2.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[9] GB2312 解码');
/* ------------------------------------------------------------------ */
{
  const dom = makeDom('<html><body></body></html>', 'http://trxs.cc/');
  const api = dom.window.__TRX__;
  const metaBytes = new Uint8Array([60,109,101,116,97,32,99,104,97,114,115,101,116,61,103,98,50,51,49,50,62]);
  ok('charset 嗅探 gbk', api.sniffCharset(metaBytes) === 'gbk', api.sniffCharset(metaBytes));
  const buf = Buffer.from('中文测试', 'utf8');
  ok('UTF-8 字节可解码',
    api.decodeBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)) === '中文测试');
  ok('GBK 字节可解码为中文', api.decodeBytes(new Uint8Array([0xD6,0xD0,0xCE,0xC4])) === '中文',
    api.decodeBytes(new Uint8Array([0xD6,0xD0,0xCE,0xC4])));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n=========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过 ✅');
