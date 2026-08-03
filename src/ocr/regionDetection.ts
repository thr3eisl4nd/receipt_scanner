/**
 * 再帰XY-cut(v1.3、複数レシート自動分割の領域検出)。
 *
 * 設計ドキュメント `docs/superpowers/specs/2026-07-27-receipt-scanner-design.md`
 * §16.2(領域検出アルゴリズム)・§16.3(LayoutDecision)の実装。
 *
 * 検証スパイク `scripts/xycut.ts`(`.superpowers/sdd/v13-spike.md`)からの移植。
 * 模擬マルチレシート写真12枚(6配置×2背景)で正解率10/12(83.3%)・誤結合0件を確認済み
 * (詳細・閾値調整の経緯はスパイクレポート参照)。ロジック・閾値・コメントはスパイク版を
 * そのまま採用しており、外部ライブラリに依存しない純粋関数のみで構成される。
 */
import type { OcrBox } from "./engine";

/** 検出済み文字box(`OcrEngine.detect()` の1要素、または本ファイル内でのマージ後の行box)。 */
export type Box = OcrBox;

/** XY-cutが最終的に切り出した1領域。中に含まれる行box群も保持する(精度計測・デバッグ用)。 */
export type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
  boxes: Box[];
};

/** §16.3のLayoutDecision型(設計ドキュメントの定義そのまま)。 */
export type LayoutDecision =
  | { kind: "single"; confidence: "certain"; region: Region }
  | { kind: "multiple"; confidence: "certain"; regions: Region[] }
  | { kind: "ambiguous"; fallbackRegion: Region };

/**
 * 閾値一式。§16.2 point4に「閾値は検証スパイク+実写真で調整」とあるため、すべて
 * 呼び出し側から上書き可能にしてある。デフォルト値はスパイクでの調整結果
 * (`.superpowers/sdd/v13-spike.md` 参照)。各フィールドのコメントに出典を明記する。
 */
