// 自动滚动专项测试：不依赖真实布局，手工控制 rAF 与 scrollTop
//
// 运行：node test/autoscroll.mjs
// 依赖 test/fixtures/（先跑 node test/fetch-fixtures.mjs 或 node test/make-fixtures.mjs）

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
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

/* 借脚本自带的解码器读 GB2312 样本 */
const boot = new JSDOM('<html><body></body></html>', {
  url: 'http://trxs.cc/', runScripts: 'outside-only', pretendToBeVisual: true
});
const bw = boot.window;
bw.GM_addStyle = () => {};
bw.GM_getValue = (k, d) => d;
bw.GM_setValue = () => {};
bw.GM_registerMenuCommand = () => {};
bw.GM_xmlhttpRequest = () => {};
bw.eval(SCRIPT);
const api0 = bw.window ? bw.window.__TRX__ : bw.__TRX__;
const readFix = (n) => {
  const api = (boot.window && boot.window.__TRX__) || bw.__TRX__;
  return api.decodeBytes(new Uint8Array(readFileSync(path.join(FIX, n))));
};

/**
 * 建立可控环境：
 * - 用真实章节 HTML，但 scrollTop / scrollHeight / clientHeight 全部可写
 * - rAF 换成手动队列，由 step 逐帧推进
 */
function makeScrollDom(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const store = new Map();
  const rafQueue = [];
  let rafId = 1;
  let virtualNow = 0;

  w.GM_addStyle = (css) => {
    const st = w.document.createElement('style');
    st.textContent = css;
    (w.document.head || w.document.documentElement).appendChild(st);
  };
  w.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  w.GM_setValue = (k, v) => { store.set(k, v); };
  w.GM_registerMenuCommand = () => {};
  w.GM_xmlhttpRequest = () => {};

  // 需要在任何 scrollTop 写入前就把属性定义好
  Object.defineProperty(w, 'requestAnimationFrame', {
    value: (fn) => { const id = rafId++; rafQueue.push({ id, fn }); return id; },
    configurable: true, writable: true
  });
  Object.defineProperty(w, 'cancelAnimationFrame', {
    value: (id) => {
      const i = rafQueue.findIndex((q) => q.id === id);
      if (i >= 0) rafQueue.splice(i, 1);
    },
    configurable: true, writable: true
  });
  Object.defineProperty(w, 'performance', {
    value: { now: () => virtualNow }, configurable: true, writable: true
  });

  w.__store__ = store;
  w.__rafQueue__ = rafQueue;
  w.__rafId__ = () => rafId;
  w.__advance__ = (ms, hop) => {
    // 把时间切成 hop 毫秒的小步，每步跑一次当前队列
    const stepMs = hop || 16;
    let left = ms;
    while (left > 0) {
      const d = Math.min(stepMs, left);
      virtualNow += d;
      left -= d;
      const due = rafQueue.splice(0, rafQueue.length);
      for (const q of due) q.fn(virtualNow);
    }
    return virtualNow;
  };
  w.__now__ = () => virtualNow;

  w.eval(SCRIPT);
  return dom;
}

function setupScroll(w, scrollHeight, clientHeight, initialTop) {
  const main = w.document.querySelector('#trx-main');
  let top = initialTop || 0;
  Object.defineProperty(main, 'scrollHeight', { get: () => scrollHeight, configurable: true });
  Object.defineProperty(main, 'clientHeight', { get: () => clientHeight, configurable: true });
  Object.defineProperty(main, 'scrollTop', {
    get: () => top,
    set: (v) => { top = Math.max(0, Math.min(scrollHeight - clientHeight, Math.round(v))); },
    configurable: true
  });
  return {
    get top() { return top; },
    set top(v) { top = v; },
    main
  };
}

const tocHtml = readFix('12573.html');
const chapterBase = readFix('12573_1.html');

