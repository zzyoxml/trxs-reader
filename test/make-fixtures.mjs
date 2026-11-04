// 生成「合成测试样本」到 test/fixtures/
//
// 用途：CI 环境不联网、也不把站点正文放进公开仓库，这里造一份结构与
// 真实页面同形的 HTML，覆盖脚本依赖的全部 DOM 契约：
//   .read_chapterDetail / .read_chapterName h1 / .textinfo em
//   .pageNav（{n}/{total}）/ .book_list a[href] / .book_info h1
//
// 本地开发推荐用 test/fetch-fixtures.mjs 抓真实页面，两个脚本产物同名，
// 后者会覆盖前者。
//
//   node test/make-fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const FIX = path.join(import.meta.dirname, 'fixtures');
mkdirSync(FIX, { recursive: true });

// 各书的合成参数（章数刻意与书名标注不一致，用于验证「不采信标题数字」）
// 章节样本文件名必须与 run.mjs / live.mjs 期望的一致。
const BOOKS = [
  {
    id: 12573, total: 98, title: '测试书甲', declared: '(1-165)',
    chapters: [1, 50, 98], parasPerChapter: 70
  },
  {
    id: 12554, total: 338, title: '测试书乙', declared: '(1-1018)',
    chapters: [338], parasPerChapter: 70
  }
];

/** 生成长度可变的正文段落，段首带全角空格（还原站点原始格式） */
function paragraphs(n, seed) {
  const filler = [
    '他沿着巷子往里走，两侧的墙壁斑驳脱落，露出底下发霉的红砖。',
    '风从街口灌进来，卷起地上的碎纸和灰尘，打在脸上生疼。',
    '远处传来铁轨的震动声，一列货车正缓缓驶过城郊的货运站。',
    '天光被云层压得很低，像一块脏抹布盖在城市头顶。',
    '他没有回头，只是把手插进大衣口袋里，握紧了那枚硬币。'
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push('\u3000\u3000' + filler[(i + seed) % filler.length] + '（' + (i + 1) + '）');
  }
  return out;
}

function chapterHtml(book, index, parasPerChapter) {
  const paras = paragraphs(parasPerChapter, index);
  const prev = Math.max(1, index - 1);
  const next = Math.min(book.total, index + 1);
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=gb2312" />
<title>${book.title} 第${index}章 - 同人小说网</title>
<link rel="stylesheet" href="/skin/default/css/bookread.css" />
</head>
<body class="reading">
<div class="topReadContent">
  <div class="readContent" id="readContent_set">
    <div class="read_chapterName tc">
      <h1>${book.title} 第${index}章</h1>
      <div class="textinfo"><em>作者：测试作者</em></div>
    </div>
    <div class="read_chapterDetail">
${paras.map((p) => '      <p>' + p + '</p>').join('\n')}
    </div>
    <div class="pageNav">
      <a href="/tongren/${book.id}/1.html">首章</a>
      <a href="/tongren/${book.id}/${prev}.html">上一章</a>
      ${index}/${book.total}
      <a href="/tongren/${book.id}/${next}.html">下一章</a>
      <a href="/tongren/${book.id}/${book.total}.html">尾章</a>
      <a href="/tongren/${book.id}.html">目录</a>
    </div>
    <div class="next_pre">
      <p>上一篇：<a href="#">无</a></p>
      <p>下一篇：<a href="#">无</a></p>
    </div>
  </div>
</div>
<div class="hotlist"><h3>推荐阅读!</h3></div>
<div class="copyright">本站所有小说为转载作品</div>
</body>
</html>`;
}

function tocHtml(book) {
  const items = [];
  for (let i = 1; i <= book.total; i++) {
    items.push(`      <li><a href="/tongren/${book.id}/${i}.html">第${i}节</a></li>`);
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=gb2312" />
<title>${book.title}${book.declared} - 同人小说网</title>
</head>
<body>
<div class="book_info">
  <h1>${book.title}${book.declared}</h1>
</div>
<div class="book_list clearfix">
  <ul class="clearfix">
${items.join('\n')}
  </ul>
</div>
</body>
</html>`;
}

function notFoundHtml(id, n) {
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=gb2312" />
<title>页面不存在 - 同人小说网</title>
</head>
<body>
<div class="readContent" id="readContent_set">
  <div class="errmsg">抱歉，本章节不存在或已被删除。（${id}/${n}）</div>
</div>
</body>
</html>`;
}

let count = 0;
for (const book of BOOKS) {
  for (const idx of book.chapters) {
    const name = book.id + '_' + idx + '.html';
    writeFileSync(path.join(FIX, name), chapterHtml(book, idx, book.parasPerChapter), 'utf8');
    count++;
  }
  writeFileSync(path.join(FIX, book.id + '.html'), tocHtml(book), 'utf8');
  count++;
}

// 越界章节 → 404 提示页（无 .read_chapterDetail，应解析为 null）
writeFileSync(path.join(FIX, '12554_1018.html'), notFoundHtml(12554, 1018), 'utf8');
count++;

console.log('已生成 ' + count + ' 个合成样本到 test/fixtures/');
console.log('注意：这些是合成数据，不是站点真实内容。');
