import { describe, expect, it } from "vitest";
import {
  buildLayoutDecision,
  cropRectForRegion,
  excludeOversizedBoxes,
  findGapsOnAxis,
  mergeBoxesIntoLines,
  reabsorbExcludedBoxesIntoRegions,
  DEFAULT_THRESHOLDS,
  type Box,
  type Region,
} from "./regionDetection";

/** 2枚のレシートが横に並んだ模擬box群を作る。各レシートは3行、行同士は垂直に十分離れる。 */
function twoReceiptsSideBySide(): Box[] {
  const receiptA: Box[] = [
    { x: 10, y: 10, width: 200, height: 20 },
    { x: 10, y: 40, width: 180, height: 20 },
    { x: 10, y: 70, width: 190, height: 20 },
    { x: 10, y: 100, width: 150, height: 20 },
    { x: 10, y: 130, width: 170, height: 20 },
  ];
  // 大きな水平ギャップ(300px、行高20の`lineMergeMaxHorizontalGapFactor`倍(既定3=60)を大きく上回る)を空けて2枚目
  const receiptB: Box[] = receiptA.map((b) => ({ ...b, x: b.x + 500 }));
  return [...receiptA, ...receiptB];
}

describe("regionDetection: mergeBoxesIntoLines", () => {
  it("垂直に重なり水平に近い2boxを同一行へ結合する", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 50, height: 20 },
      { x: 55, y: 2, width: 50, height: 18 }, // 垂直に十分重なり、水平間隔も小さい
    ];
    const { lines } = mergeBoxesIntoLines(boxes);
    expect(lines).toHaveLength(1);
  });

  it("垂直に重ならない2boxは別の行のまま結合しない", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 50, height: 20 },
      { x: 0, y: 100, width: 50, height: 20 },
    ];
    const { lines } = mergeBoxesIntoLines(boxes);
    expect(lines).toHaveLength(2);
  });

  it("box0件ならlines0件・medianLineHeight0を返す", () => {
    expect(mergeBoxesIntoLines([])).toEqual({ lines: [], medianLineHeight: 0 });
  });
});

describe("regionDetection: excludeOversizedBoxes (task-19実写真調査)", () => {
  it("生box高さ中央値のoversizedBoxHeightFactor倍を超えるboxを除外する", () => {
    const normal: Box[] = Array.from({ length: 8 }, (_, i) => ({ x: i * 20, y: 0, width: 15, height: 20 }));
    // 中央値(20)の6倍(既定oversizedBoxHeightFactor)を超える高さ(=複数行が誤結合された検出ノイズ相当)。
    const oversized: Box = { x: 0, y: 0, width: 15, height: 20 * DEFAULT_THRESHOLDS.oversizedBoxHeightFactor + 1 };
    const result = excludeOversizedBoxes([...normal, oversized], DEFAULT_THRESHOLDS);
    expect(result).toHaveLength(normal.length);
    expect(result.some((b) => b.height === oversized.height)).toBe(false);
  });

  it("しきい値ちょうど(中央値のoversizedBoxHeightFactor倍と同値)のboxは除外しない", () => {
    // 8個(高さ20)+境界値1個の計9個。中央値は20で安定する(9個中8個が20のため)。
    const normal: Box[] = Array.from({ length: 8 }, (_, i) => ({ x: i * 20, y: 0, width: 15, height: 20 }));
    const atBoundary: Box = { x: 200, y: 0, width: 15, height: 20 * DEFAULT_THRESHOLDS.oversizedBoxHeightFactor };
    expect(excludeOversizedBoxes([...normal, atBoundary], DEFAULT_THRESHOLDS)).toHaveLength(9);
  });

  it("box0件なら空配列を返す", () => {
    expect(excludeOversizedBoxes([], DEFAULT_THRESHOLDS)).toEqual([]);
  });
});

