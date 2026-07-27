import type { OcrLine } from "../ocr/engine";
import { findMoneyTokens } from "./normalize";

export type ExtractResult = {
  amountYen: number | null;
  status: "auto-high" | "needs-review" | "failed";
  candidates: number[];
};

const STRONG_LABELS = [
  /(?:税込|総)?合計/,
  /お?買上(?:げ)?(?:計|金額)/,
  /お会計/,
  /ご?請求(?:額|金額)/,
  /今回お支払額/,
  /現計/,
];

const REJECT_LABELS = [
  /小計/,
  /(?:8|10)\s*%対象/,
  /課税対象/,
  /消費税|内税|外税|税額|税率/,
  /預り|釣り?銭?|お釣/,
  /現金|クレジット|電子マネー|ポイント|残高/,
  /値引|割引/,
  /点数|電話|伝票/,
];

type Candidate = { amountYen: number; score: number };

/** 2行が視覚的に同一行か(Y中心の差が行高の6割未満) */
function sameRow(a: OcrLine, b: OcrLine): boolean {
  const ac = a.box.y + a.box.height / 2;
  const bc = b.box.y + b.box.height / 2;
  return Math.abs(ac - bc) < Math.max(a.box.height, b.box.height) * 0.6;
}

/** bがaの下方1〜2行分(行高の0.5〜2.5倍)にあるか */
function isJustBelow(a: OcrLine, b: OcrLine): boolean {
  const dy = b.box.y - a.box.y;
  const h = Math.max(a.box.height, 12);
  return dy > h * 0.5 && dy < h * 2.5;
}

export function extractTotal(lines: OcrLine[]): ExtractResult {
  if (lines.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  const maxY = Math.max(...lines.map((l) => l.box.y + l.box.height));
  const norm = (t: string) => t.normalize("NFKC");
  const strongLines = lines.filter((l) => STRONG_LABELS.some((re) => re.test(norm(l.text))));
  const rejectLines = lines.filter((l) => REJECT_LABELS.some((re) => re.test(norm(l.text))));

  const candidates: Candidate[] = [];
  for (const line of lines) {
    for (const amountYen of findMoneyTokens(line.text)) {
      let score = 0;
      const nearStrong = strongLines.some((s) => sameRow(s, line));
      const belowStrong = strongLines.some((s) => isJustBelow(s, line));
      const nearReject = rejectLines.some((r) => sameRow(r, line));
      if (nearStrong) score += 50;
      else if (belowStrong) score += 40;
      if (nearReject) score -= 100;
      if (line.box.y > maxY / 2) score += 5;                 // レシート下半分
      if (/[¥￥円]/.test(norm(line.text))) score += 10;
      score += Math.round(line.confidence * 10);
      if (score > 0 && (nearStrong || belowStrong)) {
        candidates.push({ amountYen, score });
      }
    }
  }

  if (candidates.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  candidates.sort((a, b) => b.score - a.score);
  const unique = [...new Map(candidates.map((c) => [c.amountYen, c])).values()];
  const top = unique[0];
  const second = unique[1];
  const confident = top.score >= 60 && (second === undefined || top.score - second.score >= 20);

  return {
    amountYen: top.amountYen,
    status: confident ? "auto-high" : "needs-review",
    candidates: unique.slice(0, 3).map((c) => c.amountYen),
  };
}
