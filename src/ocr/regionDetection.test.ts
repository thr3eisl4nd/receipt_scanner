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