describe("regionDetection: reabsorbExcludedBoxesIntoRegions (task-19実写真調査 追試、Codexレビュー指摘)", () => {
  it("最も近い領域のbboxを、他領域と重ならない範囲で除外boxまで拡張する", () => {
    const regions: Region[] = [
      { x: 0, y: 0, width: 100, height: 100, boxes: [{ x: 0, y: 0, width: 100, height: 20 }] },
      { x: 500, y: 0, width: 100, height: 100, boxes: [{ x: 500, y: 0, width: 100, height: 20 }] },
    ];
    // 左領域の直下(y=100〜200)にある除外box。中心(50,150)は左領域に最も近い。
    const excluded: Box = { x: 0, y: 100, width: 100, height: 100 };
    const result = reabsorbExcludedBoxesIntoRegions(regions, [excluded]);
    expect(result[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 200 });
    // 右領域は変化しない。
    expect(result[1]).toMatchObject({ x: 500, y: 0, width: 100, height: 100 });
    // .boxesは変更しない(中央値行高計算を歪めないため)。
    expect(result[0].boxes).toEqual(regions[0].boxes);
  });

  it("拡張すると他領域と重なってしまう場合は取り込みを諦める(安全側)", () => {
    const regions: Region[] = [
      { x: 0, y: 0, width: 100, height: 100, boxes: [] },
      { x: 150, y: 0, width: 100, height: 100, boxes: [] },
    ];
    // 中心(125,50)は両領域のちょうど中間に近いが、幅400の巨大boxで、取り込むと
    // 必ずどちらかの領域と重なってしまう。
    const excluded: Box = { x: 50, y: 0, width: 400, height: 20 };
    const result = reabsorbExcludedBoxesIntoRegions(regions, [excluded]);
    // どちらの領域も元のbboxのまま(重なりを起こしてまで取り込まない)。
    expect(result[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
    expect(result[1]).toMatchObject({ x: 150, y: 0, width: 100, height: 100 });
  });

  it("除外box0件・領域0件ならそのまま返す", () => {
    const regions: Region[] = [{ x: 0, y: 0, width: 10, height: 10, boxes: [] }];
    expect(reabsorbExcludedBoxesIntoRegions(regions, [])).toEqual(regions);
    expect(reabsorbExcludedBoxesIntoRegions([], [{ x: 0, y: 0, width: 10, height: 10 }])).toEqual([]);
  });

  it("buildLayoutDecision統合: 複数行結合で除外された巨大boxが、通常行から離れた位置にあってもクロップ範囲から失われない(Codexレビュー指摘)", () => {
    // 実写真調査で判明: `excludeOversizedBoxes`は分割判定の入力からは除外boxを正しく
    // 取り除くが、そのままだと領域のbbox(→クロップ範囲)の計算からも除外box自身が
    // 消えてしまい、除外boxが通常行のbboxから離れた位置にある場合(例: 合計欄が複数行
    // 結合されて検出された)、クロップ画像からその内容が丸ごと失われうる、という指摘。
    function receipt(xOffset: number, includeOversized: boolean): Box[] {
      const rows: Box[] = Array.from({ length: 5 }, (_, i) => ({ x: xOffset, y: 10 + i * 30, width: 150, height: 20 }));
      if (!includeOversized) return rows;
      // 複数行結合で検出された巨大box(高さ121=行高20の6倍超、通常行から離れたy=300)。
      const oversized: Box = { x: xOffset, y: 300, width: 150, height: 121 };
      return [...rows, oversized];
    }
    const boxes = [...receipt(0, true), ...receipt(500, false)];
    const decision = buildLayoutDecision(boxes, 1200, 800);
    expect(decision.kind).toBe("multiple");
    if (decision.kind === "multiple") {
      const [left, right] = [...decision.regions].sort((a, b) => a.x - b.x);
      // 左領域のbboxは巨大box(y=300〜421)まで拡張されている。
      expect(left.y).toBeLessThanOrEqual(300);
      expect(left.y + left.height).toBeGreaterThanOrEqual(421);
      const leftCrop = cropRectForRegion(left, 1200, 800);
      expect(leftCrop.y).toBeLessThanOrEqual(300);
      expect(leftCrop.y + leftCrop.height).toBeGreaterThanOrEqual(421);
      // 拡張しても右領域とは重ならない。
      expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    }
  });
});

describe("regionDetection: findGapsOnAxis", () => {
  it("minGutter以上のギャップのみ候補として、大きい順に返す", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 0, width: 10, height: 10 }, // gap=10 (0->10, 20->30なのでgap=10)
      { x: 100, y: 0, width: 10, height: 10 }, // gap=70
    ];
    const gaps = findGapsOnAxis(boxes, "x", 5);
    expect(gaps.map((g) => g.size)).toEqual([70, 10]);
  });

  it("minGutter未満のギャップは候補から除外する", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 12, y: 0, width: 10, height: 10 }, // gap=2
    ];
    expect(findGapsOnAxis(boxes, "x", 5)).toEqual([]);
  });
});

