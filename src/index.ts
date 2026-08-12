#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import 'dotenv/config';
import { VERSION, BUILD_TIME, GIT_COMMIT } from './version.js';
import { extractImages, parseMarkdown } from './markdown.js';
import { countXWeightedLength } from './xtext.js';

// 名称一貫性
const SERVER_NAME = process.env.MCP_NAME ?? 'note-post-mcp';
// ⚠️ version はビルド時に焼き込む（src/version.ts は prebuild が生成）。
// 実行時に package.json を読む実装にしてはいけない。起動中のプロセスは古い
// コードをメモリに載せたまま動き続けるので、ファイルだけ新しくなると
// 「旧コードが新しい番号を名乗る」状態になり、鮮度の判定ができなくなる。
const SERVER_VERSION = VERSION;

// 環境変数デフォルト
const DEFAULT_STATE_PATH = process.env.NOTE_POST_MCP_STATE_PATH ?? 
  path.join(os.homedir(), '.note-state.json');
const DEFAULT_TIMEOUT = parseInt(process.env.NOTE_POST_MCP_TIMEOUT ?? '180000', 10);
// X（旧 Twitter）の認証情報。ツール定義でも参照するのでここで宣言する
const DEFAULT_X_STATE_PATH = process.env.X_STATE_PATH ?? path.join(os.homedir(), '.x-state.json');
// Facebook Page の認証情報。同上
const DEFAULT_FACEBOOK_STATE_PATH =
  process.env.FACEBOOK_STATE_PATH ?? path.join(os.homedir(), '.facebook-state.json');
const FACEBOOK_GRAPH_VERSION = 'v26.0';

