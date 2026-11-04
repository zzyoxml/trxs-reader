import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = path.join(import.meta.dirname, 'fixtures');
const SCRIPT = readFileSync(path.join(ROOT, 'trxs-reader.user.js'), 'utf8');
const readFix = (n) => readFileSync(path.join(FIX, n));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

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
const api = w.__TRX__;

/** 线上原始 GB2312 字节 → 走脚本自身解码路径 */
const live = (n) => api.decodeBytes(new Uint8Array(readFix(n)));

console.log('\n[F1] 线上章节页（原始 GBK 字节 → 解码 → 解析）');
const chapters = [
  { f: '12573_1.html', url: 'http://trxs.cc/tongren/12573/1.html', idx: 1, total: 98 },
  { f: '12573_50.html', url: 'http://trxs.cc/tongren/12573/50.html', idx: 50, total: 98 },
  { f: '12573_98.html', url: 'http://trxs.cc/tongren/12573/98.html', idx: 98, total: 98 },
  { f: '12554_338.html', url: 'http://trxs.cc/tongren/12554/338.html', idx: 338, total: 338 }
];
for (const c of chapters) {
  const html = live(c.f);
  ok(c.f + ' 解码含中文', /[\u4e00-\u9fa5]/.test(html));
  ok(c.f + ' 无乱码特征', !/[ÃÂÅÄÆÇ][\u0080-\u00bf]/.test(html));
  ok(c.f + ' 声明 gb charset', /charset\s*=\s*["']?gb/i.test(html));

  const data = api.parseChapter(html, c.url);
  ok(c.f + ' 解析成功', !!data);
  if (!data) continue;
  ok(c.f + ' 序号 ' + c.idx, data.index === c.idx, 'got ' + data.index);
  ok(c.f + ' 总章 ' + c.total, data.total === c.total, 'got ' + data.total);
  ok(c.f + ' 段落 > 20', data.nodes.length > 20, 'got ' + data.nodes.length);
  ok(c.f + ' 书名', data.bookTitle.length > 0, data.bookTitle);
  ok(c.f + ' 作者', data.author.length > 0, data.author);

  const body = data.nodes.map((n) => n.textContent).join('\n');
  ok(c.f + ' 无导航残留', !/(^|\n)(首章|尾章|目录|上一章|下一章|上一篇|下一篇)(\n|$)/.test(body));
  ok(c.f + ' 无标签残留', !/<\/?[a-z][^>]*>/i.test(body));
  ok(c.f + ' 无段首全角空格', !data.nodes.some((n) => /^\u3000/.test(n.textContent)));
  ok(c.f + ' 正文长度 > 500', body.length > 500, 'len=' + body.length);
  if (c.idx !== 1) {
    ok(c.f + ' 首段是正文', !/^作者[：:]/.test(data.nodes[0].textContent),
      data.nodes[0].textContent.slice(0, 20));
  }
}

console.log('\n[F2] 线上目录页');
for (const b of [
  { f: '12573.html', min: 90 },
  { f: '12554.html', min: 300 }
]) {
  const html = live(b.f);
  const d = new w.DOMParser().parseFromString(html, 'text/html');
  const re = /^\/tongren\/(\d+)\/(\d+)\.html$/i;
  const ns = Array.from(d.querySelectorAll('.book_list a[href]'))
    .map((a) => { const m = re.exec(a.getAttribute('href') || ''); return m ? parseInt(m[2], 10) : null; })
    .filter(Boolean);
  ok(b.f + ' 目录项 > ' + b.min, ns.length > b.min, 'got ' + ns.length);
  ok(b.f + ' 首项 1', ns[0] === 1, 'got ' + ns[0]);
  ok(b.f + ' 连续无断档', ns.every((v, i) => i === 0 || v === ns[i - 1] + 1),
    ns.slice(0, 4).join(',') + '…' + ns.slice(-3).join(','));
  const h1 = d.querySelector('.book_info h1');
  const title = h1 ? h1.textContent.replace(/[（(]\s*\d+\s*[-~]\s*\d+\s*[)）]/, '').trim() : '';
  ok(b.f + ' 书名清理', title.length > 0 && !/\d+\s*-\s*\d+/.test(title), title);
  ok(b.f + ' 书名含中文', /[\u4e00-\u9fa5]/.test(title));
}

console.log('\n[F3] 越界章节（线上 404 页）');
{
  const html = live('12554_1018.html');
  ok('404 页无正文容器', !/class="read_chapterDetail"/.test(html));
  ok('404 页解析返回 null', api.parseChapter(html, 'http://trxs.cc/tongren/12554/1018.html') === null);
  ok('404 页是提示页', /404|不存在|找不到|错误/.test(html));
}

console.log('\n[F4] 目录页不误判为章节页');
{
  const html = live('12573.html');
  const d = new w.DOMParser().parseFromString(html, 'text/html');
  ok('目录页无 read_chapterDetail', !d.querySelector('.read_chapterDetail'));
  ok('目录页有 book_list', !!d.querySelector('.book_list'));
  ok('目录页有 book_info h1', !!d.querySelector('.book_info h1'));
}

console.log('\n=========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('真实数据验证全部通过 ✅');