describe("regionDetection: buildLayoutDecision", () => {
  it("box0件ならambiguous(写真全体のfallbackRegion)を返す", () => {
    const decision = buildLayoutDecision([], 1000, 2000);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.fallbackRegion).toEqual({ x: 0, y: 0, width: 1000, height: 2000, boxes: [] });
    }
  });

  it("box数が少なく分割条件(片側最小5box)を満たさない場合はsingleを返す", () => {
    const boxes: Box[] = [
      { x: 10, y: 10, width: 100, height: 20 },
      { x: 10, y: 40, width: 100, height: 20 },
    ];
    const decision = buildLayoutDecision(boxes, 1000, 1000);
    expect(decision.kind).toBe("single");
  });

  it("十分離れた2つのレシート相当のbox群はmultiple(2領域)へ分割する", () => {
    const boxes = twoReceiptsSideBySide();
    const decision = buildLayoutDecision(boxes, 1200, 800);
    expect(decision.kind).toBe("multiple");
    if (decision.kind === "multiple") {
      expect(decision.regions).toHaveLength(2);
      // 各領域が5行ずつ、互いに重ならない
      const [left, right] = [...decision.regions].sort((a, b) => a.x - b.x);
      expect(left.boxes).toHaveLength(5);
      expect(right.boxes).toHaveLength(5);
      expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    }
  });

  it("task-19実写真調査: 狭いギャップ+複数行結合の巨大box(アイロン相当の横断クラスタ)があっても3分割できる", () => {
    // 実物写真(レシート3枚を狭い間隔で横に並べて撮影、詳細は`.superpowers/sdd/task-19-report.md`)
    // 由来のbox配置を匿名化・単純化した合成フィクスチャ。中央のレシートは他の2枚より行数が
    // 少ない(実写真でも中央のレシートだけ短かった)。列同士の間隔(90px)は行高(20px)の
    // `lineMergeMaxHorizontalGapFactor`倍(既定3=60)は上回るが旧既定値(8=160)は下回り、
    // 旧既定値のままだと同一「行」として誤結合されていたことを確認済み。さらに、
    // 実写真で観測された「価格列が複数行分の高さで1boxに誤結合された検出ノイズ」相当の
    // 巨大box(高さ200=行高の10倍、隣接列との間隔20px)を左列側へ意図的に近接させて
    // 混入させる。この巨大boxは`excludeOversizedBoxes`で除外される(または除外されなくても
    // `verticalOverlapRatio`の対称化により隣接列の小boxと誤結合しない)ため、左右2列を
    // 誤って橋渡しすることはない。
    const left: Box[] = Array.from({ length: 8 }, (_, i) => ({ x: 0, y: 10 + i * 30, width: 170, height: 20 }));
    const middle: Box[] = Array.from({ length: 6 }, (_, i) => ({ x: 260, y: 10 + i * 30, width: 90, height: 20 }));
    const right: Box[] = Array.from({ length: 8 }, (_, i) => ({ x: 440, y: 10 + i * 30, width: 170, height: 20 }));
    // 中央列の左側(x=190〜350)へ張り出す巨大box。左列(x0〜170)との間隔はわずか20px。
    const oversizedBridge: Box = { x: 190, y: 10, width: 160, height: 200 };

    const decision = buildLayoutDecision([...left, ...middle, ...right, oversizedBridge], 1000, 600);
    expect(decision.kind).toBe("multiple");
    if (decision.kind === "multiple") {
      expect(decision.regions).toHaveLength(3);
      const sorted = [...decision.regions].sort((a, b) => a.x - b.x);
      expect(sorted.map((r) => r.boxes.length)).toEqual([8, 6, 8]);
      // 互いに重ならない(誤結合していれば重なる/1領域に潰れるはず)。
      expect(sorted[0].x + sorted[0].width).toBeLessThanOrEqual(sorted[1].x);
      expect(sorted[1].x + sorted[1].width).toBeLessThanOrEqual(sorted[2].x);
      // 巨大boxはどの領域のboxesにも含まれない(除外されている)。
      for (const region of sorted) {
        expect(region.boxes.some((b) => b.height === 200)).toBe(false);
      }
    }
  });

  it("task-19実写真回帰テスト: 実物写真(IMG_0201.jpeg)から検出された生box座標そのものを使っても3分割できる", () => {
    // `real-photos/IMG_0201.jpeg`(gitignore済み、レシート3枚を狭い間隔で横に並べて撮影した
    // 実物写真、詳細は`.superpowers/sdd/task-19-report.md`)に対して本番と同じ検出経路
    // (`service.detect()`を長辺1200px・本番同一padding(`ppuPaddleEngine.ts`の
    // `paddingVertical:0.1/paddingHorizontal:0.15`)で実行)して得た検出box群136個を、
    // 元解像度(3213×5712px)座標へスケールし戻したもの。`OcrBox`は`{x,y,width,height}`の
    // 幾何情報のみでOCRテキストを含まないため、これは実際のレシート内容(店名・金額等)を
    // 含まない匿名データである。座標は整数へ丸めてある。
    //
    // 上記の合成フィクスチャ(巨大box1個のみ)と異なり、これは実写真そのものの
    // ノイズ分布(複数行が誤結合された中間サイズのboxが複数、透かし状に列間を跨いで
    // 存在する)を含む。この配置は`DEFAULT_THRESHOLDS`(現行値)でのみ3分割に成功し、
    // task-19以前の閾値(`lineMergeMaxHorizontalGapFactor:8`,
    // `minGutterLineHeightFactor:3`, `oversizedBoxHeightFactor`なし,
    // `verticalOverlapRatio`の分母`Math.min`)へ戻すとkind="single"(1領域)に潰れることを
    // 手動検証済み(4つの変更のうちどれか1つでも欠けると3分割が崩れる)。
    const rawBoxesFromRealPhoto: Box[] = [
      { x: 0, y: 5331, width: 214, height: 71 }, { x: 0, y: 5255, width: 219, height: 67 }, { x: 0, y: 4969, width: 381, height: 186 },
      { x: 2518, y: 4879, width: 466, height: 71 }, { x: 0, y: 4831, width: 490, height: 76 }, { x: 2656, y: 4784, width: 133, height: 43 },
      { x: 3137, y: 4736, width: 48, height: 48 }, { x: 2494, y: 4731, width: 371, height: 148 }, { x: 0, y: 4703, width: 167, height: 67 },
      { x: 181, y: 4684, width: 167, height: 86 }, { x: 638, y: 4593, width: 190, height: 71 }, { x: 0, y: 4541, width: 195, height: 167 },
      { x: 219, y: 4541, width: 209, height: 67 }, { x: 2542, y: 4479, width: 362, height: 71 }, { x: 228, y: 4470, width: 162, height: 71 },
      { x: 2537, y: 4417, width: 157, height: 67 }, { x: 2885, y: 4403, width: 314, height: 67 }, { x: 238, y: 4403, width: 209, height: 67 },
      { x: 0, y: 4393, width: 209, height: 167 }, { x: 2528, y: 4346, width: 119, height: 67 }, { x: 2885, y: 4336, width: 324, height: 62 },
      { x: 252, y: 4332, width: 148, height: 62 }, { x: 0, y: 4260, width: 214, height: 148 }, { x: 243, y: 4255, width: 395, height: 71 },
      { x: 2523, y: 4208, width: 238, height: 71 }, { x: 2861, y: 4194, width: 143, height: 76 }, { x: 238, y: 4184, width: 290, height: 71 },
      { x: 0, y: 4117, width: 233, height: 167 }, { x: 238, y: 4108, width: 538, height: 76 }, { x: 2513, y: 4070, width: 238, height: 67 },
      { x: 252, y: 4060, width: 238, height: 62 }, { x: 3137, y: 4046, width: 76, height: 86 }, { x: 0, y: 3998, width: 267, height: 67 },
      { x: 400, y: 3989, width: 133, height: 71 }, { x: 2856, y: 3927, width: 352, height: 67 }, { x: 2851, y: 3870, width: 219, height: 52 },
      { x: 252, y: 3851, width: 352, height: 71 }, { x: 2475, y: 3789, width: 286, height: 219 }, { x: 2846, y: 3798, width: 309, height: 67 },
      { x: 214, y: 3784, width: 443, height: 71 }, { x: 2832, y: 3732, width: 100, height: 67 }, { x: 2694, y: 3713, width: 67, height: 48 },
      { x: 2832, y: 3670, width: 381, height: 62 }, { x: 2466, y: 3665, width: 347, height: 143 }, { x: 2451, y: 3618, width: 338, height: 67 },
      { x: 2823, y: 3613, width: 252, height: 67 }, { x: 67, y: 3599, width: 781, height: 90 }, { x: 2799, y: 3499, width: 167, height: 67 },
      { x: 2456, y: 3499, width: 257, height: 67 }, { x: 2680, y: 3380, width: 347, height: 67 }, { x: 666, y: 3356, width: 71, height: 43 },
      { x: 114, y: 3346, width: 314, height: 167 }, { x: 2594, y: 3332, width: 500, height: 62 }, { x: 466, y: 3256, width: 362, height: 309 },
      { x: 90, y: 3170, width: 752, height: 114 }, { x: 2385, y: 3156, width: 785, height: 71 }, { x: 205, y: 3061, width: 505, height: 119 },
      { x: 2380, y: 3037, width: 833, height: 71 }, { x: 138, y: 2956, width: 633, height: 124 }, { x: 2380, y: 2923, width: 790, height: 67 },
      { x: 2380, y: 2813, width: 471, height: 67 }, { x: 1814, y: 2804, width: 257, height: 67 }, { x: 157, y: 2761, width: 619, height: 214 },
      { x: 2370, y: 2718, width: 571, height: 62 }, { x: 2004, y: 2670, width: 43, height: 48 }, { x: 138, y: 2666, width: 690, height: 114 },
      { x: 1990, y: 2618, width: 43, height: 43 }, { x: 971, y: 2623, width: 114, height: 90 }, { x: 1299, y: 2613, width: 195, height: 95 },
      { x: 447, y: 2561, width: 138, height: 48 }, { x: 381, y: 2561, width: 62, height: 43 }, { x: 347, y: 2561, width: 48, height: 48 },
      { x: 2351, y: 2561, width: 714, height: 71 }, { x: 562, y: 2551, width: 71, height: 43 }, { x: 1994, y: 2513, width: 67, height: 43 },
      { x: 1347, y: 2499, width: 124, height: 43 }, { x: 2442, y: 2480, width: 62, height: 48 }, { x: 466, y: 2475, width: 186, height: 52 },
      { x: 2804, y: 2447, width: 347, height: 133 }, { x: 1418, y: 2447, width: 43, height: 43 }, { x: 2347, y: 2442, width: 243, height: 124 },
      { x: 90, y: 2404, width: 752, height: 267 }, { x: 2375, y: 2332, width: 252, height: 62 }, { x: 1528, y: 2285, width: 614, height: 566 },
      { x: 1399, y: 2309, width: 133, height: 43 }, { x: 2356, y: 2285, width: 371, height: 67 }, { x: 71, y: 2285, width: 647, height: 86 },
      { x: 76, y: 2256, width: 143, height: 62 }, { x: 281, y: 2242, width: 181, height: 52 }, { x: 2942, y: 2228, width: 219, height: 195 },
      { x: 2394, y: 2218, width: 243, height: 71 }, { x: 2351, y: 2161, width: 381, height: 71 }, { x: 2946, y: 2123, width: 209, height: 124 },
      { x: 2727, y: 2113, width: 143, height: 76 }, { x: 2370, y: 2109, width: 138, height: 67 }, { x: 728, y: 2094, width: 43, height: 43 },
      { x: 1161, y: 2013, width: 919, height: 928 }, { x: 1833, y: 2066, width: 228, height: 119 }, { x: 2418, y: 2023, width: 48, height: 48 },
      { x: 1333, y: 1994, width: 190, height: 52 }, { x: 490, y: 1971, width: 190, height: 71 }, { x: 67, y: 1947, width: 757, height: 333 },
      { x: 2404, y: 1952, width: 67, height: 86 }, { x: 466, y: 1933, width: 400, height: 262 }, { x: 2404, y: 1909, width: 48, height: 52 },
      { x: 1309, y: 1885, width: 338, height: 119 }, { x: 2394, y: 1875, width: 62, height: 43 }, { x: 1885, y: 1871, width: 157, height: 205 },
      { x: 419, y: 1780, width: 62, height: 43 }, { x: 281, y: 1780, width: 162, height: 43 }, { x: 2375, y: 1761, width: 62, height: 43 },
      { x: 1309, y: 1714, width: 471, height: 162 }, { x: 252, y: 1704, width: 566, height: 233 }, { x: 1847, y: 1709, width: 205, height: 167 },
      { x: 143, y: 1661, width: 766, height: 333 }, { x: 228, y: 1633, width: 647, height: 67 }, { x: 2370, y: 1618, width: 209, height: 43 },
      { x: 2856, y: 1547, width: 357, height: 619 }, { x: 2237, y: 1537, width: 671, height: 619 }, { x: 1752, y: 1571, width: 243, height: 62 },
      { x: 1304, y: 1528, width: 738, height: 167 }, { x: 228, y: 1495, width: 528, height: 124 }, { x: 2299, y: 1452, width: 552, height: 119 },
      { x: 1542, y: 1457, width: 267, height: 76 }, { x: 514, y: 1404, width: 48, height: 43 }, { x: 257, y: 1371, width: 709, height: 124 },
      { x: 1328, y: 1352, width: 666, height: 90 }, { x: 2285, y: 1314, width: 714, height: 138 }, { x: 2332, y: 1309, width: 252, height: 62 },
      { x: 1471, y: 1285, width: 395, height: 48 }, { x: 1875, y: 1280, width: 76, height: 52 }, { x: 814, y: 1066, width: 48, height: 43 },
      { x: 662, y: 919, width: 52, height: 43 }, { x: 2813, y: 743, width: 76, height: 76 }, { x: 2351, y: 709, width: 162, height: 119 },
      { x: 2918, y: 666, width: 138, height: 114 },
    ];

    const decision = buildLayoutDecision(rawBoxesFromRealPhoto, 3213, 5712);
    expect(decision.kind).toBe("multiple");
    if (decision.kind === "multiple") {
      expect(decision.regions).toHaveLength(3);
      const sorted = [...decision.regions].sort((a, b) => a.x - b.x);
      // 3枚のレシート(左/中央/右)にほぼ対応する列。中央のレシートは行数が少ない
      // (実写真でも中央のレシートだけ短かった)ため他の2列よりboxesが少ない。
      expect(sorted.map((r) => r.boxes.length)).toEqual([37, 17, 45]);
      // 互いに重ならない(誤結合していれば重なる/1領域に潰れるはず)。
      expect(sorted[0].x + sorted[0].width).toBeLessThanOrEqual(sorted[1].x);
      expect(sorted[1].x + sorted[1].width).toBeLessThanOrEqual(sorted[2].x);
      // 複数行が誤結合された巨大box(高さ566/619/619/928、`excludeOversizedBoxes`で除外
      // される生box)は、単体でもマージ後の行としても、どの領域にも含まれない
      // (行マージ後の高さは複数box分を含みうるが、除外された4box自体の高さとは一致しない)。
      for (const region of sorted) {
        expect(region.boxes.some((b) => [566, 619, 928].includes(b.height))).toBe(false);
      }
    }
  });

  it("task-23実機診断回帰テスト: iPhone実機(Safari)のdetect()が返した生box座標(1点のみ丸め境界値補正)を使うと右レシートが上下2領域に誤分割される(修正後は3分割)", () => {
    // `real-photos/iphone-diag-0201.json`(gitignore済み、task-22で追加した実機診断データ
    // コピー機能で採取。`IMG_0201.jpeg`をiPhone Safari実機で処理した際の
    // `rawBoxes`/`decision`をそのまま保存したもの)由来のフィクスチャ。上記
    // `task-19実写真回帰テスト`はNode(canvas polyfill)上で`service.detect()`を実行して
    // 得たbox座標だったが、これは**実機Safari**の`ppu-paddle-ocr`が実際に返した座標
    // (105個、正規化座標0..1・小数3桁。うち1点のみ下記の理由で0.0001補正)であり、
    // Node実行では再現しなかった実機固有の誤分割を再現する。
    //
    // 実機診断データの`decision`フィールド(`buildLayoutDecision`の実機での実行結果、
    // 修正前のコード)は次の4領域(誤り)だった:
    //   [{x:0,y:0.187,w:0.338,h:0.759}, {x:0.361,y:0.224,w:0.306,h:0.291},
    //    {x:0.711,y:0.117,w:0.239,h:0.158}, {x:0.727,y:0.369,w:0.273,h:0.498}]
    // 右レシート(x≈0.7〜1.0)がy≈0.275で上下2領域([2]と[3])に誤分割されている。原因は
    // 右レシートの価格列が複数行分の高さを持つ巨大box2個(x:0.696,y:0.269,w:0.209,h:0.109
    // と x:0.889,y:0.271,w:0.111,h:0.108。中央値行高の約7〜13倍)として検出され、
    // `excludeOversizedBoxes`で行マージのシードからだけでなく、ギャップ判定(占有
    // ヒストグラム)からも完全に除外されてしまうため、右レシート内 y≈0.275〜0.369に
    // 実在しない偽のYギャップが生じることだった(詳細・修正方針は
    // `.superpowers/sdd/task-23-report.md`)。
    //
    // 座標は診断データの正規化基準(`detectCanvasW`×`detectCanvasH`=675×1200、
    // `queue.ts`の`buildPhotoDiagnostics`が実際に使うのと同じ基準)へスケールし直して使う
    // (本番の`buildLayoutDecision(boxes, detectCanvas.width, detectCanvas.height)`呼び出し
    // と同じ座標系)。
    //
    // 1点のみ、診断データの3桁丸め由来の境界値を補正している: x:0.871,y:0.123の
    // box(下記配列中で`height: 0.0069`とコメント付きで直接記述している行、診断データ
    // 原本では`0.007`)は、直前のx:0.908,y:0.117のbox(高さ0.02)との
    // `verticalOverlapRatio`が丸め後の値だとちょうど0.350(=`lineMergeMinVerticalOverlap`の
    // 閾値と同値、`>=`判定で結合)になり、Node上での復元時にたまたま実機と異なる行結合結果に
    // なってしまう(3桁丸めの精度(±0.0005、canvas上で最大±0.6px)の範囲内で、真値は
    // 0.350をまたぎうる)。実機の`decision`(右上領域のbox数が結合後4個では
    // `minBoxesPerSide`(5)を満たせず分割自体が起きないはずだが、実際には分割が起きている)
    // が要求する行結合結果と整合するよう、この1boxの高さのみ0.0069(丸めれば0.007に一致する
    // 量子化区間`[0.0065,0.0075)`内で復元した推定値)へ補正した。この補正を入れると、
    // 修正前コードは実機の`decision`と完全一致する4領域([0,0.187,0.338,0.759]
    // [0.361,0.224,0.306,0.291] [0.711,0.117,0.239,0.158] [0.727,0.369,0.273,0.498])を
    // 返すことを確認済み(補正なしだと、この1boxが結合されず右上のbox数が5個になり、
    // 丸め精度の偶然だけでたまたま誤分割を回避してしまう。理想は診断データ自体を
    // ピクセル座標または小数6桁以上で採取し直すことだが、実機再採取が必要なため今回は
    // この量子化区間内での最小限の補正に留めた。下記の
    // `regionDetection: findBestSplit Y軸投影`の合成テストで、丸め境界に依存しない形でも
    // 同じ効果を直接検証している)。
    const detectCanvasW = 675;
    const detectCanvasH = 1200;
    // prettier-ignore
    const normalizedRawBoxes: Box[] = [
      { x: 0.908, y: 0.117, width: 0.042, height: 0.02 }, { x: 0.871, y: 0.123, width: 0.019, height: 0.0069 /* task-23: 量子化区間[0.0065,0.0075)内での補正、原本は0.007 */ }, { x: 0.732, y: 0.124, width: 0.05, height: 0.021 },
      { x: 0.816, y: 0.132, width: 0.025, height: 0.013 }, { x: 0.876, y: 0.137, width: 0.022, height: 0.007 }, { x: 0.201, y: 0.187, width: 0.052, height: 0.007 },
      { x: 0.584, y: 0.224, width: 0.023, height: 0.009 }, { x: 0.436, y: 0.225, width: 0.146, height: 0.009 }, { x: 0.726, y: 0.229, width: 0.078, height: 0.011 },
      { x: 0.711, y: 0.23, width: 0.222, height: 0.024 }, { x: 0.413, y: 0.237, width: 0.208, height: 0.016 }, { x: 0.081, y: 0.24, width: 0.221, height: 0.022 },
      { x: 0.48, y: 0.255, width: 0.083, height: 0.014 }, { x: 0.716, y: 0.254, width: 0.171, height: 0.021 }, { x: 0.071, y: 0.262, width: 0.165, height: 0.021 },
      { x: 0.406, y: 0.268, width: 0.23, height: 0.029 }, { x: 0.696, y: 0.269, width: 0.209, height: 0.109 }, { x: 0.889, y: 0.271, width: 0.111, height: 0.108 },
      { x: 0.071, y: 0.286, width: 0.202, height: 0.011 }, { x: 0.044, y: 0.291, width: 0.239, height: 0.058 }, { x: 0.575, y: 0.299, width: 0.062, height: 0.029 },
      { x: 0.409, y: 0.3, width: 0.145, height: 0.028 }, { x: 0.587, y: 0.328, width: 0.049, height: 0.034 }, { x: 0.404, y: 0.33, width: 0.113, height: 0.029 },
      { x: 0.145, y: 0.338, width: 0.122, height: 0.046 }, { x: 0.021, y: 0.341, width: 0.235, height: 0.059 }, { x: 0.15, y: 0.345, width: 0.041, height: 0.013 },
      { x: 0.187, y: 0.346, width: 0.022, height: 0.008 }, { x: 0.575, y: 0.363, width: 0.066, height: 0.02 }, { x: 0.361, y: 0.353, width: 0.285, height: 0.162 },
      { x: 0.738, y: 0.369, width: 0.041, height: 0.011 }, { x: 0.849, y: 0.37, width: 0.044, height: 0.013 }, { x: 0.917, y: 0.372, width: 0.065, height: 0.022 },
      { x: 0.733, y: 0.379, width: 0.116, height: 0.012 }, { x: 0.745, y: 0.388, width: 0.076, height: 0.013 }, { x: 0.087, y: 0.392, width: 0.055, height: 0.011 },
      { x: 0.916, y: 0.39, width: 0.068, height: 0.034 }, { x: 0.024, y: 0.394, width: 0.044, height: 0.011 }, { x: 0.73, y: 0.397, width: 0.122, height: 0.023 },
      { x: 0.024, y: 0.4, width: 0.2, height: 0.015 }, { x: 0.476, y: 0.4, width: 0.191, height: 0.099 }, { x: 0.028, y: 0.421, width: 0.236, height: 0.047 },
      { x: 0.727, y: 0.426, width: 0.23, height: 0.037 }, { x: 0.873, y: 0.428, width: 0.106, height: 0.023 }, { x: 0.302, y: 0.459, width: 0.036, height: 0.016 },
      { x: 0.043, y: 0.467, width: 0.215, height: 0.02 }, { x: 0.738, y: 0.476, width: 0.178, height: 0.012 }, { x: 0.049, y: 0.483, width: 0.192, height: 0.038 },
      { x: 0.563, y: 0.491, width: 0.083, height: 0.012 }, { x: 0.741, y: 0.493, width: 0.146, height: 0.011 }, { x: 0.741, y: 0.513, width: 0.246, height: 0.01 },
      { x: 0.044, y: 0.518, width: 0.195, height: 0.022 }, { x: 0.741, y: 0.532, width: 0.259, height: 0.012 }, { x: 0.064, y: 0.536, width: 0.157, height: 0.021 },
      { x: 0.741, y: 0.553, width: 0.246, height: 0.012 }, { x: 0.028, y: 0.555, width: 0.231, height: 0.02 }, { x: 0.145, y: 0.57, width: 0.113, height: 0.054 },
      { x: 0.804, y: 0.583, width: 0.163, height: 0.021 }, { x: 0.036, y: 0.586, width: 0.097, height: 0.029 }, { x: 0.871, y: 0.613, width: 0.052, height: 0.011 },
      { x: 0.764, y: 0.613, width: 0.08, height: 0.011 }, { x: 0.021, y: 0.63, width: 0.243, height: 0.017 }, { x: 0.876, y: 0.633, width: 0.08, height: 0.011 },
      { x: 0.764, y: 0.632, width: 0.112, height: 0.036 }, { x: 0.881, y: 0.643, width: 0.119, height: 0.01 }, { x: 0.881, y: 0.654, width: 0.032, height: 0.011 },
      { x: 0.067, y: 0.663, width: 0.137, height: 0.012 }, { x: 0.886, y: 0.665, width: 0.092, height: 0.011 }, { x: 0.77, y: 0.663, width: 0.089, height: 0.04 },
      { x: 0.079, y: 0.674, width: 0.108, height: 0.013 }, { x: 0.887, y: 0.678, width: 0.069, height: 0.009 }, { x: 0.889, y: 0.688, width: 0.11, height: 0.011 },
      { x: 0.126, y: 0.697, width: 0.038, height: 0.014 }, { x: 0, y: 0.7, width: 0.083, height: 0.012 }, { x: 0.976, y: 0.708, width: 0.024, height: 0.015 },
      { x: 0.079, y: 0.711, width: 0.071, height: 0.01 }, { x: 0.784, y: 0.713, width: 0.072, height: 0.011 }, { x: 0.074, y: 0.719, width: 0.167, height: 0.014 },
      { x: 0, y: 0.721, width: 0.073, height: 0.029 }, { x: 0.074, y: 0.733, width: 0.09, height: 0.012 }, { x: 0.889, y: 0.734, width: 0.046, height: 0.014 },
      { x: 0.785, y: 0.737, width: 0.074, height: 0.012 }, { x: 0.074, y: 0.744, width: 0.125, height: 0.014 }, { x: 0, y: 0.745, width: 0.067, height: 0.027 },
      { x: 0.079, y: 0.758, width: 0.045, height: 0.011 }, { x: 0.898, y: 0.759, width: 0.101, height: 0.011 }, { x: 0.785, y: 0.761, width: 0.039, height: 0.011 },
      { x: 0, y: 0.769, width: 0.065, height: 0.029 }, { x: 0.074, y: 0.771, width: 0.065, height: 0.012 }, { x: 0.898, y: 0.772, width: 0.099, height: 0.011 },
      { x: 0.79, y: 0.773, width: 0.047, height: 0.011 }, { x: 0.071, y: 0.783, width: 0.049, height: 0.012 }, { x: 0.791, y: 0.784, width: 0.113, height: 0.013 },
      { x: 0.068, y: 0.795, width: 0.065, height: 0.012 }, { x: 0, y: 0.795, width: 0.061, height: 0.029 }, { x: 0.199, y: 0.804, width: 0.059, height: 0.013 },
      { x: 0.056, y: 0.82, width: 0.052, height: 0.014 }, { x: 0, y: 0.823, width: 0.052, height: 0.011 }, { x: 0.975, y: 0.826, width: 0.016, height: 0.012 },
      { x: 0.776, y: 0.828, width: 0.113, height: 0.026 }, { x: 0, y: 0.846, width: 0.153, height: 0.012 }, { x: 0.784, y: 0.854, width: 0.142, height: 0.013 },
      { x: 0, y: 0.87, width: 0.119, height: 0.033 }, { x: 0, y: 0.92, width: 0.068, height: 0.012 }, { x: 0, y: 0.933, width: 0.068, height: 0.013 },
    ];
    // 正規化座標(0..1)から検出canvas実寸(675×1200)のピクセル座標へスケールし直す
    // (丸め境界値補正は上記配列内に直接記述済み)。
    const rawBoxesFromIphone: Box[] = normalizedRawBoxes.map((b) => ({
      x: b.x * detectCanvasW,
      y: b.y * detectCanvasH,
      width: b.width * detectCanvasW,
      height: b.height * detectCanvasH,
    }));

    const decision = buildLayoutDecision(rawBoxesFromIphone, detectCanvasW, detectCanvasH);
    expect(decision.kind).toBe("multiple");
    if (decision.kind === "multiple") {
      expect(decision.regions).toHaveLength(3);
      const sorted = [...decision.regions].sort((a, b) => a.x - b.x);
      const frac = (r: Region) => ({
        x0: r.x / detectCanvasW,
        x1: (r.x + r.width) / detectCanvasW,
      });
      // 左レシート x≈[0, 0.34]
      expect(frac(sorted[0]).x0).toBeCloseTo(0, 1);
      expect(frac(sorted[0]).x1).toBeLessThan(0.36);
      // 中央レシート x≈[0.36, 0.67]
      expect(frac(sorted[1]).x0).toBeGreaterThan(0.34);
      expect(frac(sorted[1]).x1).toBeLessThan(0.7);
      // 右レシート x≈[0.71, 1.0]
      expect(frac(sorted[2]).x0).toBeGreaterThan(0.65);
      expect(frac(sorted[2]).x1).toBeCloseTo(1, 1);
      // 互いに重ならない。
      expect(sorted[0].x + sorted[0].width).toBeLessThanOrEqual(sorted[1].x);
      expect(sorted[1].x + sorted[1].width).toBeLessThanOrEqual(sorted[2].x);
      // 右レシートが上下2領域に誤分割されていない(修正前は右レシートがy≈0.275で
      // 上下に分断され、regions.length===4になっていた)。右レシートの縦の広がりが
      // 写真の大部分(y方向)をカバーしていることを確認する。
      expect(sorted[2].height / detectCanvasH).toBeGreaterThan(0.5);
      // 中央レシートも縦に分断されていない(regionが1つだけ、= sorted[1]のみ)。
      expect(sorted.filter((r) => frac(r).x0 > 0.34 && frac(r).x1 < 0.7)).toHaveLength(1);
      // [Codexレビュー指摘] 範囲判定だけでなく、実際の出力値(行box数)も固定して回帰検出力を
      // 上げる。別の誤った3分割が偶然この範囲条件だけを満たしてしまうケースを防ぐ。
      expect(sorted.map((r) => r.boxes.length)).toEqual([31, 9, 35]);
      // 複数行が誤結合された巨大box(高さ130.8/129.6/194.4/118.8px = 正規化0.109/0.108/
      // 0.162/0.099、`excludeOversizedBoxes`で除外される生box)は、単体でもマージ後の
      // 行としても、どの領域にも含まれない。
      const oversizedHeightsPx = [130.8, 129.6, 194.4, 118.8];
      for (const region of sorted) {
        expect(region.boxes.some((b) => oversizedHeightsPx.some((h) => Math.abs(b.height - h) < 0.01))).toBe(false);
      }
    }
  });

  it("regionDetection: findBestSplit Y軸投影(task-23実機診断調査、丸め境界に依存しない合成テスト)", () => {
    // 上記の実機診断フィクスチャは3桁丸めの境界値に依存する箇所が1点あるため、
    // 同じ効果(除外された巨大boxのY範囲がギャップ判定でも「占有」として扱われ、偽の
    // Yギャップによる誤分割を防ぐ)を、丸めに一切依存しないクリーンな合成データでも
    // 直接検証する(Codexレビュー指摘)。
    //
    // 1列のレシート相当: 上段5行(y=0〜140)・下段5行(y=300〜440)、間に実在するY方向の
    // 空白(y=140〜300、160px。分割の採用条件(片側5box以上・distinctYBands3以上・
    // aspect比・面積比)は全て満たす、通常なら2領域に正しく分割されるべき構成)。
    // その空白のほぼ全体を覆う巨大box(高さ180=通常行高20の9倍、`oversizedBoxHeightFactor`
    // (既定6)を超える。y=130〜310で、上段の最後の行の直後から下段の最初の行の直前まで
    // ほぼちょうど覆う)を追加すると、この巨大box自身が実際に価格列等の複数行結合である
    // 場合と同様、行マージのシードからは除外されつつ、Y軸投影には占有区間として算入され、
    // 見かけ上の空白が消えて1領域(single)のままになる。
    const topRows: Box[] = Array.from({ length: 5 }, (_, i) => ({ x: 0, y: i * 30, width: 150, height: 20 }));
    const bottomRows: Box[] = Array.from({ length: 5 }, (_, i) => ({ x: 0, y: 300 + i * 30, width: 150, height: 20 }));
    const oversizedBox: Box = { x: 20, y: 130, width: 60, height: 180 };

    // 対照実験(巨大boxなし): 実在するYギャップ(160px)により、正しく2領域(5+5)へ分割される。
    const decisionWithoutOversized = buildLayoutDecision([...topRows, ...bottomRows], 1000, 600);
    expect(decisionWithoutOversized.kind).toBe("multiple");
    if (decisionWithoutOversized.kind === "multiple") {
      expect(decisionWithoutOversized.regions).toHaveLength(2);
      expect(decisionWithoutOversized.regions.map((r) => r.boxes.length).sort()).toEqual([5, 5]);
    }

    // 本題: 巨大boxがY方向の空白のほぼ全体を覆っている場合、Y軸投影に算入されるため
    // 偽のYギャップが生じず、10行はまとまった1領域のまま(single)になる。
    const decision = buildLayoutDecision([...topRows, ...bottomRows, oversizedBox], 1000, 600);
    expect(decision.kind).toBe("single");
    if (decision.kind === "single") {
      expect(decision.region.boxes).toHaveLength(10);
      // 巨大box自体はboxesにもクロップ範囲(bbox)にも実体としては含まれない
      // (`reabsorbExcludedBoxesIntoRegions`で最終bboxへは別途安全に取り込まれる)。
      expect(decision.region.boxes.some((b) => b.height === 180)).toBe(false);
    }
  });

  it("regionDetection: 既知のトレードオフ(task-23、Codexレビュー指摘)縦に並ぶ2レシートの間の正当なYギャップを、それを跨ぐ巨大boxが誤って埋めてしまうことがある", () => {
    // Y軸限定の占有ヒストグラム反映は、右レシート内の偽Yギャップ(task-23の主題)を防ぐ一方、
    // 「巨大box(複数行誤結合)のY範囲は、たまたま縦に並ぶ2枚の別レシートの間の正当な
    // Yギャップと重なることは無い」という保証はない。この合成テストは、その既知の
    // トレードオフ(誤分割は防げるが、極端なケースでは誤結合が新たに生じうる)を
    // 意図的に再現・記録する(`findBestSplit`のコメント「既知のトレードオフ」参照)。
    //
    // 上段レシート(5行、y=0〜120)・下段レシート(5行、y=450〜570)。330pxの正当な
    // Yギャップがあり、巨大boxなしなら2領域に正しく分割される。
    const topReceipt: Box[] = Array.from({ length: 5 }, (_, i) => ({ x: 0, y: i * 30, width: 150, height: 20 }));
    const bottomReceipt: Box[] = Array.from({ length: 5 }, (_, i) => ({ x: 0, y: 450 + i * 30, width: 150, height: 20 }));

    const withoutOversized = buildLayoutDecision([...topReceipt, ...bottomReceipt], 1000, 800);
    expect(withoutOversized.kind).toBe("multiple");
    if (withoutOversized.kind === "multiple") {
      expect(withoutOversized.regions).toHaveLength(2);
    }

    // 巨大box(高さ310=通常行高20の15.5倍、y=140〜450)を追加する。上段レシートの最後の行
    // (y=100〜120)の直後から、下段レシートの最初の行(y=450〜470)の直前まで、2レシート間の
    // 正当なギャップ(y=120〜450)のほぼ全体を覆う。
    const oversizedBridge: Box = { x: 500, y: 140, width: 60, height: 310 };
    const withOversized = buildLayoutDecision([...topReceipt, ...bottomReceipt, oversizedBridge], 1000, 800);
    // [既知のトレードオフ、実測で確認済み] 巨大boxのY範囲がギャップのほぼ全体を覆うため、
    // Y軸投影ではこのノードにギャップ候補が見つからなくなり、本来2領域(2レシート)である
    // べきものが1領域(single)に誤って結合される。これが「Y軸限定」設計が受け入れている
    // 既知のトレードオフそのものであり、その挙動を固定して記録する(将来の変更で意図せず
    // 挙動が変わった場合に検知できるようにするため。挙動自体を「正しい」と主張するテストでは
    // ない)。
    expect(withOversized.kind).toBe("single");
    if (withOversized.kind === "single") {
      expect(withOversized.region.boxes).toHaveLength(10);
    }
  });

  it("MAX_REGIONS到達時はambiguous(木全体のfallbackRegion)として打ち切る(§16.3上限到達の安全弁)", () => {
    // 4つのレシート相当(各5行)を用意し、maxRegionsを2に下げて強制的に打ち切りを起こす。
    const receipts: Box[] = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 5; j++) {
        receipts.push({ x: 10 + i * 500, y: 10 + j * 30, width: 200, height: 20 });
      }
    }
    const thresholds = { ...DEFAULT_THRESHOLDS, maxRegions: 2 };
    const decision = buildLayoutDecision(receipts, 2200, 200, thresholds);
    expect(decision.kind).toBe("ambiguous");
  });

  it("弱い(weakGapMultiplier未満の)ギャップは分割せず、そのノードは1領域のまま残る", () => {
    // 十分な行数はあるが、ギャップがminGutterを僅かに超えるだけ(weak)になるよう
    // weakGapMultiplierを大きくして「弱い」扱いを強制する。
    const boxes = twoReceiptsSideBySide();
    const thresholds = { ...DEFAULT_THRESHOLDS, weakGapMultiplier: 100 }; // どんなギャップも常にweak扱いにする
    const decision = buildLayoutDecision(boxes, 1200, 800, thresholds);
    expect(decision.kind).toBe("single"); // 分割不採用→1領域のまま
  });
});

describe("regionDetection: cropRectForRegion", () => {
  it("行高・画像サイズに基づく余白を付け、画像範囲内にクランプする", () => {
    const region: Region = {
      x: 500,
      y: 500,
      width: 100,
      height: 100,
      boxes: [{ x: 500, y: 500, width: 100, height: 20 }],
    };
    const rect = cropRectForRegion(region, 1000, 1000);
    // padX = max(3*20, 0.04*1000) = max(60,40) = 60, padY = max(4*20,0.04*1000)=max(80,40)=80
    expect(rect).toEqual({ x: 440, y: 420, width: 220, height: 260 });
  });

  it("画像端に近い領域は負にならず0にクランプする", () => {
    const region: Region = { x: 0, y: 0, width: 50, height: 50, boxes: [{ x: 0, y: 0, width: 50, height: 20 }] };
    const rect = cropRectForRegion(region, 200, 200);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });
});
