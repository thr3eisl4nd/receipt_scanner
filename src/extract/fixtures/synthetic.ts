import type { OcrLine } from "../../ocr/engine";

export function line(text: string, y: number, x = 0, confidence = 0.95): OcrLine {
  return { text, confidence, box: { x, y, width: text.length * 12, height: 20 } };
}

/** スーパーの標準的なレシート: 合計行が明確 */
export const supermarket: OcrLine[] = [
  line("スーパーABC", 0),
  line("ねぎ", 40), line("¥98", 40, 200),
  line("小計", 100), line("¥1,234", 100, 200),
  line("合計", 140), line("¥1,332", 140, 200),
  line("お預り", 180), line("¥2,000", 180, 200),
  line("お釣り", 220), line("¥668", 220, 200),
];

/** 税率別表記: 8%/10%対象が並ぶ */
export const taxBreakdown: OcrLine[] = [
  line("8%対象", 100), line("¥550", 100, 200),
  line("10%対象", 140), line("¥1,100", 140, 200),
  line("合計", 180), line("¥1,650", 180, 200),
];

/** 合計キーワードなし(下部が切れた) */
export const truncated: OcrLine[] = [
  line("ねぎ", 40), line("¥98", 40, 200),
  line("たまご", 80), line("¥298", 80, 200),
];

/** キーワードと金額が別行(1行下)に出るケース */
export const totalOnNextLine: OcrLine[] = [
  line("ご請求額", 140),
  line("¥3,980", 165),
  line("お預り", 210), line("¥5,000", 210, 200),
];

/** 現計表記+末尾ハイフン */
export const genkei: OcrLine[] = [
  line("現計", 140), line("￥１，６５０－", 140, 200),
  line("クレジット", 180), line("￥１，６５０", 180, 200),
];