export type XyCutThresholds = {
  /** §16.2 point1: 同一印字行への結合に要する垂直重なり率の下限。 */
  lineMergeMinVerticalOverlap: number;
  /**
   * §16.2 point1: 同一印字行への結合を許す水平間隔の上限(×中央値行高)。
   *
   * [task-19実写真調査] スパイクの模擬写真では8で誤結合0件だったが、実物写真
   * (レシート3枚を接近させて並べた撮影、詳細は`.superpowers/sdd/task-19-report.md`)
   * では、隣接レシート間の実測ギャップ(ヘッダー行で約290〜360px、中央値行高は
   * 約71px)が8×中央値行高(約570px)を大きく下回り、無関係な別レシートの見出しが
   * 同一「行」として水平結合されてしまうことを確認した。3(中央値行高の3倍、
   * 実測ギャップの下限より十分小さい)へ引き下げても模擬12枚(6配置×2背景)の
   * 精度・誤結合数に変化がないことを確認済み。
   */
  lineMergeMaxHorizontalGapFactor: number;
  /**
   * §16.2 point4: MIN_GUTTERの行高係数(×中央値行高。既定値は下記`DEFAULT_THRESHOLDS`参照。
   * 当初3だったが、task-19実写真調査で2へ引き下げた。理由は下記コメント参照)。
   *
   * [task-19実写真調査] 上記`lineMergeMaxHorizontalGapFactor`引き下げ後も、実物写真の
   * レシート間ギャップ(約214px)が3×中央値行高(約214.2px)とほぼ同値になり、
   * 浮動小数点誤差次第で分割可否が揺れる状態だった。2へ引き下げることで
   * `minGutterLongSideFraction`側の下限(2.5%×長辺)と同水準になり、実測ギャップに対して
   * 安定した余裕(50%程度)を確保できることを確認した。模擬12枚への影響なし
   * (詳細は`.superpowers/sdd/task-19-report.md`)。
   */
  minGutterLineHeightFactor: number;
  /** §16.2 point4: MIN_GUTTERの長辺比率(2.5%×長辺)。 */
  minGutterLongSideFraction: number;
  /** §16.2 point4: MAX_REGIONS(既定8)。 */
  maxRegions: number;
  /** §16.2 point3: 分割採用に要する片側最小box数(既定5)。 */
  minBoxesPerSide: number;
  /** §16.2 point3: 分割採用に要する片側最小の異なるY帯数(既定3)。 */
  minDistinctYBandsPerSide: number;
  /**
   * §16.2 point3「極端な細長でない」の数値化。片側bboxの
   * max(width,height)/min(width,height) がこれを超えたら棄却する。
   * 仕様に具体的数値の指定はないためスパイクで決定した値(調整過程はスパイクレポート参照)。
   */
  maxAspectRatio: number;
  /**
   * §16.2 point3「面積が極小でない」の数値化。片側bboxの面積が、分割前の
   * 親領域bbox面積に対してこの比率未満なら棄却する。仕様に具体的数値の指定はない
   * ためスパイクで決定した値。
   */
  minAreaFraction: number;
  /**
   * §16.3「分割根拠が弱い」の数値化。候補ギャップがMIN_GUTTERのこの倍数未満なら
   * "weak"とみなし、その候補を証拠不十分として除外する(次点候補を試す。全部weak
   * なら分割せずノードを1領域のまま残す。詳細は`findBestSplit`のコメント参照)。
   * 仕様に具体的数値の指定はないためスパイクで決定した値。当初1.5で試したところ、
   * 模擬8枚グリッド写真(実際に2つの別レシートを隔てる正当なY方向ギャップ)を
   * weakとして誤って拒否するケースを実測したため、1.2へ調整した
   * (詳細・調整の経緯は`.superpowers/sdd/v13-spike.md`参照)。
   */
  weakGapMultiplier: number;
  /** §16.2 point5: クロップ余白X(行高係数)。 */
  padXLineHeightFactor: number;
  /** §16.2 point5: クロップ余白X(幅比率、4%)。 */
  padXWidthFraction: number;
  /** §16.2 point5: クロップ余白Y(行高係数)。 */
  padYLineHeightFactor: number;
  /** §16.2 point5: クロップ余白Y(高さ比率、4%)。 */
  padYHeightFraction: number;
  /**
   * [task-19実写真調査] 行マージ前に除外する「異常に高い」生box(検出box)の
   * しきい値(×生box高さ中央値)。`ppu-paddle-ocr`の検出は、レシートの価格列のように
   * 右揃えの数字が行間を詰めて並ぶ領域で、複数行分の高さを1つのboxにまとめて
   * 検出することがある(実測height比で中央値の約7.9〜13倍、aspect比は正方形に近い
   * 1.0〜1.7、通常の横長な文字行boxとは形状が異なる)。このboxは
   * `verticalOverlapRatio`の仕様上、自分の高さの範囲内に収まる無関係な小boxを
   * 次々に「同一行」として巻き込み、本来複数レシートを隔てるはずのX/Y方向ギャップを
   * 消してしまう。生box高さ中央値の6倍を超えるboxは複数行の誤結合とみなし、
   * 行マージの入力から除外する(6は実写真の外れ値(7.9倍以上)と、模擬12枚中
   * `grid-2x4-wood.jpg`に実在する正当な大boxを誤って除外し始める境界(4.5倍以下)との
   * 間の値。詳細は`.superpowers/sdd/task-19-report.md`)。
   */
  oversizedBoxHeightFactor: number;
};

/**
 * スパイクでの調整結果(詳細・調整過程は `.superpowers/sdd/v13-spike.md` 参照)。
 * §16.2に明記された値はそのまま採用し、未規定の値(aspect比・面積比・weak倍率)は
 * 模擬マルチレシート写真での計測により決定した。
 */