// ログ用ユーティリティ
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${SERVER_NAME}] ${message}`, data ?? '');
}

// 現在時刻のフォーマット
function nowStr(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

// Markdown の解析は ./markdown.ts（純粋関数・テスト対象）に分離した。

// リンクカード化の取りこぼし（カードは出来たのに元の URL テキストが段落として残る）を
// 検出して掃除する。2026-08-10 に paid-01 で実測した事故への対処。
//
// note のカード化は OGP 取得を伴う非同期処理で、確定前に入力を終えると
// 「figure（カード）＋ URL だけの段落」が両方残ることがある。読者には同じリンクが
// 二重に見えるので、保存前にここで取り除く。
//
// 戻り値: { removed, remaining } — remaining が 0 でなければ呼び出し側で中断する。
async function cleanupOrphanLinkCardUrls(
  page: any,
  timeout: number
): Promise<{ removed: string[]; remaining: string[] }> {
  const findOrphans = async (): Promise<string[]> =>
    await page.evaluate(() => {
      const root = document.querySelector('[contenteditable="true"]');
      if (!root) return [];
      // カード化済みの URL を集める。
      // ⚠️ note のリンクカードは `<figure data-src="...">` に iframe を抱える形で、
      // **figure の中に a[href] は無い**（2026-08-10 に実 DOM で確認）。
      // `figure a[href]` だけで探すと1件も拾えず、掃除が永久に発火しない。
      const carded = new Set<string>();
      const norm = (u: string) => String(u).replace(/\/$/, '');
      Array.from(root.querySelectorAll('figure[data-src]')).forEach((f: any) => {
        carded.add(norm(f.getAttribute('data-src')));
      });
      Array.from(root.querySelectorAll('figure a[href]')).forEach((a: any) => {
        carded.add(norm(a.href));
      });
      // 素の URL だけで構成された段落のうち、同じ URL のカードが既にあるもの
      const out: string[] = [];
      Array.from(root.querySelectorAll('p')).forEach((p: any) => {
        const text = (p as HTMLElement).innerText.trim();
        if (!/^https?:\/\/\S+$/.test(text)) return;
        if (carded.has(norm(text))) out.push(text);
      });
      return out;
    });

  const initial: string[] = await findOrphans();
  if (!initial.length) return { removed: [], remaining: [] };

  log('Orphan raw URLs found after link-card conversion', { urls: initial });

  const removed: string[] = [];
  for (const url of initial) {
    // 段落だけを狙う（カードの可視テキストは記事タイトルなので URL 完全一致では拾わない）
    const target = page.getByText(url, { exact: true }).last();
    try {
      await target.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
      await target.click({ clickCount: 3 });
      await page.waitForTimeout(200);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(400);
      removed.push(url);
    } catch (e: any) {
      log('Failed to remove orphan raw URL', { url, error: e?.message });
    }
  }

  const remaining: string[] = await findOrphans();
  return { removed, remaining };
}

// note.com投稿関数
async function postToNote(params: {
  markdownPath: string;
  thumbnailPath?: string;
  statePath?: string;
  isPublic: boolean;
  screenshotDir?: string;
  timeout?: number;
  /** 指定すると新規作成ではなく既存記事のエディタを開き、タイトル・本文を md の内容で全置換する（update_draft 用） */
  noteKey?: string;
  /** false にすると公開フローでタグ入力をスキップする（公開済み記事の再公開時に既存タグを触らないため） */
  setTags?: boolean;
  /**
   * 有料記事を再公開するときの有料ラインの位置（この文字列で始まる段落の直後に置く）。
   * 省略時は md の front matter `paid_line_after` を使う。どちらも無い有料記事は**中断する**
   * （note は再公開のたびに有料ラインを冒頭へ飛ばすため、黙って進むと全文が無料で公開される）。
   */
  paidLineAfter?: string;
}): Promise<{
  success: boolean;
  url: string;
  screenshot?: string;
  message: string;
  /** 有料記事のとき、確定直前に実測した有料ラインの前後の段落 */
  paidLine?: { before: string; after: string | null };
}> {
  const {
    markdownPath,
    thumbnailPath,
    statePath = DEFAULT_STATE_PATH,
    isPublic,
    screenshotDir = path.join(os.tmpdir(), 'note-screenshots'),
    timeout = DEFAULT_TIMEOUT,
    noteKey,
    setTags = true,
    paidLineAfter: paidLineAfterParam,
  } = params;

  // Markdownファイルを読み込み
  if (!fs.existsSync(markdownPath)) {
    throw new Error(`Markdown file not found: ${markdownPath}`);
  }
  const mdContent = fs.readFileSync(markdownPath, 'utf-8');
  const { title, body, tags, paidLineAfter: paidLineAfterFm } = parseMarkdown(mdContent);
  // 引数を優先し、無ければ front matter を使う
  const paidLineAfter = paidLineAfterParam ?? paidLineAfterFm;
  
  // 本文中の画像を抽出
  const baseDir = path.dirname(markdownPath);
  const images = extractImages(body, baseDir, (m) => log(m));

  log('Parsed markdown', { title, bodyLength: body.length, tags, imageCount: images.length });

  // 認証状態ファイルを確認
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }

  // スクリーンショットディレクトリを作成
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `note-post-${nowStr()}.png`);

  // note.com のエディタ SPA はヘッドレス（headless_shell）だと text_notes API が
  // ボット判定で ERR_FAILED になり描画されない。実描画される headed で起動しつつ、
  // ウィンドウを画面外に置いてフォーカスを奪わないようにする。
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--lang=ja-JP',
      '--window-position=-2400,-2400',
      '--window-size=1280,900',
    ],
  });

  try {
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ja-JP',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    
    // クリップボード権限を明示的に付与
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://editor.note.com' });

    // 新規記事作成ページ、または（update 時は）既存記事のエディタに移動
    const startUrl = noteKey
      ? `https://editor.note.com/notes/${noteKey}/edit/`
      : 'https://editor.note.com/new';
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('textarea[placeholder*="タイトル"]', { timeout });

    // サムネイル画像の設定
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      log('Uploading thumbnail image');
      const candidates = page.locator('button[aria-label="画像を追加"]');

      // 既にアイキャッチが設定されている記事（update 時）には「画像を追加」が無い。
      // note のエディタには「変更」ボタンが存在せず、画像に重なった × で一度消すと
      // 「画像を追加」が現れる、という UI なので、先に削除する。
      // 「画像を追加」ボタン or 既存アイキャッチ画像のどちらかが現れるまで待つ
      // （isVisible() は即時判定なので、描画前に呼ぶと必ず false になる）
      await page.waitForFunction(
        () => {
          if (document.querySelector('button[aria-label="画像を追加"]')) return true;
          return Array.from(document.querySelectorAll('img')).some((i) => {
            const r = i.getBoundingClientRect();
            return /assets\.st-note\.com/.test(i.src) && r.top < 600 && r.width > 300;
          });
        },
        { timeout }
      );

      const hasAddBtn = await candidates.first().isVisible().catch(() => false);
      if (!hasAddBtn) {
        log('Existing eyecatch found, removing it first');
        const removed = await page.evaluate(() => {
          const img = Array.from(document.querySelectorAll('img')).find((i) => {
            const r = i.getBoundingClientRect();
            return /assets\.st-note\.com/.test(i.src) && r.top < 600 && r.width > 300;
          });
          // × は img の直上（figure）ではなく、その1つ上のコンテナに置かれている。
          // 構造変更に耐えるよう、ボタンが見つかるまで数階層だけ遡る。
          let el: HTMLElement | null | undefined = img?.parentElement;
          for (let depth = 0; depth < 4 && el; depth++, el = el.parentElement) {
            const btn = el.querySelector('button');
            if (btn) {
              (btn as HTMLButtonElement).click();
              return true;
            }
          }
          return false;
        });
        if (!removed) {
          throw new Error(
            'アイキャッチの差し替えに失敗しました（既存画像の削除ボタンが見つからない）。note のエディタ構造が変わった可能性があります。'
          );
        }
        await page.waitForTimeout(800);
      }

      await candidates.first().waitFor({ state: 'visible', timeout });

      let target = candidates.first();
      const cnt = await candidates.count();
      if (cnt > 1) {
        let minY = Infinity;
        let idx = 0;
        for (let i = 0; i < cnt; i++) {
          const box = await candidates.nth(i).boundingBox();
          if (box && box.y < minY) {
            minY = box.y;
            idx = i;
          }
        }
        target = candidates.nth(idx);
      }

      await target.scrollIntoViewIfNeeded();
      await target.click({ force: true });

      const uploadBtn = page.locator('button:has-text("画像をアップロード")').first();
      await uploadBtn.waitFor({ state: 'visible', timeout });

      let chooser = null;
      try {
        [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }),
          uploadBtn.click({ force: true }),
        ]);
      } catch (_) {
        // フォールバック
      }

      if (chooser) {
        await chooser.setFiles(thumbnailPath);
      } else {
        await uploadBtn.click({ force: true }).catch(() => {});
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout });
        await fileInput.setInputFiles(thumbnailPath);
      }

      // トリミングダイアログ内「保存」を押す
      const dialog = page.locator('div[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout });

      const saveThumbBtn = dialog.locator('button:has-text("保存")').first();
      const cropper = dialog.locator('[data-testid="cropper"]').first();

      const cropperEl = await cropper.elementHandle();
      const saveEl = await saveThumbBtn.elementHandle();

      if (cropperEl && saveEl) {
        await Promise.race([
          page.waitForFunction(
            (el) => getComputedStyle(el as Element).pointerEvents === 'none',
            cropperEl,
            { timeout }
          ),
          page.waitForFunction(
            (el) => !(el as HTMLButtonElement).disabled,
            saveEl,
            { timeout }
          ),
        ]);
      }

      await saveThumbBtn.click();
      await dialog.waitFor({ state: 'hidden', timeout }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {});

      // 反映確認
      const changedBtn = page.locator('button[aria-label="画像を変更"]');
      const addBtn = page.locator('button[aria-label="画像を追加"]');

      let applied = false;
      try {
        await changedBtn.waitFor({ state: 'visible', timeout: 5000 });
        applied = true;
      } catch {}
      if (!applied) {
        try {
          await addBtn.waitFor({ state: 'hidden', timeout: 5000 });
          applied = true;
        } catch {}
      }
      if (!applied) {
        log('Thumbnail reflection uncertain, continuing');
      }
    }

    // タイトル設定
    await page.fill('textarea[placeholder*="タイトル"]', title);
    log('Title set');

    // 本文設定（行ごとに処理してURLをリンクカードに変換、画像を埋め込む）
    const bodyBox = page.locator('div[contenteditable="true"][role="textbox"]').first();
    await bodyBox.waitFor({ state: 'visible' });
    await bodyBox.click();

    // update 時は既存本文を全選択して消してから入力（全置換）
    if (noteKey) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(400);
      log('Cleared existing body for update');
    }

    const lines = body.split('\n');
    const isMacPlatform = process.platform === 'darwin';
    let previousLineWasList = false; // 前の行がリスト項目だったかを追跡
    let previousLineWasQuote = false; // 前の行が引用だったかを追跡
    let previousLineWasHorizontalRule = false; // 前の行が水平線だったかを追跡
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;
      
      // コードブロックの開始を検出
      if (line.trim().startsWith('```')) {
        // コードブロック全体（```から```まで）を収集
        const codeBlockLines: string[] = [line]; // 開始行を含める
        let j = i + 1;
        
        // 終了行まで収集
        while (j < lines.length) {
          codeBlockLines.push(lines[j]);
          if (lines[j].trim().startsWith('```')) {
            break; // 終了行を含めて終了
          }
          j++;
        }
        
        // コードブロック全体をクリップボードにコピー
        const codeBlockContent = codeBlockLines.join('\n');
        
        await page.evaluate((text) => {
          return navigator.clipboard.writeText(text);
        }, codeBlockContent);
        
        await page.waitForTimeout(200);
        
        // ペースト
        const isMac = process.platform === 'darwin';
        if (isMac) {
          await page.keyboard.press('Meta+v');
        } else {
          await page.keyboard.press('Control+v');
        }
        
        await page.waitForTimeout(300);
        
        // コードブロックの後に改行（最終行でない場合）
        if (j < lines.length - 1) {
          await page.keyboard.press('Enter');
        }
        
        // iをコードブロック終了行まで進める
        i = j;
        
        // フラグをリセット
        previousLineWasList = false;
        previousLineWasQuote = false;
        previousLineWasHorizontalRule = false;
        continue;
      }
      
      // 次の行が水平線かどうかをチェック
      const nextLine = i < lines.length - 1 ? lines[i + 1] : '';
      const nextLineIsHorizontalRule = nextLine.trim() === '---';
      
      // 水平線の直後の空行をスキップ
      if (previousLineWasHorizontalRule && line.trim() === '') {
        previousLineWasHorizontalRule = false;
        continue; // 空行をスキップ
      }
      previousLineWasHorizontalRule = false;
      
      // 画像マークダウンを検出
      const imageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (imageMatch) {
        const imagePath = imageMatch[2];
        // ローカルパスの画像をアップロード
        if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
          const imageInfo = images.find(img => img.localPath === imagePath);
          if (imageInfo && fs.existsSync(imageInfo.absolutePath)) {
            log('Pasting inline image', { path: imageInfo.absolutePath });
            
            // 画像をクリップボードにコピーしてペーストする方法
            // 1. 改行して新しい行を作成
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);
            
            // 2. 画像ファイルをクリップボードにコピー
            const imageBuffer = fs.readFileSync(imageInfo.absolutePath);
            const base64Image = imageBuffer.toString('base64');
            const mimeType = imageInfo.absolutePath.endsWith('.png') ? 'image/png' : 
                           imageInfo.absolutePath.endsWith('.jpg') || imageInfo.absolutePath.endsWith('.jpeg') ? 'image/jpeg' :
                           imageInfo.absolutePath.endsWith('.gif') ? 'image/gif' : 'image/png';
            
            // クリップボードに画像を設定するためのJavaScriptを実行
            await page.evaluate(async ({ base64, mime }) => {
              const response = await fetch(`data:${mime};base64,${base64}`);
              const blob = await response.blob();
              const item = new ClipboardItem({ [mime]: blob });
              await navigator.clipboard.write([item]);
            }, { base64: base64Image, mime: mimeType });
            
            await page.waitForTimeout(500);
            
            // 3. Cmd+V (macOS) または Ctrl+V でペースト
            const isMac = process.platform === 'darwin';
            if (isMac) {
              await page.keyboard.press('Meta+v');
            } else {
              await page.keyboard.press('Control+v');
            }
            
            // ペースト完了を待つ
            await page.waitForTimeout(2000);
            
            log('Inline image pasted');
            
            // 画像の後に改行してテキストボックスに戻る
            if (!isLastLine) {
              await page.keyboard.press('Enter');
            }
            previousLineWasList = false; // 画像の後はリストではない
            previousLineWasQuote = false; // 画像の後は引用ではない
            previousLineWasHorizontalRule = false; // 画像の後は水平線ではない
            continue; // 次の行へ
          }
        }
      }
      
      // 水平線かどうかをチェック
      const isHorizontalRule = line.trim() === '---';
      
      // 現在の行がリスト項目かどうかをチェック
      const isBulletList = /^(\s*)- /.test(line);
      const isNumberedList = /^(\s*)\d+\.\s/.test(line);
      const isCurrentLineList = isBulletList || isNumberedList;
      
      // 現在の行が引用かどうかをチェック
      const isQuote = /^>/.test(line);
      
      // 通常のテキスト行を入力
      let processedLine = line;
      
      // 前の行がリスト項目で、現在の行もリスト項目なら、マークダウン記号を削除
      if (previousLineWasList && isCurrentLineList) {
        // 箇条書きリスト: "- " または "  - " などを削除
        // 先頭のスペース（インデント）を保持しつつ、"- " だけを削除
        if (isBulletList) {
          processedLine = processedLine.replace(/^(\s*)- /, '$1');
        }
        
        // 番号付きリスト: "1. " または "  1. " などを削除
        // 先頭のスペース（インデント）を保持しつつ、"数字. " だけを削除
        if (isNumberedList) {
          processedLine = processedLine.replace(/^(\s*)\d+\.\s/, '$1');
        }
      }
      
      // 前の行が引用で、現在の行も引用なら、マークダウン記号を削除
      if (previousLineWasQuote && isQuote) {
        // 引用: "> " を削除
        processedLine = processedLine.replace(/^>\s?/, '');
      }
      
      await page.keyboard.type(processedLine);
      
      // 次の行のために、現在の行の状態を記録
      previousLineWasList = isCurrentLineList;
      previousLineWasQuote = isQuote;
      previousLineWasHorizontalRule = isHorizontalRule;
      
      // URL単独行の場合、追加でEnterを押してリンクカード化をトリガー
      const isUrlLine = /^https?:\/\/[^\s]+$/.test(line.trim());
      if (isUrlLine) {
        await page.keyboard.press('Enter');
        // リンクカード展開のアニメーション完了を待機。
        // ⚠️ 最後の行のときは長めに待つ（2026-08-10 実測）。カード化は OGP 取得を
        // 伴う非同期処理で、確定前に本文入力を終えて保存へ進むと、カードは出来て
        // いるのに**元の URL テキストが段落として残る**（paid-01 で発生）。次の行が
        // ある場合は後続の入力までに時間が稼げるが、最後の行にはそれが無い。
        await page.waitForTimeout(isLastLine ? 2500 : 1200);

        // キャレットを本文の末尾へ明示的に戻す。
        // ⚠️ ここは以前 ArrowDown（相対移動）だった。カード展開後のキャレット位置は
        // 展開の仕方に依存するため、1行下がるだけでは末尾に着かないことがあり、
        // 以降の入力がどこにも入らず**黙って落ちる**事故が起きた（2026-08-02 実測。
        // hr/05 で関連記事4本のうち後半2本が欠落。success は返っていた）。
        // 本文は毎回クリアしてから先頭から入力するので、「末尾」＝ここまでに
        // 入力し終えた位置であり、絶対移動で確実に追いつける。
        // ⚠️ 最後の行でも実行する（以前は `if (!isLastLine)` で飛ばしていた）。
        // 末尾での余計な移動は無害な一方、カード化の確定を促す効果が期待できる。
        await page.keyboard.press(isMacPlatform ? 'Meta+ArrowDown' : 'Control+End');
        await page.waitForTimeout(150);
      } else {
        // URL以外の行の場合のみ、最後の行でなければ改行
        if (!isLastLine) {
          await page.keyboard.press('Enter');
        }
      }
    }
    
    log('Body set');

    // リンクカード化の取りこぼしを掃除する（カード＋素のURL段落が二重に残る事故への対処）。
    // ⚠️ 掃除しきれなかったら**保存せずに中断する**。二重リンクのまま公開すると
    // 読者に見える壊れ方をするので、黙って成功を返すより止めるほうがよい。
    const orphanCleanup = await cleanupOrphanLinkCardUrls(page, timeout);
    if (orphanCleanup.removed.length) {
      log('Removed orphan raw URLs', { urls: orphanCleanup.removed });
    }
    if (orphanCleanup.remaining.length) {
      throw new Error(
        `リンクカード化の取りこぼしを解消できませんでした（カードと素のURLが二重に残っています）: ` +
          `${orphanCleanup.remaining.join(', ')}。記事は保存していません。` +
          `note のエディタで該当の URL 行を削除してから、もう一度実行してください。`
      );
    }

    // 下書き保存の場合
    if (!isPublic) {
      const saveBtn = page.locator('button:has-text("下書き保存"), [aria-label*="下書き保存"]').first();
      try {
        await saveBtn.waitFor({ state: 'visible', timeout: Math.min(timeout, 20000) });
      } catch {
        // 公開済み記事のエディタには「下書き保存」が無く「公開に進む」しか出ない。
        // ここで待ち続けても保存されないので、原因が分かる形で早く落とす。
        const hasProceed = await page
          .locator('button:has-text("公開に進む")')
          .first()
          .isVisible()
          .catch(() => false);
        throw new Error(
          hasProceed
            ? 'この記事は公開済みのため「下書き保存」ができません（note のエディタに下書き保存ボタンが出ない）。本文を差し替えて公開版に反映するには update_draft を publish: true で呼んでください（＝再公開になります）。'
            : '「下書き保存」ボタンが見つかりませんでした（note のエディタ構造が変わった可能性があります）。'
        );
      }
      if (await saveBtn.isEnabled()) {
        await saveBtn.click();
        await page.locator('text=保存しました').waitFor({ timeout: 4000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }

      await page.screenshot({ path: screenshotPath, fullPage: true });
      const finalUrl = page.url();
      log('Draft saved', { url: finalUrl });

      await context.close();
      await browser.close();

      return {
        success: true,
        url: finalUrl,
        screenshot: screenshotPath,
        message: '下書きを保存しました',
      };
    }

    // 公開に進む
    const proceedBtn = page.locator('button:has-text("公開に進む")').first();
    await proceedBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 20; i++) {
      if (await proceedBtn.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await proceedBtn.click({ force: true });

    // 公開ページへ遷移
    await Promise.race([
      page.waitForURL(/\/publish/i, { timeout }).catch(() => {}),
      page
        .locator('button:has-text("投稿する"), button:has-text("公開する"), button:has-text("更新する")')
        .first()
        .waitFor({ state: 'visible', timeout })
        .catch(() => {}),
    ]);

    // タグ入力
    if (setTags && tags.length > 0) {
      log('Adding tags', { tags });
      let tagInput = page.locator('input[placeholder*="ハッシュタグ"]');
      if (!(await tagInput.count())) {
        tagInput = page.locator('input[role="combobox"]').first();
      }
      await tagInput.waitFor({ state: 'visible', timeout });
      for (const tag of tags) {
        await tagInput.click();
        await tagInput.fill(tag);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
      }
    }

    // ⚠️ 有料記事は、公開設定画面の右上が確定ボタンではなく「有料エリア設定」になっている。
    // 確定ボタン（更新する）はその次の画面にしか出ないので、ここを踏まずに
    // 「投稿する|公開する|更新する」を待つと**見つからないまま timeout する**
    // （2026-08-10 実測: paid-01 で2回再現。無料記事は同じ画面に「更新する」が出るので通る）。
    //
    // さらに note は再公開のたびに有料ラインを冒頭（第1段落の直後）へ飛ばす。
    // 黙って確定すると**有料部が全部無料で公開される**ので、位置を直せないときは中断する。
    // ⚠️ 2026-08-10 実測で発覚: isVisible() は今この瞬間の状態を見るだけで待たない。
    // ページ遷移直後（まだ描画中）にここへ来ると、有料記事でも「有料エリア設定」が
    // まだ DOM に無く isPaidArticle が false と誤判定される。誤判定すると有料記事の
    // ガードが丸ごとスキップされ、位置を直さないまま「更新する」を探しにいく事故になる
    // （paid-01 で実際に発生。有料ラインが冒頭に飛んだまま確定してしまった）。
    // 短いタイムアウトで「出現を待つ」形にして、レンダリング待ちを吸収する。
    let paidLine: { before: string; after: string | null } | undefined;
    const areaBtn = page.locator('button:has-text("有料エリア設定")').first();
    const isPaidArticle = await areaBtn
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (isPaidArticle) {
      if (!paidLineAfter || !paidLineAfter.trim()) {
        throw new Error(
          'この記事は有料です。note は再公開のたびに有料ラインを冒頭へ移動させるため、' +
            'そのまま確定すると有料部が無料で公開されます。有料ラインの位置を ' +
            'paid_line_after 引数か md の front matter `paid_line_after` で指定してください。'
        );
      }
      log('Paid article detected, opening 有料エリア設定', { paidLineAfter });
      await areaBtn.click({ force: true });
      await page.waitForTimeout(1500);

      const lineResult = await setPaidLineAfter(page, paidLineAfter, timeout);
      if (!lineResult) {
        throw new Error(
          `paid_line_after に一致する段落が見つかりませんでした（"${paidLineAfter}" で始まる段落を探しました）。` +
            '有料ラインの位置が確定できないので、記事は更新していません。'
        );
      }
      // クリックが効いたかを読み直して検証する（初回クリックが効かないことがある）
      if (!lineResult.before.startsWith(paidLineAfter)) {
        throw new Error(
          `有料ラインが意図した位置に移動しませんでした（ラインの直前は "${lineResult.before}"）。` +
            '記事は更新していません。'
        );
      }
      paidLine = lineResult;
      log('Paid line set', paidLine);
    }

    // 投稿する（公開済み記事の再公開では「更新する」になる）
    const publishBtn = page
      .locator('button:has-text("投稿する"), button:has-text("公開する"), button:has-text("更新する")')
      .first();
    await publishBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 20; i++) {
      if (await publishBtn.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await publishBtn.click({ force: true });

    // 投稿完了待ち
    await Promise.race([
      page.waitForURL((url) => !/\/publish/i.test(url.toString()), { timeout: 20000 }).catch(() => {}),
      page
        .locator('text=投稿しました, text=公開されました, text=更新しました')
        .first()
        .waitFor({ timeout: 8000 })
        .catch(() => {}),
      page.waitForTimeout(5000),
    ]);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const finalUrl = page.url();
    log('Published', { url: finalUrl });

    await context.close();
    await browser.close();

    return {
      success: true,
      url: finalUrl,
      screenshot: screenshotPath,
      message: isPaidArticle ? '有料記事を更新しました（有料ラインを設定して再公開）' : '記事を公開しました',
      ...(paidLine ? { paidLine } : {}),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// 既存の下書きを公開する関数（note_key 指定。新規作成はしない）
// ============================================================
// 有料記事の価格・有料ライン
//
// 2026-07-31 実測（note の「記事タイプ」画面）:
//   - 価格は input#price（プレースホルダ "300"）。100〜50,000円のみ許容。
//     範囲外を入れても入力自体は通るが、次に進むボタン「有料エリア設定」が
//     disabled になり「販売価格は100円〜50,000円まで設定できます。」と出る。
//     （note プレミアム/pro 契約なら上限100,000円まで、との文言もあるが未契約前提でこのツールは
//     100〜50,000 のみ許可する。契約後に上げたい場合はコードのこの範囲を見直すこと）
//   - 有料ラインの指定に専用APIは無い。「記事タイプ」で 有料 を選び価格を入れて
//     「有料エリア設定」を押すと、本文の段落と段落の間すべてに「ラインをこの場所に変更」
//     ボタンが並ぶ編集画面に遷移する。現在位置のボタンだけラベルが
//     「このラインより先を有料にする」になっている。
//   - この画面のまま上部の「投稿する」を押せば、選んだラインで確定して公開される。
//     「キャンセル」を押せば何も保存されず編集画面の下書きに戻る（dry_run はこれを使う）。
// ============================================================

const MIN_PAID_PRICE = 100;
const MAX_PAID_PRICE = 50000;

function validatePrice(price: number): void {
  if (!Number.isInteger(price)) {
    throw new Error(`price must be an integer (got ${price})`);
  }
  if (price < MIN_PAID_PRICE || price > MAX_PAID_PRICE) {
    throw new Error(
      `price must be between ${MIN_PAID_PRICE} and ${MAX_PAID_PRICE} yen (got ${price}). ` +
        `note allows up to 100,000 with a premium/pro plan, but this tool only supports the standard range.`
    );
  }
}

// 公開設定画面の「記事タイプ」タブで「有料」を選び、価格を入力する。
// 呼び出し前提: page は /publish の記事タイプタブが開ける状態（公開に進む済み）。
async function selectPaidType(page: any, price: number, timeout: number): Promise<void> {
  const paidTab = page.locator('#item-paid-setting');
  if (await paidTab.count()) {
    await paidTab.click({ force: true });
    await page.waitForTimeout(500);
  }
  const paidLabel = page.locator('label[for="paid"]');
  await paidLabel.waitFor({ state: 'visible', timeout });
  await paidLabel.click({ force: true });
  await page.waitForTimeout(800);

  const priceInput = page.locator('#price');
  await priceInput.waitFor({ state: 'visible', timeout });
  await priceInput.fill('');
  await page.waitForTimeout(150);
  await priceInput.fill(String(price));
  await page.waitForTimeout(800);

  const areaBtn = page.locator('button:has-text("有料エリア設定")').first();
  await areaBtn.waitFor({ state: 'visible', timeout });
  if (!(await areaBtn.isEnabled())) {
    // note 側のバリデーションにも弾かれた（通常は validatePrice で事前に弾いているのでここには来ないはず）
    throw new Error(`note rejected price=${price} on the price field (button stayed disabled)`);
  }
  await areaBtn.click({ force: true });
  await page.waitForTimeout(1500);
}

// 有料ライン編集画面で、本文を文書順に「段落ブロック」と「ラインボタン」に分解する
async function readPaidLineSequence(
  page: any
): Promise<Array<{ kind: 'line'; current: boolean } | { kind: 'block'; text: string }>> {
  return await page.evaluate(() => {
    const isLineBtn = (el: Element) =>
      el.tagName === 'BUTTON' &&
      /このラインより先を有料にする|ラインをこの場所に変更/.test(el.textContent || '');
    const out: any[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n: Element | null;
    // eslint-disable-next-line no-cond-assign
    while ((n = walker.nextNode() as Element | null)) {
      if (isLineBtn(n)) {
        out.push({ kind: 'line', current: /このラインより先/.test(n.textContent || '') });
      } else if (/^(P|H1|H2|H3|FIGURE|BLOCKQUOTE|PRE|UL|OL)$/.test(n.tagName)) {
        const t = (n as HTMLElement).innerText?.trim().replace(/\s+/g, ' ');
        if (t && !out.some((o) => o.kind === 'block' && o.text === t)) {
          out.push({ kind: 'block', text: t });
        }
      }
    }
    return out;
  });
}

// paidLineAfter に前方一致する段落の直後にあるラインボタンをクリックする。
// 見つからなければ何もクリックせず null を返す（呼び出し側で中断させる）。
async function setPaidLineAfter(
  page: any,
  paidLineAfter: string,
  timeout: number
): Promise<{ before: string; after: string | null } | null> {
  const seq = await readPaidLineSequence(page);
  const blockIdx = seq.findIndex(
    (s) => s.kind === 'block' && (s as any).text.startsWith(paidLineAfter)
  );
  if (blockIdx === -1) return null;

  const lineIdx = seq.findIndex((s, i) => i > blockIdx && s.kind === 'line');
  if (lineIdx === -1) return null;
  const ordinal = seq.slice(0, lineIdx + 1).filter((s) => s.kind === 'line').length - 1;

  const lineButtons = page
    .locator('button')
    .filter({ hasText: /このラインより先を有料にする|ラインをこの場所に変更/ });
  await lineButtons.nth(ordinal).waitFor({ state: 'visible', timeout });
  await lineButtons.nth(ordinal).click({ force: true });
  await page.waitForTimeout(1200);

  // 実際に動いたか読み直して検証する
  const after = await readPaidLineSequence(page);
  const curIdx = after.findIndex((s) => s.kind === 'line' && (s as any).current);
  let beforeText = '';
  for (let i = curIdx - 1; i >= 0; i--) {
    if (after[i].kind === 'block') {
      beforeText = (after[i] as any).text;
      break;
    }
  }
  let afterText: string | null = null;
  for (let i = curIdx + 1; i < after.length; i++) {
    if (after[i].kind === 'block') {
      afterText = (after[i] as any).text;
      break;
    }
  }
  return { before: beforeText, after: afterText };
}

async function publishDraft(params: {
  noteKey: string;
  tags?: string[];
  price?: number;
  paidLineAfter?: string;
  dryRun?: boolean;
  statePath?: string;
  screenshotDir?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  url: string;
  status: string;
  tags: string[];
  price: number;
  dryRun?: boolean;
  paidLine?: { before: string; after: string | null };
  screenshot?: string;
  message: string;
}> {
  const {
    noteKey,
    tags = [],
    price,
    paidLineAfter,
    dryRun = false,
    statePath = DEFAULT_STATE_PATH,
    screenshotDir = path.join(os.tmpdir(), 'note-screenshots'),
    timeout = DEFAULT_TIMEOUT,
  } = params;

  if (price !== undefined) {
    validatePrice(price);
    if (!paidLineAfter || !paidLineAfter.trim()) {
      throw new Error('paid_line_after is required when price is specified');
    }
  }
  if (dryRun && price === undefined) {
    throw new Error('dry_run is only meaningful together with price (nothing to preview otherwise)');
  }

  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }

  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `note-publish-${nowStr()}.png`);

  // save_draft と同様、note のエディタは headed でないと描画されない
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--lang=ja-JP',
      '--window-position=-2400,-2400',
      '--window-size=1280,900',
    ],
  });

  try {
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ja-JP',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // 公開前の状態を API で確認（存在チェック＋二重公開の検出）
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout });
    const before = await page.evaluate(async (key) => {
      const res = await fetch(`https://note.com/api/v3/notes/${key}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const j = await res.json();
      return { status: j.data?.status, name: j.data?.name, isPublished: j.data?.is_published };
    }, noteKey);

    if (!before) {
      throw new Error(`Note "${noteKey}" not found (or not accessible)`);
    }
    log('Target note before publish', { noteKey, ...before });

    // エディタを開く
    await page.goto(`https://editor.note.com/notes/${noteKey}/edit/`, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    // 「公開に進む」
    const proceedBtn = page.locator('button:has-text("公開に進む")').first();
    await proceedBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 30; i++) {
      if (await proceedBtn.isEnabled()) break;
      await page.waitForTimeout(150);
    }
    await proceedBtn.click({ force: true });
    log('Clicked 公開に進む');

    // 公開設定画面へ遷移
    await Promise.race([
      page.waitForURL(/\/publish/i, { timeout }).catch(() => {}),
      page
        .locator('button:has-text("投稿する"), button:has-text("公開する"), button:has-text("更新する")')
        .first()
        .waitFor({ state: 'visible', timeout })
        .catch(() => {}),
    ]);
    await page.waitForTimeout(1000);

    if (!/\/publish/i.test(page.url())) {
      throw new Error(`Failed to reach publish screen (still at ${page.url()})`);
    }

    // タグを設定（下書き保存では保存できないが、公開フローでは投稿時に一緒に保存される）
    const appliedTags: string[] = [];
    if (tags.length > 0) {
      log('Adding tags', { tags });
      let tagInput = page.locator('input[placeholder*="ハッシュタグ"]');
      if (!(await tagInput.count())) {
        tagInput = page.locator('input[role="combobox"]').first();
      }
      await tagInput.waitFor({ state: 'visible', timeout });
      for (const tag of tags) {
        await tagInput.click();
        await tagInput.fill(tag);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        appliedTags.push(tag);
      }
      // 入力欄に取り込まれ残った文字列を消す（未確定のまま投稿されるのを防ぐ）
      await tagInput.fill('');
      await page.waitForTimeout(200);
    }

    // 有料設定（price 指定時のみ）。「記事タイプ」で有料を選び、価格を入れ、
    // 有料ラインを指定する。ここまでは全部 note 側の UI 状態に閉じているので、
    // 途中で失敗すれば「キャンセル」で抜ければ何も保存されない。
    let paidLine: { before: string; after: string | null } | undefined;
    if (price !== undefined) {
      log('Setting paid type', { price });
      await selectPaidType(page, price, timeout);

      log('Setting paid line', { paidLineAfter });
      const lineResult = await setPaidLineAfter(page, paidLineAfter as string, timeout);
      if (!lineResult) {
        // 事故防止: 該当段落が見つからない場合は絶対に公開せず、キャンセルして抜ける
        const cancelBtn = page.locator('button:has-text("キャンセル")').first();
        if (await cancelBtn.count()) {
          await cancelBtn.click({ force: true }).catch(() => {});
        }
        throw new Error(
          `paid_line_after paragraph not found (looked for text starting with "${paidLineAfter}"). ` +
            `Nothing was published or changed.`
        );
      }
      paidLine = lineResult;
      log('Paid line set', paidLine);

      if (dryRun) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const cancelBtn = page.locator('button:has-text("キャンセル")').first();
        await cancelBtn.click({ force: true });
        await page.waitForTimeout(1000);

        await context.close();
        await browser.close();

        return {
          success: true,
          url: `https://editor.note.com/notes/${noteKey}/edit/`,
          status: before.status ?? 'draft',
          tags,
          price,
          dryRun: true,
          paidLine,
          screenshot: screenshotPath,
          message: 'dry_run: 公開せずキャンセルしました（有料設定は保存されていません）',
        };
      }
    }

    // 「投稿する」（公開済み記事を再公開する場合は「更新する」等になる）
    const publishBtn = page
      .locator('button:has-text("投稿する"), button:has-text("公開する"), button:has-text("更新する")')
      .first();
    await publishBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 30; i++) {
      if (await publishBtn.isEnabled()) break;
      await page.waitForTimeout(150);
    }
    const publishBtnLabel = (await publishBtn.textContent())?.trim();
    log('Clicking publish button', { label: publishBtnLabel });
    await publishBtn.click({ force: true });

    // 公開完了待ち
    await Promise.race([
      page.waitForURL((url) => !/\/publish/i.test(url.toString()), { timeout: 25000 }).catch(() => {}),
      page.locator('text=投稿しました').first().waitFor({ timeout: 10000 }).catch(() => {}),
      page.waitForTimeout(8000),
    ]);
    await page.waitForTimeout(2000);

    await page.screenshot({ path: screenshotPath, fullPage: false });

    // 公開されたことを API で検証（画面遷移だけを信用しない）
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout });
    const after = await page.evaluate(async (key) => {
      const res = await fetch(`https://note.com/api/v3/notes/${key}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const j = await res.json();
      return {
        status: j.data?.status,
        isPublished: j.data?.is_published,
        noteUrl: j.data?.note_url,
        price: j.data?.price ?? 0,
        isLimited: j.data?.is_limited ?? false,
        hashtags: (j.data?.hashtag_notes ?? []).map(
          (h: any) => h?.hashtag?.name ?? h?.name ?? ''
        ),
      };
    }, noteKey);

    if (!after) {
      await context.close();
      await browser.close();
      throw new Error(`Could not verify note "${noteKey}" after publish`);
    }
    log('Target note after publish', { noteKey, ...after });

    if (!after.isPublished) {
      await context.close();
      await browser.close();
      throw new Error(
        `Publish did not take effect: status="${after.status}", is_published=${after.isPublished}`
      );
    }

    // 有料指定時は、記事ページ本体を実際に開いてペイウォールと価格表示を目視相当で検証する
    // （API の price フィールドだけでなく、画面の実体で判定する）
    //
    // ⚠️ 実測（2026-07-31）: 著者本人のセッションでは購入導線（「ここから先は」＋価格＋
    // 「購入手続きへ」）が出ない。著者にはペイウォールの代わりに
    // 「このラインより上のエリアが無料で表示されます。」という編集者向けの説明が出るだけで、
    // 本文全体がそのまま読める。そのため検証は**ログアウトした別コンテキスト**（cookie 無し）
    // で行う＝実際の読者が見る画面と同じもの。
    if (price !== undefined) {
      if (after.price !== price) {
        await context.close();
        await browser.close();
        throw new Error(
          `Price did not take effect via API: expected ${price}, got ${after.price}`
        );
      }
      const guestContext = await browser.newContext({ locale: 'ja-JP' });
      const guestPage = await guestContext.newPage();
      await guestPage.goto(after.noteUrl, { waitUntil: 'domcontentloaded', timeout });
      await guestPage.waitForTimeout(2000);
      const pageCheck = await guestPage.evaluate((expectedPrice: number) => {
        const text = document.body.innerText || '';
        const hasWall = /ここから先は|購入手続きへ/.test(text);
        const priceRegex = new RegExp(`${expectedPrice.toLocaleString('en-US')}\\s*円|¥\\s*${expectedPrice.toLocaleString('en-US')}`);
        const priceShown = priceRegex.test(text);
        return { hasWall, priceShown, snippet: text.slice(0, 2000) };
      }, price);
      await guestContext.close();
      log('Paywall page check (logged-out)', { hasWall: pageCheck.hasWall, priceShown: pageCheck.priceShown });
      if (!pageCheck.hasWall || !pageCheck.priceShown) {
        await context.close();
        await browser.close();
        throw new Error(
          `Published, but the paywall/price was not visibly confirmed on the article page as seen by a logged-out visitor ` +
            `(hasWall=${pageCheck.hasWall}, priceShown=${pageCheck.priceShown}, expected ¥${price}). ` +
            `Check the article manually: ${after.noteUrl}`
        );
      }
    }

    await context.close();
    await browser.close();

    return {
      success: true,
      url: after.noteUrl,
      status: after.status,
      tags: (after.hashtags as string[]).filter(Boolean),
      price: after.price,
      paidLine,
      screenshot: screenshotPath,
      message: price !== undefined ? '有料記事として公開しました（ペイウォール表示を確認済み）' : '記事を公開しました',
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// 公開済みの有料記事の価格だけを変更する。有料ライン（paid_line_after）はここでは触らない。
async function updatePrice(params: {
  noteKey: string;
  price: number;
  statePath?: string;
  screenshotDir?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  url: string;
  price: number;
  screenshot?: string;
  message: string;
}> {
  const {
    noteKey,
    price,
    statePath = DEFAULT_STATE_PATH,
    screenshotDir = path.join(os.tmpdir(), 'note-screenshots'),
    timeout = DEFAULT_TIMEOUT,
  } = params;

  validatePrice(price);

  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }

  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `note-price-${nowStr()}.png`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--lang=ja-JP', '--window-position=-2400,-2400', '--window-size=1280,900'],
  });

  try {
    const context = await browser.newContext({ storageState: statePath, locale: 'ja-JP' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // 前提チェック: 公開済み・かつ既に有料（price > 0）であること
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout });
    const before = await page.evaluate(async (key) => {
      const res = await fetch(`https://note.com/api/v3/notes/${key}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const j = await res.json();
      return {
        status: j.data?.status,
        isPublished: j.data?.is_published,
        price: j.data?.price ?? 0,
        noteUrl: j.data?.note_url,
      };
    }, noteKey);

    if (!before) {
      await context.close();
      await browser.close();
      throw new Error(`Note "${noteKey}" not found (or not accessible)`);
    }
    if (!before.isPublished) {
      await context.close();
      await browser.close();
      throw new Error(`Note "${noteKey}" is not published (status="${before.status}"). update_price only applies to published articles.`);
    }
    if (!before.price || before.price <= 0) {
      await context.close();
      await browser.close();
      throw new Error(
        `Note "${noteKey}" is not currently a paid article (price=${before.price}). ` +
          `update_price only changes the price of an already-paid article; use publish_draft with price to make a free article paid.`
      );
    }
    log('Target note before price update', before);

    if (before.price === price) {
      await context.close();
      await browser.close();
      return {
        success: true,
        url: before.noteUrl,
        price: before.price,
        message: `既に ¥${price} なので変更していません`,
      };
    }

    await page.goto(`https://editor.note.com/notes/${noteKey}/edit/`, { waitUntil: 'domcontentloaded', timeout });
    const proceedBtn = page.locator('button:has-text("公開に進む")').first();
    await proceedBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 30; i++) {
      if (await proceedBtn.isEnabled()) break;
      await page.waitForTimeout(150);
    }
    await proceedBtn.click({ force: true });
    await Promise.race([
      page.waitForURL(/\/publish/i, { timeout }).catch(() => {}),
      page
        .locator('button:has-text("投稿する"), button:has-text("公開する"), button:has-text("更新する")')
        .first()
        .waitFor({ state: 'visible', timeout })
        .catch(() => {}),
    ]);
    await page.waitForTimeout(1000);
    if (!/\/publish/i.test(page.url())) {
      await context.close();
      await browser.close();
      throw new Error(`Failed to reach publish screen (still at ${page.url()})`);
    }

    const paidTab = page.locator('#item-paid-setting');
    if (await paidTab.count()) {
      await paidTab.click({ force: true });
      await page.waitForTimeout(500);
    }
    const paidRadioChecked = await page.evaluate(() => (document.querySelector('#paid') as HTMLInputElement | null)?.checked ?? false);
    if (!paidRadioChecked) {
      // 事故防止: 有料のはずが無料表示になっている状態で価格をいじらない
      const cancelBtn = page.locator('button:has-text("キャンセル")').first();
      if (await cancelBtn.count()) await cancelBtn.click({ force: true }).catch(() => {});
      await context.close();
      await browser.close();
      throw new Error(`Expected note "${noteKey}" to show as 有料 on the publish screen, but it did not. Aborted without changing anything.`);
    }

    const priceInput = page.locator('#price');
    await priceInput.waitFor({ state: 'visible', timeout });
    await priceInput.fill('');
    await page.waitForTimeout(150);
    await priceInput.fill(String(price));
    await page.waitForTimeout(800);

    // 価格だけの変更でも「有料エリア設定」を経由しないと確定ボタンへ進めない（実測）。
    // 既存の有料ラインには触れない。
    const areaBtn = page.locator('button:has-text("有料エリア設定")').first();
    if (await areaBtn.count()) {
      if (!(await areaBtn.isEnabled())) {
        const cancelBtn = page.locator('button:has-text("キャンセル")').first();
        if (await cancelBtn.count()) await cancelBtn.click({ force: true }).catch(() => {});
        await context.close();
        await browser.close();
        throw new Error(`note rejected price=${price} (有料エリア設定 button stayed disabled)`);
      }
      await areaBtn.click({ force: true });
      await page.waitForTimeout(1500);
    }

    const confirmBtn = page
      .locator('button:has-text("投稿する"), button:has-text("公開する"), button:has-text("更新する")')
      .first();
    await confirmBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 30; i++) {
      if (await confirmBtn.isEnabled()) break;
      await page.waitForTimeout(150);
    }
    const confirmLabel = (await confirmBtn.textContent())?.trim();
    log('Clicking confirm button for price update', { label: confirmLabel });
    await confirmBtn.click({ force: true });

    await Promise.race([
      page.waitForURL((url) => !/\/publish/i.test(url.toString()), { timeout: 25000 }).catch(() => {}),
      page.waitForTimeout(8000),
    ]);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout });
    const after = await page.evaluate(async (key) => {
      const res = await fetch(`https://note.com/api/v3/notes/${key}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const j = await res.json();
      return { price: j.data?.price ?? 0, noteUrl: j.data?.note_url, isLimited: j.data?.is_limited ?? false };
    }, noteKey);

    if (!after) {
      await context.close();
      await browser.close();
      throw new Error(`Could not verify note "${noteKey}" after price update`);
    }
    if (after.price !== price) {
      await context.close();
      await browser.close();
      throw new Error(`Price did not take effect via API: expected ${price}, got ${after.price}`);
    }

    // 画面の実体（記事ページの価格表示）で検証する。publishDraft と同様、
    // 著者本人のセッションではなくログアウトした別コンテキストで見る
    // （購入導線・価格表示は読者視点で出るものなので、それを見るのが正しい検証）
    const guestContext = await browser.newContext({ locale: 'ja-JP' });
    const guestPage = await guestContext.newPage();
    await guestPage.goto(after.noteUrl, { waitUntil: 'domcontentloaded', timeout });
    await guestPage.waitForTimeout(2000);
    const pageCheck = await guestPage.evaluate((expectedPrice: number) => {
      const text = document.body.innerText || '';
      const priceRegex = new RegExp(`${expectedPrice.toLocaleString('en-US')}\\s*円|¥\\s*${expectedPrice.toLocaleString('en-US')}`);
      return { priceShown: priceRegex.test(text) };
    }, price);
    await guestContext.close();

    await context.close();
    await browser.close();

    if (!pageCheck.priceShown) {
      throw new Error(
        `Price updated via API to ${price} but was not visibly confirmed on the article page. Check manually: ${after.noteUrl}`
      );
    }

    return {
      success: true,
      url: after.noteUrl,
      price: after.price,
      screenshot: screenshotPath,
      message: `価格を ¥${before.price} → ¥${price} に変更しました`,
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// ============================================================
// マガジン自体の CRUD
//
// 2026-07-30 実測したエンドポイント（create/delete は /my/、update は /our/ で非対称）:
//   create : POST   /api/v1/my/magazines
//   read   : GET    /api/v1/my/magazines?includes_editable=true
//   update : PUT    /api/v1/our/magazines/{magazineKey}
//   delete : DELETE /api/v1/my/magazines/{magazineKey}
// ============================================================

interface MagazineSummary {
  id: number;
  key: string;
  name: string;
  description: string;
  status: string;
  price: number;
  noteCount: number;
  cover: string;
  hasCustomCover: boolean;
}

// カバー画像として note が受け付ける拡張子（編集画面の input accept と同じ）
const MAGAZINE_COVER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.heic'];

function coverMimeType(coverPath: string): string {
  const ext = path.extname(coverPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.heic') return 'image/heic';
  return 'image/png';
}

// カバー画像をアップロードして cover_key を得る
// 2026-07-30 実測: POST /api/v1/image_upload/magazine_cover（multipart, field 名は "file"）
async function uploadMagazineCover(
  page: any,
  magazineKey: string,
  coverPath: string
): Promise<string> {
  if (!fs.existsSync(coverPath)) {
    throw new Error(`Cover image not found: ${coverPath}`);
  }
  const ext = path.extname(coverPath).toLowerCase();
  if (!MAGAZINE_COVER_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Cover image must be one of ${MAGAZINE_COVER_EXTENSIONS.join(' / ')} (got "${ext}")`
    );
  }

  const base64 = fs.readFileSync(coverPath).toString('base64');
  const result = await page.evaluate(
    async ({ base64, mime, magKey, filename }: any) => {
      const bin = atob(base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('file', new Blob([arr], { type: mime }), filename);
      fd.append('magazine_key', magKey);
      const res = await fetch('https://note.com/api/v1/image_upload/magazine_cover', {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: fd,
      });
      const text = await res.text();
      let key = null;
      try {
        key = JSON.parse(text)?.data?.key ?? null;
      } catch {}
      return { status: res.status, ok: res.ok, key, text: text.slice(0, 300) };
    },
    { base64, mime: coverMimeType(coverPath), magKey: magazineKey, filename: path.basename(coverPath) }
  );
  log('Cover upload response', { status: result.status, key: result.key });

  if (!result.ok || !result.key) {
    throw new Error(`Cover upload failed with status ${result.status}: ${result.text}`);
  }
  return result.key;
}

// カバー画像を外す
// 2026-07-30 実測: PUT /api/v1/image_upload/magazine_cover/delete（body: {magazine_key}）
async function removeMagazineCover(page: any, magazineKey: string): Promise<void> {
  const result = await page.evaluate(async (magKey: string) => {
    const res = await fetch('https://note.com/api/v1/image_upload/magazine_cover/delete', {
      method: 'PUT',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({ magazine_key: magKey }),
    });
    return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 300) };
  }, magazineKey);
  log('Cover delete response', result);
  if (!result.ok) {
    throw new Error(`Cover removal failed with status ${result.status}: ${result.text}`);
  }
}

