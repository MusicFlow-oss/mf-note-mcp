// Markdown の解析（front matter・本文・画像参照）。
// ブラウザにも note にも依存しない純粋関数群で、test/ から直接検証する。

import * as fs from 'fs';
import * as path from 'path';

export interface ImageInfo {
  alt: string;
  localPath: string;
  absolutePath: string;
  placeholder: string;
}

// Markdownから画像パスを抽出する
export function extractImages(
  markdown: string,
  baseDir: string,
  warn?: (message: string) => void
): ImageInfo[] {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images: ImageInfo[] = [];
  let match;

  while ((match = imageRegex.exec(markdown)) !== null) {
    const alt = match[1] || 'image';
    const imagePath = match[2];

    // URLではなくローカルパスの場合のみ処理
    if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
      const absolutePath = path.resolve(baseDir, imagePath);
      if (fs.existsSync(absolutePath)) {
        images.push({
          alt,
          localPath: imagePath,
          absolutePath,
          placeholder: match[0], // 元のマークダウン記法全体
        });
      } else {
        warn?.(`Warning: Image file not found: ${absolutePath}`);
      }
    }
  }

  return images;
}

// Markdownファイルをパースする。
//
// front matter の扱い:
//   - front matter は**文書の先頭行が `---` のときだけ**始まる。本文中の `---` は
//     水平線としてそのまま本文に残す（以前は本文中の `---` で front matter 判定が
//     トグルし、以降の本文を飲み込むバグがあった）。
//   - `- item` をタグとして読むのは `tags:` ブロックの中だけ。`x_ja: |` のような
//     複数行値に `- ` で始まる行があってもタグに混ざらない。
export function parseMarkdown(content: string): {
  title: string;
  body: string;
  tags: string[];
  paidLineAfter?: string;
} {
  const lines = content.split('\n');
  let title = '';
  let body = '';
  const tags: string[] = [];
  let paidLineAfter: string | undefined;

  let inFrontMatter = false;
  let frontMatterEnded = false;
  let inTagsBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === 0 && line.trim() === '---') {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter && line.trim() === '---') {
      inFrontMatter = false;
      frontMatterEnded = true;
      continue;
    }

    if (inFrontMatter) {
      if (line.startsWith('title:')) {
        title = line.substring(6).trim().replace(/^["']|["']$/g, '');
        inTagsBlock = false;
      } else if (line.startsWith('tags:')) {
        const tagsStr = line.substring(5).trim();
        if (tagsStr.startsWith('[') && tagsStr.endsWith(']')) {
          // 配列形式: tags: [tag1, tag2]
          tags.push(
            ...tagsStr
              .slice(1, -1)
              .split(',')
              .map((t) => t.trim().replace(/^["']|["']$/g, ''))
          );
          inTagsBlock = false;
        } else {
          // ブロック形式: 次行以降の "- tag" を読む
          inTagsBlock = true;
        }
      } else if (line.startsWith('paid_line_after:')) {
        // 有料ラインの位置（この文字列で始まる段落の直後にラインを置く）。
        // 再公開のたびに note が有料ラインを冒頭へ飛ばすため、位置の正典として使う。
        paidLineAfter = line.substring(16).trim().replace(/^["']|["']$/g, '');
        inTagsBlock = false;
      } else if (inTagsBlock && line.trim().startsWith('-')) {
        const tag = line.trim().substring(1).trim().replace(/^["']|["']$/g, '');
        if (tag) tags.push(tag);
      } else if (/^\S/.test(line)) {
        // 別のキーが始まったら tags ブロックは終わり
        inTagsBlock = false;
      }
      continue;
    }

    // タイトルを # から抽出（front matterに title が無い場合）
    if (!title && line.startsWith('# ')) {
      title = line.substring(2).trim();
      continue;
    }

    body += line + '\n';
  }

  return {
    title: title || 'Untitled',
    body: body.trim(),
    tags: tags.filter(Boolean),
    paidLineAfter,
  };
}