export const DEFAULT_THRESHOLDS: XyCutThresholds = {
  lineMergeMinVerticalOverlap: 0.35,
  lineMergeMaxHorizontalGapFactor: 3,
  minGutterLineHeightFactor: 2,
  minGutterLongSideFraction: 0.025,
  maxRegions: 8,
  minBoxesPerSide: 5,
  minDistinctYBandsPerSide: 3,
  maxAspectRatio: 8,
  minAreaFraction: 0.02,
  weakGapMultiplier: 1.2,
  padXLineHeightFactor: 3,
  padXWidthFraction: 0.04,
  padYLineHeightFactor: 4,
  padYHeightFraction: 0.04,
  oversizedBoxHeightFactor: 6,
};

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function bbox(boxes: Box[]): Box {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 垂直方向の重なり率(0〜1)。重なりがなければ0。
 *
 * [task-19実写真調査] 分母には`Math.max(a.height, b.height)`(2boxのうち高い方の
 * 高さ)を使う。当初`Math.min`(低い方の高さ)を使っていたが、これだと「一方の box が
 * 通常の文字行よりはるかに高い(複数行分の高さがある)」場合、重なり量が小さくても
 * 低い方のboxからみた比率だけは高くなり、無関係な小boxを次々「同一行」として
 * 巻き込んでしまう(詳細・実測は`oversizedBoxHeightFactor`のコメント・
 * `.superpowers/sdd/task-19-report.md`参照)。`Math.min`も引数の交換に対しては対称
 * (`verticalOverlapRatio(a,b) === verticalOverlapRatio(b,a)`)だが、`Math.max`に
 * することで「重なり量は、2boxのうち**大きい方**の高さに対して十分な割合を占める」ことを
 * 要求する、より厳しい基準になる。これにより、高さが極端に異なるbox同士(小さい方から
 * 見れば包含されていても、大きい方の全体から見ればごく一部にしか重ならない)が
 * 安易に同一行と判定されにくくなる。模擬12枚
 * (6配置×2背景)への影響はなし(高さがほぼ揃った文字行box同士では
 * `Math.min`と`Math.max`の差が無視できるため)。
 */
function verticalOverlapRatio(a: Box, b: Box): number {
  const aTop = a.y;
  const aBottom = a.y + a.height;
  const bTop = b.y;
  const bBottom = b.y + b.height;
  const overlap = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  if (overlap <= 0) return 0;
  return overlap / Math.max(a.height, b.height);
}

/** 水平方向の間隔(重なっていれば0、離れていれば正の距離)。 */
function horizontalGap(a: Box, b: Box): number {
  const aLeft = a.x;
  const aRight = a.x + a.width;
  const bLeft = b.x;
  const bRight = b.x + b.width;
  if (aRight >= bLeft && bRight >= aLeft) return 0;
  return aRight < bLeft ? bLeft - aRight : aLeft - bRight;
}

/** 水平方向の重なり幅(0以上。重なっていなければ0)。[task-23実機診断調査] */
function horizontalOverlap(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
}

/** 単純なUnion-Find(経路圧縮のみ、ランクなし。box数が数百程度の用途では十分)。 */
function createUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(a: number): number {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  return { find, union };
}

function groupByCluster(boxes: Box[], sameCluster: (a: Box, b: Box) => boolean): Box[][] {
  const uf = createUnionFind(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (sameCluster(boxes[i], boxes[j])) uf.union(i, j);
    }
  }
  const clusters = new Map<number, Box[]>();
  for (let i = 0; i < boxes.length; i++) {
    const root = uf.find(i);
    const list = clusters.get(root);
    if (list) list.push(boxes[i]);
    else clusters.set(root, [boxes[i]]);
  }
  return [...clusters.values()];
}

/**
 * [task-19実写真調査] 検出box群から、通常の1文字行としては高さが異常な生boxを除外する
 * (`oversizedBoxHeightFactor`のコメント参照)。行マージ(`mergeBoxesIntoLines`)より前に
 * 一度だけ、写真全体の生box高さ中央値を基準に適用する(ノードごとの局所再計算はしない。
 * この除外は「複数行が誤って1boxに結合された検出ノイズを取り除く」前処理であり、
 * 分割判定自体が使う局所中央値行高とは目的が異なるため)。
 *
 * 除外されたboxは行マージ(`mergeBoxesIntoLines`)・sideA/sideB振り分け・box数/Y帯数/
 * aspect比/面積比などの採用条件統計には一切使われない([task-23実機診断調査]
 * `findBestSplit`のコメント参照: Y軸のギャップ候補生成(軸投影区間)にのみ、除外box自身の
 * 座標を「占有区間」として算入する。これは`excludeOversizedBoxes`を無効化するものではなく、
 * 「行として結合はしないが、その空間を空白とは扱わない」という区別)。領域の最終bboxには
 * `reabsorbExcludedBoxesIntoRegions`で別途(グローバルに1回だけ)安全な場合のみ再吸収される。
 * 各領域の実際のOCR(`recognize()`)は領域クロップ後の画像全体に対して独立に再実行される
 * ため、ここでの除外は「どこで領域を区切るか」の判定にのみ影響し、文字認識結果
 * (合計金額の読み取り)を欠落させることはない。
 */
export function excludeOversizedBoxes(boxes: readonly Box[], thresholds: XyCutThresholds = DEFAULT_THRESHOLDS): Box[] {
  if (boxes.length === 0) return [...boxes];
  const medianHeight = median(boxes.map((b) => b.height));
  if (medianHeight <= 0) return [...boxes];
  const maxHeight = thresholds.oversizedBoxHeightFactor * medianHeight;
  return boxes.filter((b) => b.height <= maxHeight);
}

/**
 * §16.2 point1: 検出box群を同一印字行へ結合する。
 * 垂直重なり率≥`lineMergeMinVerticalOverlap` かつ 水平間隔≤`lineMergeMaxHorizontalGapFactor`×
 * (結合前boxの中央値行高) の2boxを同一クラスタとし、クラスタごとのbboxを行boxとする。
 */
