import { describe, expect, it } from "vitest";
import {
  buildLayoutDecision,
  cropRectForRegion,
  findGapsOnAxis,
  mergeBoxesIntoLines,
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
  // 大きな水平ギャップ(300px、行高20の8倍=160を大きく上回る)を空けて2枚目
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
