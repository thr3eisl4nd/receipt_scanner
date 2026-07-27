const MAX_YEN = 10_000_000;

/** 金額らしき1トークンを円整数へ。金額でなければnull。 */
export function normalizeMoneyToken(token: string): number | null {
  let s = token.normalize("NFKC");     // 全角→半角
  s = s
    .replace(/[OoＯｏ]/g, "0")
    .replace(/[Il|ｌ]/g, "1")
    .replace(/^▲/, "-")
    .replace(/[¥￥円,\s]/g, "")
    .replace(/[-ー−]$/, "");           // 末尾ハイフン(¥1,234-)は除去
  if (!/^-?\d+$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isSafeInteger(value)) return null;
  if (Math.abs(value) > MAX_YEN) return null;
  return value;
}

/**
 * 行テキストから金額候補をすべて抽出する。
 *
 * 数値グループは「先頭1〜3桁 + (区切り + 3桁)の繰り返し」に限定することで、
 * "550 10%対象" のような無関係な数値が空白でくっついて誤結合するのを防ぐ
 * (桁区切りとしての空白/カンマは常に3桁区切りであるため)。
 * また、直後に "%" が続く数値(税率表記 "8%対象" 等)は金額候補から除外する。
 */
export function findMoneyTokens(text: string): number[] {
  const re = /[▲-]?[¥￥]?[0-9OoIl|]{1,3}(?:[,\s][0-9OoIl|]{3})*(?:円)?[-ー−]?/g;
  const normalized = text.normalize("NFKC");
  const out: number[] = [];
  for (const m of normalized.matchAll(re)) {
    const nextChar = normalized[m.index + m[0].length];
    if (nextChar === "%") continue;
    const v = normalizeMoneyToken(m[0].trim());
    if (v !== null) out.push(v);
  }
  return out;
}
