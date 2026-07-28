import { MAX_YEN } from "./extract/normalize";

/**
 * 金額入力欄(円)の正規化・検証・符号切替を共通化したユーティリティ
 * (Codexレビュー最終ゲート指摘Minor#1)。
 *
 * 従来は`ReceiptRow.tsx`にこの実装があり、`ManualEntryForm.tsx`がコンポーネント
 * 越しに直接importして流用していた。金額の解釈・符号切替ルールはOCR結果の手修正
 * (ReceiptRow)と手動追加(ManualEntryForm)の双方で同一であるべきかつ実際に同一なので、
 * コンポーネントに依存しない共通モジュールへ抽出する。
 */

/**
 * 金額入力の正規化+検証(Codexレビュー指摘I3)。
 *
 * 従来は「数字/マイナス以外を除去してから解釈する」実装だったため、`1.5`→`15`、
 * `12abc34`→`1234`のように入力ミスがまったく別の金額として黙って確定してしまう
 * 危険があった。当初の修正版もNFKC正規化後に許可文字(カンマ・空白・円記号)を
 * 「文字列中のどこからでも」除去してから検証しており、`"円"`単体→null(未入力扱い)、
 * `"1,00"`→100、`"1 2"`→12のように、依然として一部の入力ミスを黙って解釈して
 * しまう穴が残っていた(Codexレビュー再指摘I3)。ここでは許可する書式そのものを
 * 正規表現で構造的に検証し、部分一致除去はしない。
 *
 * 上限はOCR抽出(`src/extract/normalize.ts`の`MAX_YEN`=1,000万円)と揃える
 * (Codexレビュー最終ゲート指摘Minor: 手動入力にはこれまで上限がなく、複数行合算が
 * safe integerを超えうる可能性があった)。
 */
export function parseYenInput(raw: string): number | null | "invalid" {
  const value = raw.normalize("NFKC").trim();
  if (value === "") return null;

  // 許可する書式: 任意の先頭¥(空白可)、任意の-、"1234"のような数字の並び、または
  // "1,234"/"12,345,678"のようにカンマ区切りが3桁ごとに正しく入っている数字、
  // 任意の末尾円(空白可)。これ以外(記号だけ・桁区切りの誤り・数字の途中に
  // 空白や文字が混ざる等)はすべて"invalid"として拒否する。
  const match = /^(?:¥\s*)?(-?)(\d+|\d{1,3}(?:,\d{3})+)\s*円?$/.exec(value);
  if (!match) return "invalid";

  const parsed = Number(`${match[1]}${match[2].replaceAll(",", "")}`);
  if (!Number.isSafeInteger(parsed)) return "invalid";
  if (Math.abs(parsed) > MAX_YEN) return "invalid";
  return parsed === 0 ? 0 : parsed; // "-0"の負のゼロを正のゼロへ正規化する(Codexレビュー再指摘Minor)
}

/**
 * 金額入力欄の符号を切り替える(返品・取消の入力補助。iPhoneの数値キーボードに
 * マイナスキーがないための代替導線)。
 *
 * `parseYenInput`が許可する書式は「¥(任意)→-(任意)→数字」の順(¥が-より前)。
 * 単純に文字列の先頭へ"-"を足し引きすると、ユーザーが"¥1,234"のように¥を
 * 手入力していた場合に"-¥1,234"という不正な並びを作ってしまう(Codexレビュー
 * 再指摘Minor)。先頭の¥プレフィックスを検出し、その直後に符号を置く。
 */
export function toggleYenSign(raw: string): string {
  const prefixMatch = /^[¥￥]\s*/.exec(raw);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  const rest = raw.slice(prefix.length);
  const toggled = rest.startsWith("-") ? rest.slice(1) : `-${rest}`;
  return `${prefix}${toggled}`;
}

/** 符号切替ボタンの`aria-pressed`表示用に、現在の入力が負数書式かを判定する。 */
export function isNegativeYenInput(raw: string): boolean {
  return /^[¥￥]?\s*-/.test(raw);
}
