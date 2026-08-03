import type { OcrLine } from "../ocr/engine";
import { findMoneyTokens } from "./normalize";

export type ExtractResult = {
  amountYen: number | null;
  status: "auto-high" | "needs-review" | "failed";
  candidates: number[];
};

/**
 * ラベル行の一致種別(Codexレビュー指摘I3)。
 *
 * - `exact`: `STRONG_LABELS`に完全一致(「合計」「お会計」等)。
 * - `corrupted`: `STRONG_LABEL_CORRUPTED_VARIANTS`に一致する観測済みの字形崩れ
 *   (「含計」「台計」等)。スコアは`exact`と同じ(+50/+40)だが、auto-highの対象には
 *   ならない(下記`eligible`判定を参照)。
 * - `fuzzy`: `isWeakLabelLine`が真になる弱ラベル(「合」単独)。スコアが低く抑えられ、
 *   auto-highの対象にもならない。
 */
type LabelKind = "exact" | "corrupted" | "fuzzy";

// task-25追記: `STRONG_LABELS`/`STRONG_LABEL_CORRUPTED_VARIANTS`/
// `STRONG_LABEL_CORRUPTED_VARIANTS_NO_TORI`/`REJECT_LABELS`は
// `src/extract/extractTotalFromText.ts`(iPhone Live Text連携のテキスト行モード抽出)からも
// そのままimportして再利用する。box座標に依存しないキーワード集合そのものは共有すべきで、
// 別ファイルへ複製すると「合計」の崩れバリアント等の知見(調査で観測済みの実データ由来)が
// 二重管理になり将来の追記が食い違う恐れがあるため、ここでexportして一次ソースを1箇所に保つ。
export const STRONG_LABELS = [
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
 *
 * ただし、字形崩れである以上「合計」以外の語を誤って拾っている可能性を完全には
 * 排除できないため、auto-highへの自動確定は許可しない(Codexレビュー指摘I3)。
 * 通貨記号すら不要な入力(例:「台計」+「3」)で60点に達し得ることが判明したため、
 * `LabelKind`を`exact`/`corrupted`/`fuzzy`に分離し、`eligible`判定で`exact`のみを
 * auto-high対象にする安全弁を設けた。`failed → needs-review`の回復効果自体は
 * auto-highを許可しなくても維持される。
 *
 * task-20追記: 実写真(`real-photos/IMG_0201.jpeg`)3領域のper-region OCR実測
 * (`.superpowers/sdd/task-20-report.md`)で新たに観測した「合計」の崩れ「今計」
 * (task-19調査で観測、本タスクでは別OCR実行での再現はしていないが同一写真・同一
 * パイプラインでの既存観測のため採用)・「合十」(本タスクで3回連続再現)を追加。
 *
 * Codexレビュー(task-20)指摘: 単純な部分一致だと「只今計算中」が「今計」を
 * 部分文字列として含んでしまい誤爆する(実際に`/今計/.test("只今計算中")`が
 * `true`になることを確認済み)。そのため`^\s*`で行頭アンカーし、直後は
 * 行末か「(:|：)?空白?金額らしき文字」に限定した(下記`STRONG_LABEL_CORRUPTED_VARIANTS_NO_TORI`
 * と同じ考え方)。既存4バリアント(含計/合针/合计/台計)は前回タスクで既にレビュー済みの
 * ためアンカー化は本タスクのスコープ外とし、新規追加分のみ対象にした。
 */
export const STRONG_LABEL_CORRUPTED_VARIANTS = [
  /含計/,
  /合针/,
  /合计/,
  /台計/,
  /^\s*(?:今計|合十)(?=\s*(?:$|[:：]?\s*[¥￥\d]))/,
];

/**
 * task-20追記: 「取引金額」(クレジット売上票で頻出するラベル)が、先頭の「取」が
 * 脱落して「引金額」/「引金额」(簡体字寄りの字形)に崩れるパターン
 * (`.superpowers/sdd/task-20-report.md`実測、`real-photos/IMG_0201.jpeg`左領域で
 * 3回連続再現)。
 *
 * 正しくOCRできた「取引金額」自体は意図的に**含めない**。実測で、同一写真の別領域
 * (右領域)に「取引金額」という**正しい**ラベルが、断片的にしか読めなかった金額
 * (「¥3」、おそらく「¥3,684」の読み取り欠損)と同じ行に存在するケースを確認した。
 * `src/ocr/queue.ts`の`runOcrPipeline`内のリトライ判定は`STATUS_RANK`
 * (failed<needs-review<auto-high)で「同ランクへの遷移では上書きしない」設計のため、
 * 1回目の認識で「取引金額」をラベルとして許可してしまうと、1回目の(誤った値のままの)
 * needs-reviewがqueueの最終結果として採用されてしまい(UI上はneeds-reviewとして
 * 要確認表示になるだけで、auto-highのように自動確定するわけではないが、2回目
 * (コントラスト強調再試行)で正しい合計(「合十」経由)が取れていても
 * needs-review→needs-reviewの同ランクなので採用されない)。つまり「正しくOCRできた
 * 取引金額」を安易にラベルとして許可すると、かえって同一写真の別領域を退行させる。
 * このため「取」が脱落した崩れ形のみを対象にし、正しい「取引金額」はスコープ外として
 * 見送った(既存の安全弁と同じ考え方: 疑わしきは対象を狭める)。
 *
 * Codexレビュー(task-20)指摘: 当初は否定後読み`/(?<!取)引金[額额]/`だったが、
 * 「値引金額」「割引金額」「代引金額」のような無関係語にも「引金額」が部分文字列として
 * 含まれてしまい誤爆することが判明した(実際に`/(?<!取)引金[額额]/.test("値引金額")`が
 * `true`になることを確認済み。なお「値引|割引」はREJECT_LABELSに含まれるが、
 * `corruptedLines`の判定はREJECT_LABELSを見ないため無防備だった)。行頭アンカー
 * (`^\s*`)に変更することで、この問題と「取引金額」除外の両方を同時に解決した
 * (「引金額」が行の**先頭**に来るのは「取」が脱落した崩れ形だけであり、「値引金額」
 * 「取引金額」はどちらも「引金額」が行の途中から始まるため`^`に一致しない)。
 * 副次的に否定後読み自体が不要になった(古いJS実行環境での対応状況を気にしなくて済む)。
 * 「取 引金額」のように空白で分割された崩れ方(境界ケース)は本パターンでは
 * 引き続き検出できない(スコープ外、安全側に倒れるだけなので実害はない)。
 */
export const STRONG_LABEL_CORRUPTED_VARIANTS_NO_TORI = [/^\s*引金[額额](?=\s*(?:$|[:：]?\s*[¥￥\d]))/];

export const REJECT_LABELS = [
  /小計/,
  /(?:8|10)\s*%対象/,
  /課税対象/,
  /消費税|内税|外税|税額|税率|税抜/,
  /預り|釣り?銭?|お釣/,
  /現金|クレジット|電子マネー|ポイント|残高/,
  /値引|割引/,
  /点数|電話|伝票/,
];

/** auto-highに要求する最低confidence(金額行・対応する強ラベル行の両方に適用) */
const AUTO_HIGH_MIN_CONFIDENCE = 0.9;

/**
 * [仮説A]段階2: 「合」の単独文字(「合計」の2文字目「計」が実機で脱落した崩れ、調査
 * Phase1 7.2節の実データで観測済み)のみを、通常より弱い「弱ラベル」として許容するための
 * スコア。
 *
 * 従来は「計」単独、および短い行(3文字以下)限定で「合計」への編集距離1以内のゆるい
 * 照合も許容していたが、Codexレビュー指摘I2により廃止した。「計」は「3点計」のような
 * 数量表記の一部としても頻出する一般的な1文字で、OCRが2boxへ分割すると無関係な数量
 * (例:「計」+「3点」)を金額候補へ格上げしてしまう。編集距離1のゆるい照合も
 * 「累計」「商品計」のような一般語まで拾ってしまうため、実機で実際に観測された
 * 「合」の単独脱落だけを許可する。
 *
 * 弱ラベル経由で到達しうる最大スコアは
 * `WEAK_LABEL_NEAR_SCORE(20) + 円記号(10) + 位置ボーナス(5) + confidence満点(10) = 45`で、
 * `marginConfident`が要求する`top.score >= 60`を**構造的に満たせない**(45 < 60、調査で
 * 数学的に検証済み)。つまり弱ラベル単独が根拠の候補は、下記`isWeakLabelLine`による
 * 明示的な安全弁が無くてもスコア設計上auto-highになり得ない。ただし「スコア式が将来
 * 変わった場合にも壊れない明示的な不変条件」として、下記`eligible`判定でも弱ラベル経由を
 * 明示的にauto-high対象外にする(調査レポート推奨の安全弁、暗黙の偶然の安全性に
 * 依存しない設計)。
 *
 * 加えて、弱ラベル経由の金額候補は通貨表記(¥/￥/円)を必須とする(Codexレビュー指摘I2)。
 * `findMoneyTokens`はカンマ/円記号なしの裸の数字(「3点」の「3」等)もトークンとして
 * 拾うため、通貨表記がない場合は弱ラベルとの関連付け自体を無効にし、「計 3点」のような
 * 一般的な数量表記が金額候補へ紛れ込むのを防ぐ。
 */
const WEAK_LABEL_NEAR_SCORE = 20;
const WEAK_LABEL_BELOW_SCORE = 15;

/**
 * [仮説A]段階2。「合」の単独脱落として弱ラベル扱いする行か。
 *
 * 安全弁(調査Phase3仮説A「fuzzyExcludeRejectMatches」相当): REJECT_LABELSに一致する
 * 行は弱ラベルとして扱わない。
 *
 * task-20追記: 「金額」(2文字、実測`.superpowers/sdd/task-20-report.md`
 * `real-photos/IMG_0201.jpeg`中央領域、3回連続再現)も弱ラベルとして追加した。
 * こちらは「合」と異なりOCRの字形崩れではなく、レシートに実際に印字されている
 * 汎用ラベル(Codexレビュー指摘、task-20)。「金額」単独は品名/単価/金額のような
 * 明細の**列見出し**としても頻出するため(STRONG_LABELSに含めない既存判断の理由
 * そのもの)、既存の「合」弱ラベルと全く同じ安全弁(通貨表記必須・REJECT_LABELS
 * 同居行を除外・スコア上限45点でauto-highの60点に構造的に届かない)をそのまま適用する。
 * 敵対テスト(列見出し「金額」+明細行の下で、離れた場所に本物の「合計」がある
 * ケース、および「税抜」+「金額」に分割されたOCR行のケース。後者はREJECT_LABELSへ
 * 「税抜」を追加して防いだ)で、本物の合計を「金額」経由の候補が上書きしないことを
 * 確認済み(`extractTotal.test.ts`)。
 *
 * 既知の残存リスク(Codexレビュー指摘、task-20): 「金額」経由の弱ラベル候補が
 * 1回目の認識で誤った値のneeds-reviewを作ってしまうと、`src/ocr/queue.ts`の
 * `STATUS_RANK`同ランク非上書き設計により、2回目の再試行で正しい合計が取れても
 * 採用されない可能性が理論上ある。ただしこれは「金額」固有の新規リスクではなく、
 * 既存の「合」弱ラベル・既存の字形崩れ4バリアントにも同様に当てはまる、この
 * 弱ラベル/corrupted設計全体に元々内在するトレードオフである。queue.ts側の
 * リトライ判定をラベル品質(exact/corrupted/fuzzyの強さ)まで見て同ランク内でも
 * 更新するよう拡張する対応は本タスクのスコープ外として見送った(詳細は
 * `.superpowers/sdd/task-20-report.md`の懸念点を参照)。
 */
function isWeakLabelLine(normalizedText: string): boolean {
  const t = normalizedText.trim();
  if (t.length === 0) return false;
  if (REJECT_LABELS.some((re) => re.test(t))) return false;
  return t === "合" || t === "金額"; // 実機で観測済みの脱落(合)・実在ラベル(金額)のみ許可(Codexレビュー指摘I2、task-20)
}

type RawCandidate = {
  amountYen: number;
  score: number;
  line: OcrLine;
  /** このスコアの根拠になった強ラベル行 */
  strongSource: OcrLine;
  /** strongSourceの一致種別(Codexレビュー指摘I3)。auto-high可否は`exact`のみ許可する。 */
  labelKind: LabelKind;
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
  // ラベル種別(Codexレビュー指摘I3)を排他的に判定する: exact優先、次にcorrupted、
  // どちらでもない場合のみ弱ラベル(fuzzy)候補になり得る。
  const exactLines = lines.filter((l) => STRONG_LABELS.some((re) => re.test(norm(l.text))));
  const exactSet = new Set(exactLines);
  const corruptedLines = lines.filter(
    (l) =>
      !exactSet.has(l) &&
      (STRONG_LABEL_CORRUPTED_VARIANTS.some((re) => re.test(norm(l.text))) ||
        STRONG_LABEL_CORRUPTED_VARIANTS_NO_TORI.some((re) => re.test(norm(l.text)))),
  );
  const corruptedSet = new Set(corruptedLines);
  const rejectLines = lines.filter((l) => REJECT_LABELS.some((re) => re.test(norm(l.text))));
  const strongLines = [...exactLines, ...corruptedLines];
  const strongSet = new Set(strongLines);
  const rejectSet = new Set(rejectLines);
  // [仮説A]段階2: 強ラベル(exact/corrupted)に一致しなかった行のうち、弱ラベル(「合」単独)に
  // 該当するものを別途集める。同一行判定(nearestStrongSameRow/Above)は強・弱を区別せず
  // 幾何的な近さで選ぶため、両方を1つのプールとして渡す(強弱の判定はスコア計算時に
  // `labelKindOf(strongSource)`で行う)。
  const weakLines = lines.filter((l) => !strongSet.has(l) && isWeakLabelLine(norm(l.text)));
  const labelLines = [...strongLines, ...weakLines];
  const moneyLines = lines.filter((l) => findMoneyTokens(l.text).length > 0);

  function labelKindOf(l: OcrLine): LabelKind {
    if (exactSet.has(l)) return "exact";
    if (corruptedSet.has(l)) return "corrupted";
    return "fuzzy";
  }

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
    const labelKind = labelKindOf(strongSource);
    const isWeakSource = labelKind === "fuzzy";

    // [仮説A]弱ラベル経由の金額候補は通貨表記(¥/￥/円)を必須にする(Codexレビュー指摘I2)。
    // `findMoneyTokens`は裸の数字("3点"の"3"等)も拾うため、通貨表記がなければ弱ラベルとの
    // 関連付け自体を無効にする(この行はcontinueで丸ごとスキップする)。
    if (isWeakSource && !/[¥￥円]/.test(norm(line.text))) continue;

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
      raw.push({ amountYen, score, line, strongSource, labelKind, viaBelowStrong, sameLineBlocked });
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
    // [仮説A]安全弁 + Codexレビュー指摘I3: auto-highの対象は`exact`(完全一致の強ラベル)
    // 経由の候補のみに限定する。弱ラベル(fuzzy)はスコア設計上45<60で既に到達不能だが、
    // 将来スコア式が変わっても壊れない不変条件として明示する(調査レポート推奨)。
    // `corrupted`(字形崩れバリアント)は`exact`と同じスコアで60点に到達しうる
    // (例:「台計」+ 通貨表記なしの数字で60点)ため、明示的に対象外にする必要がある
    // ("failed → needs-review"の回復効果自体はauto-highを許可しなくても維持される)。
    top.labelKind === "exact" &&
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
