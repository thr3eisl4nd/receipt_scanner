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

/**
 * [仮説A]段階1: 実機OCR調査(`.superpowers/sdd/ocr-investigation.md` Phase1 7.2/7.3節)で
 * 実際に観測された「合計」の字形崩れバリアント。感熱紙の低コントラスト・回転・ブラー等の
 * 劣化により「合計」の2文字が字形の近い別文字へ誤認識されるパターンで、いずれも
 * 特徴的な2文字の並びのため無関係な語との誤爆リスクが低い。通常のSTRONG_LABELSと
 * 完全に同じスコア(+50/+40)で扱ってよいと調査で判断された(Phase3仮説A考察: A1構成で
 * 既存回帰・敵対的ケースともに安全性を確認済み)。
 */
const STRONG_LABEL_CORRUPTED_VARIANTS = [/含計/, /合针/, /合计/, /台計/];

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

/**
 * [仮説A]段階2+3: 「合」「計」の単独文字、および短い行(3文字以下)限定の編集距離1以内の
 * ゆるい照合を、通常より弱い「弱ラベル」として許容するためのスコア(調査由来、
 * Phase3仮説A)。
 *
 * 弱ラベル経由で到達しうる最大スコアは
 * `WEAK_LABEL_NEAR_SCORE(20) + 円記号(10) + 位置ボーナス(5) + confidence満点(10) = 45`で、
 * `marginConfident`が要求する`top.score >= 60`を**構造的に満たせない**(45 < 60、調査で
 * 数学的に検証済み)。つまり弱ラベル単独が根拠の候補は、下記`isWeakLabelLine`による
 * 明示的な安全弁が無くてもスコア設計上auto-highになり得ない。ただし「スコア式が将来
 * 変わった場合にも壊れない明示的な不変条件」として、下記`eligible`判定でも弱ラベル経由を
 * 明示的にauto-high対象外にする(調査レポート推奨の安全弁、暗黙の偶然の安全性に
 * 依存しない設計)。
 */
const WEAK_LABEL_NEAR_SCORE = 20;
const WEAK_LABEL_BELOW_SCORE = 15;

/** 「合計」に対する編集距離1以内のゆるい照合を許容する対象文字列(段階3)。 */
const FUZZY_WEAK_TARGET = "合計";
/** ゆるい照合の対象を誤爆が起きやすい長い行へ広げないための文字数上限。 */
const FUZZY_WEAK_MAX_LENGTH = 3;

/** レーベンシュタイン距離。短い文字列(FUZZY_WEAK_MAX_LENGTH以下)専用のため素朴なDPで十分。 */
function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * [仮説A]段階2(単独文字)+段階3(ゆるい照合)。「合計」の崩れとして弱ラベル扱いする行か。
 *
 * 安全弁(調査Phase3仮説A「fuzzyExcludeRejectMatches」相当): REJECT_LABELS
 * (「小計」等)に一致する行は、編集距離が近くても弱ラベルとして扱わない。
 * 「小計」は「合計」と編集距離1(調査で使った敵対的ケース: 合計ラベルが完全消失し
 * 小計だけが残るケース)だが、REJECT_LABELSとの同一行ペナルティ(-100)を弱ラベル
 * 経由で回避されると誤爆に繋がりうるため明示的に除外する。
 */
function isWeakLabelLine(normalizedText: string): boolean {
  const t = normalizedText.trim();
  if (t.length === 0) return false;
  if (REJECT_LABELS.some((re) => re.test(t))) return false;
  if (t === "合" || t === "計") return true;
  if (t.length <= FUZZY_WEAK_MAX_LENGTH && levenshteinDistance(t, FUZZY_WEAK_TARGET) <= 1) return true;
  return false;
}

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
  const strongLines = lines.filter(
    (l) =>
      STRONG_LABELS.some((re) => re.test(norm(l.text))) ||
      STRONG_LABEL_CORRUPTED_VARIANTS.some((re) => re.test(norm(l.text))),
  );
  const rejectLines = lines.filter((l) => REJECT_LABELS.some((re) => re.test(norm(l.text))));
  const strongSet = new Set(strongLines);
  const rejectSet = new Set(rejectLines);
  // [仮説A]段階2/3: 強ラベルに一致しなかった行のうち、弱ラベル(単独文字/ゆるい照合)に
  // 該当するものを別途集める。同一行判定(nearestStrongSameRow/Above)は強・弱を区別せず
  // 幾何的な近さで選ぶため、両方を1つのプールとして渡す(強弱の判定はスコア計算時に
  // `weakSet.has(strongSource)`で行う)。
  const weakLines = lines.filter((l) => !strongSet.has(l) && isWeakLabelLine(norm(l.text)));
  const weakSet = new Set(weakLines);
  const labelLines = [...strongLines, ...weakLines];
  const moneyLines = lines.filter((l) => findMoneyTokens(l.text).length > 0);

  const raw: RawCandidate[] = [];
  for (const line of lines) {
    const tokens = findMoneyTokens(line.text);
    if (tokens.length === 0) continue;

    let strongSource: OcrLine | undefined = nearestStrongSameRow(line, labelLines);
    let viaBelowStrong = false;
    if (strongSource === undefined) {
      strongSource = nearestStrongAbove(line, labelLines);
      viaBelowStrong = strongSource !== undefined;
    }
    if (strongSource === undefined) continue;
    const nearStrong = !viaBelowStrong;
    const isWeakSource = weakSet.has(strongSource);

    // 除外ラベルとの同一行判定。ただし自分自身(line)が強ラベルでもある場合、
    // 自分自身との一致だけでは減点しない(強ラベル+除外語の同居はsameLineBlockedで扱う)。
    const nearReject = rejectLines.some(
      (r) => sameRow(r, line) && !(r === line && strongSet.has(line)),
    );

    const sameLineBlocked =
      (strongSet.has(line) && rejectSet.has(line)) || rejectSet.has(strongSource) || tokens.length > 1;

    let score = 0;
    if (isWeakSource) {
      // [仮説A]弱ラベル経由: 通常より弱いスコア(WEAK_LABEL_NEAR_SCORE/BELOW_SCORE定義部の
      // コメント参照。数学的にauto-highの60点に届かない)。
      score += nearStrong ? WEAK_LABEL_NEAR_SCORE : WEAK_LABEL_BELOW_SCORE;
    } else if (nearStrong) {
      score += 50;
    } else {
      score += 40; // belowStrong
    }
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
    // [仮説A]安全弁: 弱ラベル(単独文字/ゆるい照合)経由の候補は明示的にauto-high対象外にする。
    // スコア設計上45<60で既に到達不能だが、将来スコア式が変わっても壊れない不変条件として
    // 明示する(調査レポート推奨)。
    !weakSet.has(top.strongSource) &&
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
