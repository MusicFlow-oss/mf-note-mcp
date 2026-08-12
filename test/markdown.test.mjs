// parseMarkdown / extractImages のユニットテスト。
// ビルド成果物（build/markdown.js）に対して実行する: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMarkdown, extractImages } from '../build/markdown.js';

test('front matter: title と tags（ブロック形式）を読む', () => {
  const md = [
    '---',
    'title: 記事タイトル',
    'tags:',
    '  - PromptAgile',
    '  - 個人開発',
    '---',
    '',
    '本文です。',
  ].join('\n');
  const r = parseMarkdown(md);
  assert.equal(r.title, '記事タイトル');
  assert.deepEqual(r.tags, ['PromptAgile', '個人開発']);
  assert.equal(r.body, '本文です。');
});

test('front matter: tags 配列形式と paid_line_after', () => {
  const md = [
    '---',
    'title: "quoted"',
    'tags: [tag1, "tag2"]',
    'paid_line_after: ここまでが無料部分です',
    '---',
    'x',
  ].join('\n');
  const r = parseMarkdown(md);
  assert.equal(r.title, 'quoted');
  assert.deepEqual(r.tags, ['tag1', 'tag2']);
  assert.equal(r.paidLineAfter, 'ここまでが無料部分です');
});

test('複数行値（x_ja: | 等）の中の "- " 行をタグとして誤読しない', () => {
  const md = [
    '---',
    'title: t',
    'tags:',
    '  - real-tag',
    'x_ja: |',
    '  告知文の一行目',
    '  - これは箇条書きでありタグではない',
    '---',
    'body',
  ].join('\n');
  const r = parseMarkdown(md);
  assert.deepEqual(r.tags, ['real-tag']);
});

test('front matter なし: 先頭の # がタイトルになり、--- は水平線として本文に残る', () => {
  const md = ['# 見出しタイトル', '', '前半', '', '---', '', '後半'].join('\n');
  const r = parseMarkdown(md);
  assert.equal(r.title, '見出しタイトル');
  assert.ok(r.body.includes('---'), '水平線が本文から落ちている');
  assert.ok(r.body.includes('後半'), '--- 以降の本文が失われている');
});

test('front matter あり: 本文中の --- が本文に残る', () => {
  const md = ['---', 'title: t', '---', '前半', '', '---', '', '後半'].join('\n');
  const r = parseMarkdown(md);
  assert.ok(r.body.includes('---'));
  assert.ok(r.body.includes('後半'));
});

test('タイトルが無ければ Untitled', () => {
  const r = parseMarkdown('本文だけ');
  assert.equal(r.title, 'Untitled');
  assert.equal(r.body, '本文だけ');
});

test('extractImages: 実在するローカル画像だけを拾い、URL と欠損ファイルは無視する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-note-mcp-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'exists.png'), 'fake');
    const md = [
      '![a](./exists.png)',
      '![b](./missing.png)',
      '![c](https://example.com/remote.png)',
    ].join('\n');
    const warnings = [];
    const images = extractImages(md, dir, (m) => warnings.push(m));
    assert.equal(images.length, 1);
    assert.equal(images[0].localPath, './exists.png');
    assert.equal(images[0].alt, 'a');
    assert.equal(warnings.length, 1, '欠損ファイルの警告が出ていない');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
