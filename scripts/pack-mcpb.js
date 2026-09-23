#!/usr/bin/env node

// .mcpb（Claude Desktop のワンクリック導入パッケージ）を作る。
//
//   npm run pack
//
// 中身は「動かすのに要るものだけ」。staging ディレクトリを作って必要物だけ集め、
// そこで本番依存だけを入れ直してから固める。リポジトリをそのまま固めない理由は
// devDependencies（typescript 等）や .git を配ってしまうため。
//
// ⚠️ Chromium（約300MB）は同梱しない。入れると bundle が巨大になるので、
// 利用者の端末で初回に note_login_start が取りに行く（src/index.ts の
// startChromiumInstall）。したがってこの .mcpb だけではまだブラウザは無い。

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf-8'));

if (manifest.version !== pkg.version) {
  console.error(
    `manifest.json の version (${manifest.version}) と package.json (${pkg.version}) が食い違っています。合わせてから作り直してください。`
  );
  process.exit(1);
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });

console.log('1/4 build');
run('npm', ['run', 'build'], { cwd: root });

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-note-mcpb-'));
console.log(`2/4 staging: ${stage}`);

const copy = (rel, required = true) => {
  const from = path.join(root, rel);
  if (!fs.existsSync(from)) {
    if (required) throw new Error(`見つかりません: ${rel}`);
    return;
  }
  fs.cpSync(from, path.join(stage, rel), { recursive: true });
};

copy('manifest.json');
copy('icon.png');
copy('build');
copy('package.json');
copy('package-lock.json');
copy('LICENSE');
copy('README.md', false);

console.log('3/4 install production deps');
run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: stage });
// package-lock.json は配布物に要らない（入れ直しは済んでいる）
fs.rmSync(path.join(stage, 'package-lock.json'), { force: true });

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const out = path.join(distDir, `mf-note-mcp-${pkg.version}.mcpb`);
fs.rmSync(out, { force: true });

console.log('4/4 pack');
run('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'pack', stage, out], { cwd: root });

fs.rmSync(stage, { recursive: true, force: true });

const size = fs.statSync(out).size;
console.log();
console.log(`できました: ${out}`);
console.log(`サイズ: ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log();
console.log('Claude Desktop にダブルクリックで入れて、「noteにログインして」と伝えてください。');
