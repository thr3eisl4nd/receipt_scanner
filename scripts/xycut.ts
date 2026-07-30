/**
 * 再帰XY-cut(スパイク版、純粋関数)。
 *
 * v1.3設計ドキュメント `docs/superpowers/specs/2026-07-27-receipt-scanner-design.md`
 * §16.2(領域検出アルゴリズム)・§16.3(LayoutDecision)を実装したもの。本ファイルは
 * `ppu-paddle-ocr` 等の外部ライブラリに一切依存しない純粋関数のみで構成されており、
 * 本実装時に `src/layout/` 等へそのまま(型ごと)移設できることを意図している。
 *
 * 検証スパイクでの使い方は `scripts/run-xycut-detect.mjs` 等を参照。
 */

/** 検出済み文字box(`OcrEngine.detect()` の1要素、または本ファイル内でのマージ後の行box)。 */
export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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
  /** §16.2 point1: 同一印字行への結合を許す水平間隔の上限(×中央値行高)。 */
  lineMergeMaxHorizontalGapFactor: number;
  /** §16.2 point4: MIN_GUTTERの行高係数(3×中央値行高)。 */
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
   * 仕様に具体的数値の指定はないためスパイクで決定した値(調整過程はレポート参照)。
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
};

/**
 * スパイクでの調整結果(詳細・調整過程は `.superpowers/sdd/v13-spike.md` 参照)。
 * §16.2に明記された値はそのまま採用し、未規定の値(aspect比・面積比・weak倍率)は
 * 模擬マルチレシート写真での計測により決定した。
 */
export const DEFAULT_THRESHOLDS: XyCutThresholds = {
  lineMergeMinVerticalOverlap: 0.35,
  lineMergeMaxHorizontalGapFactor: 8,
  minGutterLineHeightFactor: 3,
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

/** 垂直方向の重なり率(0〜1)。重なりがなければ0。 */
function verticalOverlapRatio(a: Box, b: Box): number {
  const aTop = a.y;
  const aBottom = a.y + a.height;
  const bTop = b.y;
  const bBottom = b.y + b.height;
  const overlap = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.height, b.height);
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

/** 単純なUnion-Find(経路圧縮のみ、ランクなし。box数が数百程度のスパイク用途では十分)。 */
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

export type SplitResult = { sideA: Box[]; sideB: Box[] };

/**
 * §16.2 point2/3: 1ノード分の分割を試みる。X/Y両軸のギャップ候補をサイズの大きい順に
 * 試し、§16.2 point3の採用条件(box数・Y帯数・aspect比・面積比・非weak)をすべて
 * 満たす最初の候補を採用する。満たす候補が無ければ`null`(このノードは終端領域=
 * 分割せず1つの領域として残す)。
 *
 * `medianLineHeight`はこのノードの箱集合から**局所的に**再計算する(木全体で固定の
 * 1値を使うのではない)。スパイクでの調整過程で判明した点: 1枚の写真内でもレシートに
 * よって文字サイズが大きく異なりうる(例: §16「上段横長1」のような縦の余裕が乏しい
 * レイアウトはフォントを縮小するため)。ルートで固定した中央値行高だと、その1枚の
 * 写真内のどこかの局所的な文字サイズと合わず、MIN_GUTTERが実情に合わなくなる
 * (widthの割に大きすぎ/小さすぎるギャップ閾値になる)ケースが実写で観測されたため、
 * ノードごとに再計算する方式へ変更した。
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
 */
export function findBestSplit(boxes: Box[], thresholds: XyCutThresholds, longSide: number): SplitResult | null {
  const medianLineHeight = median(boxes.map((b) => b.height));
  const minGutter = Math.max(thresholds.minGutterLineHeightFactor * medianLineHeight, thresholds.minGutterLongSideFraction * longSide);
  const weakFloor = thresholds.weakGapMultiplier * minGutter;
  const candidates = [...findGapsOnAxis(boxes, "x", minGutter), ...findGapsOnAxis(boxes, "y", minGutter)].sort(
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

    return { sideA, sideB };
  }
  return null;
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
  const { lines } = mergeBoxesIntoLines(rawBoxes, thresholds);

  if (lines.length === 0) {
    return {
      kind: "ambiguous",
      fallbackRegion: { x: 0, y: 0, width: imageWidth, height: imageHeight, boxes: [] },
    };
  }

  const longSide = Math.max(imageWidth, imageHeight);
  const maxLeaves = thresholds.maxRegions;

  const queue: Box[][] = [lines];
  const resolved: Box[][] = [];
  let truncated = false;

  while (queue.length > 0) {
    const node = queue.shift()!;
    const candidate = findBestSplit(node, thresholds, longSide);

    if (candidate === null) {
      // 分割根拠なし(weak候補も含めて証拠不十分)。このノードは1領域のまま残す
      // (§16.3の安全弁の考え方を分割単位に局所化したもの。詳細は`findBestSplit`の
      // コメント・`.superpowers/sdd/v13-spike.md`参照)。
      resolved.push(node);
      continue;
    }

    // これ以上分割すると資源(MAX_REGIONS)を超える場合は、分割根拠があっても
    // 打ち切る(§16.2 point4 MAX_REGIONS、§16.3「上限到達」)。
    if (resolved.length + queue.length + 1 >= maxLeaves) {
      truncated = true;
      resolved.push(node);
      continue;
    }

    queue.push(candidate.sideA, candidate.sideB);
  }

  const regions: Region[] = resolved.map((boxes) => ({ ...bbox(boxes), boxes }));

  if (regions.length === 1) {
    return { kind: "single", confidence: "certain", region: regions[0] };
  }

  if (truncated) {
    // §16.3「上限到達」→ 写真全体を1領域として扱う安全弁。
    return {
      kind: "ambiguous",
      fallbackRegion: { ...bbox(lines), boxes: lines },
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
