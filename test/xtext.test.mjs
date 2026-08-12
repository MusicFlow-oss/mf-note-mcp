// countXWeightedLength のユニットテスト: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countXWeightedLength } from '../build/xtext.js';

test('ASCII は1文字=1', () => {
  assert.equal(countXWeightedLength('abc'), 3);
});

test('CJK は1文字=2', () => {
  assert.equal(countXWeightedLength('あいう'), 6);
});

test('URL は長さに関わらず23', () => {
  assert.equal(countXWeightedLength('https://example.com/very/long/path/that/keeps/going'), 23);
  assert.equal(countXWeightedLength('http://a.io'), 23);
});

test('混在: CJK + ASCII + URL', () => {
  // あ(2) + a(1) + 半角スペース(1) + URL(23) = 27
  assert.equal(countXWeightedLength('あa https://x.com/y'), 27);
});

test('URL 2本はそれぞれ23', () => {
  assert.equal(countXWeightedLength('https://a.io https://b.io'), 23 + 1 + 23);
});

test('280 判定の境界に使える（意味のある実文で281以上を検出できる）', () => {
  const ja = 'あ'.repeat(140); // 280
  assert.equal(countXWeightedLength(ja), 280);
  assert.equal(countXWeightedLength(ja + 'a'), 281);
});
