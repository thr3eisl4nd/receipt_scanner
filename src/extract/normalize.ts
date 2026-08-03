// 手動入力(src/moneyInput.ts)にも同じ上限を適用するためexportする
// (Codexレビュー最終ゲート指摘Minor: 手動入力にはこれまで上限がなく、
// 複数行合算がsafe integerを超えうる可能性があった)。
export const MAX_YEN = 10_000_000;

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
 * 数値本体は3パターンの択一:
 *   1. カンマ区切り: 先頭1〜3桁 + ("," + 3桁) を1回以上
 *   2. 空白区切り: 先頭1〜3桁 + (半角空白/タブ + 3桁) を1回以上。
 *      ただし桁区切りとしての空白は ¥/円 のいずれかが伴う場合に限る
 *      ("550 10%対象" のような無関係な数値の誤結合を防ぐため)。
 *      改行等を含む \s ではなく [ \t] のみを区切りとして許容する。
 *   3. 区切りなし: 桁数制限のない連続数字("1332円" のような4桁以上の
 *      カンマなし金額もそのまま1トークンとして拾う)。
 *
 * マッチの直前・直後の文字が英数字/ピリオド/カンマ/ハイフンの場合は、
 * 日付("2026-07-27")や電話番号("03-1234-5678")、コード("No.123...")
 * などの部分マッチとみなして不採用にする。ここで見る前後の文字は
 * マッチ全体(先頭の▲/-や末尾の-/ー/−を含む)の外側であり、マッチ自身が
 * 消費したそれらの符号文字自体を前後判定の対象にすることはない。
 * また、直後に(空白を1つ挟んでもよい)"%" が続く数値(税率表記)は
 * 金額候補から除外する。
 */
export function findMoneyTokens(text: string): number[] {
  const D = "[0-9OoIl|]";
  const digit13 = `${D}{1,3}`;
  const digit3 = `${D}{3}`;
  const cur = "[¥￥]";
  // 1. カンマ区切り(円は前後どちらでも任意)
  const commaBody = `${cur}?${digit13}(?:,${digit3})+円?`;
  // 2a. ¥prefixあり + 空白区切り(円は任意)
  const spaceBodyWithPrefix = `${cur}${digit13}(?:[ \\t]${digit3})+円?`;
  // 2b. ¥prefixなし + 空白区切り + 円は必須
  const spaceBodyWithSuffix = `${digit13}(?:[ \\t]${digit3})+円`;
  // 3. 区切りなし(桁数無制限)
  const bareBody = `${cur}?${D}+円?`;
  const re = new RegExp(
    `[▲-]?(?:(?:${commaBody})|(?:${spaceBodyWithPrefix})|(?:${spaceBodyWithSuffix})|(?:${bareBody}))[-ー−]?`,
    "g",
  );
  const boundary = /[0-9A-Za-z.,-]/;
  const normalized = text.normalize("NFKC");
  const out: number[] = [];
  for (const m of normalized.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? normalized[start - 1] : undefined;
    const after = end < normalized.length ? normalized[end] : undefined;
    if ((before !== undefined && boundary.test(before)) || (after !== undefined && boundary.test(after))) {
      continue;
    }
    if (/^[ \t]?%/.test(normalized.slice(end))) continue;
    // 直後(空白/タブを1つ挟んでもよい)が個数の助数詞なら金額として扱わない
    // (Codexレビュー指摘、task-25: 「3点」のような品目の個数表記が、通貨記号なし・
    // 円表記なしの裸の数字として金額候補に紛れ込んでいた。「合計 3点」が¥3に化ける等、
    // box座標モード・テキスト行モードいずれの安全性にも関わる)。
    if (/^[ \t]?(?:点|個|本|枚|人|件|回)/.test(normalized.slice(end))) continue;
    const v = normalizeMoneyToken(m[0].trim());
    if (v !== null) out.push(v);
  }
  return out;
}