// note.com のページを開いて cookie 付きで API を叩くための共通ラッパ
async function withNoteApiPage<T>(
  statePath: string,
  timeout: number,
  fn: (page: any) => Promise<T>
): Promise<T> {
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }
  const browser = await chromium.launch({
    headless: false,
    args: ['--lang=ja-JP', '--window-position=-2400,-2400', '--window-size=1280,900'],
  });
  try {
    const context = await browser.newContext({ storageState: statePath, locale: 'ja-JP' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout });
    const result = await fn(page);
    await context.close();
    await browser.close();
    return result;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// 自分のマガジン一覧を取得
// 公開 URL は https://note.com/{urlname}/... なので、ログイン中ユーザーの urlname を引く。
// 取れなかった場合に固定値へ落とすと他人の環境で壊れた URL を返すため、呼び出し側で扱う。
// ⚠️ プロセス寿命でキャッシュしない: state_path はツール呼び出しごとに変えられるので、
// 別アカウントの urlname を使い回すと他人の URL を組み立ててしまう。
async function fetchUrlname(page: any): Promise<string | null> {
  return await page.evaluate(async () => {
    const res = await fetch('https://note.com/api/v2/current_user', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.data?.urlname ?? null;
  });
}

// urlname が引けないときは編集 URL を返す（公開 URL を捏造しない）
function noteUrl(urlname: string | null, key: string): string {
  return urlname
    ? `https://note.com/${urlname}/n/${key}`
    : `https://editor.note.com/notes/${key}/edit/`;
}

async function fetchMagazines(page: any): Promise<MagazineSummary[]> {
  return await page.evaluate(async () => {
    const res = await fetch('https://note.com/api/v1/my/magazines?includes_editable=true', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.data?.magazines ?? []).map((m: any) => ({
      id: m.id,
      key: m.key,
      name: m.name,
      description: m.description ?? '',
      status: m.status,
      price: m.price ?? 0,
      noteCount: m.note_count ?? 0,
      cover: m.cover ?? '',
      // note は未設定でも既定ヘッダー画像の URL を返すので、それを「カバー無し」と見なす
      hasCustomCover: !!m.cover && !String(m.cover).includes('default_magazine_header'),
    }));
  });
}

// 名前（部分一致）またはキーからマガジンを特定
function resolveMagazine(magazines: MagazineSummary[], identifier: string): MagazineSummary {
  const exact =
    magazines.find((m) => m.key === identifier) ?? magazines.find((m) => m.name === identifier);
  if (exact) return exact;

  const partial = magazines.filter((m) => m.name.includes(identifier));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Magazine "${identifier}" is ambiguous: ${partial.map((m) => m.name).join(' / ')}. Use the exact name or the magazine key.`
    );
  }
  throw new Error(
    `Magazine "${identifier}" not found. Available: ${magazines.map((m) => m.name).join(' / ')}`
  );
}

// マガジン更新 API の共通ラッパ。
// note の PUT は全項目送信型なので、呼び出し側で現在値をマージしてから渡すこと。
// cover_key は「カバーを変えるときだけ」載せる（省略しても既存カバーは消えないことを実測済み）。
async function putMagazine(
  page: any,
  fields: {
    magazineKey: string;
    name: string;
    description: string;
    status: string;
    price: number;
    coverKey?: string;
  }
): Promise<void> {
  const result = await page.evaluate(async (f: any) => {
    const body: any = {
      name: f.name,
      description: f.description,
      message: '',
      price: f.price,
      is_immediate_charge: false,
      is_signup_enabled: true,
      status: f.status,
    };
    if (f.coverKey) body.cover_key = f.coverKey;
    const res = await fetch(`https://note.com/api/v1/our/magazines/${f.magazineKey}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 300) };
  }, fields);
  log('Magazine PUT response', { status: result.status, coverKey: fields.coverKey });
  if (!result.ok) {
    throw new Error(`Update failed with status ${result.status}: ${result.text}`);
  }
}

