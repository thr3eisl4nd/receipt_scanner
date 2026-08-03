import { findMoneyTokens } from "./normalize";
import {
  STRONG_LABELS,
  STRONG_LABEL_CORRUPTED_VARIANTS,
  STRONG_LABEL_CORRUPTED_VARIANTS_NO_TORI,
  REJECT_LABELS,
  type ExtractResult,
} from "./extractTotal";

/**
 * iPhone Live Text(写真アプリ「テキストをコピー」/ショートカット「画像からテキストを
 * 抽出」)で得たプレーンテキストから合計金額を抽出する、テキスト行モードの抽出
 * (task-25、設計ドキュメント§18)。
 *
 * `extractTotal`(box座標モード)とラベル/除外語のキーワード集合(`STRONG_LABELS`等、
 * `./extractTotal`からimportして再利用する)・金額トークン抽出(`findMoneyTokens`、
 * 円整数化・上限MAX_YEN・負数▲の各ルールを含む)を共有しつつ、判定根拠をbox座標を
 * 使わない2パターンに単純化する:
 *
 * 1. 「同一テキスト行内のラベル+金額」(例: "合計 ¥1,332")
 * 2. 「ラベル行の直後の1行の金額」(例: "ご請求額" の次の行が "¥3,980")
 *
 * Live Textはbox座標モードのOCRに比べて字形崩れ・断片化が少ない前提(タスク仕様)だが、
 * 安全設計(auto-high/needs-review/failedの3段構え)は同様に維持する:
 * - 明確な強ラベル(`STRONG_LABELS`完全一致)+金額が一意に対応 → `auto-high`
 * - ラベルの崩れバリアント一致・除外語との同居・複数候補の拮抗等の曖昧なケース →
 *   `needs-review`(候補付き、ユーザーが選べる)
 * - ラベルが一切見つからない → `failed`(UI側の既存の「金額を入力」導線で手入力する)
 */

type LabelKind = "exact" | "corrupted";

type Candidate = {
  amountYen: number;
  score: number;
  labelKind: LabelKind;
  viaBelowStrong: boolean;
  sameLineBlocked: boolean;
};

/** 同一行内(ラベルと金額が同じ行)の基礎スコア。box座標モードのnearStrongに相当。 */
const NEAR_SCORE = 50;
/** ラベル行の直後行(box座標モードのbelowStrongに相当)の基礎スコア。 */
const BELOW_SCORE = 40;
/** 通貨記号(¥/￥/円)が行内にあれば加点。 */
const CURRENCY_BONUS = 10;
/** auto-highに要求する最低スコア。 */
const AUTO_HIGH_MIN_SCORE = 50;

function normalize(t: string): string {
  return t.normalize("NFKC");
}

/** テキストが`STRONG_LABELS`(完全一致)/崩れバリアントのいずれに一致するか。どちらでもなければnull。 */
function labelKindOf(text: string): LabelKind | null {
  if (STRONG_LABELS.some((re) => re.test(text))) return "exact";
  if (
    STRONG_LABEL_CORRUPTED_VARIANTS.some((re) => re.test(text)) ||
    STRONG_LABEL_CORRUPTED_VARIANTS_NO_TORI.some((re) => re.test(text))
  ) {
    return "corrupted";
  }
  return null;
}

function isRejectLine(text: string): boolean {
  return REJECT_LABELS.some((re) => re.test(text));
}

/**
 * 行のテキストが「金額だけ(前後の空白・任意の桁区切り・¥/円・末尾ハイフンのみ)」で
 * 構成されているか(Codexレビュー指摘、task-25)。
 *
 * ラベル行の直後行を金額とみなす(viaBelowStrong)際、この判定を経ずに「行に金額
 * トークンが1つある」というだけで結び付けると、「合計」の直後にたまたま明細行
 * (例:「商品A ¥100」)が続くケースまで合計として誤って自動確定してしまう
 * (実際にCodexレビューで再現された穴)。ラベル直後の行が本当に金額単体の行である
 * 場合のみ、直後行経由をauto-high対象にする(それ以外はneeds-reviewへ落とす、
 * 安全側の設計)。
 */
function isStandaloneMoneyLine(text: string): boolean {
  return /^[▲-]?[¥￥]?[0-9OoIl|,]+円?[-ー−]?$/.test(text.trim());
}

