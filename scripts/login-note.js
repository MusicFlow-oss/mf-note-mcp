#!/usr/bin/env node

// ターミナルから使うログイン（MCP ツール note_login_start / note_login_finish と同じ判定）。
//
// ⚠️ ログイン済みかの判定は build/login.js の checkNoteLogin ただ1つに寄せてある。
// ここに同じ判定を書き写さないこと（二重実装になり、片方だけ直す事故が起きる）。
// そのため実行前に `npm run build` が要る。
//
// 以前は「ログインが終わったらターミナルで Enter」だったが、cookie を見て自動で
// 気づくようにした。Enter を押せない環境（Claude Desktop の利用者）と同じ経路を、
// ターミナル側でも使うため。

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { checkNoteLogin } from '../build/login.js';

const DEFAULT_STATE_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.note-state.json');
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;

async function loginToNote() {
  const statePath =
    process.env.NOTE_POST_MCP_STATE_PATH || process.env.NOTE_STATE_PATH || DEFAULT_STATE_PATH;

  console.log('='.repeat(60));
  console.log('note.com ログイン');
  console.log('='.repeat(60));
  console.log();
  console.log(`認証状態の保存先: ${statePath}`);
  console.log();

  if (fs.existsSync(statePath)) {
    console.log('⚠️  既存の認証ファイルは、ログインが終わった時点で上書きします。');
    console.log();
  }

  console.log('ブラウザを起動します...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--lang=ja-JP'],
  });

  try {
    const context = await browser.newContext({
      locale: 'ja-JP',
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    await page.goto('https://note.com/login', { waitUntil: 'domcontentloaded' });

    console.log();
    console.log('━'.repeat(60));
    console.log('📝 ブラウザでログインしてください');
    console.log('━'.repeat(60));
    console.log();
    console.log('ログインが終わると自動で気づいて保存します（Enter は不要）。');
    console.log('中止するときは Ctrl+C。');
    console.log();

    const startedAt = Date.now();
    let saved = false;

    while (Date.now() - startedAt < TIMEOUT_MS) {
      let state;
      try {
        state = await context.storageState();
      } catch (error) {
        console.error('ブラウザが閉じられました。中止します。');
        process.exit(1);
      }

      const check = checkNoteLogin(state);
      if (check.loggedIn) {
        const dir = path.dirname(statePath);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        if (process.platform !== 'win32') fs.chmodSync(statePath, 0o600);
        saved = true;
        console.log();
        console.log('✅ 認証状態を保存しました！');
        console.log(`保存先: ${statePath}`);
        if (check.expiresAt) console.log(`有効期限: ${check.expiresAt}`);
        break;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!saved) {
      console.error();
      console.error('❌ 時間内にログインが確認できませんでした。やり直してください。');
      process.exit(1);
    }

    console.log();
    console.log('━'.repeat(60));
    console.log('次のステップ:');
    console.log('━'.repeat(60));
    console.log();
    console.log('MCP クライアントに build/index.js を登録してください（絶対パス指定）。');
    console.log('デフォルト以外の保存先を使った場合は NOTE_POST_MCP_STATE_PATH も設定します。');
    console.log();
    console.log('詳細は README.md の "Register with a client" を参照してください。');
    console.log();
  } catch (error) {
    console.error();
    console.error('❌ エラーが発生しました:', error.message);
    console.error();
    process.exit(1);
  } finally {
    await browser.close();
  }
}

loginToNote().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
