import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = path.join(import.meta.dirname, 'fixtures');
const SCRIPT = readFileSync(path.join(ROOT, 'trxs-reader.user.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 40));

/* 用一个独立 jsdom 实例借用脚本自带的 GBK 解码器 */
const boot = new JSDOM('<html><body></body></html>', {
  url: 'http://trxs.cc/', runScripts: 'outside-only', pretendToBeVisual: true
});
boot.window.GM_addStyle = () => {};
boot.window.GM_getValue = (k, d) => d;
boot.window.GM_setValue = () => {};
boot.window.GM_registerMenuCommand = () => {};
boot.window.GM_xmlhttpRequest = () => {};
boot.window.eval(SCRIPT);
const decoder = boot.window.__TRX__;

/** 读取线上抓取的 GB2312 原始页面并解码为 UTF-8 文本 */
const readFix = (n) => decoder.decodeBytes(new Uint8Array(readFileSync(path.join(FIX, n))));

function makeChapterHtml(base, bookId, index, total) {
  let html = base;
  html = html.replace(
    /<div class="pageNav">[\s\S]*?<\/div>/,
    '<div class="pageNav">\n' +
    '  <a href="/tongren/' + bookId + '/1.html">首章</a> ' +
    '<a href="/tongren/' + bookId + '/' + Math.max(1, index - 1) + '.html">上一章</a> ' +
    index + '/' + total +
    '<a href="/tongren/' + bookId + '/' + Math.min(total, index + 1) + '.html">下一章</a> ' +
    '<a href="/tongren/' + bookId + '/' + total + '.html">尾章</a> ' +
    '<a href="/tongren/' + bookId + '.html">目录</a>\n</div>'
  );
  html = html.replace(/<h1>[\s\S]*?<\/h1>/, '<h1>测试书名 第' + index + '章</h1>');
  html = html.replace(/<em>[\s\S]*?<\/em>/, '<em>作者：测试作者</em>');
  return html;
}

function buildSite(bookId, total, baseHtml, tocHtml) {
  const map = new Map();
  map.set('http://trxs.cc/tongren/' + bookId + '.html',
    tocHtml.replace(/articleId=12573/g, 'articleId=' + bookId));
  for (let i = 1; i <= total; i++) {
    map.set('http://trxs.cc/tongren/' + bookId + '/' + i + '.html',
      makeChapterHtml(baseHtml, bookId, i, total));
  }
  return map;
}

async function makeSiteDom(pageUrl, site) {
  const html = site.get(pageUrl) || '<html><body></body></html>';
  const dom = new JSDOM(html, { url: pageUrl, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const store = new Map();
  const requests = [];
  w.GM_addStyle = (css) => {
    const st = w.document.createElement('style');
    st.textContent = css;
    (w.document.head || w.document.documentElement).appendChild(st);
  };
  w.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  w.GM_setValue = (k, v) => { store.set(k, v); };
  w.GM_registerMenuCommand = () => {};
  w.GM_xmlhttpRequest = (opts) => {
    requests.push(opts.url);
    setTimeout(() => {
      const body = site.get(opts.url);
      if (body === undefined) { if (opts.onerror) opts.onerror({ status: 404 }); return; }
      // 走脚本自身的解码链路：把 UTF-8 文本转成字节再交给它
      const buf = Buffer.from(body, 'utf8');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      opts.onload({ status: 200, response: ab });
    }, 0);
  };
  w.__store__ = store;
  w.__requests__ = requests;
  w.eval(SCRIPT);
  await tick(40);
  return dom;
}

/** jsdom 无布局，手工注入滚动尺寸 */
function fakeScroll(w, height, clientHeight, scrollTop) {
  const main = w.document.querySelector('#trx-main');
  Object.defineProperty(main, 'scrollHeight', { value: height, configurable: true });
  Object.defineProperty(main, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(main, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  const secs = w.document.querySelectorAll('#trx-content .trx-chap');
  secs.forEach((s, i) => Object.defineProperty(s, 'offsetTop', { value: i * 900, configurable: true }));
  main.dispatchEvent(new w.Event('scroll'));
  return main;
}

/* ========================================================== */
console.log('\n[1] 打开阅读模式（真实抓取链路）');
/* ========================================================== */
const tocHtml = readFix('12573.html');
const chapterBase = readFix('12573_1.html');
const site = buildSite('12573', 98, chapterBase, tocHtml);
const dom = await makeSiteDom('http://trxs.cc/tongren/12573/1.html', site);
const w = dom.window;
const api = w.__TRX__;
const doc = w.document;

api.openReader(1);
await tick(150);

ok('请求了目录页', w.__requests__.some((u) => /\/tongren\/12573\.html$/.test(u)),
  w.__requests__.join(' | '));
ok('请求了第 1 章', w.__requests__.some((u) => /\/12573\/1\.html$/.test(u)));
ok('阅读器渲染出 1 章', doc.querySelectorAll('#trx-content .trx-chap').length === 1,
  'got ' + doc.querySelectorAll('#trx-content .trx-chap').length);
const firstSec = doc.querySelector('#trx-content .trx-chap');
ok('章节序号 data-index=1', firstSec.dataset.index === '1', firstSec.dataset.index);
ok('章节标题正确', /第1章/.test(firstSec.dataset.title), firstSec.dataset.title);
ok('段落已渲染', firstSec.querySelectorAll('p.trx-p').length >= 60,
  'got ' + firstSec.querySelectorAll('p.trx-p').length);
ok('顶栏书名', doc.querySelector('#trx-bar-title .trx-book').textContent.length > 0,
  doc.querySelector('#trx-bar-title .trx-book').textContent);
ok('总章数 = 98', api.state.total === 98, 'got ' + api.state.total);
ok('进度显示 1 / 98', /1\s*\/\s*98/.test(doc.querySelector('#trx-pos').textContent),
  doc.querySelector('#trx-pos').textContent);
ok('上一章按钮禁用', doc.querySelector('#trx-prev').disabled === true);
ok('下一章按钮可用', doc.querySelector('#trx-next').disabled === false);
ok('目录已渲染 98 项', doc.querySelectorAll('#trx-toc-list a').length === 98,
  'got ' + doc.querySelectorAll('#trx-toc-list a').length);
ok('目录当前项高亮', doc.querySelectorAll('#trx-toc-list a.trx-cur').length === 1);
ok('进度已保存', !!w.__store__.get('trxs:progress'),
  JSON.stringify(w.__store__.get('trxs:progress')));

/* ========================================================== */
console.log('\n[2] 自动连读（滚动到底部追加下一章）');
/* ========================================================== */
fakeScroll(w, 3000, 800, 0);
await tick(10);
ok('滚动不离底时不追加', doc.querySelectorAll('#trx-content .trx-chap').length === 1,
  'got ' + doc.querySelectorAll('#trx-content .trx-chap').length);

fakeScroll(w, 3000, 800, 2200);
await tick(120);
let secs = doc.querySelectorAll('#trx-content .trx-chap');
ok('触底追加第 2 章', secs.length === 2, 'got ' + secs.length);
ok('追加章节序号 = 2', secs[1] && secs[1].dataset.index === '2', secs[1] && secs[1].dataset.index);
ok('第 1 章仍在', secs[0].dataset.index === '1');

fakeScroll(w, 4600, 800, 3900);
await tick(120);
secs = doc.querySelectorAll('#trx-content .trx-chap');
ok('再次触底追加第 3 章', secs.length === 3, 'got ' + secs.length);
ok('追加后 lastIndex = 3', api.state.lastIndex === 3, 'got ' + api.state.lastIndex);
ok('进度条宽度更新', /%/.test(doc.querySelector('#trx-progress-bar').style.width),
  doc.querySelector('#trx-progress-bar').style.width);

const urls = w.__requests__.filter((u) => /\/12573\/\d+\.html$/.test(u));
const nInts = urls.map((u) => parseInt(u.match(/\/(\d+)\.html$/)[1], 10));
ok('章节请求无重复', new Set(nInts).size === nInts.length, urls.join(','));

fakeScroll(w, 5500, 800, 3900);
await tick(120);
ok('贴近底部时继续追加', doc.querySelectorAll('#trx-content .trx-chap').length === 4,
  'got ' + doc.querySelectorAll('#trx-content .trx-chap').length);
fakeScroll(w, 6400, 800, 3900);
await tick(120);
ok('远离底部时停止追加', doc.querySelectorAll('#trx-content .trx-chap').length === 4,
  'got ' + doc.querySelectorAll('#trx-content .trx-chap').length);

/* ========================================================== */
console.log('\n[3] 目录跳转（替换而不是追加）');
/* ========================================================== */
const tocLink = Array.from(doc.querySelectorAll('#trx-toc-list a'))
  .find((a) => parseInt(a.dataset.n, 10) === 50);
ok('目录中存在第 50 章', !!tocLink);
tocLink.dispatchEvent(new w.Event('click', { bubbles: true }));
await tick(150);
secs = doc.querySelectorAll('#trx-content .trx-chap');
ok('跳转后只剩 1 章', secs.length === 1, 'got ' + secs.length);
ok('跳转到第 50 章', secs[0].dataset.index === '50', secs[0].dataset.index);
ok('跳转后 firstIndex = 50', api.state.firstIndex === 50, 'got ' + api.state.firstIndex);
ok('跳转后进度 50 / 98', /50\s*\/\s*98/.test(doc.querySelector('#trx-pos').textContent),
  doc.querySelector('#trx-pos').textContent);

/* ========================================================== */
console.log('\n[4] 上一章 / 下一章按钮');
/* ========================================================== */
doc.querySelector('#trx-next').click();
await tick(150);
secs = doc.querySelectorAll('#trx-content .trx-chap');
ok('下一章 → 第 51 章', secs[0].dataset.index === '51', secs[0].dataset.index);

doc.querySelector('#trx-prev').click();
await tick(150);
secs = doc.querySelectorAll('#trx-content .trx-chap');
ok('上一章 → 第 50 章', secs[0].dataset.index === '50', secs[0].dataset.index);

/* ========================================================== */
console.log('\n[5] 末章边界');
/* ========================================================== */
api.loadChapter(98, false);
await tick(150);
secs = doc.querySelectorAll('#trx-content .trx-chap');
ok('载入最后一章', secs[0].dataset.index === '98', secs[0].dataset.index);
ok('末章时下一章按钮禁用', doc.querySelector('#trx-next').disabled === true);
fakeScroll(w, 2000, 800, 1200);
await tick(120);
ok('末章不再追加', doc.querySelectorAll('#trx-content .trx-chap').length === 1,
  'got ' + doc.querySelectorAll('#trx-content .trx-chap').length);

api.loadChapter(99, false);
await tick(150);
ok('越界章节加载失败但不清空正文',
  doc.querySelectorAll('#trx-content .trx-chap').length >= 1);

/* ========================================================== */
console.log('\n[6] 主题 / 字号 / 字体设置生效');
/* ========================================================== */
const reader = doc.querySelector('#trx-reader');
Array.from(doc.querySelectorAll('.trx-theme-btn')).forEach((b) => {
  if (b.dataset.theme === 'dark') b.dispatchEvent(new w.Event('click', { bubbles: true }));
});
await tick(30);
ok('主题切换为 dark', reader.dataset.theme === 'dark', reader.dataset.theme);

const fontEl = doc.querySelector('#set-font');
fontEl.value = '26';
fontEl.dispatchEvent(new w.Event('input'));
await tick(30);
ok('字号变量 = 26px', reader.style.getPropertyValue('--trx-fs') === '26px',
  reader.style.getPropertyValue('--trx-fs'));
ok('字号写入存储', w.__store__.get('trxs:settings').fontSize === 26,
  String(w.__store__.get('trxs:settings').fontSize));

const famEl = doc.querySelector('#set-family');
famEl.value = 'song';
famEl.dispatchEvent(new w.Event('change'));
await tick(30);
ok('字体切换为宋体', /Songti|SimSun/.test(reader.style.fontFamily), reader.style.fontFamily);

/* ========================================================== */
console.log('\n[7] 目录搜索过滤');
/* ========================================================== */
const searchEl = doc.querySelector('#trx-toc-search');
searchEl.value = '33';
searchEl.dispatchEvent(new w.Event('input'));
await tick(30);
const visible = Array.from(doc.querySelectorAll('#trx-toc-list a'))
  .filter((a) => a.style.display !== 'none');
ok('搜索 33 → 仅编号含 33 可见', visible.every((a) => a.dataset.n.includes('33')),
  'got ' + visible.map((a) => a.dataset.n).join(','));
searchEl.value = '';
searchEl.dispatchEvent(new w.Event('input'));
await tick(30);
ok('清空搜索恢复全部',
  Array.from(doc.querySelectorAll('#trx-toc-list a')).every((a) => a.style.display === ''),
  'visible=' + Array.from(doc.querySelectorAll('#trx-toc-list a')).filter((a) => a.style.display !== 'none').length);

/* ========================================================== */
console.log('\n[8] 键盘快捷键');
/* ========================================================== */
api.loadChapter(50, false);
await tick(150);
const before = api.state.firstIndex;
ok('快捷键测试基准 = 50', before === 50, 'got ' + before);
doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
await tick(150);
ok('→ 切到下一章', api.state.firstIndex === before + 1, before + ' -> ' + api.state.firstIndex);
doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
await tick(150);
ok('← 切回上一章', api.state.firstIndex === before, before + ' -> ' + api.state.firstIndex);

/* ========================================================== */
console.log('\n[9] 退出阅读模式');
/* ========================================================== */
api.closeReader();
await tick(40);
ok('隐藏阅读器', doc.querySelector('#trx-reader').style.display === 'none',
  doc.querySelector('#trx-reader').style.display);
ok('移除 trx-open', !doc.documentElement.classList.contains('trx-open'));
ok('悬浮按钮恢复显示', doc.querySelector('#trx-fab') &&
  doc.querySelector('#trx-fab').style.display === 'flex');

/* ========================================================== */
console.log('\n[10] 进度恢复');
/* ========================================================== */
w.__store__.set('trxs:progress', { 12573: { index: 20, title: 'x', total: 98, ts: 1 } });
api.openReader(null);
await tick(180);
secs = doc.querySelectorAll('#trx-content .trx-chap');
ok('恢复到上次阅读的第 20 章', secs[0].dataset.index === '20', secs[0].dataset.index);

/* ========================================================== */
console.log('\n=========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过 ✅');