export function extractTotalFromText(text: string): ExtractResult {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => normalize(l).trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  const candidates: Candidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const tokens = findMoneyTokens(t);
    if (tokens.length === 0) continue;

    const selfKind = labelKindOf(t);
    let kind: LabelKind | null;
    let viaBelowStrong: boolean;
    /** このスコアの根拠になった行のテキスト(sameLineBlocked判定用)。 */
    let sourceText: string;

    if (selfKind !== null) {
      // 同一行にラベルと金額が同居する(通貨表記の要否を問わない、box座標モードの
      // nearStrongに相当)。除外語(内税等)が同じ行に同居していても、ラベル一致自体は
      // 優先し、以下のsameLineBlockedでauto-high可否だけを絞る
      // (box座標モードの「合計 ¥1,100 内税 ¥100」テストと同じ設計)。
      kind = selfKind;
      viaBelowStrong = false;
      sourceText = t;
    } else {
      // 自分の行がラベルではない場合、除外語(小計/お預り/電話番号等)一致行は
      // ラベルとの結びつけ自体を一切試みない(タスク仕様の敵対ケース対策: 除外語のみの
      // 行の金額は、直上に強ラベルがあってもauto-highはおろかneeds-reviewの候補にも
      // 一切浮上させない、box座標モードのnearRejectより厳格な安全側の設計)。
      if (isRejectLine(t)) continue;

      const prev = i > 0 ? lines[i - 1] : null;
      const prevKind = prev !== null ? labelKindOf(prev) : null;
      if (prevKind === null) continue; // 直前行もラベルでなければ対応する強ラベルなし

      kind = prevKind;
      viaBelowStrong = true;
      sourceText = prev as string;
    }

    // sameLineBlocked: ラベルの根拠行(sourceText)自身が除外語とも同居している場合
    // (box座標モードの`rejectSet.has(strongSource)`に相当)、1行に金額が複数ある場合、
    // または直後行経由(viaBelowStrong)なのに金額行自体が金額単体ではない場合
    // (Codexレビュー指摘: 「合計」の直後に明細行が続くケースの誤自動確定を防ぐ)。
    const sameLineBlocked =
      isRejectLine(sourceText) || tokens.length > 1 || (viaBelowStrong && !isStandaloneMoneyLine(t));

    let score = viaBelowStrong ? BELOW_SCORE : NEAR_SCORE;
    if (/[¥￥円]/.test(t)) score += CURRENCY_BONUS;

    for (const amountYen of tokens) {
      candidates.push({ amountYen, score, labelKind: kind, viaBelowStrong, sameLineBlocked });
    }
  }

  if (candidates.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  // 同額候補は最大スコアを保持する(`extractTotal`と同じ、後勝ちで低スコアが残る事故を回避)。
  const bestByAmount = new Map<number, Candidate>();
  for (const c of candidates) {
    const current = bestByAmount.get(c.amountYen);
    if (current === undefined || c.score > current.score) bestByAmount.set(c.amountYen, c);
  }
  const unique = [...bestByAmount.values()].sort((a, b) => b.score - a.score);
  const top = unique[0];

  const eligible =
    !top.sameLineBlocked &&
    // 崩れバリアント(corrupted)はexactと同じスコアになりうるが、字形崩れである以上
    // 「合計」以外を誤って拾っている可能性を排除できないためauto-highの対象外にする
    // (`extractTotal`のCodexレビュー指摘I3と同じ安全弁)。
    top.labelKind === "exact" &&
    top.score >= AUTO_HIGH_MIN_SCORE &&
    // 異なる強ラベルがそれぞれ異なる金額を主張する等、候補が複数ある時点で「一意に
    // 対応する」とは言えないためauto-high対象外にする(Codexレビュー指摘: スコア差
    // だけで自動確定していると、「合計 ¥1,000」と「ご請求額\n900」のように異なる
    // 強ラベル由来の異なる金額が競合してもauto-highになってしまっていた)。
    unique.length === 1;

  return {
    amountYen: top.amountYen,
    status: eligible ? "auto-high" : "needs-review",
    candidates: unique.slice(0, 3).map((c) => c.amountYen),
  };
}
