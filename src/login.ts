// ログイン状態の判定。
//
// ブラウザにも note にも依存しない純粋関数として切り出してある。理由は2つ:
//   1) test/ から直接検証できる（ブラウザを起動せずに済む）
//   2) MCP ツール（note_login_start / note_login_finish）と scripts/login-note.js の
//      両方が同じ判定を使い、二重実装にならない
//
// 判定の根拠は storageState の cookie。値そのものは秘密なので一切扱わない
// （ログにも出さない）。
//
// ⚠️ これは**安い前さばきであって、真の判定ではない**（2026-09-23 実測）。
// note.com はログイン前の訪問者にも `note_gql_auth_token` を置く。まっさらな
// ブラウザで note.com/login を開いただけの状態でも、この cookie は存在する。
// つまり「cookie がある」＝「ログイン済み」ではない。
//
// 本当にログインできたかは note 自身に聞くしかない（index.ts の fetchUrlname が
// /api/v2/current_user を叩いて urlname を引く）。ここは「cookie すら無い＝
// 明らかにまだ」を弾くために使い、最後の確認は必ず API 側で行うこと。

/** ログイン済みを示す cookie の名前。 */
export const NOTE_AUTH_COOKIE = 'note_gql_auth_token';

/** cookie が属していなければならないドメイン。 */
export const NOTE_COOKIE_DOMAIN = 'note.com';

export interface StorageStateCookie {
  name: string;
  domain?: string;
  value?: string;
  /** Unix 秒。セッション cookie は -1。 */
  expires?: number;
}

export interface StorageStateLike {
  cookies?: StorageStateCookie[];
}

export interface LoginCheck {
  loggedIn: boolean;
  /** 人間に見せる理由。ツールの返り値にそのまま入れる。 */
  reason: string;
  /** 認証 cookie の失効時刻（ISO8601）。セッション cookie のときは undefined。 */
  expiresAt?: string;
}

function domainMatches(domain: string | undefined): boolean {
  if (!domain) return false;
  const d = domain.replace(/^\./, '').toLowerCase();
  return d === NOTE_COOKIE_DOMAIN || d.endsWith(`.${NOTE_COOKIE_DOMAIN}`);
}

/**
 * storageState からログイン済みかを判定する。
 *
 * @param state Playwright の storageState（ファイルから読んだ JSON でよい）
 * @param _nowMs 使っていない（以前は失効判定に使っていた。下のコメント参照）。互換のため残す
 */
export function checkNoteLogin(
  state: StorageStateLike | null | undefined,
  _nowMs: number = Date.now()
): LoginCheck {
  if (!state || !Array.isArray(state.cookies) || state.cookies.length === 0) {
    return { loggedIn: false, reason: 'cookie がまだ1つもありません（ログイン前の状態です）' };
  }

  const auth = state.cookies.find(
    (c) => c && c.name === NOTE_AUTH_COOKIE && domainMatches(c.domain)
  );

  if (!auth) {
    return {
      loggedIn: false,
      reason: `ログインを示す cookie（${NOTE_AUTH_COOKIE}）がまだありません。ブラウザでログインを終えてから、もう一度ためしてください`,
    };
  }

  if (!auth.value) {
    return {
      loggedIn: false,
      reason: `cookie（${NOTE_AUTH_COOKIE}）はありますが中身が空です。ログインが最後まで終わっていない可能性があります`,
    };
  }

  // ⚠️ expires で「切れている」と判断してはいけない（2026-09-23 実測）。
  // 現に動いている認証ファイルの note_gql_auth_token は expires が6週間前の
  // 日付だったが、note へのリクエストは通り続けていた。note 側はこの cookie の
  // expires を実際の寿命として扱っていない。ここで失効と決めつけると、
  // 使えている利用者に「ログインし直せ」と言うことになる。
  //
  // したがって expires は参考情報としてだけ返し、判定には使わない。
  // 本当に切れているかを知りたいときは note の API に当てて確かめること
  // （index.ts の fetchUrlname を使う）。
  const expiresAt =
    typeof auth.expires === 'number' && auth.expires > 0
      ? new Date(auth.expires * 1000).toISOString()
      : undefined;

  return { loggedIn: true, reason: 'ログイン済みです', ...(expiresAt ? { expiresAt } : {}) };
}

/**
 * 保存済みの認証ファイルを読んで判定する。読めなければ「ログインしていない」扱い。
 * fs を呼ぶのはここだけにして、checkNoteLogin 自体は純粋に保つ。
 */
export function checkNoteLoginFile(
  statePath: string,
  readFile: (p: string) => string,
  existsFile: (p: string) => boolean,
  nowMs: number = Date.now()
): LoginCheck {
  if (!existsFile(statePath)) {
    return { loggedIn: false, reason: `認証ファイルがありません（${statePath}）` };
  }
  let parsed: StorageStateLike;
  try {
    parsed = JSON.parse(readFile(statePath));
  } catch {
    return { loggedIn: false, reason: `認証ファイルが壊れています（${statePath}）。作り直してください` };
  }
  return checkNoteLogin(parsed, nowMs);
}