async function listMagazines(params: { statePath?: string; timeout?: number }): Promise<{
  success: boolean;
  count: number;
  magazines: MagazineSummary[];
}> {
  const { statePath = DEFAULT_STATE_PATH, timeout = DEFAULT_TIMEOUT } = params;
  const magazines = await withNoteApiPage(statePath, timeout, (page) => fetchMagazines(page));
  log('Listed magazines', { count: magazines.length });
  return { success: true, count: magazines.length, magazines };
}

async function createMagazine(params: {
  name: string;
  description?: string;
  isPublic?: boolean;
  coverPath?: string;
  statePath?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  magazine: MagazineSummary;
  url?: string;
  message: string;
}> {
  const {
    name,
    description = '',
    isPublic = true,
    coverPath,
    statePath = DEFAULT_STATE_PATH,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  // note の入力欄と同じ上限（超えると API 側で弾かれる or 切られるので事前に止める）
  if (name.length > 30) {
    throw new Error(`Magazine name must be 30 characters or fewer (got ${name.length})`);
  }
  if (description.length > 400) {
    throw new Error(`Magazine description must be 400 characters or fewer (got ${description.length})`);
  }

  return await withNoteApiPage(statePath, timeout, async (page) => {
    const before = await fetchMagazines(page);
    if (before.some((m) => m.name === name)) {
      throw new Error(`A magazine named "${name}" already exists`);
    }

    const res = await page.evaluate(
      async ({ name, description, status }: any) => {
        const r = await fetch('https://note.com/api/v1/my/magazines', {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
          },
          // UI が送っているフィールドをそのまま踏襲（有料マガジンは作らない = price 0 / subscribe false）
          body: JSON.stringify({
            name,
            description,
            status,
            price: 0,
            subscribe: false,
            content: '',
            frequency: 1,
            is_free_subscribe: false,
            management_name: '',
            layout_type: 'list',
            message: null,
            categories: [],
          }),
        });
        return { status: r.status, ok: r.ok, text: (await r.text()).slice(0, 300) };
      },
      { name, description, status: isPublic ? 'public' : 'private' }
    );
    log('Create magazine response', res);
    if (!res.ok) {
      throw new Error(`Create failed with status ${res.status}: ${res.text}`);
    }

    // 作成できたかは一覧を引き直して確認する（レスポンス本文が空なので）
    const after = await fetchMagazines(page);
    const created = after.find((m) => m.name === name);
    if (!created) {
      throw new Error('Create did not take effect: the magazine is not in the list');
    }

    // カバー画像はマガジンが出来てからでないと紐付けられないので、作成後に載せる
    let final = created;
    if (coverPath) {
      const coverKey = await uploadMagazineCover(page, created.key, coverPath);
      await putMagazine(page, {
        magazineKey: created.key,
        name: created.name,
        description: created.description,
        status: created.status,
        price: created.price,
        coverKey,
      });
      const reread = (await fetchMagazines(page)).find((m) => m.key === created.key);
      if (!reread?.hasCustomCover) {
        throw new Error('Cover upload did not take effect');
      }
      final = reread;
    }

    const urlname = await fetchUrlname(page);
    return {
      success: true,
      magazine: final,
      url: urlname ? `https://note.com/${urlname}/m/${final.key}` : undefined,
      message: coverPath ? 'マガジンを作成しました（カバー画像込み）' : 'マガジンを作成しました',
    };
  });
}

async function updateMagazine(params: {
  magazine: string;
  name?: string;
  description?: string;
  isPublic?: boolean;
  coverPath?: string;
  removeCover?: boolean;
  statePath?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  magazine: MagazineSummary;
  changed: string[];
  message: string;
}> {
  const {
    magazine,
    name,
    description,
    isPublic,
    coverPath,
    removeCover,
    statePath = DEFAULT_STATE_PATH,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  if (
    name === undefined &&
    description === undefined &&
    isPublic === undefined &&
    coverPath === undefined &&
    !removeCover
  ) {
    throw new Error(
      'Nothing to update: pass at least one of name / description / is_public / cover_path / remove_cover'
    );
  }
  if (coverPath !== undefined && removeCover) {
    throw new Error('cover_path and remove_cover cannot be used together');
  }
  if (name !== undefined && name.length > 30) {
    throw new Error(`Magazine name must be 30 characters or fewer (got ${name.length})`);
  }
  if (description !== undefined && description.length > 400) {
    throw new Error(`Magazine description must be 400 characters or fewer (got ${description.length})`);
  }

  return await withNoteApiPage(statePath, timeout, async (page) => {
    const magazines = await fetchMagazines(page);
    const target = resolveMagazine(magazines, magazine);

    // PUT は全フィールドを送る形なので、現在値に差分を上書きしてから投げる
    // （name だけ送ると description が消えるため。cover_key だけは省略しても既存が残る）
    const next = {
      name: name ?? target.name,
      description: description ?? target.description,
      status: isPublic === undefined ? target.status : isPublic ? 'public' : 'private',
    };
    const changed: string[] = [];
    if (next.name !== target.name) changed.push('name');
    if (next.description !== target.description) changed.push('description');
    if (next.status !== target.status) changed.push('status');

    log('Update magazine', { key: target.key, from: target, to: next });

    // カバーを外す場合は専用エンドポイント。差し替える場合はアップロードして cover_key を載せる
    if (removeCover) {
      await removeMagazineCover(page, target.key);
      changed.push('cover(removed)');
    }
    const coverKey = coverPath ? await uploadMagazineCover(page, target.key, coverPath) : undefined;
    if (coverKey) changed.push('cover');

    await putMagazine(page, {
      magazineKey: target.key,
      name: next.name,
      description: next.description,
      status: next.status,
      price: target.price,
      coverKey,
    });

    // 反映を一覧で検証
    const after = await fetchMagazines(page);
    const updated = after.find((m) => m.key === target.key);
    if (!updated) {
      throw new Error('Could not verify the magazine after update');
    }
    if (updated.name !== next.name || updated.description !== next.description) {
      throw new Error(
        `Update did not take effect: name="${updated.name}", description="${updated.description}"`
      );
    }
    if (coverPath && !updated.hasCustomCover) {
      throw new Error('Cover replacement did not take effect');
    }
    if (removeCover && updated.hasCustomCover) {
      throw new Error('Cover removal did not take effect');
    }

    return {
      success: true,
      magazine: updated,
      changed,
      message: 'マガジンを更新しました',
    };
  });
}

async function deleteMagazine(params: {
  magazine: string;
  force?: boolean;
  statePath?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  deleted: { key: string; name: string; noteCount: number };
  message: string;
}> {
  const {
    magazine,
    force = false,
    statePath = DEFAULT_STATE_PATH,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  return await withNoteApiPage(statePath, timeout, async (page) => {
    const magazines = await fetchMagazines(page);
    const target = resolveMagazine(magazines, magazine);

    // 記事が入っているマガジンは事故が痛いので、明示的な force なしでは消さない
    // （マガジンを消しても記事自体は残るが、まとめ直す手間が大きい）
    if (target.noteCount > 0 && !force) {
      throw new Error(
        `Magazine "${target.name}" still contains ${target.noteCount} note(s). ` +
          `Deleting it removes the grouping (the articles themselves survive). ` +
          `Pass force: true if you really mean to delete it.`
      );
    }

    log('Deleting magazine', { key: target.key, name: target.name, noteCount: target.noteCount });

    const res = await page.evaluate(async (magKey: string) => {
      const r = await fetch(`https://note.com/api/v1/my/magazines/${magKey}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      return { status: r.status, ok: r.ok, text: (await r.text()).slice(0, 300) };
    }, target.key);
    log('Delete magazine response', res);
    if (!res.ok) {
      throw new Error(`Delete failed with status ${res.status}: ${res.text}`);
    }

    // 一覧から消えたことを検証
    const after = await fetchMagazines(page);
    if (after.some((m) => m.key === target.key)) {
      throw new Error('Delete did not take effect: the magazine is still in the list');
    }

    return {
      success: true,
      deleted: { key: target.key, name: target.name, noteCount: target.noteCount },
      message: 'マガジンを削除しました',
    };
  });
}

// マガジンへの記事追加/削除（API 直叩き。2026-07-29 実測: 追加 = POST /api/v1/our/magazines/{magKey}/notes）
async function magazineOp(params: {
  noteKey: string;
  magazine: string; // マガジン名 or マガジンキー（m で始まる）
  action: 'add' | 'remove';
  statePath?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  magazine: { key: string; name: string };
  belongingMagazineKeys: string[];
  message: string;
}> {
  const {
    noteKey,
    magazine,
    action,
    statePath = DEFAULT_STATE_PATH,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--lang=ja-JP',
      '--window-position=-2400,-2400',
      '--window-size=1280,900',
    ],
  });

  try {
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ja-JP',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout });

    // 対象記事の id と現在の所属マガジンを取得
    const note = await page.evaluate(async (key) => {
      const res = await fetch(`https://note.com/api/v3/notes/${key}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const j = await res.json();
      return {
        id: j.data?.id,
        status: j.data?.status,
        belonging: j.data?.belonging_magazine_keys ?? [],
      };
    }, noteKey);
    if (!note?.id) {
      throw new Error(`Note "${noteKey}" not found (or not accessible)`);
    }

    // 自分のマガジン一覧から対象を特定（名前 or キーの部分一致→完全一致優先）
    const magazines = await page.evaluate(async (key) => {
      const res = await fetch(
        `https://note.com/api/v1/my/magazines?includes_editable=true&note_key=${key}`,
        { credentials: 'include', headers: { accept: 'application/json' } }
      );
      if (!res.ok) return [];
      const j = await res.json();
      return (j.data?.magazines ?? []).map((m: any) => ({ id: m.id, key: m.key, name: m.name }));
    }, noteKey);
    if (!magazines.length) {
      throw new Error('No magazines found for this account');
    }

    const target =
      magazines.find((m: any) => m.key === magazine || m.name === magazine) ??
      magazines.find((m: any) => m.name.includes(magazine));
    if (!target) {
      throw new Error(
        `Magazine "${magazine}" not found. Available: ${magazines.map((m: any) => m.name).join(' / ')}`
      );
    }
    log('Magazine target', { action, noteKey, magazine: target });

    // 追加 / 削除（実測エンドポイント。x-requested-with 必須系に合わせて付与）
    const result = await page.evaluate(
      async ({ magKey, noteId, key, action }) => {
        // 実測: 追加は POST（body に note_id/note_key）、削除は DELETE で **note_key** をパスに置く
        // （note_id をパスに置くと 404「指定されたノートが見つかりません」になる）
        const url =
          action === 'add'
            ? `https://note.com/api/v1/our/magazines/${magKey}/notes`
            : `https://note.com/api/v1/our/magazines/${magKey}/notes/${key}`;
        const res = await fetch(url, {
          method: action === 'add' ? 'POST' : 'DELETE',
          credentials: 'include',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
          },
          body: action === 'add' ? JSON.stringify({ note_id: noteId, note_key: key }) : undefined,
        });
        const text = await res.text();
        return { status: res.status, ok: res.ok, text: text.slice(0, 300) };
      },
      { magKey: target.key, noteId: note.id, key: noteKey, action }
    );
    log('Magazine API response', result);
    if (!result.ok) {
      throw new Error(`Magazine ${action} failed with status ${result.status}: ${result.text}`);
    }

    // 検証: belonging_magazine_keys を再取得して実際に反映されたか確かめる
    const after = await page.evaluate(async (key) => {
      const res = await fetch(`https://note.com/api/v3/notes/${key}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const j = await res.json();
      return j.data?.belonging_magazine_keys ?? [];
    }, noteKey);

    await context.close();
    await browser.close();

    const belongs = (after ?? []).includes(target.key);
    if (action === 'add' && !belongs) {
      throw new Error(`Add did not take effect: belonging_magazine_keys=${JSON.stringify(after)}`);
    }
    if (action === 'remove' && belongs) {
      throw new Error(`Remove did not take effect: belonging_magazine_keys=${JSON.stringify(after)}`);
    }

    return {
      success: true,
      magazine: { key: target.key, name: target.name },
      belongingMagazineKeys: after ?? [],
      message: action === 'add' ? 'マガジンに追加しました' : 'マガジンから削除しました',
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// ============================================================
// 記事一覧の取得 / 公開済み記事のタグ更新
//
// 2026-07-30 実測:
//   - タグ専用のエンドポイントは存在しない。タグは PUT /api/v1/text_notes/{noteId} に
//     free_body（本文全体）や magazine_keys と一緒に同梱されて飛ぶ。
//   - hashtags だけを送る PUT は 422（不正なパラメータ）で拒否される＝部分更新は不可。
//   - よって「本文に触らずタグだけ差し替える」直叩きは成立しない。
//     公開設定画面を内部で操作して、ページ自身が組んだ完全なペイロードを送らせる方式にした。
//     手組みの PUT にしなかった理由は、非公開マガジンの所属が API から読めない
//     （belonging_magazine_keys に出ない）ため magazine_keys を忠実に再現できず、
//     マガジン所属を黙って外す危険があること。
// ============================================================

interface NoteSummary {
  noteKey: string;
  title: string;
  status: string;
  tags: string[];
  magazineKeys: string[];
  publishAt: string | null;
  url: string;
  isPaid: boolean;
  price: number;
}

// note のタグ上限（公開設定画面の仕様）
const MAX_HASHTAGS = 10;

// "#タグ" / "タグ" のどちらで来ても比較できるようにする
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '');
}
function tagKey(tag: string): string {
  // note は大文字小文字を畳む（SwiftUI → #swiftui）ので比較は小文字で行う
  return normalizeTag(tag).toLowerCase();
}

// 記事1本の現在状態（タグ更新の前後比較に使う）
async function fetchNoteState(
  page: any,
  noteKey: string
): Promise<{
  id: number;
  status: string;
  name: string;
  body: string;
  tags: string[];
  magazineKeys: string[];
  price: number;
  isLimited: boolean;
} | null> {
  return await page.evaluate(async (key: string) => {
    const res = await fetch(`https://note.com/api/v3/notes/${key}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const d = j.data;
    if (!d) return null;
    return {
      id: d.id,
      status: d.status,
      name: d.name ?? '',
      body: d.body ?? '',
      tags: (d.hashtag_notes ?? []).map((h: any) => h?.hashtag?.name ?? h?.name ?? '').filter(Boolean),
      magazineKeys: d.belonging_magazine_keys ?? [],
      price: d.price ?? 0,
      isLimited: d.is_limited ?? false,
    };
  }, noteKey);
}

async function listNotes(params: {
  status?: 'all' | 'draft' | 'published';
  limit?: number;
  statePath?: string;
  timeout?: number;
}): Promise<{ success: boolean; count: number; notes: NoteSummary[] }> {
  const {
    status = 'all',
    limit,
    statePath = DEFAULT_STATE_PATH,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  return await withNoteApiPage(statePath, timeout, async (page) => {
    // 一覧 API は key/title/status/publishAt までしか返さないのでページングで全件集める
    const raw: Array<{ key: string; name: string; status: string; publishAt: string | null }> = [];
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      const chunk = await page.evaluate(async (p: number) => {
        const res = await fetch(`https://note.com/api/v2/note_list/contents?limit=50&page=${p}`, {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) return null;
        const j = await res.json();
        return {
          notes: (j.data?.notes ?? []).map((n: any) => ({
            key: n.key,
            name: n.name ?? '',
            status: n.status ?? '',
            publishAt: n.publishAt ?? null,
          })),
          isLastPage: j.data?.isLastPage ?? true,
        };
      }, pageNum);
      if (!chunk) break;
      raw.push(...chunk.notes);
      if (chunk.isLastPage || chunk.notes.length === 0) break;
    }

    const filtered = raw.filter((n) => status === 'all' || n.status === status);
    const targeted = limit ? filtered.slice(0, limit) : filtered;

    // タグとマガジンは一覧に含まれないので1本ずつ引く
    const urlname = await fetchUrlname(page);
    const notes: NoteSummary[] = [];
    for (const n of targeted) {
      const state = await fetchNoteState(page, n.key);
      notes.push({
        noteKey: n.key,
        title: n.name,
        status: n.status,
        tags: state?.tags ?? [],
        magazineKeys: state?.magazineKeys ?? [],
        publishAt: n.publishAt,
        url:
          n.status === 'published'
            ? noteUrl(urlname, n.key)
            : `https://editor.note.com/notes/${n.key}/edit/`,
        isPaid: state?.price ? state.price > 0 : false,
        price: state?.price ?? 0,
      });
    }

    log('Listed notes', { requested: status, total: raw.length, returned: notes.length });
    return { success: true, count: notes.length, notes };
  });
}

// 公開設定画面で「適用済みタグ」だけを読む。
// 適用済みチップは input と同じ親の中にあり、× アイコンの <span> を持つ。
// 一方「おすすめタグ」はその外側に並ぶ span 無しのボタンなので、親の内側だけを見れば区別できる。
async function readAppliedTags(page: any): Promise<string[]> {
  return await page.evaluate(() => {
    const input = document.querySelector('input[placeholder*="ハッシュタグ"]');
    const box = input?.parentElement;
    if (!box) return [];
    return Array.from(box.querySelectorAll('button'))
      .map((b) => (b.textContent ?? '').trim())
      .filter(Boolean);
  });
}

async function updateTags(params: {
  noteKeys: string[];
  add?: string[];
  remove?: string[];
  statePath?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  summary: { total: number; updated: number; unchanged: number; failed: number };
  results: Array<{
    noteKey: string;
    title: string;
    ok: boolean;
    changed: boolean;
    before: string[];
    after: string[];
    bodyPreserved: boolean;
    error?: string;
  }>;
}> {
  const {
    noteKeys,
    add = [],
    remove = [],
    statePath = DEFAULT_STATE_PATH,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  if (noteKeys.length === 0) {
    throw new Error('note_keys is empty');
  }
  if (add.length === 0 && remove.length === 0) {
    throw new Error('Nothing to do: pass at least one of add / remove');
  }
  const overlap = add.filter((a) => remove.some((r) => tagKey(r) === tagKey(a)));
  if (overlap.length) {
    throw new Error(`The same tag appears in both add and remove: ${overlap.join(', ')}`);
  }

  return await withNoteApiPage(statePath, timeout, async (page) => {
    // ---- 事前チェック（1本でも上限超過や下書きがあれば、何も触らずに止める）----
    const plans: Array<{
      noteKey: string;
      title: string;
      id: number;
      body: string;
      current: string[];
      desired: string[];
    }> = [];
    const preflightErrors: string[] = [];

    for (const noteKey of noteKeys) {
      const state = await fetchNoteState(page, noteKey);
      if (!state) {
        preflightErrors.push(`${noteKey}: not found (or not accessible)`);
        continue;
      }
      // 下書きにタグは保存できず、公開ボタンを押すと「公開」してしまうので対象外にする
      if (state.status !== 'published') {
        preflightErrors.push(
          `${noteKey} "${state.name}": status is "${state.status}" — tags can only be set on published notes (a draft would get published)`
        );
        continue;
      }

      const removeKeys = new Set(remove.map(tagKey));
      const kept = state.tags.filter((t) => !removeKeys.has(tagKey(t)));
      const desired = [...kept];
      for (const a of add) {
        if (!desired.some((t) => tagKey(t) === tagKey(a))) desired.push(`#${normalizeTag(a)}`);
      }
      if (desired.length > MAX_HASHTAGS) {
        preflightErrors.push(
          `${noteKey} "${state.name}": would end up with ${desired.length} tags (limit ${MAX_HASHTAGS}) — currently ${state.tags.length}`
        );
        continue;
      }
      plans.push({
        noteKey,
        title: state.name,
        id: state.id,
        body: state.body,
        current: state.tags,
        desired,
      });
    }

    if (preflightErrors.length) {
      throw new Error(
        `Aborted before changing anything (${preflightErrors.length} of ${noteKeys.length} notes would fail):\n` +
          preflightErrors.map((e) => `  - ${e}`).join('\n')
      );
    }

    // ---- 1本ずつ公開設定画面でタグを差し替える ----
    const results: any[] = [];
    for (const plan of plans) {
      const sameSet =
        plan.current.length === plan.desired.length &&
        plan.current.every((t) => plan.desired.some((d) => tagKey(d) === tagKey(t)));
      if (sameSet) {
        log('Tags already as desired, skipping', { noteKey: plan.noteKey });
        results.push({
          noteKey: plan.noteKey,
          title: plan.title,
          ok: true,
          changed: false,
          before: plan.current,
          after: plan.current,
          bodyPreserved: true,
        });
        continue;
      }

      try {
        log('Updating tags', { noteKey: plan.noteKey, from: plan.current, to: plan.desired });

        await page.goto(`https://editor.note.com/notes/${plan.noteKey}/edit/`, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
        const proceedBtn = page.locator('button:has-text("公開に進む")').first();
        await proceedBtn.waitFor({ state: 'visible', timeout });
        for (let i = 0; i < 30; i++) {
          if (await proceedBtn.isEnabled()) break;
          await page.waitForTimeout(150);
        }
        await proceedBtn.click({ force: true });

        await Promise.race([
          page.waitForURL(/\/publish/i, { timeout }).catch(() => {}),
          page
            .locator('button:has-text("更新する"), button:has-text("投稿する"), button:has-text("公開する")')
            .first()
            .waitFor({ state: 'visible', timeout })
            .catch(() => {}),
        ]);
        await page.waitForTimeout(1200);
        if (!/\/publish/i.test(page.url())) {
          throw new Error(`could not reach the publish screen (at ${page.url()})`);
        }

        let tagInput = page.locator('input[placeholder*="ハッシュタグ"]');
        if (!(await tagInput.count())) {
          tagInput = page.locator('input[role="combobox"]').first();
        }
        await tagInput.waitFor({ state: 'visible', timeout });

        // 外すタグ: 適用済みチップを名前で照合してクリック（× として機能する）
        const applied = await readAppliedTags(page);
        const desiredKeys = new Set(plan.desired.map(tagKey));
        for (const chip of applied) {
          if (desiredKeys.has(tagKey(chip))) continue;
          const chipBtn = tagInput.locator('xpath=../button').filter({ hasText: chip }).first();
          if (await chipBtn.count()) {
            await chipBtn.click({ force: true });
            await page.waitForTimeout(400);
          }
        }

        // 足すタグ: 入力して Enter
        const stillApplied = new Set((await readAppliedTags(page)).map(tagKey));
        for (const tag of plan.desired) {
          if (stillApplied.has(tagKey(tag))) continue;
          await tagInput.click();
          await tagInput.fill(normalizeTag(tag));
          await page.keyboard.press('Enter');
          await page.waitForTimeout(350);
        }
        // 未確定の入力が残らないように空にする
        await tagInput.fill('');
        await page.waitForTimeout(200);

        // 「更新する」（公開済み記事なのでこのラベル。念のため他表記も拾う）
        const updateBtn = page
          .locator('button:has-text("更新する"), button:has-text("公開する"), button:has-text("投稿する")')
          .first();
        await updateBtn.waitFor({ state: 'visible', timeout });
        for (let i = 0; i < 30; i++) {
          if (await updateBtn.isEnabled()) break;
          await page.waitForTimeout(150);
        }
        await updateBtn.click({ force: true });

        await Promise.race([
          page.waitForURL((u: any) => !/\/publish/i.test(u.toString()), { timeout: 25000 }).catch(() => {}),
          page.waitForTimeout(9000),
        ]);
        await page.waitForTimeout(1500);

        // 反映を API で検証（画面遷移では判断しない）＋本文が変わっていないことも確認
        await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout });
        const after = await fetchNoteState(page, plan.noteKey);
        if (!after) throw new Error('could not re-read the note after update');

        const afterKeys = new Set(after.tags.map(tagKey));
        const missing = plan.desired.filter((t) => !afterKeys.has(tagKey(t)));
        const extra = after.tags.filter((t) => !plan.desired.some((d) => tagKey(d) === tagKey(t)));
        const bodyPreserved = after.body === plan.body;

        if (missing.length || extra.length) {
          throw new Error(
            `tags did not land as expected (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'})`
          );
        }

        results.push({
          noteKey: plan.noteKey,
          title: plan.title,
          ok: true,
          changed: true,
          before: plan.current,
          after: after.tags,
          bodyPreserved,
          ...(bodyPreserved ? {} : { error: 'WARNING: body changed during the tag update' }),
        });
        log('Tags updated', { noteKey: plan.noteKey, after: after.tags, bodyPreserved });
      } catch (error) {
        // 部分失敗でも残りは続ける
        const message = error instanceof Error ? error.message : String(error);
        log('Tag update failed', { noteKey: plan.noteKey, error: message });
        results.push({
          noteKey: plan.noteKey,
          title: plan.title,
          ok: false,
          changed: false,
          before: plan.current,
          after: plan.current,
          bodyPreserved: true,
          error: message,
        });
      }
    }

    const updated = results.filter((r) => r.ok && r.changed).length;
    const unchanged = results.filter((r) => r.ok && !r.changed).length;
    const failed = results.filter((r) => !r.ok).length;

    return {
      success: failed === 0,
      summary: { total: results.length, updated, unchanged, failed },
      results,
    };
  });
}

// 記事削除関数（下書き・公開問わず）
async function deleteNote(params: {
  noteKey: string;
  statePath?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  message: string;
}> {
  const {
    noteKey,
    statePath = DEFAULT_STATE_PATH,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--lang=ja-JP',
      '--window-position=-2400,-2400',
      '--window-size=1280,900',
    ],
  });

  try {
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ja-JP',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // note.com にアクセスしてから DELETE API を直接呼ぶ（cookie を有効化するため）
    await page.goto('https://note.com/notes', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    log('Calling DELETE API', { noteKey });

    // 実測で確認済みのエンドポイント: DELETE /api/v1/notes/n/{note_key} => 200
    const result = await page.evaluate(async (key) => {
      const res = await fetch(`/api/v1/notes/n/${key}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      return { status: res.status, ok: res.ok };
    }, noteKey);

    log('DELETE API response', result);

    if (!result.ok) {
      throw new Error(`Delete failed with status ${result.status} for note_key "${noteKey}"`);
    }

    await context.close();
    await browser.close();

    return {
      success: true,
      message: '記事を削除しました',
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Zodスキーマ定義
const PublishNoteSchema = z.object({
  markdown_path: z.string().describe('Markdownファイルのパス（タイトル、本文、タグを含む）'),
  thumbnail_path: z.string().optional().describe('サムネイル画像のパス（オプション）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const SaveDraftSchema = z.object({
  markdown_path: z.string().describe('Markdownファイルのパス（タイトル、本文、タグを含む）'),
  thumbnail_path: z.string().optional().describe('サムネイル画像のパス（オプション）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const DeleteNoteSchema = z.object({
  note_key: z.string().describe('削除する記事のキー（例: nxxxxxxxxxxxx）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const UpdateDraftSchema = z.object({
  note_key: z.string().describe('更新する既存記事のキー（例: nxxxxxxxxxxxx）'),
  markdown_path: z.string().describe('新しい内容の Markdown ファイルのパス（タイトル・本文で全置換される）'),
  thumbnail_path: z
    .string()
    .optional()
    .describe('差し替えるアイキャッチ画像のパス（省略時は既存のアイキャッチを維持）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
  publish: z
    .boolean()
    .optional()
    .describe(
      '公開済み記事の本文を差し替えて再公開する場合に true（公開済み記事は「下書き保存」ができないため）。既存のタグ・マガジンはそのまま維持される'
    ),
  paid_line_after: z
    .string()
    .optional()
    .describe(
      '有料記事を再公開するときの有料ラインの位置（この文字列で始まる段落の直後に置く）。省略時は md の front matter `paid_line_after` を使う。' +
        'note は再公開のたびに有料ラインを冒頭へ飛ばすため、有料記事ではどちらかが必須（無いと中断する）'
    ),
});

const PostToXSchema = z.object({
  text: z.string().describe('投稿本文（weighted length 280 以内）'),
  in_reply_to_tweet_id: z.string().optional().describe('返信先ツイートID（スレッドにする場合）'),
  dry_run: z.boolean().optional().describe('true なら投稿せず文字数検証のみ'),
  state_path: z.string().optional().describe(`X の認証情報ファイルのパス（デフォルト: ${DEFAULT_X_STATE_PATH}）`),
});

const PostToFacebookSchema = z.object({
  message: z.string().describe('投稿本文'),
  link: z.string().optional().describe('添付するURL（任意。Facebook側がOGPを取得してプレビューを付ける）'),
  dry_run: z.boolean().optional().describe('true なら投稿せず本文確認のみ'),
  state_path: z
    .string()
    .optional()
    .describe(`Facebook の認証情報ファイルのパス（デフォルト: ${DEFAULT_FACEBOOK_STATE_PATH}）`),
});

const MagazineOpSchema = z.object({
  note_key: z.string().describe('対象記事のキー（例: nxxxxxxxxxxxx）'),
  magazine: z.string().describe('マガジン名（部分一致可）またはマガジンキー（m で始まる）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const PublishDraftSchema = z.object({
  note_key: z.string().describe('公開する既存下書きのキー（例: nxxxxxxxxxxxx）'),
  tags: z.array(z.string()).optional().describe('公開時に付けるハッシュタグ（# は不要）'),
  price: z
    .number()
    .int()
    .optional()
    .describe(`有料記事として公開する場合の価格（円、整数、${MIN_PAID_PRICE}〜${MAX_PAID_PRICE}）。省略時は無料公開（従来どおり）`),
  paid_line_after: z
    .string()
    .optional()
    .describe('有料ラインを置く段落の直前一致テキスト。price 指定時は必須。該当段落が無ければ公開せずエラーになる'),
  dry_run: z
    .boolean()
    .optional()
    .describe('true の場合、有料設定の内容を読み取って返すだけで公開しない（price 指定時のみ有効）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const UpdatePriceSchema = z.object({
  note_key: z.string().describe('価格を変更する公開済み有料記事のキー'),
  price: z.number().int().describe(`新しい価格（円、整数、${MIN_PAID_PRICE}〜${MAX_PAID_PRICE}）`),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const ListNotesSchema = z.object({
  status: z.enum(['all', 'draft', 'published']).optional().describe('絞り込み（既定 all）'),
  limit: z.number().optional().describe('返す件数の上限（既定は全件）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const UpdateTagsSchema = z.object({
  note_keys: z.array(z.string()).describe('対象記事のキー（複数まとめて処理できる）'),
  add: z.array(z.string()).optional().describe('追加するタグ（# は不要）'),
  remove: z.array(z.string()).optional().describe('外すタグ（# は不要）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const ListMagazinesSchema = z.object({
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const CreateMagazineSchema = z.object({
  name: z.string().describe('マガジン名（30字以内）'),
  description: z.string().optional().describe('マガジンの説明（400字以内）'),
  is_public: z.boolean().optional().describe('公開するか（既定 true。false で非公開マガジン）'),
  cover_path: z.string().optional().describe('カバー画像のパス（PNG/JPEG/HEIC）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const UpdateMagazineSchema = z.object({
  magazine: z.string().describe('対象マガジン（名前の部分一致可 / マガジンキー）'),
  name: z.string().optional().describe('新しいマガジン名（30字以内）'),
  description: z.string().optional().describe('新しい説明（400字以内）'),
  is_public: z.boolean().optional().describe('公開状態を変える場合に指定'),
  cover_path: z.string().optional().describe('差し替えるカバー画像のパス（PNG/JPEG/HEIC）'),
  remove_cover: z.boolean().optional().describe('カバー画像を外して既定ヘッダーに戻す場合に true'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const DeleteMagazineSchema = z.object({
  magazine: z.string().describe('削除するマガジン（名前の部分一致可 / マガジンキー）'),
  force: z.boolean().optional().describe('記事が入っているマガジンを削除する場合に true が必要'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

// ツール定義
const TOOLS: Tool[] = [
  {
    name: 'publish_note',
    description: 'note.comに記事を公開します。Markdownファイルからタイトル、本文、タグを読み取り、自動的に投稿します。',
    inputSchema: {
      type: 'object',
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Markdownファイルのパス（タイトル、本文、タグを含む）',
        },
        thumbnail_path: {
          type: 'string',
          description: 'サムネイル画像のパス（オプション）',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['markdown_path'],
    },
  },
  {
    name: 'save_draft',
    description: 'note.comに下書きを保存します。Markdownファイルからタイトル、本文、タグを読み取り、下書きとして保存します。',
    inputSchema: {
      type: 'object',
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Markdownファイルのパス（タイトル、本文、タグを含む）',
        },
        thumbnail_path: {
          type: 'string',
          description: 'サムネイル画像のパス（オプション）',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['markdown_path'],
    },
  },
  {
    name: 'publish_draft',
    description:
      'note.com の既存の下書きを公開します（新規作成はしません）。note_key で対象を指定し、任意でハッシュタグを付けられます。price を指定すると有料記事として公開します（paid_line_after が必須）。公開後に is_published と、有料の場合はペイウォール表示・価格表示を実際のページから検証してから成功を返します。⚠️ 不可逆な操作です。ユーザーの明示指示があるときだけ実行してください。',
    inputSchema: {
      type: 'object',
      properties: {
        note_key: {
          type: 'string',
          description: '公開する既存下書きのキー（例: nxxxxxxxxxxxx。URL の notes/xxx/edit の xxx 部分）',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '公開時に付けるハッシュタグ（# は不要。下書き保存では付けられないのでここで指定する）',
        },
        price: {
          type: 'number',
          description: `有料記事として公開する場合の価格（円、整数、${MIN_PAID_PRICE}〜${MAX_PAID_PRICE}）。省略時は無料公開（従来どおり）`,
        },
        paid_line_after: {
          type: 'string',
          description: '有料ラインを置く段落の直前一致テキスト（例: "ここまでが無料部分です。"）。price 指定時は必須。該当段落が見つからなければ公開せずエラーで停止する',
        },
        dry_run: {
          type: 'boolean',
          description: 'true なら有料設定の内容（価格・ライン前後の段落）を読み取って返すだけで公開しない。price 指定時のみ有効。本番公開前のレビューに使う',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['note_key'],
    },
  },
  {
    name: 'update_price',
    description:
      '公開済みの有料記事の価格を変更します。note_key は現に有料公開されている記事のキーである必要があります。変更後に価格表示を実際のページから検証してから成功を返します。⚠️ 不可逆な操作（購入者への影響あり）です。ユーザーの明示指示があるときだけ実行してください。',
    inputSchema: {
      type: 'object',
      properties: {
        note_key: { type: 'string', description: '価格を変更する公開済み有料記事のキー' },
        price: {
          type: 'number',
          description: `新しい価格（円、整数、${MIN_PAID_PRICE}〜${MAX_PAID_PRICE}）`,
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['note_key', 'price'],
    },
  },
  {
    name: 'update_draft',
    description:
      'note.com の既存記事のタイトル・本文を Markdown ファイルの内容で全置換します。下書きに対しては下書き保存で終わります。公開済み記事は note の仕様で「下書き保存」ができないため、publish: true を付けて呼ぶ必要があり、その場合は本文差し替え＋再公開（既存タグ・マガジンは維持）になります。アイキャッチは変更しません。⚠️ 有料記事の再公開では note が有料ラインを冒頭へ飛ばすため、paid_line_after（または md の front matter）で位置を指定する必要があります（指定が無ければ記事を変更せずに中断します）。',
    inputSchema: {
      type: 'object',
      properties: {
        note_key: { type: 'string', description: '更新する既存記事のキー（例: nxxxxxxxxxxxx。URL の notes/xxx/edit の xxx 部分）' },
        markdown_path: { type: 'string', description: '新しい内容の Markdown ファイルのパス（タイトル・本文で全置換される）' },
        thumbnail_path: {
          type: 'string',
          description: '差し替えるアイキャッチ画像のパス（省略時は既存のアイキャッチを維持）',
        },
        publish: {
          type: 'boolean',
          description:
            '公開済み記事の本文を差し替えて再公開する場合に true（公開済み記事は「下書き保存」ができないため）。既存のタグ・マガジンはそのまま維持される',
        },
        paid_line_after: {
          type: 'string',
          description:
            '有料記事を再公開するときの有料ラインの位置（この文字列で始まる段落の直後に置く）。省略時は md の front matter `paid_line_after` を使う。note は再公開のたびに有料ラインを冒頭へ飛ばすため、有料記事ではどちらかが必須（無いと中断する）',
        },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        screenshot_dir: { type: 'string', description: 'スクリーンショット保存ディレクトリ（オプション）' },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: ['note_key', 'markdown_path'],
    },
  },
  {
    name: 'server_info',
    description:
      'いま応答している MCP サーバー自身の版を返します（version / build_time / git_commit）。これらはビルド時に焼き込まれた値なので、「ディスク上のコードは新しいが、起動中のプロセスは古い」状態を検出できます。MCP クライアントは接続時のプロセスを使い続けるため、コードを直してビルドしても再接続するまで反映されません。書き込み系ツールを使う前に、build/version.json と突き合わせてください。note には一切アクセスしません。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_notes',
    description:
      '自分の記事一覧を取得します（note_key・タイトル・状態・タグ・所属マガジン・公開日・有料/無料の別・価格）。読み取り専用。ローカルの台帳と note 実体の差分確認、タグや価格を直す対象の洗い出し、有料公開の echo-back 検証に使います。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'draft', 'published'],
          description: '絞り込み（既定 all）',
        },
        limit: { type: 'number', description: '返す件数の上限（既定は全件）' },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: [],
    },
  },
  {
    name: 'update_tags',
    description:
      '公開済み記事のハッシュタグを変更します。複数記事を1回の呼び出しでまとめて処理できます。既存タグは保持し、add は追記・remove は除去。本文・アイキャッチ・マガジン所属は変えません。上限10タグを超える場合は何も変更せずエラーで止まります。下書きは対象外（公開してしまうため）。',
    inputSchema: {
      type: 'object',
      properties: {
        note_keys: {
          type: 'array',
          items: { type: 'string' },
          description: '対象記事のキー（複数まとめて処理できる。例: ["nxxxxxxxxxxxx","nyyyyyyyyyyyy"]）',
        },
        add: { type: 'array', items: { type: 'string' }, description: '追加するタグ（# は不要）' },
        remove: { type: 'array', items: { type: 'string' }, description: '外すタグ（# は不要）' },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）。記事数×15秒程度を見込む` },
      },
      required: ['note_keys'],
    },
  },
  {
    name: 'list_magazines',
    description:
      '自分のマガジン一覧を取得します（キー・名前・説明・公開状態・記事数）。マガジン名を確かめたいとき、他のマガジン系ツールを呼ぶ前に使います。',
    inputSchema: {
      type: 'object',
      properties: {
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: [],
    },
  },
  {
    name: 'create_magazine',
    description:
      'マガジンを新規作成します（無料マガジンのみ。有料マガジンは作れません）。作成後に一覧で存在を検証してキーとURLを返します。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'マガジン名（30字以内）' },
        description: { type: 'string', description: 'マガジンの説明（400字以内）' },
        is_public: { type: 'boolean', description: '公開するか（既定 true。false で非公開マガジン）' },
        cover_path: { type: 'string', description: 'カバー画像のパス（PNG/JPEG/HEIC）' },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_magazine',
    description:
      'マガジンの名前・説明・公開状態を変更します。指定しなかった項目は現在値がそのまま維持されます（note の更新APIは全項目送信型なので、内部で現在値を読んでマージしています）。',
    inputSchema: {
      type: 'object',
      properties: {
        magazine: { type: 'string', description: '対象マガジン（名前の部分一致可 / マガジンキー）' },
        name: { type: 'string', description: '新しいマガジン名（30字以内）' },
        description: { type: 'string', description: '新しい説明（400字以内）' },
        is_public: { type: 'boolean', description: '公開状態を変える場合に指定' },
        cover_path: { type: 'string', description: '差し替えるカバー画像のパス（PNG/JPEG/HEIC）' },
        remove_cover: { type: 'boolean', description: 'カバー画像を外して既定ヘッダーに戻す場合に true' },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: ['magazine'],
    },
  },
  {
    name: 'delete_magazine',
    description:
      'マガジンを削除します。記事が入っているマガジンは force: true が無いと削除しません（マガジンを消しても記事自体は残りますが、まとめ直す手間が大きいため）。',
    inputSchema: {
      type: 'object',
      properties: {
        magazine: { type: 'string', description: '削除するマガジン（名前の部分一致可 / マガジンキー）' },
        force: { type: 'boolean', description: '記事が入っているマガジンを削除する場合に true が必要' },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: ['magazine'],
    },
  },
  {
    name: 'add_to_magazine',
    description:
      'note.com の記事を自分のマガジンに追加します。マガジンは名前（部分一致可）またはキーで指定。追加後に belonging_magazine_keys で反映を検証します。',
    inputSchema: {
      type: 'object',
      properties: {
        note_key: { type: 'string', description: '対象記事のキー（例: nxxxxxxxxxxxx）' },
        magazine: { type: 'string', description: 'マガジン名（部分一致可）またはマガジンキー（m で始まる）' },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: ['note_key', 'magazine'],
    },
  },
  {
    name: 'remove_from_magazine',
    description:
      'note.com の記事を自分のマガジンから外します。マガジンは名前（部分一致可）またはキーで指定。削除後に belonging_magazine_keys で反映を検証します。',
    inputSchema: {
      type: 'object',
      properties: {
        note_key: { type: 'string', description: '対象記事のキー（例: nxxxxxxxxxxxx）' },
        magazine: { type: 'string', description: 'マガジン名（部分一致可）またはマガジンキー（m で始まる）' },
        state_path: { type: 'string', description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）` },
        timeout: { type: 'number', description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）` },
      },
      required: ['note_key', 'magazine'],
    },
  },
  {
    name: 'delete_note',
    description: 'note.comの記事（下書き・公開済問わず）を削除します。記事キーを指定します。',
    inputSchema: {
      type: 'object',
      properties: {
        note_key: {
          type: 'string',
          description: '削除する記事のキー（例: nxxxxxxxxxxxx または nyyyyyyyyyyyy）',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['note_key'],
    },
  },
  {
    name: 'post_to_x',
    description:
      'X（旧 Twitter）に投稿します。state_path のアカウントで投稿する記事告知用。in_reply_to_tweet_id を渡すとスレッドの返信になる（日本語を本投稿、英語を返信にする運用）。dry_run: true なら投稿せず文字数チェックだけ行う（認証情報も不要）。⚠️ 投稿は取り消せないので、ユーザーの明示指示があるときだけ実行する。',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            '投稿本文。上限は weighted length で280（日本語1文字＝2、URL は長さに関わらず23として数える）',
        },
        in_reply_to_tweet_id: {
          type: 'string',
          description: '返信先のツイートID。スレッドにする場合に指定（英語版を日本語版へ返信させる等）',
        },
        dry_run: {
          type: 'boolean',
          description: 'true なら投稿せず、文字数の検証結果だけ返す（既定 false）',
        },
        state_path: {
          type: 'string',
          description: `X の認証情報ファイルのパス（デフォルト: ${DEFAULT_X_STATE_PATH}）`,
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'post_to_facebook',
    description:
      'Facebook Page に投稿します。state_path で指定した Page Access Token を使う。link を渡すと Facebook 側が OGP を取得してリンクプレビューを付ける。dry_run: true なら投稿せず本文の確認だけ行う（認証情報も不要）。⚠️ 投稿は取り消せないので、ユーザーの明示指示があるときだけ実行する。',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '投稿本文',
        },
        link: {
          type: 'string',
          description: '添付するURL（任意。指定すると Facebook 側がOGPを取得してリンクプレビューを付ける）',
        },
        dry_run: {
          type: 'boolean',
          description: 'true なら投稿せず、投稿内容の確認結果だけ返す（既定 false）',
        },
        state_path: {
          type: 'string',
          description: `Facebook の認証情報ファイルのパス（デフォルト: ${DEFAULT_FACEBOOK_STATE_PATH}）`,
        },
      },
      required: ['message'],
    },
  },
];

// ---------------------------------------------------------------------------
// X（旧 Twitter）への投稿
//
// note とは別サービスだが、記事公開とツイートは一連の運用なので同じ MCP に置く。
// 認証は OAuth 1.0a User Context。自分のアカウントに投稿するだけなら
// 静的な4つの鍵で済み、トークンの期限切れも無いため OAuth 2.0 より扱いやすい。
// ---------------------------------------------------------------------------


type XCredentials = {
  apiKey: string;
  apiKeySecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

function loadXCredentials(statePath: string): XCredentials {
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `X の認証情報が見つかりません: ${statePath}\n` +
        'developer.x.com でアプリを作成し（権限は Read and write）、API Key / API Key Secret / ' +
        'Access Token / Access Token Secret の4つを発行して、次の形で保存してください:\n' +
        '{ "apiKey": "...", "apiKeySecret": "...", "accessToken": "...", "accessTokenSecret": "..." }\n' +
        '⚠️ 権限を Read and write に変えた「後」に Access Token を生成すること（順序を逆にすると読み取り専用のままで 403 になる）。'
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch (e) {
    throw new Error(`X の認証情報が JSON として読めません: ${statePath}`);
  }
  const missing = (['apiKey', 'apiKeySecret', 'accessToken', 'accessTokenSecret'] as const).filter(
    (k) => !parsed[k] || typeof parsed[k] !== 'string'
  );
  if (missing.length) {
    throw new Error(`X の認証情報に不足があります: ${missing.join(', ')}（${statePath}）`);
  }
  return parsed as XCredentials;
}

/** OAuth 1.0a のパーセントエンコード（RFC 3986。encodeURIComponent が変換しない4文字を追加で潰す） */
function oauthEncode(v: string): string {
  return encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * OAuth 1.0a の Authorization ヘッダーを作る。
 * 署名対象に含めるのは HTTP メソッド・URL・パラメータのみ。
 * ⚠️ JSON ボディは署名に含めない（X API v2 の仕様。含めると 401 になる）。
 */
function buildOAuthHeader(
  method: string,
  url: string,
  cred: XCredentials,
  extraParams: Record<string, string> = {}
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: cred.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: cred.accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${oauthEncode(k)}=${oauthEncode(allParams[k])}`)
    .join('&');

  const baseString = [method.toUpperCase(), oauthEncode(url), oauthEncode(paramString)].join('&');
  const signingKey = `${oauthEncode(cred.apiKeySecret)}&${oauthEncode(cred.accessTokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${oauthEncode(k)}="${oauthEncode(headerParams[k])}"`)
      .join(', ')
  );
}

// countXWeightedLength は ./xtext.ts（純粋関数・テスト対象）に分離した。

async function postToX(params: {
  text: string;
  inReplyToTweetId?: string;
  statePath?: string;
  dryRun?: boolean;
}): Promise<{
  success: boolean;
  dryRun: boolean;
  tweetId?: string;
  url?: string;
  text: string;
  weightedLength: number;
  message: string;
}> {
  const { text, inReplyToTweetId, statePath = DEFAULT_X_STATE_PATH, dryRun = false } = params;

  if (!text || !text.trim()) {
    throw new Error('text が空です');
  }

  const weightedLength = countXWeightedLength(text);
  if (weightedLength > 280) {
    throw new Error(
      `X の上限280を超えています（${weightedLength}）。CJK は1文字＝2、URL は23として数えます。短くしてください。`
    );
  }

  if (dryRun) {
    log('post_to_x dry run', { weightedLength, inReplyToTweetId });
    return {
      success: true,
      dryRun: true,
      text,
      weightedLength,
      message: `dry run（投稿していません）。文字数 ${weightedLength}/280。`,
    };
  }

  // dry_run でないときだけ認証情報を要求する（文字数チェックだけなら鍵は不要）
  const cred = loadXCredentials(statePath);

  const url = 'https://api.x.com/2/tweets';
  const body: Record<string, any> = { text };
  if (inReplyToTweetId) {
    body.reply = { in_reply_to_tweet_id: inReplyToTweetId };
  }

  const authHeader = buildOAuthHeader('POST', url, cred);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    // 詰まりやすいところを名指しで案内する
    let hint = '';
    if (res.status === 403) {
      hint =
        '\nヒント: アプリの権限が Read only のままか、権限変更「前」に発行した Access Token を使っている可能性があります。権限を Read and write にしてから Access Token を再生成してください。';
    } else if (res.status === 401) {
      hint = '\nヒント: 4つの鍵のいずれかが間違っているか、端末の時刻がずれています（署名に timestamp を使うため）。';
    } else if (res.status === 429) {
      hint = '\nヒント: レート制限です。しばらく待ってから再実行してください。';
    } else if (res.status === 402 || /payment|credit/i.test(raw)) {
      hint =
        '\nヒント: クレジット残高が不足しています。X は従量課金（PPU）に移行済みで、無料枠はありません。console.x.com でクレジットを購入してください。';
    }
    throw new Error(`X への投稿に失敗しました（HTTP ${res.status}）: ${raw}${hint}`);
  }

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`X の応答が JSON として読めません: ${raw}`);
  }

  const tweetId = json?.data?.id;
  if (!tweetId) {
    throw new Error(`投稿できたか確認できません（id が返りませんでした）: ${raw}`);
  }

  log('Posted to X', { tweetId, weightedLength });
  return {
    success: true,
    dryRun: false,
    tweetId,
    url: `https://x.com/i/status/${tweetId}`,
    text,
    weightedLength,
    message: 'X に投稿しました',
  };
}

// ---------------------------------------------------------------------------
// Facebook Page への投稿
//
// X とは認証方式が異なる（静的4鍵の OAuth 1.0a ではなく、OAuth 2.0 の
// Page Access Token）。トークンの発行自体はブラウザでの一度きりの操作
// （Meta for Developers でアプリ作成→対象ページを紐付け→Graph API Explorer
// で User Token を取得し Page Token に交換→長期化）が要り、MCP 側では
// 発行済みトークンを state ファイルから読むだけ。
// ---------------------------------------------------------------------------

type FacebookCredentials = {
  pageId: string;
  pageAccessToken: string;
};

function loadFacebookCredentials(statePath: string): FacebookCredentials {
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `Facebook の認証情報が見つかりません: ${statePath}\n` +
        'developers.facebook.com でアプリを作成し、対象ページを紐付けたうえで、Graph API Explorer で ' +
        'pages_manage_posts / pages_read_engagement / pages_show_list 権限の User Token を取得 → ' +
        '/me/accounts で Page Access Token に交換 → 長期化してから、次の形で保存してください:\n' +
        '{ "pageId": "...", "pageAccessToken": "..." }'
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch (e) {
    throw new Error(`Facebook の認証情報が JSON として読めません: ${statePath}`);
  }
  const missing = (['pageId', 'pageAccessToken'] as const).filter(
    (k) => !parsed[k] || typeof parsed[k] !== 'string'
  );
  if (missing.length) {
    throw new Error(`Facebook の認証情報に不足があります: ${missing.join(', ')}（${statePath}）`);
  }
  return parsed as FacebookCredentials;
}

async function postToFacebook(params: {
  message: string;
  link?: string;
  statePath?: string;
  dryRun?: boolean;
}): Promise<{
  success: boolean;
  dryRun: boolean;
  postId?: string;
  url?: string;
  message: string;
  length: number;
  info: string;
}> {
  const { message, link, statePath = DEFAULT_FACEBOOK_STATE_PATH, dryRun = false } = params;

  if (!message || !message.trim()) {
    throw new Error('message が空です');
  }

  const length = [...message].length;

  if (dryRun) {
    log('post_to_facebook dry run', { length, link });
    return {
      success: true,
      dryRun: true,
      message,
      length,
      info: `dry run（投稿していません）。文字数 ${length}（Facebookに厳密な短い上限は無い）${
        link ? `。link: ${link}` : ''
      }`,
    };
  }

  // dry_run でないときだけ認証情報を要求する（本文チェックだけなら鍵は不要）
  const cred = loadFacebookCredentials(statePath);

  const url = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${cred.pageId}/feed`;
  const body: Record<string, string> = {
    message,
    access_token: cred.pageAccessToken,
  };
  if (link) {
    body.link = link;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  const raw = await res.text();
  if (!res.ok) {
    let hint = '';
    if (/permission|review|scope/i.test(raw)) {
      hint =
        '\nヒント: pages_manage_posts などの権限が不足しているか、App Review（Advanced Access）が必要な状態の可能性があります。' +
        'Standard Access のままなら、投稿しようとしているアカウントがそのMetaアプリの管理者/開発者/テスターとして登録されているか確認してください。';
    } else if (/token|OAuthException/i.test(raw)) {
      hint = '\nヒント: Page Access Token が失効しているか、pageId と紐付いていない可能性があります。';
    }
    throw new Error(`Facebook への投稿に失敗しました（HTTP ${res.status}）: ${raw}${hint}`);
  }

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Facebook の応答が JSON として読めません: ${raw}`);
  }

  const postId = json?.id;
  if (!postId) {
    throw new Error(`投稿できたか確認できません（id が返りませんでした）: ${raw}`);
  }

  log('Posted to Facebook', { postId, length });
  return {
    success: true,
    dryRun: false,
    postId,
    url: `https://www.facebook.com/${postId}`,
    message,
    length,
    info: 'Facebook に投稿しました',
  };
}

// MCPサーバーの初期化
const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧ハンドラ
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ツール呼び出しハンドラ
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'publish_note') {
      const params = PublishNoteSchema.parse(args);
      const result = await postToNote({
        markdownPath: params.markdown_path,
        thumbnailPath: params.thumbnail_path,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
        isPublic: true,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'save_draft') {
      const params = SaveDraftSchema.parse(args);
      const result = await postToNote({
        markdownPath: params.markdown_path,
        thumbnailPath: params.thumbnail_path,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
        isPublic: false,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'publish_draft') {
      const params = PublishDraftSchema.parse(args);
      const result = await publishDraft({
        noteKey: params.note_key,
        tags: params.tags,
        price: params.price,
        paidLineAfter: params.paid_line_after,
        dryRun: params.dry_run,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'update_price') {
      const params = UpdatePriceSchema.parse(args);
      const result = await updatePrice({
        noteKey: params.note_key,
        price: params.price,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'update_draft') {
      const params = UpdateDraftSchema.parse(args);
      const result = await postToNote({
        markdownPath: params.markdown_path,
        thumbnailPath: params.thumbnail_path,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
        isPublic: params.publish === true,
        noteKey: params.note_key,
        // 再公開時は公開設定画面の既存タグに触らない（front matter の tags で二重に足さない）
        setTags: false,
        paidLineAfter: params.paid_line_after,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'server_info') {
      // ビルド時に焼き込んだ定数を返す。実行時に package.json を読み直さないこと
      // （古いプロセスが新しい番号を名乗ってしまい、鮮度の判定にならない）。
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                name: SERVER_NAME,
                version: VERSION,
                build_time: BUILD_TIME,
                git_commit: GIT_COMMIT,
                pid: process.pid,
                note: 'build/version.json と一致しなければ、MCP クライアントが古いプロセスを掴んでいます（再接続が必要）',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'list_notes') {
      const params = ListNotesSchema.parse(args);
      const result = await listNotes({
        status: params.status,
        limit: params.limit,
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'update_tags') {
      const params = UpdateTagsSchema.parse(args);
      const result = await updateTags({
        noteKeys: params.note_keys,
        add: params.add,
        remove: params.remove,
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'list_magazines') {
      const params = ListMagazinesSchema.parse(args);
      const result = await listMagazines({
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'create_magazine') {
      const params = CreateMagazineSchema.parse(args);
      const result = await createMagazine({
        name: params.name,
        description: params.description,
        isPublic: params.is_public,
        coverPath: params.cover_path,
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'update_magazine') {
      const params = UpdateMagazineSchema.parse(args);
      const result = await updateMagazine({
        magazine: params.magazine,
        name: params.name,
        description: params.description,
        isPublic: params.is_public,
        coverPath: params.cover_path,
        removeCover: params.remove_cover,
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'delete_magazine') {
      const params = DeleteMagazineSchema.parse(args);
      const result = await deleteMagazine({
        magazine: params.magazine,
        force: params.force,
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'add_to_magazine' || name === 'remove_from_magazine') {
      const params = MagazineOpSchema.parse(args);
      const result = await magazineOp({
        noteKey: params.note_key,
        magazine: params.magazine,
        action: name === 'add_to_magazine' ? 'add' : 'remove',
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'delete_note') {
      const params = DeleteNoteSchema.parse(args);
      const result = await deleteNote({
        noteKey: params.note_key,
        statePath: params.state_path,
        timeout: params.timeout,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'post_to_x') {
      const params = PostToXSchema.parse(args);
      const result = await postToX({
        text: params.text,
        inReplyToTweetId: params.in_reply_to_tweet_id,
        statePath: params.state_path,
        dryRun: params.dry_run,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === 'post_to_facebook') {
      const params = PostToFacebookSchema.parse(args);
      const result = await postToFacebook({
        message: params.message,
        link: params.link,
        statePath: params.state_path,
        dryRun: params.dry_run,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('Tool execution error', { name, error: errorMessage });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// サーバー起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server started', { name: SERVER_NAME, version: SERVER_VERSION });
}

main().catch((error) => {
  log('Fatal error', error);
  process.exit(1);
});