export function mergeBoxesIntoLines(
  boxes: readonly Box[],
  thresholds: XyCutThresholds = DEFAULT_THRESHOLDS,
): { lines: Box[]; medianLineHeight: number } {
  if (boxes.length === 0) return { lines: [], medianLineHeight: 0 };
  const initialMedianHeight = median(boxes.map((b) => b.height));
  const maxGap = thresholds.lineMergeMaxHorizontalGapFactor * Math.max(1, initialMedianHeight);
  const clusters = groupByCluster(
    [...boxes],
    (a, b) => verticalOverlapRatio(a, b) >= thresholds.lineMergeMinVerticalOverlap && horizontalGap(a, b) <= maxGap,
  );
  const lines = clusters.map((cluster) => bbox(cluster));
  const medianLineHeight = median(lines.map((l) => l.height)) || initialMedianHeight;
  return { lines, medianLineHeight };
}

/** 指定boxes内の「異なるY帯」数(垂直方向にどれだけ重なりのない塊があるか)。 */
function countDistinctYBands(boxes: Box[]): number {
  if (boxes.length === 0) return 0;
  return groupByCluster(boxes, (a, b) => verticalOverlapRatio(a, b) > 0).length;
}

export type AxisGap = { axis: "x" | "y"; splitPoint: number; size: number };

/** 指定軸上の投影区間をマージし、`minGutter`以上のギャップ候補を大きい順に返す。 */
export function findGapsOnAxis(boxes: Box[], axis: "x" | "y", minGutter: number): AxisGap[] {
  const intervals = boxes
    .map((b) => (axis === "x" ? { start: b.x, end: b.x + b.width } : { start: b.y, end: b.y + b.height }))
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }

  const gaps: AxisGap[] = [];
  for (let i = 1; i < merged.length; i++) {
    const size = merged[i].start - merged[i - 1].end;
    if (size >= minGutter) {
      gaps.push({ axis, splitPoint: merged[i - 1].end + size / 2, size });
    }
  }
  return gaps.sort((a, b) => b.size - a.size);
}

function aspectRatio(b: Box): number {
  return Math.max(b.width, b.height) / Math.max(1, Math.min(b.width, b.height));
}

export type SplitResult = { sideA: Box[]; sideB: Box[]; excludedA: Box[]; excludedB: Box[] };

