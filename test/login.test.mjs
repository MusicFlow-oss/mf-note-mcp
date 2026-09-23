// checkNoteLogin / checkNoteLoginFile のユニットテスト。
// ブラウザを起動せずに「ログインできたか」の判定だけを検証する: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNoteLogin, checkNoteLoginFile, NOTE_AUTH_COOKIE } from '../build/login.js';

const NOW = Date.UTC(2026, 8, 23, 0, 0, 0);
const HOUR = 3600 * 1000;

function state(cookies) {
  return { cookies, origins: [] };
}

function authCookie(overrides = {}) {
  return {
    name: NOTE_AUTH_COOKIE,
    domain: '.note.com',
    value: 'x'.repeat(572),
    expires: (NOW + 30 * 24 * HOUR) / 1000,
    ...overrides,
  };
}

test('cookie が無ければログインしていない', () => {
  assert.equal(checkNoteLogin(state([])).loggedIn, false);
  assert.equal(checkNoteLogin(null).loggedIn, false);
  assert.equal(checkNoteLogin(undefined).loggedIn, false);
  assert.equal(checkNoteLogin({}).loggedIn, false);
});

test('note 以外の cookie しか無ければログインしていない', () => {
  const r = checkNoteLogin(state([{ name: '_ga', domain: '.note.com', value: 'a' }]), NOW);
  assert.equal(r.loggedIn, false);
  assert.match(r.reason, new RegExp(NOTE_AUTH_COOKIE));
});

test('認証 cookie があればログイン済み・失効時刻を返す', () => {
  const r = checkNoteLogin(state([authCookie()]), NOW);
  assert.equal(r.loggedIn, true);
  assert.equal(r.expiresAt, new Date(NOW + 30 * 24 * HOUR).toISOString());
});

test('ドメインが note.com でなければ認めない', () => {
  const r = checkNoteLogin(state([authCookie({ domain: '.example.com' })]), NOW);
  assert.equal(r.loggedIn, false);
});

test('先頭のドットは有無どちらでも通る', () => {
  assert.equal(checkNoteLogin(state([authCookie({ domain: 'note.com' })]), NOW).loggedIn, true);
  assert.equal(checkNoteLogin(state([authCookie({ domain: 'editor.note.com' })]), NOW).loggedIn, true);
});

test('値が空なら「終わっていない」と言う', () => {
  const r = checkNoteLogin(state([authCookie({ value: '' })]), NOW);
  assert.equal(r.loggedIn, false);
  assert.match(r.reason, /空/);
});

// ⚠️ 2026-09-23 実測: 現に使えている認証ファイルの expires は6週間前だった。
// note はこの cookie の expires を寿命として扱っていないので、過去日付でも
// ログアウト扱いにしてはいけない（使えている人に「入り直せ」と言うことになる）。
test('expires が過去でもログアウト扱いにしない（参考情報として返すだけ）', () => {
  const r = checkNoteLogin(state([authCookie({ expires: (NOW - HOUR) / 1000 })]), NOW);
  assert.equal(r.loggedIn, true);
  assert.equal(r.expiresAt, new Date(NOW - HOUR).toISOString());
});

test('セッション cookie（expires=-1）は失効判定しない', () => {
  const r = checkNoteLogin(state([authCookie({ expires: -1 })]), NOW);
  assert.equal(r.loggedIn, true);
  assert.equal(r.expiresAt, undefined);
});

test('ファイルが無ければログインしていない', () => {
  const r = checkNoteLoginFile('/nowhere/.note-state.json', () => '', () => false);
  assert.equal(r.loggedIn, false);
  assert.match(r.reason, /認証ファイルがありません/);
});

test('壊れたファイルは作り直しを促す', () => {
  const r = checkNoteLoginFile('/tmp/broken.json', () => 'not json', () => true);
  assert.equal(r.loggedIn, false);
  assert.match(r.reason, /壊れて/);
});

test('ファイル経由でもログイン済みを判定できる', () => {
  const r = checkNoteLoginFile(
    '/tmp/ok.json',
    () => JSON.stringify(state([authCookie()])),
    () => true,
    NOW
  );
  assert.equal(r.loggedIn, true);
});
