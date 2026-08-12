#!/usr/bin/env node
// ビルド時に src/version.ts を生成する。
//
// なぜ「実行時に package.json を読む」ではダメか:
// 起動中のプロセスはコードをメモリに載せたまま動き続けるので、あとから
// package.json だけ新しくなっても、そのプロセスは古いコードのまま新しい番号を
// 名乗ってしまう。それでは「いま動いているのは新ビルドか」を判定できない
// （2026-08-02 に実際にこれで詰まった）。
// import はプロセス起動時に確定するため、ビルド時に焼き込めば、稼働中の
// プロセスは「自分がロードしたコードの版」を名乗り続ける。

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  const dirty = execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  if (dirty) gitCommit += '-dirty';
} catch {
  // git が無い環境（tarball 展開など）でもビルドは通す
}

const buildTime = new Date().toISOString();

writeFileSync(
  join(root, 'src', 'version.ts'),
  `// 自動生成ファイル — 直接編集しない（scripts/gen-version.js が prebuild で生成する）
export const VERSION = ${JSON.stringify(pkg.version)};
export const BUILD_TIME = ${JSON.stringify(buildTime)};
export const GIT_COMMIT = ${JSON.stringify(gitCommit)};
`,
  'utf8'
);

// ディスク側の正典。skill はこれと server_info の戻りを突き合わせる。
// tsc より先に走るので build/ がまだ無いことがある。
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(
  join(root, 'build', 'version.json'),
  JSON.stringify({ version: pkg.version, buildTime, gitCommit }, null, 2) + '\n',
  'utf8'
);

console.log(`version.ts generated: ${pkg.version} / ${buildTime} / ${gitCommit}`);