/**
 * §16.2 point2/3: 1ノード分の分割を試みる。X/Y両軸のギャップ候補をサイズの大きい順に
 * 試し、§16.2 point3の採用条件(box数・Y帯数・aspect比・面積比・非weak)をすべて
 * 満たす最初の候補を採用する。満たす候補が無ければ`null`(このノードは終端領域=
 * 分割せず1つの領域として残す)。
 *
 * `medianLineHeight`はこのノードの箱集合から**局所的に**再計算する(木全体で固定の
 * 1値を使うのではない)。1枚の写真内でもレシートによって文字サイズが大きく異なりうる
 * (例: 縦の余裕が乏しいレイアウトはフォントを縮小するため)。ルートで固定した
 * 中央値行高だと、その1枚の写真内のどこかの局所的な文字サイズと合わず、MIN_GUTTERが
 * 実情に合わなくなる(widthの割に大きすぎ/小さすぎるギャップ閾値になる)ケースが
 * スパイクで観測されたため、ノードごとに再計算する方式を採用した。
 *
 * [スパイクでの調整] 当初は「weak(ギャップが僅かにMIN_GUTTERを超えただけ)な候補でも
 * 分割は実行するが、木全体のLayoutDecisionをambiguousへ倒す」という設計だったが、
 * 模擬8枚グリッド写真で「8領域中7領域は確信度の高い分割で正しく求まっているのに、
 * 深い階層でのweakな1分割のせいで木全体がambiguous(写真全体を1行)に潰れる」
 * という致命的な過剰安全動作を実測で確認した(詳細は`.superpowers/sdd/v13-spike.md`)。
 * このため、weak候補は「採用するが全体を疑わしくする」のではなく「証拠不十分として
 * その候補を除外し、次点候補を試す(全部weakなら分割せず現ノードを1領域のまま残す)」
 * という、より局所的で安全側に倒れる扱いへ変更した。これにより：
 * - 他の確信度の高い分割は木の残り部分で維持される(過剰にambiguous化しない)
 * - 分割根拠が弱いノードは「2枚を1領域のまま」に留まる(安全側のデフォルト。
 *   誤って2分割してどちらか一方の合計だけを拾う事故より、1領域のまま
 *   needs-reviewに倒れる方が§16.3の安全弁の意図に合致する)
 *
 * [task-23実機診断調査] `excludedBoxes`(このノードに属する、`excludeOversizedBoxes`で
 * 行マージのシードから除外済みの巨大box群)は、ギャップ候補の**生成**(軸投影区間のunion)
 * にのみ算入し、sideA/sideB振り分け・box数/Y帯数/aspect比/面積比の各採用条件チェックには
 * 一切使わない(`boxes`のみで判定。巨大boxは通常の文字行として異常な形状のため、これらの
 * 統計を歪めないため)。実機(iPhone Safari)の`detect()`は、レシートの価格列のように
 * 右揃えの数字が行間を詰めて並ぶ領域を、複数行分の高さを持つ1つの巨大boxとして検出する
 * ことがある。この巨大boxを軸投影区間から完全に除外してしまうと、巨大boxが実際には
 * 覆っているはずのY範囲が「空白(ギャップ)」に見えてしまい、本来1つの領域であるはずの
 * レシートが、巨大boxの上下で誤って2領域に分割される(実機診断データでの実測、詳細は
 * `.superpowers/sdd/task-23-report.md`)。巨大box自体をギャップ候補の**採用判定**にまで
 * 使わないのは、`excludeOversizedBoxes`が防ごうとしている別の問題(巨大boxが隣接する
 * 別レシートの領域まで橋渡ししてしまい、本来分割すべき2レシートが誤って1領域に結合される
 * こと)を再発させないため。ギャップ候補生成に算入しても、sideA/sideBの実体
 * (`boxes`ベース)には一切含まれないため、box数・Y帯数などの採用条件は`excludedBoxes`の
 * 有無に関わらず「実際に検出された通常の文字行だけで採用条件を満たすか」を厳密に問い続ける
 * (既存の回帰テスト`task-19実写真調査: 狭いギャップ+複数行結合の巨大box(アイロン相当の
 * 横断クラスタ)があっても3分割できる`・`task-19実写真回帰テスト`の両方が引き続き
 * パスすることで検証済み。詳細な境界条件の検討過程は`.superpowers/sdd/task-23-report.md`参照)。
 *
 * [既知のトレードオフ、Codexレビュー指摘] 「巨大boxは複数行の誤結合(縦方向の現象)だから
 * Y座標は信頼できる」という前提は絶対ではない。異常判定の根拠はあくまで「高さ」であり、
 * 巨大boxのY範囲が(例えば極端に間隔の狭い)縦に並ぶ2枚の別レシートの間の正当なYギャップを
 * 偶然跨いでしまう可能性は理論上排除できない。その場合、本来2領域に分割すべきレシートが
 * 誤って1領域(`single`)に結合される。これは今回の修正方針(「誤分割(1レシートが複数
 * 領域に割れる)を減らす」)が必然的に伴うトレードオフであり、`weakGapMultiplier`等
 * 既存の設計判断(§16.3の安全弁、`findBestSplit`の一番上のコメント参照)と同じく
 * 「誤って2分割してどちらか一方の合計だけを拾う事故より、1領域のままneeds-reviewに
 * 倒れる方が安全」という考え方の延長線上にある。この副作用は合成フィクスチャで再現・
 * 記録済み(`regionDetection.test.ts`の`task-23`関連テスト参照)。
 */
