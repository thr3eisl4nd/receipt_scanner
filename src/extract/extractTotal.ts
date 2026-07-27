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

/** auto-highに要求する最低confidence(金額行・対応する強ラベル行の両方に適用) */
const AUTO_HIGH_MIN_CONFIDENCE = 0.9;

type RawCandidate = {
  amountYen: number;
  score: number;
  line: OcrLine;
  /** このスコアの根拠になった強ラベル行 */
  strongSource: OcrLine;
  /** nearStrong(同一行)ではなくbelowStrong(直下1〜2行)経由で拾った候補か */
  viaBelowStrong: boolean;
  /** 強ラベルと除外語が同一OcrLineに同居 or 1行に複数金額 → auto-high不可 */
  sameLineBlocked: boolean;
};

/** aとbの垂直方向の重なり率(0〜1)。重なりがなければ0。 */
function verticalOverlapRatio(a: OcrLine, b: OcrLine): number {
  const aTop = a.box.y;
  const aBottom = a.box.y + a.box.height;
  const bTop = b.box.y;
  const bBottom = b.box.y + b.box.height;
  const overlap = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.box.height, b.box.height);
}

/** 2行が視覚的に同一行か(垂直重なり率が、低いほうの行高の50%以上) */
function sameRow(a: OcrLine, b: OcrLine): boolean {
  return verticalOverlapRatio(a, b) >= 0.5;
}

/** bがaの下方1〜2行分(行高の0.5〜2.5倍)にあるか */
function isJustBelow(a: OcrLine, b: OcrLine): boolean {
  const dy = b.box.y - a.box.y;
  const h = Math.max(a.box.height, 12);
  return dy > h * 0.5 && dy < h * 2.5;
}

/**
 * ラベル行と金額行が「同一行の関連付け」とみなせるか。
 * 垂直方向で同一行であることに加え、金額行はラベル行の右側にあることを要求する
 * (同じOcrLine内にラベルと金額が同居する場合はX座標条件を課さない)。
 */
function labelAssociates(label: OcrLine, amountLine: OcrLine): boolean {
  if (!sameRow(label, amountLine)) return false;
  if (label === amountLine) return true;
  return amountLine.box.x >= label.box.x + label.box.width - 8;
}

/**
 * lineと同一行関連付け(labelAssociates)可能な強ラベルのうち、
 * 水平方向の距離が最小の(最もlineに近い)ものを選ぶ。
 * 複数の強ラベル行が候補になり得る場合に、配列順ではなく幾何的な近さで
 * 対応する強ラベル行(confidenceゲートの対象)を決定するため。
 */
