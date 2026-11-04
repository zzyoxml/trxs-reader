// ==UserScript==
// @name         同人小说网 trxs.cc 阅读增强（阅读模式 · 夜间 · 去广告）
// @namespace    https://github.com/zzyoxml/trxs-reader
// @version      1.3.0
// @description  为 trxs.cc 提供沉浸式阅读模式、夜间/护眼配色、广告清理、目录跳转、自动连读、阅读进度记忆
// @author       zzyoxml
// @license      MIT
// @homepageURL  https://github.com/zzyoxml/trxs-reader
// @supportURL   https://github.com/zzyoxml/trxs-reader/issues
// @match        *://trxs.cc/*
// @match        *://www.trxs.cc/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      trxs.cc
// @connect      www.trxs.cc
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 0. 站点判定
   * ========================================================================= */
  if (window.top !== window.self) return;
  if (!/^(www\.)?trxs\.cc$/i.test(location.hostname)) return;

  const CHAP_RE = /^\/tongren\/(\d+)\/(\d+)\.html$/i;
  const BOOK_RE = /^\/tongren\/(\d+)\.html$/i;
  const TOC_LINK_RE = /^\/tongren\/(\d+)\/(\d+)\.html$/i;

  /* =========================================================================
   * 1. 广告拦截（document-start 阶段先行）
   * =========================================================================
   * trxs.cc 的广告并不在自己的 HTML 里，而是由以下三方脚本动态注入：
   *   /skin/default/js/funNav.js  -> cpt.geniee.jp + securepubads.g.doubleclick.net
   *   /skin/default/js/tongji.js  -> googletagmanager.com (GA)
   * 因此策略是：拦截脚本注入 + 清理已出现的广告节点 + 隐藏广告位容器。
   * 注意：页面末尾 Cloudflare 注入的那个 1px 隐藏 iframe 不是广告，不能误删。
   */
  const AD_HOSTS = [
    'cpt.geniee.jp',
    'geniee.jp',
    'securepubads.g.doubleclick.net',
    'doubleclick.net',
    'googletagmanager.com',
    'google-analytics.com',
    'googlesyndication.com',
    'googleadservices.com',
    'adservice.google.com',
    'adsbygoogle.js',
    'pubmatic.com',
    'taboola.com',
    'outbrain.com'
  ];

  const AD_SELECTORS = [
    'script[src*="geniee"]',
    'script[src*="doubleclick"]',
    'script[src*="googletagmanager"]',
    'script[src*="google-analytics"]',
    'script[src*="googlesyndication"]',
    'script[src*="adsbygoogle"]',
    'iframe[src*="geniee"]',
    'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="googleads"]',
    'iframe[src*="googletagmanager"]',
    'ins.adsbygoogle',
    '.adsbygoogle',
    '[id^="div-gpt-ad"]',
    '[id*="geniee"]',
    '[id^="google_ads"]',
    '[class*="gnshb"]'
  ];

  const isAdUrl = (text) => {
    if (typeof text !== 'string' || !text) return false;
    const s = text.toLowerCase();
    for (let i = 0; i < AD_HOSTS.length; i++) {
      if (s.indexOf(AD_HOSTS[i]) >= 0) return true;
    }
    return false;
  };

  // 1.1 拦截 document.write 写入的广告脚本（funNav.js / tongji.js 都靠它）
  (function hookDocumentWrite() {
    try {
      const rawWrite = document.write;
      const rawWriteln = document.writeln;
      document.write = function () {
        for (let i = 0; i < arguments.length; i++) {
          if (isAdUrl(arguments[i])) return undefined;
        }
        return rawWrite.apply(document, arguments);
      };
      document.writeln = function () {
        for (let i = 0; i < arguments.length; i++) {
          if (isAdUrl(arguments[i])) return undefined;
        }
        return rawWriteln.apply(document, arguments);
      };
    } catch (e) {
      /* 某些环境下 document.write 只读，忽略 */
    }
  })();

  function sweepAds(root) {
    if (!root || !root.querySelectorAll) return;
    for (let i = 0; i < AD_SELECTORS.length; i++) {
      let nodes;
      try {
        nodes = root.querySelectorAll(AD_SELECTORS[i]);
      } catch (e) {
        continue;
      }
      for (let j = nodes.length - 1; j >= 0; j--) {
        const n = nodes[j];
        if (n && n.parentNode) n.parentNode.removeChild(n);
      }
    }
  }

  function watchAds() {
    sweepAds(document);
    if (typeof MutationObserver !== 'function' || !document.documentElement) return;
    const mo = new MutationObserver((records) => {
      for (let i = 0; i < records.length; i++) {
        const added = records[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SCRIPT' || node.tagName === 'IFRAME') {
            const src = node.getAttribute('src');
            if (src && isAdUrl(src)) { node.remove(); continue; }
            if (node.tagName === 'SCRIPT' && isAdUrl(node.textContent)) { node.remove(); continue; }
          }
          if (node.querySelectorAll) sweepAds(node);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* =========================================================================
   * 2. 本地设置 / 进度存储
   * ========================================================================= */
  const DEFAULTS = {
    fontSize: 19,
    lineHeight: 1.9,
    maxWidth: 780,
    family: 'system',
    theme: 'light',
    autoNext: true,
    autoScroll: false,  // 自动滚动
    scrollSpeed: 4,     // 自动滚动速度 1-10
    darkNative: false   // 原页面夜间模式
  };

  /* -------------------------------------------------------------------------
   * 固定行为（不提供开关）
   * -------------------------------------------------------------------------
   * 去广告 / 隐藏推荐 / 隐藏登录条 / 显示悬浮按钮 这四项是脚本的既有价值，
   * 做成 checkbox 反而让人以为可以关掉，实测也没人会关。因此直接固化，
   * 且不受历史存档里的旧值影响（老用户存过 noAds:false 也不会被尊重）。
   * ----------------------------------------------------------------------- */
  const ALWAYS = {
    noAds: true,
    noHot: true,
    noLogin: true,
    showFab: true
  };

  function readStore(key, def) {
    try {
      const v = GM_getValue(key, null);
      if (v === null || v === undefined) return def;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (e) { return def; }
      }
      return v;
    } catch (e) {
      return def;
    }
  }

  function writeStore(key, value) {
    try { GM_setValue(key, value); } catch (e) { /* ignore */ }
  }

  let settings = Object.assign({}, DEFAULTS, readStore('trxs:settings', {}) || {});
  function saveSettings() { writeStore('trxs:settings', settings); }

  const FAMILIES = {
    system: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
    yahei: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif',
    song: '"Songti SC", "SimSun", "Source Han Serif SC", "Noto Serif CJK SC", serif',
    kai: '"Kaiti SC", "KaiTi", "STKaiti", serif',
    hei: '"Microsoft YaHei", "PingFang SC", "Heiti SC", sans-serif'
  };

  const THEMES = [
    { id: 'light', name: '日间' },
    { id: 'sepia', name: '羊皮纸' },
    { id: 'green', name: '护眼' },
    { id: 'dark', name: '夜间' },
    { id: 'black', name: '纯黑' }
  ];

  /* =========================================================================
   * 3. 通用工具
   * ========================================================================= */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  let toastTimer = null;
  function toast(msg, ms) {
    if (!document.body) return;
    let el = $('#trx-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'trx-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('trx-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('trx-show'); }, ms || 2000);
  }

  function sniffCharset(bytes) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    const m = /charset\s*=\s*["']?([a-zA-Z0-9_\-]+)/i.exec(head);
    if (m) {
      const cs = m[1].toLowerCase();
      if (cs === 'utf-8' || cs === 'utf8') return 'utf-8';
      if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') return 'gbk';
      return cs;
    }
    return 'gbk'; // trxs.cc 默认 gb2312
  }

  function decodeBytes(bytes) {
    let declared = 'gbk';
    try { declared = sniffCharset(bytes); } catch (e) { declared = 'gbk'; }

    // 页面声明的 charset 优先
    if (declared === 'utf-8') {
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { /* fallthrough */ }
    }

    // GBK 的高位字节几乎不可能通过严格 UTF-8 校验，
    // 因此用「严格 UTF-8 是否成立」来识别被错误标注为 gb2312 的页面。
    let gbkText = null;
    try { gbkText = new TextDecoder('gbk').decode(bytes); } catch (e) { gbkText = null; }
    try {
      const utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (utf8Text) return utf8Text;
    } catch (e) { /* 不是合法 UTF-8，继续用 gbk */ }

    if (gbkText !== null) return gbkText;
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e2) { return new TextDecoder('gbk', { fatal: false }).decode(bytes); }
  }

  /** 站内页面统一用 GB2312/GBK，必须自行解码，不能直接依赖 responseText。 */
  function gmFetch(url) {
    return new Promise(function (resolve, reject) {
      const handle = function (raw) {
        try {
          let u8 = null;
          if (raw && typeof raw.byteLength === 'number') {
            if (ArrayBuffer.isView(raw)) {
              u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
            } else {
              u8 = new Uint8Array(raw);
            }
          }
          const text = u8 ? decodeBytes(u8) : null;
          if (!text) reject(new Error('空响应'));
          else resolve(text);
        } catch (e) {
          reject(e);
        }
      };

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          timeout: 25000,
          onload: function (res) { handle(res.response); },
          onerror: function () { reject(new Error('网络错误')); },
          ontimeout: function () { reject(new Error('请求超时')); }
        });
      } else {
        // 没有 GM_xmlhttpRequest 时退化为 fetch
        fetch(url, { credentials: 'include' })
          .then(function (r) { return r.arrayBuffer(); })
          .then(handle)
          .catch(reject);
      }
    });
  }

  function parseDoc(html) {
    try {
      return new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return null;
    }
  }

  const chapUrl = (bookId, n) => location.origin + '/tongren/' + bookId + '/' + n + '.html';
  const bookUrl = (bookId) => location.origin + '/tongren/' + bookId + '.html';

  /* =========================================================================
   * 4. 正文解析（针对 trxs.cc 的固定 DOM 结构）
   * =========================================================================
   * 章节页结构：
   *   .readDetail > .read_chapterName > h1(书名 第N章) + .textinfo > em(作者：xx)
   *   .readDetail > .read_chapterDetail > 大量 <p>（正文，段首为两个全角空格）
   *   .pageNav : 首章 / 上一章 / {n}/{total} / 下一章 / 尾章 / 目录
   * 「上一篇 / 下一篇」在 .next_pre 中，不在正文容器内，额外做一次保险过滤。
   */
  const NAV_TAIL = /^(上一篇|下一篇|上一章|下一章|返回目录|返回列表|目录|首章|尾章|加入书签)\s*[:：]?$/;

  function makeParagraph(text, extraClass) {
    const p = document.createElement('p');
    p.className = 'trx-p' + (extraClass ? ' ' + extraClass : '');
    p.textContent = text;
    return p;
  }

  function extractBody(detailEl) {
    const out = [];
    if (!detailEl) return out;

    const pushText = function (raw) {
      if (raw === null || raw === undefined) return;
      let text = String(raw).replace(/\u00a0/g, ' ');
      // 去掉段首的全角空格（改用 CSS text-indent 统一缩进）
      text = text.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
      if (!text) return;
      if (NAV_TAIL.test(text)) return;
      if (/^(全本小说网|请记住本站|手机用户请|本章未完)/.test(text)) return;
      out.push(makeParagraph(text));
    };

    const pushImage = function (img) {
      const p = document.createElement('p');
      p.className = 'trx-p trx-img';
      const clone = img.cloneNode(false);
      clone.removeAttribute('width');
      clone.removeAttribute('height');
      clone.removeAttribute('style');
      if (clone.getAttribute('src')) {
        p.appendChild(clone);
        out.push(p);
      }
    };

    const pushBlank = function () {
      if (!out.length) return;
      const last = out[out.length - 1];
      if (last && last.classList.contains('trx-blank')) return;
      out.push(makeParagraph('', 'trx-blank'));
    };

    const walk = function (node) {
      const kids = Array.prototype.slice.call(node.childNodes);
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === 3) {
          pushText(child.nodeValue);
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INS' || tag === 'IFRAME' || tag === 'NOSCRIPT') continue;
        if (tag === 'IMG') { pushImage(child); continue; }
        if (tag === 'BR') { pushBlank(); continue; }
        if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'LI' || tag === 'BLOCKQUOTE') {
          // 段落内部若还有块级节点，继续递归；否则整体取文本
          if (child.querySelector && child.querySelector('p, img, br')) {
            walk(child);
          } else {
            pushText(child.textContent);
          }
          continue;
        }
        // span / a / em / strong 等行内节点
        pushText(child.textContent);
      }
    };

    walk(detailEl);

    // 去掉尾部多余空段
    while (out.length && out[out.length - 1].classList.contains('trx-blank')) out.pop();
    return out;
  }

  function parseChapter(html, url) {
    const doc = parseDoc(html);
    if (!doc) return null;
    const detail = doc.querySelector('.read_chapterDetail');
    if (!detail) return null;

    const href = url || '';
    const urlMatch = /\/tongren\/(\d+)\/(\d+)\.html/i.exec(href);
    const bookId = urlMatch ? urlMatch[1] : null;
    const urlIndex = urlMatch ? parseInt(urlMatch[2], 10) : null;

    const navEl = doc.querySelector('.pageNav');
    const navText = navEl ? navEl.textContent.replace(/\s+/g, ' ') : '';
    const navMatch = /(\d+)\s*\/\s*(\d+)/.exec(navText);
    const index = navMatch ? parseInt(navMatch[1], 10) : urlIndex;
    const total = navMatch ? parseInt(navMatch[2], 10) : null;

    const h1 = doc.querySelector('.read_chapterName h1') ||
               doc.querySelector('.read_chapterName h2') ||
               doc.querySelector('h1');
    const title = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
    const em = doc.querySelector('.textinfo em');
    const author = em ? em.textContent.replace(/^作者[：:]\s*/, '').trim() : '';

    // 「书名 第N章」→ 书名
    let bookTitle = title.replace(/\s*第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷].*$/, '').trim();
    if (!bookTitle) bookTitle = title;

    const nodes = extractBody(detail);
    if (!nodes.length) return null;

    return {
      bookId: bookId,
      index: index,
      total: total,
      title: title,
      bookTitle: bookTitle,
      author: author,
      nodes: nodes
    };
  }

  function shortTitle(data) {
    let t = data.title || '';
    if (data.bookTitle && t.indexOf(data.bookTitle) === 0) {
      t = t.slice(data.bookTitle.length).trim();
    }
    return t || ('第 ' + data.index + ' 章');
  }

  /* =========================================================================
   * 5. 样式
   * ========================================================================= */
  const CSS = `
/* ---------- 原页面：去广告 / 去杂物 ---------- */
html.trxs-noads .membershow,
html.trxs-noads .dp_head,
html.trxs-noads #onclickshowdiv,
html.trxs-noads .star_box,
html.trxs-noads ins.adsbygoogle,
html.trxs-noads .adsbygoogle { display: none !important; }

html.trxs-nohot .hotlist,
html.trxs-nohot .next_pre { display: none !important; }

html.trxs-nologin .membershow { display: none !important; }

/* Cloudflare 的 1px 隐藏 iframe 保留，不动 */

/* ---------- 原页面：夜间模式 ---------- */
html.trxs-dark { background: #15161a !important; }
html.trxs-dark body,
html.trxs-dark .reading { background: #15161a !important; color: #c2c4cc !important; }
html.trxs-dark .head,
html.trxs-dark .newNav,
html.trxs-dark #newNav,
html.trxs-dark .readContent,
html.trxs-dark #readContent_set,
html.trxs-dark .readDetail,
html.trxs-dark .topReadContent,
html.trxs-dark .book_list,
html.trxs-dark .book_info,
html.trxs-dark .lists,
html.trxs-dark .books,
html.trxs-dark .booknews,
html.trxs-dark .container,
html.trxs-dark .box,
html.trxs-dark .copyright,
html.trxs-dark .footer,
html.trxs-dark .bk {
  background: #1b1d22 !important;
  border-color: #2b2e37 !important;
  box-shadow: none !important;
}
html.trxs-dark .head,
html.trxs-dark .navTop { border-bottom: 2px solid #0aa89a !important; }
html.trxs-dark .readTop,
html.trxs-dark .menNav { background: #1b1d22 !important; border-bottom-color: #2b2e37 !important; }
html.trxs-dark .readTop,
html.trxs-dark .readTop a { color: #8b8f99 !important; }
html.trxs-dark .read_chapterName h1,
html.trxs-dark .read_chapterName h2 { color: #d8dae1 !important; }
html.trxs-dark .textinfo,
html.trxs-dark .textinfo em,
html.trxs-dark .textinfo a,
html.trxs-dark .textinfo span { color: #8b8f99 !important; }
html.trxs-dark .read_chapterDetail,
html.trxs-dark .read_chapterDetail p { color: #c6c8d0 !important; }
html.trxs-dark .read_chapterDetail img { opacity: .88; }
html.trxs-dark .pageNav,
html.trxs-dark .pageNav a { color: #9aa0aa !important; }
html.trxs-dark a,
html.trxs-dark .littleLogo { color: #b9bcc5 !important; }
html.trxs-dark a:hover { color: #2fd0bd !important; }
html.trxs-dark .book_info h1,
html.trxs-dark .book_info p,
html.trxs-dark .infos .date,
html.trxs-dark .infos .date a,
html.trxs-dark .infos span,
html.trxs-dark .hotlist h3,
html.trxs-dark .hotlist ul li a { color: #b9bcc5 !important; }
html.trxs-dark .book_list ul li { background-image: none !important; }
html.trxs-dark .book_list ul li a { color: #b9bcc5 !important; }
html.trxs-dark .book_list ul li a:visited { color: #7f8798 !important; }
html.trxs-dark .search .search-keyword,
html.trxs-dark .search .search-submit {
  background: #232630 !important; color: #c2c4cc !important; border-color: #343845 !important;
}
html.trxs-dark .booktips h3 a,
html.trxs-dark .infos h3 a { background: #33384a !important; color: #d8dae1 !important; }
html.trxs-dark .copyright,
html.trxs-dark .copyright a { color: #6f747f !important; }

/* ---------- 右下角悬浮按钮 ---------- */
#trx-fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147482000;
  display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
  font: 13px/1.4 "Microsoft YaHei", sans-serif;
}
#trx-fab button {
  display: flex; align-items: center; gap: 6px;
  padding: 9px 14px; border: none; border-radius: 20px; cursor: pointer;
  color: #fff; background: rgba(24, 26, 32, .82); backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .28); transition: transform .15s, background .15s;
  white-space: nowrap;
}
#trx-fab button:hover { transform: translateY(-2px); background: #0aa89a; }
#trx-fab .trx-fab-main { background: #0aa89a; font-weight: bold; }
html.trx-open #trx-fab { display: none !important; }

/* ---------- 阅读器 ---------- */
html.trx-open,
html.trx-open body { overflow: hidden !important; height: 100% !important; }

#trx-reader {
  --trx-bg: #fbfaf7; --trx-fg: #2b2d33; --trx-dim: #8b8d94;
  --trx-panel: #ffffff; --trx-line: #e6e4dd; --trx-accent: #0aa89a;
  --trx-fs: 19px; --trx-lh: 1.9; --trx-w: 780px;
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; flex-direction: column;
  background: var(--trx-bg); color: var(--trx-fg);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
#trx-reader[data-theme="sepia"] { --trx-bg: #f5eddd; --trx-fg: #4a3d31; --trx-panel: #efe4cf; --trx-line: #e0d3ba; --trx-dim: #9b8b74; --trx-accent: #b07b3a; }
#trx-reader[data-theme="green"] { --trx-bg: #dbe8d3; --trx-fg: #2e3a2b; --trx-panel: #e7f1e0; --trx-line: #c3d5b9; --trx-dim: #78866f; --trx-accent: #4c8b3f; }
#trx-reader[data-theme="dark"]  { --trx-bg: #191a1e; --trx-fg: #c8cbd3; --trx-panel: #212329; --trx-line: #2e313a; --trx-dim: #838894; --trx-accent: #2fd0bd; }
#trx-reader[data-theme="black"] { --trx-bg: #000000; --trx-fg: #9b9b9b; --trx-panel: #101010; --trx-line: #232323; --trx-dim: #6f6f6f; --trx-accent: #2fd0bd; }

#trx-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  height: 48px; padding: 0 12px;
  background: var(--trx-panel); border-bottom: 1px solid var(--trx-line);
  font-size: 13px; color: var(--trx-dim);
}
#trx-bar-title { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 10px; overflow: hidden; }
#trx-bar-title .trx-book { color: var(--trx-fg); font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%; }
#trx-bar-title .trx-chap { color: var(--trx-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#trx-bar button {
  flex: 0 0 auto; height: 30px; min-width: 30px; padding: 0 9px;
  border: 1px solid var(--trx-line); border-radius: 6px;
  background: transparent; color: var(--trx-fg); cursor: pointer;
  font-size: 13px; line-height: 28px; white-space: nowrap;
}
#trx-bar button:hover { border-color: var(--trx-accent); color: var(--trx-accent); }
#trx-bar button.trx-on { border-color: var(--trx-accent); color: var(--trx-accent); background: color-mix(in srgb, var(--trx-accent) 14%, transparent); }
#trx-bar .trx-bar-actions { display: flex; gap: 8px; }

#trx-progress { flex: 0 0 auto; height: 3px; background: transparent; }
#trx-progress-bar { height: 3px; width: 0; background: var(--trx-accent); transition: width .1s linear; }

#trx-main { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; }
/* 自动滚动开启时关掉平滑滚动，否则每帧赋 scrollTop 会被平滑动画吞掉 */
#trx-reader.trx-autoscroll #trx-main { scroll-behavior: auto; }
#trx-content {
  max-width: var(--trx-w); margin: 0 auto;
  padding: 26px 22px 140px;
  font-size: var(--trx-fs); line-height: var(--trx-lh);
}
.trx-chap { margin-bottom: 2.2em; }
.trx-chap + .trx-chap { border-top: 1px dashed var(--trx-line); padding-top: 1.6em; }
.trx-chap-title {
  font-size: calc(var(--trx-fs) * 1.02); font-weight: 600;
  color: var(--trx-fg); text-align: center;
  margin: 0 0 1.4em; padding: 0;
  letter-spacing: .02em;
}
.trx-chap-title .trx-chap-sub { display: block; font-size: .62em; font-weight: 400; color: var(--trx-dim); margin-top: .5em; }
.trx-p { margin: 0 0 .82em; text-indent: 2em; word-break: break-word; overflow-wrap: break-word; }
.trx-p.trx-blank { height: .6em; margin: 0; }
.trx-p.trx-img { text-indent: 0; text-align: center; margin: 1.2em 0; }
.trx-p.trx-img img { max-width: 100%; height: auto; border-radius: 3px; }
.trx-loading { text-align: center; padding: 14px 0 30px; color: var(--trx-dim); font-size: 13px; }

#trx-pager {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  z-index: 2147483200;
  display: flex; align-items: center; gap: 10px;
  padding: 7px 12px; border-radius: 22px;
  background: color-mix(in srgb, var(--trx-panel) 88%, transparent);
  border: 1px solid var(--trx-line);
  box-shadow: 0 4px 16px rgba(0,0,0,.16);
  font-size: 12px; color: var(--trx-dim); white-space: nowrap;
  backdrop-filter: blur(8px);
}
#trx-pager button {
  height: 28px; padding: 0 12px; border-radius: 14px;
  border: 1px solid var(--trx-line); background: transparent;
  color: var(--trx-fg); font-size: 12px; cursor: pointer;
}
#trx-pager button:hover { border-color: var(--trx-accent); color: var(--trx-accent); }
#trx-pager button:disabled { opacity: .38; cursor: not-allowed; }

/* 目录侧栏 */
#trx-toc {
  position: fixed; top: 0; left: 0; bottom: 0; width: 320px; max-width: 86vw;
  z-index: 2147483400;
  display: flex; flex-direction: column;
  background: var(--trx-panel); border-right: 1px solid var(--trx-line);
  transform: translateX(-102%); transition: transform .2s ease;
  box-shadow: 6px 0 24px rgba(0,0,0,.16);
}
#trx-toc.trx-open { transform: translateX(0); }
.trx-panel-head {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  height: 46px; padding: 0 12px; border-bottom: 1px solid var(--trx-line);
  font-size: 13px; color: var(--trx-fg);
}
.trx-panel-head .trx-panel-title { font-weight: 600; }
.trx-panel-head .trx-panel-close {
  margin-left: auto; width: 28px; height: 28px; line-height: 26px;
  border: 1px solid var(--trx-line); border-radius: 6px;
  background: transparent; color: var(--trx-fg); cursor: pointer; text-align: center;
}
#trx-toc-search {
  flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 8px;
  border: 1px solid var(--trx-line); border-radius: 6px;
  background: transparent; color: var(--trx-fg); font-size: 12px; outline: none;
}
#trx-toc-list { flex: 1 1 auto; overflow-y: auto; padding: 6px 0 18px; }
#trx-toc-list a {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; font-size: 13px; color: var(--trx-fg);
  text-decoration: none; border-left: 3px solid transparent;
}
#trx-toc-list a:hover { background: rgba(10, 168, 154, .08); }
#trx-toc-list a.trx-cur { border-left-color: var(--trx-accent); background: rgba(10, 168, 154, .12); font-weight: 600; }
#trx-toc-list a .trx-toc-n { color: var(--trx-dim); font-size: 12px; min-width: 42px; }
#trx-toc-mask {
  position: fixed; inset: 0; z-index: 2147483300;
  background: rgba(0,0,0,.36); opacity: 0; pointer-events: none; transition: opacity .2s;
}

/* 设置面板 */
#trx-set {
  position: fixed; right: 0; bottom: 0; width: 340px; max-width: 92vw;
  z-index: 2147483400;
  background: var(--trx-panel); border-left: 1px solid var(--trx-line);
  border-top: 1px solid var(--trx-line);
  border-radius: 12px 0 0 0;
  box-shadow: -6px -6px 26px rgba(0,0,0,.18);
  transform: translateY(102%); transition: transform .22s ease;
  padding-bottom: 10px;
  max-height: 78vh; overflow-y: auto;
}
#trx-set.trx-open { transform: translateY(0); }
#trx-set .trx-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px; font-size: 13px; color: var(--trx-fg);
}
#trx-set .trx-row label { flex: 0 0 auto; width: 62px; color: var(--trx-dim); }
#trx-set .trx-row input[type="range"] { flex: 1 1 auto; accent-color: var(--trx-accent); }
#trx-set .trx-row .trx-val { flex: 0 0 auto; width: 42px; text-align: right; color: var(--trx-dim); font-variant-numeric: tabular-nums; }
#trx-set .trx-row select,
#trx-set .trx-row input[type="checkbox"] { accent-color: var(--trx-accent); }
#trx-set .trx-row select {
  flex: 1 1 auto; height: 28px; padding: 0 6px;
  border: 1px solid var(--trx-line); border-radius: 6px;
  background: transparent; color: var(--trx-fg); font-size: 13px;
}
#trx-set .trx-themes { flex: 1 1 auto; display: flex; gap: 6px; flex-wrap: wrap; }
#trx-set .trx-theme-btn {
  flex: 1 1 auto; min-width: 54px; height: 30px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--trx-line); font-size: 12px;
}
#trx-set .trx-theme-btn.trx-on { outline: 2px solid var(--trx-accent); outline-offset: -1px; font-weight: 600; }
#trx-set .trx-sheet-foot { display: flex; gap: 10px; padding: 4px 16px 0; }
#trx-set .trx-sheet-foot button {
  flex: 1 1 0; height: 32px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--trx-line); background: transparent; color: var(--trx-fg); font-size: 13px;
}

/* 提示 */
#trx-toast {
  position: fixed; left: 50%; bottom: 84px; transform: translate(-50%, 10px);
  z-index: 2147483600;
  padding: 9px 16px; border-radius: 8px;
  background: rgba(20, 22, 28, .92); color: #fff;
  font: 13px/1.5 "Microsoft YaHei", sans-serif;
  opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s;
  max-width: 80vw; text-align: center;
}
#trx-toast.trx-show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 720px) {
  #trx-content { padding: 18px 16px 130px; }
  #trx-bar { height: 44px; gap: 6px; }
  #trx-bar-title .trx-book { display: none; }
  #trx-pager { bottom: 10px; padding: 6px 8px; }
  #trx-fab button { padding: 8px 12px; font-size: 12px; }
}
`;

  function injectCSS() {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(CSS);
    } else {
      const st = document.createElement('style');
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
  }

  /* =========================================================================
   * 6. 原页面标记应用（广告 / 夜间）
   * ========================================================================= */
  function applyNativeFlags() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('trxs-noads', ALWAYS.noAds);
    root.classList.toggle('trxs-nohot', ALWAYS.noHot);
    root.classList.toggle('trxs-nologin', ALWAYS.noLogin && ALWAYS.noAds);

    root.classList.toggle('trxs-dark', !!settings.darkNative);
    sweepAds(document);
    updateFab();
  }

  function toggleNativeDark() {
    settings.darkNative = !settings.darkNative;
    saveSettings();
    applyNativeFlags();
    toast(settings.darkNative ? '已开启夜间模式' : '已关闭夜间模式');
  }

  /* =========================================================================
   * 7. 阅读器状态
   * ========================================================================= */
  const state = {
    open: false,
    bookId: null,
    firstIndex: null,
    lastIndex: null,
    total: null,
    bookTitle: '',
    loading: false,
    reachedEnd: false,
    toc: null,
    lastScrollSave: 0,
    // 自动滚动
    scrollOn: false,
    scrollRaf: null,
    scrollAcc: 0,
    scrollLastTs: null
  };

  function progressMap() {
    const p = readStore('trxs:progress', {});
    return (p && typeof p === 'object') ? p : {};
  }

  function saveProgress() {
    if (!state.bookId || !state.firstIndex) return;
    const p = progressMap();
    p[state.bookId] = {
      index: state.firstIndex,
      title: state.bookTitle || '',
      total: state.total || 0,
      ts: Date.now()
    };
    writeStore('trxs:progress', p);
  }

  /* =========================================================================
   * 8. 阅读器 DOM
   * ========================================================================= */
  function buildReader() {
    if ($('#trx-reader')) return;

    const wrap = document.createElement('div');
    wrap.id = 'trx-reader';
    wrap.dataset.theme = settings.theme;

    wrap.innerHTML = `
      <div id="trx-bar">
        <button id="trx-btn-toc" title="目录（快捷键 T）">☰ 目录</button>
        <div id="trx-bar-title">
          <span class="trx-book"></span>
          <span class="trx-chap"></span>
        </div>
        <div class="trx-bar-actions">
          <button id="trx-btn-font-down" title="缩小字号">A−</button>
          <button id="trx-btn-font-up" title="放大字号">A+</button>
          <button id="trx-btn-scroll" title="自动滚动（快捷键 S）">▶</button>
          <button id="trx-btn-theme" title="切换夜间（快捷键 D）">🌙</button>
          <button id="trx-btn-set" title="阅读设置">⚙</button>
          <button id="trx-btn-exit" title="退出阅读模式（Esc）">✕</button>
        </div>
      </div>
      <div id="trx-progress"><div id="trx-progress-bar"></div></div>
      <div id="trx-main"><article id="trx-content"></article></div>
      <div id="trx-pager">
        <button id="trx-prev">上一章</button>
        <span id="trx-pos">— / —</span>
        <button id="trx-next">下一章</button>
      </div>
      <div id="trx-toc-mask"></div>
      <aside id="trx-toc">
        <div class="trx-panel-head">
          <span class="trx-panel-title">目录</span>
          <input id="trx-toc-search" type="search" placeholder="搜索章节编号" autocomplete="off">
          <button class="trx-panel-close" id="trx-toc-close" title="关闭">✕</button>
        </div>
        <div id="trx-toc-list"></div>
      </aside>
      <aside id="trx-set">
        <div class="trx-panel-head">
          <span class="trx-panel-title">阅读设置</span>
          <button class="trx-panel-close" id="trx-set-close" title="关闭">✕</button>
        </div>
        <div class="trx-row"><label>字号</label><input id="set-font" type="range" min="14" max="34" step="1"><span class="trx-val" id="set-font-v"></span></div>
        <div class="trx-row"><label>行距</label><input id="set-lh" type="range" min="1.4" max="2.6" step="0.1"><span class="trx-val" id="set-lh-v"></span></div>
        <div class="trx-row"><label>页宽</label><input id="set-width" type="range" min="520" max="1400" step="20"><span class="trx-val" id="set-width-v"></span></div>
        <div class="trx-row"><label>字体</label>
          <select id="set-family">
            <option value="system">系统默认</option>
            <option value="yahei">微软雅黑</option>
            <option value="song">宋体</option>
            <option value="kai">楷体</option>
            <option value="hei">黑体</option>
          </select>
        </div>
        <div class="trx-row"><label>主题</label><div class="trx-themes" id="set-theme"></div></div>
        <div class="trx-row"><label>滚速</label><input id="set-speed" type="range" min="1" max="10" step="1"><span class="trx-val" id="set-speed-v"></span></div>
        <div class="trx-row"><label>自动连读</label><input type="checkbox" id="set-auto"></div>
        <div class="trx-sheet-foot">
          <button id="trx-set-reset">恢复默认</button>
          <button id="trx-set-apply">完成</button>
        </div>
      </aside>
      <div id="trx-toast"></div>
    `;

    document.body.appendChild(wrap);

    // 主题按钮
    const themeBox = $('#set-theme', wrap);
    THEMES.forEach(function (t) {
      const b = document.createElement('button');
      b.className = 'trx-theme-btn';
      b.dataset.theme = t.id;
      b.textContent = t.name;
      themeBox.appendChild(b);
    });

    bindReaderEvents(wrap);
    syncSettingsUI();
    applyReaderSettings();
  }

  function bindReaderEvents(wrap) {
    $('#trx-btn-exit', wrap).onclick = closeReader;
    $('#trx-btn-toc', wrap).onclick = toggleToc;
    $('#trx-toc-close', wrap).onclick = closeToc;
    $('#trx-toc-mask', wrap).onclick = closeToc;
    $('#trx-btn-set', wrap).onclick = toggleSettings;
    $('#trx-set-close', wrap).onclick = closeSettings;
    $('#trx-set-apply', wrap).onclick = closeSettings;
    $('#trx-btn-theme', wrap).onclick = cycleTheme;
    $('#trx-btn-font-up', wrap).onclick = function () { stepFontSize(1); };
    $('#trx-btn-font-down', wrap).onclick = function () { stepFontSize(-1); };
    $('#trx-btn-scroll', wrap).onclick = toggleAutoScroll;

    $('#trx-prev', wrap).onclick = function () { goRelative(-1); };
    $('#trx-next', wrap).onclick = function () { goRelative(1); };

    $('#trx-main', wrap).addEventListener('scroll', onReaderScroll, { passive: true });

    $('#trx-toc-search', wrap).addEventListener('input', function () {
      filterToc(this.value);
    });

    $('#trx-set-reset', wrap).onclick = function () {
      settings = Object.assign({}, DEFAULTS);
      saveSettings();
      applyNativeFlags();
      applyReaderSettings();
      syncSettingsUI();
      toast('已恢复默认设置');
    };

    // 滑块
    const bindRange = function (id, key, fmt) {
      const el = $('#' + id, wrap);
      const out = $('#' + id + '-v', wrap);
      el.addEventListener('input', function () {
        settings[key] = parseFloat(el.value);
        writeStore('trxs:settings', settings);
        if (out) out.textContent = fmt ? fmt(settings[key]) : settings[key];
        applyReaderSettings();
      });
    };
    bindRange('set-font', 'fontSize', function (v) { return v + 'px'; });
    bindRange('set-lh', 'lineHeight', function (v) { return v.toFixed(1); });
    bindRange('set-width', 'maxWidth', function (v) { return v + 'px'; });
    bindRange('set-speed', 'scrollSpeed', function (v) { return String(v); });

    $('#set-family', wrap).addEventListener('change', function () {
      settings.family = this.value;
      saveSettings();
      applyReaderSettings();
    });

    $('#set-theme', wrap).addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('.trx-theme-btn') : null;
      if (!b) return;
      settings.theme = b.dataset.theme;
      saveSettings();
      applyReaderSettings();
      syncSettingsUI();
    });

    const bindCheck = function (id, key, after) {
      const el = $('#' + id, wrap);
      el.addEventListener('change', function () {
        settings[key] = el.checked;
        saveSettings();
        if (after) after();
      });
    };
    bindCheck('set-auto', 'autoNext');
  }

  function syncSettingsUI() {
    const wrap = $('#trx-reader');
    if (!wrap) return;
    const set = function (id, v) {
      const el = $('#' + id, wrap);
      if (el) el.value = v;
      const out = $('#' + id + '-v', wrap);
      if (out) {
        if (id === 'set-font') out.textContent = v + 'px';
        else if (id === 'set-lh') out.textContent = Number(v).toFixed(1);
        else if (id === 'set-speed') out.textContent = String(v);
        else out.textContent = v + 'px';
      }
    };
    set('set-font', settings.fontSize);
    set('set-lh', settings.lineHeight);
    set('set-width', settings.maxWidth);
    set('set-speed', settings.scrollSpeed);

    const fam = $('#set-family', wrap);
    if (fam) fam.value = settings.family;

    $$('.trx-theme-btn', wrap).forEach(function (b) {
      b.classList.toggle('trx-on', b.dataset.theme === settings.theme);
    });

    const chk = function (id, v) {
      const el = $('#' + id, wrap);
      if (el) el.checked = !!v;
    };
    chk('set-auto', settings.autoNext);
  }

  function applyReaderSettings() {
    const wrap = $('#trx-reader');
    if (!wrap) return;
    wrap.dataset.theme = settings.theme;
    wrap.style.setProperty('--trx-fs', settings.fontSize + 'px');
    wrap.style.setProperty('--trx-lh', String(settings.lineHeight));
    wrap.style.setProperty('--trx-w', settings.maxWidth + 'px');
    wrap.style.fontFamily = FAMILIES[settings.family] || FAMILIES.system;

    const tb = $('#trx-btn-theme', wrap);
    if (tb) tb.textContent = (settings.theme === 'dark' || settings.theme === 'black') ? '☀' : '🌙';
    updatePager();
  }

  function cycleTheme() {
    const darkOnes = ['dark', 'black'];
    if (darkOnes.indexOf(settings.theme) >= 0) {
      settings.theme = 'light';
    } else {
      settings.theme = 'dark';
    }
    saveSettings();
    applyReaderSettings();
    syncSettingsUI();
    toast(settings.theme === 'dark' ? '夜间模式' : '日间模式');
  }

  const FONT_STEPS = [16, 18, 19, 21, 23, 26, 29];

  /** 在当前字号基础上向 dir（+1 放大 / -1 缩小）方向迈一档，到头则停住 */
  function stepFontSize(dir) {
    const cur = settings.fontSize;
    let idx = 0;
    let best = 999;
    FONT_STEPS.forEach(function (v, i) {
      const d = Math.abs(v - cur);
      if (d < best) { best = d; idx = i; }
    });

    let nextIdx = idx + (dir > 0 ? 1 : -1);
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx > FONT_STEPS.length - 1) nextIdx = FONT_STEPS.length - 1;

    // 已经落在步长表之外（例如手动拖过滑块），先归到最近的档位再走一步
    if (FONT_STEPS[nextIdx] === cur) {
      if (nextIdx === idx) return;
    }

    settings.fontSize = FONT_STEPS[nextIdx];
    saveSettings();
    applyReaderSettings();
    syncSettingsUI();
  }

  function toggleToc() {
    const panel = $('#trx-toc');
    const mask = $('#trx-toc-mask');
    if (!panel) return;
    const willOpen = !panel.classList.contains('trx-open');
    panel.classList.toggle('trx-open', willOpen);
    if (mask) mask.style.pointerEvents = willOpen ? 'auto' : 'none';
    if (mask) mask.style.opacity = willOpen ? '1' : '0';
    if (willOpen) {
      ensureToc().then(function () { scrollTocToCurrent(); });
    }
  }

  function closeToc() {
    const panel = $('#trx-toc');
    const mask = $('#trx-toc-mask');
    if (panel) panel.classList.remove('trx-open');
    if (mask) { mask.style.opacity = '0'; mask.style.pointerEvents = 'none'; }
  }

  function toggleSettings() {
    const panel = $('#trx-set');
    if (!panel) return;
    panel.classList.toggle('trx-open');
  }

  function closeSettings() {
    const panel = $('#trx-set');
    if (panel) panel.classList.remove('trx-open');
  }

  /* =========================================================================
   * 9. 目录
   * ========================================================================= */
  function collectTocFromDoc(doc) {
    const items = [];
    const seen = {};
    $$('.book_list a[href]', doc).forEach(function (a) {
      const href = a.getAttribute('href') || '';
      const m = TOC_LINK_RE.exec(href);
      if (!m) return;
      const n = parseInt(m[2], 10);
      if (!n || seen[n]) return;
      seen[n] = 1;
      items.push({ n: n, label: a.textContent.replace(/\s+/g, ' ') || ('第 ' + n + ' 节') });
    });
    items.sort(function (a, b) { return a.n - b.n; });

    const h1 = $('.book_info h1', doc);
    let bookTitle = h1 ? h1.textContent.trim() : '';
    bookTitle = bookTitle.replace(/[（(]\s*\d+\s*[-~]\s*\d+\s*[)）]/, '').trim();

    return { items: items, bookTitle: bookTitle };
  }

  function acceptToc(parsed) {
    state.toc = {
      bookId: state.bookId,
      items: parsed.items,
      total: parsed.items.length,
      bookTitle: parsed.bookTitle
    };
    if (parsed.items.length && (!state.total || state.total < parsed.items.length)) {
      state.total = parsed.items.length;
    }
    if (parsed.bookTitle && !state.bookTitle) state.bookTitle = parsed.bookTitle;
    renderToc();
    updateBar();
    return state.toc;
  }

  function ensureToc(force) {
    if (!state.bookId) return Promise.resolve(null);
    if (state.toc && state.toc.bookId === state.bookId && !force) {
      return Promise.resolve(state.toc);
    }

    // 已经站在目录页时直接复用当前文档，省掉一次请求
    if (!force && pageInfo().kind === 'book' && $('.book_list')) {
      const parsed = collectTocFromDoc(document);
      if (parsed.items.length) return Promise.resolve(acceptToc(parsed));
    }

    return gmFetch(bookUrl(state.bookId)).then(function (html) {
      const doc = parseDoc(html);
      if (!doc) throw new Error('目录解析失败');
      const parsed = collectTocFromDoc(doc);
      if (!parsed.items.length) throw new Error('目录为空');
      return acceptToc(parsed);
    }).catch(function () {
      toast('目录加载失败');
      return null;
    });
  }

  function renderToc() {
    const list = $('#trx-toc-list');
    if (!list) return;
    const toc = state.toc;
    list.innerHTML = '';
    if (!toc || !toc.items.length) {
      list.textContent = '暂无目录';
      return;
    }
    const frag = document.createDocumentFragment();
    toc.items.forEach(function (it) {
      const a = document.createElement('a');
      a.href = 'javascript:void(0)';
      a.dataset.n = it.n;
      const num = document.createElement('span');
      num.className = 'trx-toc-n';
      num.textContent = it.n;
      const label = document.createElement('span');
      label.textContent = it.label.replace(/^\s*第\s*\d+\s*[节章]\s*/, '') || ('第 ' + it.n + ' 章');
      a.appendChild(num);
      a.appendChild(label);
      a.onclick = function () {
        closeToc();
        loadChapter(it.n, false);
      };
      frag.appendChild(a);
    });
    list.appendChild(frag);
    markCurrentToc();
  }

  function markCurrentToc() {
    const list = $('#trx-toc-list');
    if (!list) return;
    $$('a', list).forEach(function (a) {
      a.classList.toggle('trx-cur', parseInt(a.dataset.n, 10) === state.firstIndex);
    });
  }

  function scrollTocToCurrent() {
    const cur = $('#trx-toc-list .trx-cur');
    if (cur && cur.scrollIntoView) {
      cur.scrollIntoView({ block: 'center' });
    }
  }

  function filterToc(q) {
    const kw = (q || '').trim();
    $$('#trx-toc-list a').forEach(function (a) {
      const n = String(a.dataset.n || '');
      a.style.display = (!kw || n.indexOf(kw) >= 0) ? '' : 'none';
    });
  }

  /* =========================================================================
   * 10. 章节加载与渲染
   * ========================================================================= */
  function updateBar() {
    const wrap = $('#trx-reader');
    if (!wrap) return;
    const bookEl = $('#trx-bar-title .trx-book', wrap);
    const chapEl = $('#trx-bar-title .trx-chap', wrap);
    if (bookEl) bookEl.textContent = state.bookTitle || '阅读模式';
    if (chapEl) {
      const sec = $$('#trx-content .trx-chap');
      const last = sec[sec.length - 1];
      const t = last ? (last.dataset.title || '') : '';
      chapEl.textContent = t;
    }
    updatePager();
  }

  function updatePager() {
    const wrap = $('#trx-reader');
    if (!wrap) return;
    const pos = $('#trx-pos', wrap);
    const prev = $('#trx-prev', wrap);
    const next = $('#trx-next', wrap);
    const total = state.total || 0;
    if (pos) {
      pos.textContent = (state.firstIndex ? state.firstIndex : '—') + ' / ' + (total || '—');
    }
    if (prev) prev.disabled = !state.firstIndex || state.firstIndex <= 1;
    if (next) next.disabled = !state.firstIndex || (total > 0 && state.firstIndex >= total);
  }

  function showLoading(on) {
    const content = $('#trx-content');
    if (!content) return;
    let el = $('.trx-loading', content);
    if (on) {
      if (!el) {
        el = document.createElement('div');
        el.className = 'trx-loading';
        el.textContent = '正在加载下一章…';
        content.appendChild(el);
      }
    } else if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  function loadChapter(index, append) {
    if (!state.bookId || !index || index < 1) return Promise.resolve(false);
    if (state.loading) return Promise.resolve(false);
    state.loading = true;
    if (append) showLoading(true);

    const url = chapUrl(state.bookId, index);
    return gmFetch(url).then(function (html) {
      const data = parseChapter(html, url);
      if (!data) throw new Error('未找到正文');
      renderChapter(data, append);
      return true;
    }).catch(function () {
      if (append) state.reachedEnd = true;
      toast('第 ' + index + ' 章加载失败');
      return false;
    }).then(function (ok) {
      state.loading = false;
      if (append) showLoading(false);
      return ok;
    });
  }

  function renderChapter(data, append) {
    const content = $('#trx-content');
    if (!content) return;

    if (data.bookTitle) state.bookTitle = data.bookTitle;
    if (data.total) state.total = data.total;
    if (data.index) {
      if (!append) state.firstIndex = data.index;
      state.lastIndex = data.index;
      if (!append) state.reachedEnd = false;
    }

    const sec = document.createElement('section');
    sec.className = 'trx-chap';
    sec.dataset.index = String(data.index || '');
    sec.dataset.url = chapUrl(state.bookId, data.index);

    const title = shortTitle(data);
    sec.dataset.title = title;

    const h = document.createElement('h2');
    h.className = 'trx-chap-title';
    h.textContent = title;
    if (data.total) {
      const sub = document.createElement('span');
      sub.className = 'trx-chap-sub';
      sub.textContent = '第 ' + data.index + ' / ' + data.total + ' 章';
      h.appendChild(sub);
    }
    sec.appendChild(h);

    data.nodes.forEach(function (n) { sec.appendChild(n); });

    if (append) {
      content.appendChild(sec);
    } else {
      content.innerHTML = '';
      content.appendChild(sec);
      const main = $('#trx-main');
      if (main) main.scrollTop = 0;
      resetAutoScrollBaseline();
    }

    if (state.bookId && data.index) {
      saveProgress();
      if (state.toc) markCurrentToc();
    }
    updateBar();
    updateProgressBar();
  }

  function goRelative(delta) {
    const base = delta > 0 ? (state.lastIndex || state.firstIndex) : (state.firstIndex || 1);
    const target = base + delta;
    if (target < 1) { toast('已经是第一章'); return; }
    if (state.total && target > state.total) { toast('已经是最后一章'); return; }
    loadChapter(target, false);
  }

  /* =========================================================================
   * 11. 滚动 / 进度 / 自动连读
   * ========================================================================= */
  function updateProgressBar() {
    const main = $('#trx-main');
    const bar = $('#trx-progress-bar');
    if (!main || !bar) return;
    const max = main.scrollHeight - main.clientHeight;
    const pct = max > 0 ? Math.min(100, Math.max(0, (main.scrollTop / max) * 100)) : 0;
    bar.style.width = pct.toFixed(2) + '%';
  }

  function onReaderScroll() {
    updateProgressBar();

    const now = Date.now();
    if (now - state.lastScrollSave > 1500) {
      state.lastScrollSave = now;
      // 根据滚动位置推断当前阅读到哪一章
      const main = $('#trx-main');
      if (main) {
        const top = main.scrollTop + 60;
        const secs = $$('#trx-content .trx-chap');
        for (let i = 0; i < secs.length; i++) {
          const sec = secs[i];
          if (sec.offsetTop <= top && (i === secs.length - 1 || secs[i + 1].offsetTop > top)) {
            const idx = parseInt(sec.dataset.index, 10);
            if (idx && idx !== state.firstIndex) {
              state.firstIndex = idx;
              saveProgress();
              updatePager();
              markCurrentToc();
            }
            break;
          }
        }
      }
    }

    if (!settings.autoNext || state.loading || state.reachedEnd) return;
    const main = $('#trx-main');
    if (!main) return;
    const remain = main.scrollHeight - main.scrollTop - main.clientHeight;
    if (remain > 900) return;
    const nextIndex = (state.lastIndex || state.firstIndex || 0) + 1;
    if (!nextIndex || nextIndex < 2) return;
    if (state.total && nextIndex > state.total) return;
    loadChapter(nextIndex, true);
  }

  /* -------------------------------------------------------------------------
   * 自动滚动
   * -------------------------------------------------------------------------
   * 用 requestAnimationFrame 驱动，按「每秒像素」累加位移。
   * 关键点：scrollTop 只接受整数，速度较低时每帧位移不足 1px，
   * 若直接赋值会因取整而原地不动（读起来像卡住）。
   * 因此把小数部分累积到 state.scrollAcc，攒够 1px 才真正写入。
   * ----------------------------------------------------------------------- */
  const SCROLL_PX_PER_SEC = [14, 20, 28, 38, 50, 66, 86, 110, 140, 180];

  /** rAF 在部分环境不可用（jsdom / 极端老浏览器），用定时器兜底 */
  const raf = (typeof requestAnimationFrame === 'function')
    ? function (fn) { return requestAnimationFrame(fn); }
    : function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); };
  const caf = (typeof cancelAnimationFrame === 'function')
    ? function (id) { cancelAnimationFrame(id); }
    : function (id) { clearTimeout(id); };
  const nowTs = function () {
    return (typeof performance === 'object' && performance && performance.now)
      ? performance.now() : Date.now();
  };

  function autoScrollPxPerSec() {
    const i = Math.min(SCROLL_PX_PER_SEC.length - 1,
      Math.max(0, Math.round(settings.scrollSpeed) - 1));
    return SCROLL_PX_PER_SEC[i];
  }

  function tickAutoScroll(ts) {
    state.scrollRaf = null;
    if (!state.scrollOn) return;

    const t = (typeof ts === 'number' && isFinite(ts)) ? ts : nowTs();

    const main = $('#trx-main');
    if (!main) { stopAutoScroll(); return; }

    if (state.scrollLastTs === null) state.scrollLastTs = t;
    const dt = Math.min(64, t - state.scrollLastTs); // 切后台回来时避免跳一大段
    state.scrollLastTs = t;

    if (dt > 0) {
      state.scrollAcc += (autoScrollPxPerSec() * dt) / 1000;
      const step = Math.floor(state.scrollAcc);
      if (step > 0) {
        state.scrollAcc -= step;
        main.scrollTop += step;
      }
    }

    // 到底后交给「自动连读」续章；关掉连读则停下来
    const remain = main.scrollHeight - main.scrollTop - main.clientHeight;
    if (remain <= 2) {
      if (settings.autoNext && !state.loading && !state.reachedEnd) {
        state.scrollRaf = raf(tickAutoScroll);
        return;
      }
      stopAutoScroll();
      toast('已滚动到底部');
      return;
    }

    state.scrollRaf = raf(tickAutoScroll);
  }

  function startAutoScroll() {
    if (state.scrollOn) return;
    const main = $('#trx-main');
    if (!main) return;
    state.scrollOn = true;
    state.scrollAcc = 0;
    state.scrollLastTs = null;
    const wrap = $('#trx-reader');
    if (wrap) wrap.classList.add('trx-autoscroll');
    state.scrollRaf = raf(tickAutoScroll);
    updateScrollBtn();
    toast('自动滚动已开启（速度 ' + settings.scrollSpeed + '）');
  }

  function stopAutoScroll(silent) {
    state.scrollOn = false;
    if (state.scrollRaf !== null) {
      caf(state.scrollRaf);
      state.scrollRaf = null;
    }
    state.scrollAcc = 0;
    state.scrollLastTs = null;
    const wrap = $('#trx-reader');
    if (wrap) wrap.classList.remove('trx-autoscroll');
    updateScrollBtn();
    if (!silent) toast('自动滚动已停止');
  }

  function toggleAutoScroll() {
    if (state.scrollOn) stopAutoScroll();
    else startAutoScroll();
  }

  function updateScrollBtn() {
    const btn = $('#trx-btn-scroll');
    if (!btn) return;
    btn.textContent = state.scrollOn ? '⏸' : '▶';
    btn.classList.toggle('trx-on', state.scrollOn);
    btn.title = state.scrollOn ? '暂停自动滚动（快捷键 S）' : '自动滚动（快捷键 S）';
  }

  /** 用户主动翻章 / 跳转时，让自动滚动继续跟着走（不误停），但要重置时间基准 */
  function resetAutoScrollBaseline() {
    state.scrollLastTs = null;
    state.scrollAcc = 0;
  }

  /* =========================================================================
   * 12. 打开 / 关闭阅读模式
   * ========================================================================= */
  function openReader(startIndex) {
    if (!document.body) return;
    state.open = true;
    document.documentElement.classList.add('trx-open');
    buildReader();

    const wrap = $('#trx-reader');
    if (wrap) wrap.style.display = 'flex';

    const saved = state.bookId ? (progressMap()[state.bookId] || null) : null;
    let target = startIndex;
    if (!target && saved && saved.index) target = saved.index;
    if (!target) target = 1;

    const first = document.createElement('div');
    first.className = 'trx-loading';
    first.textContent = '正在载入…';
    const content = $('#trx-content');
    if (content) { content.innerHTML = ''; content.appendChild(first); }

    updateBar();

    // 先取目录（拿到书名 / 总章数），再载入正文；目录失败也不阻塞阅读
    ensureToc().then(function () {
      return loadChapter(target, false);
    }).then(function () {
      if (saved && saved.index && saved.index !== target) {
        toast('上次读到第 ' + saved.index + ' 章，可在目录中跳转', 2600);
      }
    });
  }

  function closeReader() {
    stopAutoScroll(true);
    const wrap = $('#trx-reader');
    if (wrap) wrap.style.display = 'none';
    state.open = false;
    document.documentElement.classList.remove('trx-open');
    closeToc();
    closeSettings();
    updateFab();
  }

  /* =========================================================================
   * 13. 悬浮按钮
   * ========================================================================= */
  function pageInfo() {
    const mc = CHAP_RE.exec(location.pathname);
    if (mc) return { kind: 'chapter', bookId: mc[1], index: parseInt(mc[2], 10) };
    const mb = BOOK_RE.exec(location.pathname);
    if (mb) return { kind: 'book', bookId: mb[1], index: null };
    return { kind: 'other', bookId: null, index: null };
  }

  function updateFab() {
    let fab = $('#trx-fab');
    const info = pageInfo();
    const canRead = info.kind === 'chapter' || info.kind === 'book';

    if (!canRead || !ALWAYS.showFab) {
      if (fab) fab.style.display = 'none';
      return;
    }
    if (!fab) {
      fab = document.createElement('div');
      fab.id = 'trx-fab';
      document.body.appendChild(fab);
    }
    fab.style.display = 'flex';
    fab.innerHTML = '';

    const readBtn = document.createElement('button');
    readBtn.className = 'trx-fab-main';
    readBtn.textContent = '📖 阅读模式';
    readBtn.onclick = function () { openReader(info.index || null); };
    fab.appendChild(readBtn);

    const darkBtn = document.createElement('button');
    darkBtn.textContent = document.documentElement.classList.contains('trxs-dark') ? '☀ 日间' : '🌙 夜间';
    darkBtn.onclick = toggleNativeDark;
    fab.appendChild(darkBtn);
  }

  /* =========================================================================
   * 14. 键盘
   * ========================================================================= */
  function onKeydown(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
      if (e.key === 'Escape') closeToc();
      return;
    }

    if (!state.open) {
      if (e.key === 'r' || e.key === 'R') {
        const info = pageInfo();
        if (info.kind === 'chapter' || info.kind === 'book') openReader(info.index || null);
      }
      return;
    }

    switch (e.key) {
      case 'Escape':
        closeToc();
        closeSettings();
        if (!$('#trx-toc') || !$('#trx-toc').classList.contains('trx-open')) closeReader();
        e.preventDefault();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        goRelative(-1);
        e.preventDefault();
        break;
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        goRelative(1);
        e.preventDefault();
        break;
      case 't':
      case 'T':
        toggleToc();
        e.preventDefault();
        break;
      case 'd':
      case 'D':
        cycleTheme();
        e.preventDefault();
        break;
      case 's':
      case 'S':
        toggleAutoScroll();
        e.preventDefault();
        break;
      case 'Home':
        if ($('#trx-main')) $('#trx-main').scrollTop = 0;
        e.preventDefault();
        break;
      case 'End':
        if ($('#trx-main')) $('#trx-main').scrollTop = $('#trx-main').scrollHeight;
        e.preventDefault();
        break;
      default:
        break;
    }
  }

  /* =========================================================================
   * 15. 启动
   * ========================================================================= */
  function boot() {
    injectCSS();
    applyNativeFlags();
    watchAds();
    document.addEventListener('keydown', onKeydown, true);

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('进入阅读模式', function () {
        const info = pageInfo();
        if (info.kind === 'chapter' || info.kind === 'book') openReader(info.index || null);
        else toast('请在书籍目录页或章节页使用');
      });
      GM_registerMenuCommand('切换夜间模式', toggleNativeDark);
      GM_registerMenuCommand('恢复默认设置', function () {
        settings = Object.assign({}, DEFAULTS);
        saveSettings();
        applyNativeFlags();
        applyReaderSettings();
        syncSettingsUI();
        toast('已恢复默认设置');
      });
    }
  }

  function whenReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(fn, 0);
    } else {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
  }

  whenReady(function () {
    const info = pageInfo();
    if (info.bookId) state.bookId = info.bookId;
    if (info.index) {
      state.firstIndex = info.index;
      state.lastIndex = info.index;
    }
    boot();
  });

  // 供自动化测试使用的调试出口（不影响正常使用）
  try {
    window.__TRX__ = {
      version: '1.3.0',
      get settings() { return settings; },
      state: state,
      parseChapter: parseChapter,
      extractBody: extractBody,
      shortTitle: shortTitle,
      gmFetch: gmFetch,
      decodeBytes: decodeBytes,
      sniffCharset: sniffCharset,
      openReader: openReader,
      closeReader: closeReader,
      loadChapter: loadChapter,
      ensureToc: ensureToc,
      pageInfo: pageInfo,
      stepFontSize: stepFontSize,
      toggleAutoScroll: toggleAutoScroll,
      startAutoScroll: startAutoScroll,
      stopAutoScroll: stopAutoScroll,
      autoScrollPxPerSec: autoScrollPxPerSec,
      applyNativeFlags: applyNativeFlags,
      isAdUrl: isAdUrl,
      sweepAds: sweepAds,
      css: CSS
    };
  } catch (e) { /* ignore */ }
})();
