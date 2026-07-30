import { describe, expect, it } from "vitest";
import { mapToOcrLines, sanitizeBoxes } from "./mapRecognitionResult";

/** 既存テストで使うboxを一切クランプしない、十分に大きな画像境界。 */
const AMPLE_BOUNDS = { width: 10_000, height: 10_000 };

describe("mapToOcrLines", () => {
  it("正常な行はそのままOcrLineへ変換する", () => {
    const result = mapToOcrLines(
      [{ text: "合計", confidence: 0.87, box: { x: 10, y: 20, width: 40, height: 18 } }],
      AMPLE_BOUNDS,
    );
    expect(result).toEqual([
      { text: "合計", confidence: 0.87, box: { x: 10, y: 20, width: 40, height: 18 } },
    ]);
  });

  it("confidenceが1を超える場合は1にクランプする", () => {
    const [line] = mapToOcrLines(
      [{ text: "x", confidence: 1.5, box: { x: 0, y: 0, width: 10, height: 10 } }],
      AMPLE_BOUNDS,
    );
    expect(line.confidence).toBe(1);
  });

  it("confidenceが負の場合は0にクランプする", () => {
    const [line] = mapToOcrLines(
      [{ text: "x", confidence: -0.3, box: { x: 0, y: 0, width: 10, height: 10 } }],
      AMPLE_BOUNDS,
    );
    expect(line.confidence).toBe(0);
  });

  it("confidenceがNaN/Infinityなど非有限の場合は0にする", () => {
    const results = mapToOcrLines(
      [
        { text: "a", confidence: Number.NaN, box: { x: 0, y: 0, width: 10, height: 10 } },
        { text: "b", confidence: Number.POSITIVE_INFINITY, box: { x: 0, y: 0, width: 10, height: 10 } },
        { text: "c", confidence: Number.NEGATIVE_INFINITY, box: { x: 0, y: 0, width: 10, height: 10 } },
      ],
      AMPLE_BOUNDS,
    );
    expect(results.map((l) => l.confidence)).toEqual([0, 0, 0]);
  });

  it("box.height<=0の行は除外する", () => {
    const results = mapToOcrLines(
      [
        { text: "zero", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 0 } },
        { text: "negative", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: -5 } },
        { text: "ok", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } },
      ],
      AMPLE_BOUNDS,
    );
    expect(results.map((l) => l.text)).toEqual(["ok"]);
  });

  it("box.width<=0の行は除外する(負のwidthはextractTotalの左右判定を壊すため)", () => {
    const results = mapToOcrLines(
      [
        { text: "zero", confidence: 0.9, box: { x: 0, y: 0, width: 0, height: 10 } },
        { text: "negative", confidence: 0.9, box: { x: 0, y: 0, width: -5, height: 10 } },
        { text: "ok", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } },
      ],
      AMPLE_BOUNDS,
    );
    expect(results.map((l) => l.text)).toEqual(["ok"]);
  });

  it("boxの値が非有限(NaN/Infinity)の行は除外する", () => {
    const results = mapToOcrLines(
      [
        { text: "nanX", confidence: 0.9, box: { x: Number.NaN, y: 0, width: 10, height: 10 } },
        { text: "nanY", confidence: 0.9, box: { x: 0, y: Number.NaN, width: 10, height: 10 } },
        { text: "infWidth", confidence: 0.9, box: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 } },
        { text: "infHeight", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY } },
        { text: "ok", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } },
      ],
      AMPLE_BOUNDS,
    );
    expect(results.map((l) => l.text)).toEqual(["ok"]);
  });

  it("画像境界の外にあるboxは除外する", () => {
    const results = mapToOcrLines(
      [
        { text: "beyondRight", confidence: 0.9, box: { x: 200, y: 0, width: 10, height: 10 } },
        { text: "beyondBottom", confidence: 0.9, box: { x: 0, y: 200, width: 10, height: 10 } },
        { text: "negativeOrigin", confidence: 0.9, box: { x: -20, y: -20, width: 10, height: 10 } },
        { text: "ok", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } },
      ],
      { width: 100, height: 100 },
    );
    expect(results.map((l) => l.text)).toEqual(["ok"]);
  });

  it("画像境界にまたがるboxは境界内に切り詰める", () => {
    const [line] = mapToOcrLines(
      [{ text: "edge", confidence: 0.9, box: { x: 90, y: 90, width: 30, height: 30 } }],
      { width: 100, height: 100 },
    );
    expect(line.box).toEqual({ x: 90, y: 90, width: 10, height: 10 });
  });

  it("空配列を渡すと空配列を返す", () => {
    expect(mapToOcrLines([], AMPLE_BOUNDS)).toEqual([]);
  });
});

describe("sanitizeBoxes (v1.3: OcrEngine.detect()結果のサニタイズ)", () => {
  it("正常なboxはそのまま通す", () => {
    const result = sanitizeBoxes([{ x: 10, y: 20, width: 40, height: 18 }], AMPLE_BOUNDS);
    expect(result).toEqual([{ x: 10, y: 20, width: 40, height: 18 }]);
  });

  it("非有限値を含むboxは除外する", () => {
    const result = sanitizeBoxes(
      [
        { x: NaN, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: Infinity, height: 10 },
        { x: 0, y: 0, width: 10, height: 10 },
      ],
      AMPLE_BOUNDS,
    );
    expect(result).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
  });

  it("width/heightが0以下のboxは除外する", () => {
    const result = sanitizeBoxes(
      [
        { x: 0, y: 0, width: 0, height: 10 },
        { x: 0, y: 0, width: 10, height: -5 },
      ],
      AMPLE_BOUNDS,
    );
    expect(result).toEqual([]);
  });

  it("画像完全に外側のboxは除外し、境界にまたがるboxは切り詰める", () => {
    const result = sanitizeBoxes(
      [
        { x: -50, y: -50, width: 10, height: 10 },
        { x: 90, y: 90, width: 30, height: 30 },
      ],
      { width: 100, height: 100 },
    );
    expect(result).toEqual([{ x: 90, y: 90, width: 10, height: 10 }]);
  });

  it("空配列を渡すと空配列を返す", () => {
    expect(sanitizeBoxes([], AMPLE_BOUNDS)).toEqual([]);
  });
});