function nearestStrongSameRow(line: OcrLine, strongLines: OcrLine[]): OcrLine | undefined {
  let best: OcrLine | undefined;
  let bestGap = Infinity;
  for (const s of strongLines) {
    if (!labelAssociates(s, line)) continue;
    const gap = s === line ? -Infinity : line.box.x - (s.box.x + s.box.width);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  return best;
}

/**
 * lineの直下(isJustBelow)にある強ラベルのうち、Y方向の距離が最小の
 * (最もlineに近い)ものを選ぶ。理由はnearestStrongSameRowと同様。
 */
function nearestStrongAbove(line: OcrLine, strongLines: OcrLine[]): OcrLine | undefined {
  let best: OcrLine | undefined;
  let bestDy = Infinity;
  for (const s of strongLines) {
    if (!isJustBelow(s, line)) continue;
    const dy = line.box.y - s.box.y;
    if (dy < bestDy) {
      bestDy = dy;
      best = s;
    }
  }
  return best;
}

/** strongとtargetのY方向の間(読み順で挟まれる位置)に除外ラベル行が存在するか */
function hasRejectBetween(strong: OcrLine, target: OcrLine, rejectLines: OcrLine[]): boolean {
  const lo = Math.min(strong.box.y, target.box.y);
  const hi = Math.max(strong.box.y, target.box.y);
  return rejectLines.some((r) => r.box.y > lo && r.box.y < hi);
}

/**
 * targetが、strongより下(Y方向で正の距離)にある金額行の中で
 * 最もY方向に近い(直下最近傍の)ものであるか。
 * 判定対象はisJustBelowの0.5〜2.5倍窓に絞らず全金額行とする
 * (窓の下限より近い金額行が「もっと近い金額行」として存在する場合に、
 * 窓内の遠い金額行を誤って最近傍と判定しないため)。
 */
function isNearestBelowMoneyLine(strong: OcrLine, target: OcrLine, moneyLines: OcrLine[]): boolean {
  const targetDy = target.box.y - strong.box.y;
  if (targetDy <= 0) return false;
  return !moneyLines.some((l) => {
    if (l === target) return false;
    const dy = l.box.y - strong.box.y;
    return dy > 0 && dy <= targetDy; // 同距離のタイも曖昧とみなしブロックする
  });
}

export function extractTotal(lines: OcrLine[]): ExtractResult {
  if (lines.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  const minY = Math.min(...lines.map((l) => l.box.y));
  const maxY = Math.max(...lines.map((l) => l.box.y + l.box.height));
  const midY = minY + (maxY - minY) / 2;
  const norm = (t: string) => t.normalize("NFKC");
  const strongLines = lines.filter((l) => STRONG_LABELS.some((re) => re.test(norm(l.text))));
  const rejectLines = lines.filter((l) => REJECT_LABELS.some((re) => re.test(norm(l.text))));
  const strongSet = new Set(strongLines);
  const rejectSet = new Set(rejectLines);
  const moneyLines = lines.filter((l) => findMoneyTokens(l.text).length > 0);

  const raw: RawCandidate[] = [];
  for (const line of lines) {
    const tokens = findMoneyTokens(line.text);
    if (tokens.length === 0) continue;

    let strongSource: OcrLine | undefined = nearestStrongSameRow(line, strongLines);
    let viaBelowStrong = false;
    if (strongSource === undefined) {
      strongSource = nearestStrongAbove(line, strongLines);
      viaBelowStrong = strongSource !== undefined;
    }
    if (strongSource === undefined) continue;
    const nearStrong = !viaBelowStrong;

    // 除外ラベルとの同一行判定。ただし自分自身(line)が強ラベルでもある場合、
    // 自分自身との一致だけでは減点しない(強ラベル+除外語の同居はsameLineBlockedで扱う)。
    const nearReject = rejectLines.some(
      (r) => sameRow(r, line) && !(r === line && strongSet.has(line)),
    );

    const sameLineBlocked =
      (strongSet.has(line) && rejectSet.has(line)) || rejectSet.has(strongSource) || tokens.length > 1;

    let score = 0;
    if (nearStrong) score += 50;
    else score += 40; // belowStrong
    if (nearReject) score -= 100;
    if (line.box.y > midY) score += 5; // レシート下半分(minY〜maxYの中点より下)
    if (/[¥￥円]/.test(norm(line.text))) score += 10;
    score += Math.round(line.confidence * 10);

    if (score <= 0) continue;

    for (const amountYen of tokens) {
      raw.push({ amountYen, score, line, strongSource, viaBelowStrong, sameLineBlocked });
    }
  }

  if (raw.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  // 同額候補は最大スコアを保持してから降順ソート
  // (ソート後にMapへ詰めるだけだと後勝ちで低スコアが残ってしまうバグを回避)
  const bestByAmount = new Map<number, RawCandidate>();
  for (const r of raw) {
    const current = bestByAmount.get(r.amountYen);
    if (current === undefined || r.score > current.score) bestByAmount.set(r.amountYen, r);
  }
  const unique = [...bestByAmount.values()].sort((a, b) => b.score - a.score);

  const top = unique[0];
  const second = unique[1];
  const marginConfident = top.score >= 60 && (second === undefined || top.score - second.score >= 20);

  let eligible =
    !top.sameLineBlocked &&
    top.line.confidence >= AUTO_HIGH_MIN_CONFIDENCE &&
    top.strongSource.confidence >= AUTO_HIGH_MIN_CONFIDENCE;

  if (eligible && top.viaBelowStrong) {
    // belowStrong経路の安全化: 除外ラベルが間に挟まらない・直下最近傍である・
    // 競合する正スコア候補がゼロ、の3条件をすべて満たす場合のみauto-high対象にする
    const noRejectBetween = !hasRejectBetween(top.strongSource, top.line, rejectLines);
    const isNearest = isNearestBelowMoneyLine(top.strongSource, top.line, moneyLines);
    const noCompetition = unique.length === 1;
    eligible = noRejectBetween && isNearest && noCompetition;
  }

  return {
    amountYen: top.amountYen,
    status: marginConfident && eligible ? "auto-high" : "needs-review",
    candidates: unique.slice(0, 3).map((c) => c.amountYen),
  };
}