/* ------------------------------------------------------------------ */
console.log('\n[1] 速度档位映射');
/* ------------------------------------------------------------------ */
{
  const site = new Map();
  site.set('http://trxs.cc/tongren/12573.html', tocHtml);
  for (let i = 1; i <= 98; i++) site.set('http://trxs.cc/tongren/12573/' + i + '.html', chapterBase);
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  w.GM_xmlhttpRequest = (opts) => {
    setTimeout(() => {
      const b = site.get(opts.url);
      if (!b) { opts.onerror && opts.onerror({ status: 404 }); return; }
      const buf = Buffer.from(b, 'utf8');
      opts.onload({ status: 200, response: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    }, 0);
  };
  const api = w.__TRX__;

  const table = [];
  for (let s = 1; s <= 10; s++) {
    api.settings.scrollSpeed = s;
    table.push(api.autoScrollPxPerSec());
  }
  ok('速度 1-10 单调递增', table.every((v, i) => i === 0 || v > table[i - 1]), table.join(','));
  ok('速度 1 = 14px/s', table[0] === 14, String(table[0]));
  ok('速度 10 = 180px/s', table[9] === 180, String(table[9]));

  api.settings.scrollSpeed = 0;
  ok('越界下限钳到 14', api.autoScrollPxPerSec() === 14, String(api.autoScrollPxPerSec()));
  api.settings.scrollSpeed = 99;
  ok('越界上限钳到 180', api.autoScrollPxPerSec() === 180, String(api.autoScrollPxPerSec()));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[2] 开启 / 暂停 / 按钮状态');
/* ------------------------------------------------------------------ */
{
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  const doc = w.document;

  api.openReader(1);
  await tick(80);
  const s = setupScroll(w, 6000, 800, 0);

  const btn = doc.querySelector('#trx-btn-scroll');
  ok('自动滚动按钮存在', !!btn);
  ok('初始为播放态', btn.textContent === '▶', btn.textContent);
  ok('初始未激活', !btn.classList.contains('trx-on'));

  api.startAutoScroll();
  ok('开启后 state.scrollOn = true', api.state.scrollOn === true);
  ok('按钮变暂停态', btn.textContent === '⏸', btn.textContent);
  ok('按钮高亮', btn.classList.contains('trx-on'));

  api.stopAutoScroll(true);
  ok('停止后 state.scrollOn = false', api.state.scrollOn === false);
  ok('按钮恢复播放态', btn.textContent === '▶', btn.textContent);
  ok('按钮取消高亮', !btn.classList.contains('trx-on'));

  api.startAutoScroll();
  api.toggleAutoScroll();
  ok('toggle 可关闭', api.state.scrollOn === false);
  api.toggleAutoScroll();
  ok('toggle 可开启', api.state.scrollOn === true);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[3] 实际滚动位移量（积分正确）');
/* ------------------------------------------------------------------ */
{
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;

  api.openReader(1);
  await tick(80);
  const s = setupScroll(w, 6000, 800, 0);

  api.settings.scrollSpeed = 5; // 50 px/s
  api.startAutoScroll();

  // 推进 1 秒（每步 16ms）
  w.__advance__(1000, 16);
  // 允许 ±6px 误差（帧步长取整导致）
  ok('1 秒后滚约 50px', Math.abs(s.top - 50) <= 6, 'top=' + s.top);

  w.__advance__(1000, 16);
  ok('2 秒后滚约 100px', Math.abs(s.top - 100) <= 8, 'top=' + s.top);

  api.settings.scrollSpeed = 10; // 切到 180px/s
  const before = s.top;
  w.__advance__(1000, 16);
  ok('提速到 10 后 1 秒约 +180px', Math.abs((s.top - before) - 180) <= 10,
    'delta=' + (s.top - before));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[4] 低速不卡住（亚像素累积）');
/* ------------------------------------------------------------------ */
{
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;

  api.openReader(1);
  await tick(80);
  const s = setupScroll(w, 6000, 800, 0);

  api.settings.scrollSpeed = 1; // 14 px/s，每帧约 0.22px
  api.startAutoScroll();
  w.__advance__(500, 16);
  const midTop = s.top;
  // 500ms 约 7px；若没有小数累积会一直是 0
  ok('速度 1 时 0.5 秒内确有位移', midTop > 0, 'top=' + midTop);

  w.__advance__(1500, 16);
  ok('速度 1 时 2 秒约 28px', s.top >= 18 && s.top <= 40, 'top=' + s.top);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[5] 切换章 / 到底边界');
/* ------------------------------------------------------------------ */
{
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  const doc = w.document;

  api.openReader(1);
  await tick(80);
  const s = setupScroll(w, 3000, 800, 0);

  api.settings.scrollSpeed = 10; // 180px/s
  api.startAutoScroll();
  // 可滚区间 = 3000 - 800 = 2200px，180px/s 约需 12.2 秒
  w.__advance__(3000, 16);
  ok('3 秒后滚约 540px', Math.abs(s.top - 540) <= 12, 'top=' + s.top);

  // 继续推进直到越过底部：autoNext 为 true，此时应停在底部而不是继续加
  // 注意：脚本判定「剩余 <= 2px 即到底」，因此会停在 2198 而非 2200
  w.__advance__(12000, 16);
  ok('长时滚动停在底部且不越界', s.top >= 2190 && s.top <= 2200, 'top=' + s.top);

  // 把 autoNext 关掉，到底应自动停止并提示
  api.settings.autoNext = false;
  s.top = 2195;
  w.__advance__(500, 16);
  ok('关闭连读时到底自动停止', api.state.scrollOn === false, 'scrollOn=' + api.state.scrollOn);

  // 重新开启，模拟续章后高度增长可继续滚
  api.settings.autoNext = true;
  api.startAutoScroll();
  ok('可再次开启', api.state.scrollOn === true);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[6] 键盘 S 与翻章联动');
/* ------------------------------------------------------------------ */
{
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  const doc = w.document;

  api.openReader(1);
  await tick(80);
  setupScroll(w, 4000, 800, 0);

  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', bubbles: true }));
  await tick(20);
  ok('按 S 开启自动滚动', api.state.scrollOn === true);

  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', bubbles: true }));
  await tick(20);
  ok('再按 S 关闭自动滚动', api.state.scrollOn === false);

  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'S', bubbles: true }));
  await tick(20);
  ok('大写 S 同样生效', api.state.scrollOn === true);

  api.closeReader();
  await tick(20);
  ok('退出阅读模式后自动停', api.state.scrollOn === false);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[7] 设置持久化与 UI 同步');
/* ------------------------------------------------------------------ */
{
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  const doc = w.document;

  api.openReader(1);
  await tick(80);

  ok('设置面板有滚速滑块', !!doc.querySelector('#set-speed'));
  const slider = doc.querySelector('#set-speed');
  ok('滚速范围 1-10', slider.min === '1' && slider.max === '10', slider.min + '-' + slider.max);

  slider.value = '8';
  slider.dispatchEvent(new w.Event('input'));
  await tick(20);
  ok('拖动滑块写入 scrollSpeed', api.settings.scrollSpeed === 8, String(api.settings.scrollSpeed));
  ok('滚速显示值同步', doc.querySelector('#set-speed-v').textContent === '8',
    doc.querySelector('#set-speed-v').textContent);
  ok('速度 8 = 110px/s', api.autoScrollPxPerSec() === 110, String(api.autoScrollPxPerSec()));

  const saved = w.__store__.get('trxs:settings');
  ok('滚速已持久化', saved && saved.scrollSpeed === 8,
    saved && String(saved.scrollSpeed));
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n[8] 自动滚动中切主题不中断');
/* ---------------- */
{
  const dom = makeScrollDom(chapterBase, 'http://trxs.cc/tongren/12573/1.html');
  const w = dom.window;
  const api = w.__TRX__;
  const doc = w.document;

  api.openReader(1);
  await tick(80);
  const s = setupScroll(w, 5000, 800, 0);

  api.settings.scrollSpeed = 5;
  api.startAutoScroll();
  const before = s.top;
  w.__advance__(500, 16);

  // 切主题
  Array.from(doc.querySelectorAll('.trx-theme-btn')).forEach((b) => {
    if (b.dataset.theme === 'dark') b.dispatchEvent(new w.Event('click', { bubbles: true }));
  });
  await tick(20);

  const mid = s.top;
  w.__advance__(500, 16);
  ok('切主题后仍在滚动', api.state.scrollOn === true && s.top > mid,
    'before=' + before + ' mid=' + mid + ' now=' + s.top);
  dom.window.close();
}

/* ------------------------------------------------------------------ */
console.log('\n=========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('自动滚动测试全部通过 ✅');