export function findBestSplit(
  boxes: Box[],
  thresholds: XyCutThresholds,
  longSide: number,
  excludedBoxes: readonly Box[] = [],
): SplitResult | null {
  const medianLineHeight = median(boxes.map((b) => b.height));
  const minGutter = Math.max(thresholds.minGutterLineHeightFactor * medianLineHeight, thresholds.minGutterLongSideFraction * longSide);
  const weakFloor = thresholds.weakGapMultiplier * minGutter;
  // [task-23実機診断調査] ギャップ候補の生成(占有ヒストグラム)には、行マージのシードからは
  // 除外済みの巨大boxも含める(=巨大boxが覆う範囲はギャップにならない)。上記コメント参照。
  //
  // Y軸にのみ適用し、X軸には適用しない。除外される巨大boxは`excludeOversizedBoxes`の
  // コメントの通り「価格列のように行間を詰めて並ぶ数字が複数行分の高さで1boxに誤結合された」
  // ものであり、この誤結合は本質的に**縦方向**(複数の「行」にまたがる)の現象であって、
  // 横方向に複数の「列」(=複数の異なるレシート)へまたがる現象ではない。X軸にも適用すると、
  // 実際に別レシートの間にある正当なギャップへ巨大boxの水平方向の広がりが橋渡ししてしまい、
  // 本来分割すべき別々のレシートが誤って1領域に結合される(既存の
  // 模擬フィクスチャ`task-19実写真調査: 狭いギャップ+複数行結合の巨大box(アイロン相当の
  // 横断クラスタ)`・実写真フィクスチャ`task-19実写真回帰テスト`の両方で実測・確認済み。
  // 詳細は`.superpowers/sdd/task-23-report.md`)。
  const yProjectionBoxes = excludedBoxes.length > 0 ? [...boxes, ...excludedBoxes] : boxes;
  const candidates = [...findGapsOnAxis(boxes, "x", minGutter), ...findGapsOnAxis(yProjectionBoxes, "y", minGutter)].sort(
    (a, b) => b.size - a.size,
  );

  const parentBBox = bbox(boxes);
  const parentArea = Math.max(1, parentBBox.width * parentBBox.height);

  for (const candidate of candidates) {
    if (candidate.size < weakFloor) continue; // 証拠不十分(weak)。このノードでは分割しない。

    const sideA: Box[] = [];
    const sideB: Box[] = [];
    for (const box of boxes) {
      const center = candidate.axis === "x" ? box.x + box.width / 2 : box.y + box.height / 2;
      (center < candidate.splitPoint ? sideA : sideB).push(box);
    }
    if (sideA.length < thresholds.minBoxesPerSide || sideB.length < thresholds.minBoxesPerSide) continue;
    if (countDistinctYBands(sideA) < thresholds.minDistinctYBandsPerSide) continue;
    if (countDistinctYBands(sideB) < thresholds.minDistinctYBandsPerSide) continue;

    const bboxA = bbox(sideA);
    const bboxB = bbox(sideB);
    if (aspectRatio(bboxA) > thresholds.maxAspectRatio || aspectRatio(bboxB) > thresholds.maxAspectRatio) continue;
    const areaA = bboxA.width * bboxA.height;
    const areaB = bboxB.width * bboxB.height;
    if (areaA / parentArea < thresholds.minAreaFraction || areaB / parentArea < thresholds.minAreaFraction) continue;

    // [task-23実機診断調査] 子ノードへの再帰でも同じ軸投影の恩恵を受けられるよう、
    // このノードに属していた除外box群も子ノードのexcludedA/excludedBへ振り分けて渡す。
    //
    // 分割軸がYの場合: この除外boxたちは`yProjectionBoxes`としてこの分割候補自身の
    // ギャップ発見に使われている。つまり除外boxのY範囲は(定義上)このY方向の空白ギャップの
    // 外側にあるはずで、splitPointを跨いで存在するとは考えにくい。通常boxのsideA/sideB
    // 判定と同じ「中心点がsplitPointのどちら側か」基準で問題ない(Codexレビューで安全と
    // 確認済み)。
    //
    // 分割軸がXの場合: 除外boxはX軸のギャップ生成には使っていない(意図的、上記コメント
    // 参照)ため、除外boxがX方向のsplitPointを跨いで存在する可能性がある(Codexレビュー
    // 指摘)。この場合に中心点だけで機械的にどちらか一方の子へ丸ごと渡すと、実際には
    // 両方の子の実bboxと重なる除外box(=本来どちらの子にも部分的に属する)が、片方の子だけの
    // Y軸投影区間に混入し、その子の内部にある正当なYギャップを誤って抑止しかねない。
    // このため、X分割の場合のみ子の実bbox(`bboxA`/`bboxB`)との水平方向の重なりで判定し、
    // 片方のみと重なる場合だけその子へ渡す。両方と重なる(帰属が曖昧)、またはどちらとも
    // 重ならない場合はどちらの子のexcludedにも渡さない(このノード配下のY軸投影からは
    // 除外されるが、`buildLayoutDecision`側の`reabsorbExcludedBoxesIntoRegions`が最終
    // 領域集合に対してグローバルに1回、除外box全部を再吸収するため、情報が失われる
    // わけではない)。
    const excludedA: Box[] = [];
    const excludedB: Box[] = [];
    for (const box of excludedBoxes) {
      if (candidate.axis === "y") {
        const center = box.y + box.height / 2;
        (center < candidate.splitPoint ? excludedA : excludedB).push(box);
      } else {
        const overlapsA = horizontalOverlap(box, bboxA) > 0;
        const overlapsB = horizontalOverlap(box, bboxB) > 0;
        if (overlapsA && !overlapsB) excludedA.push(box);
        else if (overlapsB && !overlapsA) excludedB.push(box);
        // 両方/どちらとも重ならない場合は帰属が曖昧なため、どちらの子にも渡さない。
      }
    }

    return { sideA, sideB, excludedA, excludedB };
  }
  return null;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function unionBBox(a: Box, b: Box): Box {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 点(px,py)から矩形rまでの距離の2乗(矩形内なら0)。 */
function pointToRectDistanceSquared(px: number, py: number, r: Box): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
  return dx * dx + dy * dy;
}

/**
 * [task-19実写真調査 追試(Codexレビュー指摘)] `excludeOversizedBoxes`で除外した生boxは
 * 行マージ・sideA/sideB振り分けの実体には使わないが([task-23実機診断調査]
 * `findBestSplit`のY軸ギャップ候補生成にのみ、占有区間として一時的に算入されることがある。
 * それとは別に、除外boxは実際の文字内容(例えば合計金額そのもの)を含んでいる可能性がある。
 * 除外box自身の座標は最終的な領域bbox(→`cropRectForRegion`のクロップ範囲)の計算に
 * (この関数が呼ばれるまでは)一切使われないため、除外boxが「生き残った行群のbboxから
 * クロップ余白を超えて離れた位置」にある場合、後段のOCR入力(クロップ画像)からその内容が
 * 丸ごと欠落しうる(Codexレビュー指摘: 除外boxの位置次第では実在する。実写真では偶然
 * クロップ余白の範囲内に収まっていたため顕在化しなかった)。
 *
 * この関数は、各除外boxを「中心点が最も近い領域」へ、その領域のbboxを**他のどの領域とも
 * 重ならない範囲でのみ**拡張して取り込む。拡張後に他領域と重なってしまう場合は、その除外box
 * の取り込みを諦めて元のbboxのまま残す(安全側: 隣接領域を跨いで誤って橋渡ししてしまう
 * `excludeOversizedBoxes`導入前の不具合を、クロップ段階で再発させないため)。この「最も近い
 * 領域」への割り当ては、`buildLayoutDecision`内の分割探索中に`findBestSplit`が行う
 * 「分割軸・分割点による`excludedA`/`excludedB`振り分け」(ギャップ候補生成用、木を降りる
 * ための一時的な帰属)とは**独立した別のアルゴリズム**であり、一致しなくてもよい(こちらは
 * 分割確定後の最終領域集合に対して、除外box全部を1回だけグローバルに割り当て直す)。
 * `region.boxes`(`cropRectForRegion`の中央値行高計算に使う)は変更しない(除外boxは
 * 通常より高いため、統計に混ぜると中央値行高が歪む)。
 */
export function reabsorbExcludedBoxesIntoRegions(regions: readonly Region[], excludedBoxes: readonly Box[]): Region[] {
  if (excludedBoxes.length === 0 || regions.length === 0) return [...regions];
  const expanded: Region[] = regions.map((r) => ({ ...r }));
  for (const excluded of excludedBoxes) {
    const cx = excluded.x + excluded.width / 2;
    const cy = excluded.y + excluded.height / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < expanded.length; i++) {
      const d = pointToRectDistanceSquared(cx, cy, expanded[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) continue;
    const candidateBBox = unionBBox(expanded[bestIdx], excluded);
    const overlapsSibling = expanded.some((r, i) => i !== bestIdx && boxesOverlap(candidateBBox, r));
    if (!overlapsSibling) {
      expanded[bestIdx] = { ...candidateBBox, boxes: expanded[bestIdx].boxes };
    }
  }
  return expanded;
}

/**
 * §16.2/§16.3の中心関数。検出box群(パス1・検出専用実行の結果)からLayoutDecisionを
 * 構築する。
 *
 * @param rawBoxes パス1で得た検出box(検出専用実行に使ったcanvas座標系のままでよい。
 *   本関数は座標系に依存しない。呼び出し側は`Region`の座標を後段のクロップに使う際、
 *   必要なら元解像度へスケールし直すこと)。
 * @param imageWidth 検出に使った画像の幅(パディング・ギャップ閾値の基準)。
 * @param imageHeight 検出に使った画像の高さ。
 */
export function buildLayoutDecision(
  rawBoxes: readonly Box[],
  imageWidth: number,
  imageHeight: number,
  thresholds: XyCutThresholds = DEFAULT_THRESHOLDS,
): LayoutDecision {
  // [task-19実写真調査] 行マージの前に、複数行が誤って1boxに結合された検出ノイズを
  // 除外する(`excludeOversizedBoxes`のコメント参照)。
  const filteredBoxes = excludeOversizedBoxes(rawBoxes, thresholds);
  // [task-19実写真調査 追試(Codexレビュー指摘)] 除外した生boxは`reabsorbExcludedBoxesIntoRegions`
  // で後述のクロップ範囲へ安全に取り込む(参照等価で比較。`excludeOversizedBoxes`は要素を
  // コピーせずフィルタするだけなので、同一オブジェクト参照で判定できる)。
  const filteredBoxSet = new Set(filteredBoxes);
  const excludedBoxes = rawBoxes.filter((b) => !filteredBoxSet.has(b));
  const { lines } = mergeBoxesIntoLines(filteredBoxes, thresholds);

  if (lines.length === 0) {
    return {
      kind: "ambiguous",
      fallbackRegion: { x: 0, y: 0, width: imageWidth, height: imageHeight, boxes: [] },
    };
  }

  const longSide = Math.max(imageWidth, imageHeight);
  const maxLeaves = thresholds.maxRegions;

  // [task-23実機診断調査] 各ノードには、そのノードの実体である行box群(`lines`)に加えて、
  // 空間的にそのノードへ帰属する除外済み巨大box群(`excluded`)も一緒に運ぶ。`findBestSplit`
  // が返す`excludedA`/`excludedB`(採用された分割候補と同じ軸・分割点で振り分け済み)を
  // そのまま子ノードへ引き継ぐことで、深い階層でも占有ヒストグラムに巨大boxの範囲を
  // 反映し続けられる(詳細は`findBestSplit`のコメント参照)。
  type Node = { lines: Box[]; excluded: Box[] };
  const queue: Node[] = [{ lines, excluded: excludedBoxes }];
  const resolved: Box[][] = [];
  let truncated = false;

  while (queue.length > 0) {
    const node = queue.shift()!;
    const candidate = findBestSplit(node.lines, thresholds, longSide, node.excluded);

    if (candidate === null) {
      // 分割根拠なし(weak候補も含めて証拠不十分)。このノードは1領域のまま残す
      // (§16.3の安全弁の考え方を分割単位に局所化したもの。詳細は`findBestSplit`の
      // コメント・`.superpowers/sdd/v13-spike.md`参照)。
      resolved.push(node.lines);
      continue;
    }

    // これ以上分割すると資源(MAX_REGIONS)を超える場合は、分割根拠があっても
    // 打ち切る(§16.2 point4 MAX_REGIONS、§16.3「上限到達」)。
    if (resolved.length + queue.length + 1 >= maxLeaves) {
      truncated = true;
      resolved.push(node.lines);
      continue;
    }

    queue.push({ lines: candidate.sideA, excluded: candidate.excludedA }, { lines: candidate.sideB, excluded: candidate.excludedB });
  }

  const regions: Region[] = reabsorbExcludedBoxesIntoRegions(
    resolved.map((boxes) => ({ ...bbox(boxes), boxes })),
    excludedBoxes,
  );

  if (regions.length === 1) {
    return { kind: "single", confidence: "certain", region: regions[0] };
  }

  if (truncated) {
    // §16.3「上限到達」→ 写真全体を1領域として扱う安全弁。領域が1つしかないため、
    // 除外box全部を無条件(重なりチェック不要)に取り込んでよい。
    const fallbackBBox = excludedBoxes.reduce((acc, b) => unionBBox(acc, b), bbox(lines));
    return {
      kind: "ambiguous",
      fallbackRegion: { ...fallbackBBox, boxes: lines },
    };
  }

  return { kind: "multiple", confidence: "certain", regions };
}

/** クロップ用矩形(0以上・画像範囲内にクランプ済み)。 */
export type CropRect = { x: number; y: number; width: number; height: number };

/**
 * §16.2 point5: 領域のクロップ余白を計算し、画像範囲内にクランプした矩形を返す。
 * 紙輪郭ではなく文字群のbboxを基準に余白を付ける。
 *
 * 中央値行高は`region.boxes`(この領域に属する行box群)から局所的に計算する
 * (`buildLayoutDecision`の分割判定と同じ理由。写真全体で1つの値を使うと、
 * その領域自身の文字サイズと合わないことがある)。
 */
export function cropRectForRegion(
  region: Region,
  imageWidth: number,
  imageHeight: number,
  thresholds: XyCutThresholds = DEFAULT_THRESHOLDS,
): CropRect {
  const medianLineHeight = median(region.boxes.map((b) => b.height));
  const padX = Math.max(thresholds.padXLineHeightFactor * medianLineHeight, thresholds.padXWidthFraction * imageWidth);
  const padY = Math.max(thresholds.padYLineHeightFactor * medianLineHeight, thresholds.padYHeightFraction * imageHeight);

  const x0 = Math.max(0, region.x - padX);
  const y0 = Math.max(0, region.y - padY);
  const x1 = Math.min(imageWidth, region.x + region.width + padX);
  const y1 = Math.min(imageHeight, region.y + region.height + padY);

  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
