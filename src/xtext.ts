// X（旧 Twitter）の weighted length 計算。純粋関数なので test/ から直接検証する。

/** X の文字数カウント（CJK は2文字、URL は23文字固定として数える。上限280） */
export function countXWeightedLength(text: string): number {
  // URL は t.co に短縮されるため、実際の長さに関わらず 23 として数える
  const withoutUrls = text.replace(/https?:\/\/[^\s]+/g, '');
  const urlCount = (text.match(/https?:\/\/[^\s]+/g) || []).length;

  let weighted = 0;
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    // Twitter の weighted length: ラテン・記号などは1、CJK や全角は2
    const isNarrow =
      (cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    weighted += isNarrow ? 1 : 2;
  }
  return weighted + urlCount * 23;
}
