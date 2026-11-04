// 抓取测试样本页面到 test/fixtures/
//
// 这些文件是站点原始 GB2312 字节，只用于本地回归测试，不纳入版本库
// （见 .gitignore）。运行测试前先执行本脚本：
//
//   node test/fetch-fixtures.mjs
//
// 说明：
// - Cloudflare 会拦截 Node 内置 fetch 的 TLS 指纹（返回 403），所以这里调用系统 curl。
// - 为避免依赖子进程输出捕获，本脚本不读取 curl 的 stdout，只按落盘文件大小判断结果。
// - 若没有 curl，请手动下载下列 URL 并保持同名保存。

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';

const FIX = path.join(import.meta.dirname, 'fixtures');

const TARGETS = [
  // [保存文件名, 站点 URL]
  ['12573_1.html',   'http://trxs.cc/tongren/12573/1.html'],
  ['12573_50.html',  'http://trxs.cc/tongren/12573/50.html'],
  ['12573_98.html',  'http://trxs.cc/tongren/12573/98.html'],
  ['12554_338.html', 'http://trxs.cc/tongren/12554/338.html'],
  ['12573.html',     'http://trxs.cc/tongren/12573.html'],
  ['12554.html',     'http://trxs.cc/tongren/12554.html'],
  // 越界章节，站点返回 404 提示页，用于验证「不误判为正文」
  ['12554_1018.html', 'http://trxs.cc/tongren/12554/1018.html']
];

// 各文件至少应达到的字节数，用来判断是否真的抓到了页面（404 提示页也很大，属正常）
const MIN_SIZE = 5000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function hasCurl() {
  const r = spawnSync('curl', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

mkdirSync(FIX, { recursive: true });

if (!hasCurl()) {
  console.error('未找到 curl，无法自动抓取样本。');
  console.error('请手动下载以下 URL，并按下表命名保存到 test/fixtures/：\n');
  for (const [name, url] of TARGETS) console.error('  ' + name.padEnd(18) + url);
  process.exit(1);
}

let ok = 0;
let bad = 0;

for (const [name, url] of TARGETS) {
  const out = path.join(FIX, name);
  if (existsSync(out)) rmSync(out);

  const r = spawnSync(
    'curl',
    ['-s', '-o', out, '-A', UA, '--max-time', '30', url],
    { stdio: 'ignore' }
  );

  if (r.error) {
    console.error('  FAIL  ' + name + '  ' + r.error.message);
    bad++;
    continue;
  }

  const size = existsSync(out) ? statSync(out).size : 0;
  if (size >= MIN_SIZE) {
    console.log('  OK    ' + name.padEnd(18) + size + ' B');
    ok++;
  } else {
    console.error('  FAIL  ' + name.padEnd(18) + (size ? size + ' B 过小' : '未落盘'));
    bad++;
  }
}

console.log('\n完成：成功 ' + ok + '，失败 ' + bad);
if (bad > 0) process.exit(1);
console.log('现在可以运行：node test/run.mjs && node test/integration.mjs && node test/live.mjs');
