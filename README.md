# mf-note-mcp

An MCP server for posting to [note.com](https://note.com) from a Markdown file. Fork of [Go-555/note-post-mcp](https://github.com/Go-555/note-post-mcp) (MIT), maintained by MusicFlow.

**What this fork changes** — the browser runs *headed* (an off-screen window) rather than headless. note.com's editor blocks the headless build: the `POST /api/v1/text_notes` call fails bot detection and the editor never renders. This fork also adds tools for publishing existing drafts, editing tags and prices, managing magazines, and announcing posts.

This is a **local tool**. It drives a real browser session with your own cookies, so it needs a desktop OS with a GUI — it does not run on a headless server or in CI. It only touches your own account's own content.

Not published to npm: clone, build, and register `build/index.js` directly.

## Requirements

- Node.js 18+
- A desktop OS with a GUI session
- A note.com account

## Install

```bash
git clone <this-repo> mf-note-mcp
cd mf-note-mcp
npm install
npm run build
npm run install-browser
```

Then create the auth state file:

```bash
npm run login
```

A visible browser window opens. Log in to note.com, then press Enter in the terminal. This writes `~/.note-state.json` (mode `600`) with your session cookies. It expires after a few weeks — rerun to refresh. Keep the file private.

## Register with a client

Any MCP client works; point it at the built entry with an absolute path. For Claude Code:

```bash
claude mcp add note-post -s user -- node /absolute/path/to/mf-note-mcp/build/index.js
```

For a JSON-configured client (Cursor, VS Code, Claude Desktop):

```json
{
  "mcpServers": {
    "note-post-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/mf-note-mcp/build/index.js"]
    }
  }
}
```

After editing `src/index.ts`, run `npm run build`, then **reconnect the client** — an MCP client keeps the process it spawned at connect time, so a rebuild alone changes nothing. Call `server_info` and compare it against `build/version.json` to detect a stale process.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NOTE_POST_MCP_STATE_PATH` | `~/.note-state.json` | note.com auth state file |
| `NOTE_POST_MCP_TIMEOUT` | `180000` | Browser operation timeout (ms) |
| `MCP_NAME` | `note-post-mcp` | Server name override |
| `X_STATE_PATH` | `~/.x-state.json` | X credentials; read only when `post_to_x` is called |
| `FACEBOOK_STATE_PATH` | `~/.facebook-state.json` | Facebook credentials; read only when `post_to_facebook` is called |

## Tools

Every tool also accepts `state_path` and `timeout`. Tools that drive the browser additionally accept `screenshot_dir`.

### Server

| Tool | Purpose | Key inputs |
|---|---|---|
| `server_info` | Returns the running build's `version` / `build_time` / `git_commit`. Does not touch note. | — |

### Articles

| Tool | Purpose | Key inputs |
|---|---|---|
| `list_notes` | Read-only inventory: key, title, status, tags, magazines, publish date, paid/price. | `status` (`all`\|`draft`\|`published`), `limit` |
| `save_draft` | Create a **new draft** from a Markdown file. | `markdown_path`, `thumbnail_path` |
| `publish_note` | Create a **new article and publish it** in one step. | `markdown_path`, `thumbnail_path` |
| `publish_draft` | Publish an **existing** draft. | `note_key`, `tags`, `price`, `paid_line_after`, `dry_run` |
| `update_draft` | Replace an existing article's title and body from a Markdown file. | `note_key`, `markdown_path`, `thumbnail_path`, `publish` |
| `update_tags` | Change hashtags on published articles; accepts **many articles per call**. | `note_keys[]`, `add[]`, `remove[]` |
| `update_price` | Change the price of an already-paid published article. | `note_key`, `price` |
| `delete_note` | Delete an article (draft or published). | `note_key` |

Notes that affect how you call these:

- **Tags cannot be stored on a draft.** `save_draft` ignores `tags:` front matter; pass tags to `publish_draft` instead. `update_tags` rejects drafts.
- **note's tag limit is 10.** If a call would exceed it, `update_tags` changes nothing and reports which article would overflow.
- **Publishing paid requires `paid_line_after`** — the prefix of the paragraph the paywall should follow. Use `dry_run` first to see where the line lands. Price range is 100–50,000 yen.
- **`update_draft` on an already-published article requires `publish: true`**, since note has no "save draft" for published articles. Tags and magazine membership are preserved.
- Use `publish_draft`, not `publish_note`, when the draft already exists — otherwise you get two copies.

### Magazines

| Tool | Purpose | Key inputs |
|---|---|---|
| `list_magazines` | Your magazines with key, name, description, status, note count. | — |
| `create_magazine` | Create a magazine (**free only**). | `name` (≤30), `description` (≤400), `is_public`, `cover_path` |
| `update_magazine` | Change name / description / visibility / cover. | `magazine`, plus fields to change, `remove_cover` |
| `delete_magazine` | Delete a magazine. Refuses a non-empty one without `force`. | `magazine`, `force` |
| `add_to_magazine` | Add a **published** article to a magazine. | `note_key`, `magazine` |
| `remove_from_magazine` | Remove an article from a magazine. | `note_key`, `magazine` |

The `magazine` argument takes a name substring or an `m...` key. An ambiguous substring is rejected with the candidates listed. Omitted fields in `update_magazine` keep their current values.

### Announcements

Both are **optional** — credentials are read inside the call, so an unused tool touches nothing, and `dry_run` needs no credentials at all.

| Tool | Purpose | Key inputs |
|---|---|---|
| `post_to_x` | Post to X, optionally as a reply (to build a thread). | `text`, `in_reply_to_tweet_id`, `dry_run` |
| `post_to_facebook` | Post to a Facebook Page, optionally with a link preview. | `message`, `link`, `dry_run` |

`post_to_x` credentials are OAuth 1.0a User Context (`~/.x-state.json`):

```json
{ "apiKey": "...", "apiKeySecret": "...", "accessToken": "...", "accessTokenSecret": "..." }
```

Set the app permission to "Read and write" **before** generating the access token — the other order yields a read-only token. X's text limit is a weighted 280 (CJK counts 2 per character, any URL counts 23).

`post_to_facebook` credentials are a Page Access Token (`~/.facebook-state.json`):

```json
{ "pageId": "...", "pageAccessToken": "..." }
```

## Markdown format

```markdown
---
title: Your Article Title
tags:
  - tag1
  - tag2
---

Your article body goes here.
```

`tags: [tag1, tag2]` also works. With no front matter, the first `# ` line becomes the title.

Body handling:

- `## ` / `### ` headings, bullet and numbered lists, block quotes, and `---` rules are converted.
- Fenced code blocks need a closing fence; the language tag is preserved.
- A URL alone on a line becomes a link card. A YouTube URL alone on a line becomes a video embed.
- Images use **relative paths** from the Markdown file (`![alt](./images/x.png)`, PNG/JPEG/GIF) and are uploaded to note's CDN. Remote image URLs are **not** supported — they end up as literal text in the article.
- Local video files cannot be embedded; upload to YouTube or convert to GIF.

## Example call

```json
{
  "name": "save_draft",
  "arguments": { "markdown_path": "/path/to/article.md" }
}
```

## Troubleshooting

- **Authentication errors** — the session expired; rerun `npm run login`.
- **Editor fails to launch, missing `Chromium Framework`** — Playwright's extraction hung at 100%. Extract the downloaded zip manually.
- **A change to the code has no effect** — the client is holding the process it spawned. Compare `server_info` against `build/version.json` and reconnect.
- **Timeouts** — raise `NOTE_POST_MCP_TIMEOUT` or pass a larger `timeout`.

## References

- [Model Context Protocol](https://modelcontextprotocol.io/docs/sdks)
- [Playwright](https://playwright.dev/)

## License

MIT. See [`LICENSE`](LICENSE) for the upstream and fork copyright notices.
