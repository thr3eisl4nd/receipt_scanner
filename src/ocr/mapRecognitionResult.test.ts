import { describe, expect, it } from "vitest";
import { mapToOcrLines } from "./mapRecognitionResult";

describe("mapToOcrLines", () => {
  it("正常な行はそのままOcrLineへ変換する", () => {
    const result = mapToOcrLines([
      { text: "合計", confidence: 0.87, box: { x: 10, y: 20, width: 40, height: 18 } },
    ]);
    expect(result).toEqual([
      { text: "合計", confidence: 0.87, box: { x: 10, y: 20, width: 40, height: 18 } },
    ]);
  });

  it("confidenceが1を超える場合は1にクランプする", () => {
    const [line] = mapToOcrLines([
      { text: "x", confidence: 1.5, box: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(line.confidence).toBe(1);
  });

  it("confidenceが負の場合は0にクランプする", () => {
    const [line] = mapToOcrLines([
      { text: "x", confidence: -0.3, box: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(line.confidence).toBe(0);
  });

  it("confidenceがNaN/Infinityなど非有限の場合は0にする", () => {
    const results = mapToOcrLines([
      { text: "a", confidence: Number.NaN, box: { x: 0, y: 0, width: 10, height: 10 } },
      { text: "b", confidence: Number.POSITIVE_INFINITY, box: { x: 0, y: 0, width: 10, height: 10 } },
      { text: "c", confidence: Number.NEGATIVE_INFINITY, box: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(results.map((l) => l.confidence)).toEqual([0, 0, 0]);
  });

  it("box.height<=0の行は除外する", () => {
    const results = mapToOcrLines([
      { text: "zero", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 0 } },
      { text: "negative", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: -5 } },
      { text: "ok", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(results.map((l) => l.text)).toEqual(["ok"]);
  });

  it("boxの値が非有限(NaN/Infinity)の行は除外する", () => {
    const results = mapToOcrLines([
      { text: "nanX", confidence: 0.9, box: { x: Number.NaN, y: 0, width: 10, height: 10 } },
      { text: "nanY", confidence: 0.9, box: { x: 0, y: Number.NaN, width: 10, height: 10 } },
      { text: "infWidth", confidence: 0.9, box: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 } },
      { text: "infHeight", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY } },
      { text: "ok", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(results.map((l) => l.text)).toEqual(["ok"]);
  });

  it("空配列を渡すと空配列を返す", () => {
    expect(mapToOcrLines([])).toEqual([]);
  });
});
