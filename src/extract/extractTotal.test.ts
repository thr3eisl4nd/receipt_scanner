import { describe, expect, test } from "vitest";
import { extractTotal } from "./extractTotal";
import * as fx from "./fixtures/synthetic";

describe("extractTotal", () => {
  test("標準レシート: 合計を採用し、お預り・お釣り・小計を選ばない", () => {
    const r = extractTotal(fx.supermarket);
    expect(r.amountYen).toBe(1332);
    expect(r.status).toBe("auto-high");
  });

  test("税率別表記: 8%/10%対象ではなく合計を採用", () => {
    const r = extractTotal(fx.taxBreakdown);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("キーワードなし: failed(最大値フォールバック禁止)", () => {
    const r = extractTotal(fx.truncated);
    expect(r.amountYen).toBeNull();
    expect(r.status).toBe("failed");
    expect(r.candidates).toEqual([]); // キーワード無しなら候補も出さない
  });

  test("キーワードの1行下の金額も拾う", () => {
    const r = extractTotal(fx.totalOnNextLine);
    expect(r.amountYen).toBe(3980);
    expect(r.status).toBe("auto-high");
  });

  test("現計+全角末尾ハイフン", () => {
    const r = extractTotal(fx.genkei);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("空入力はfailed", () => {
    expect(extractTotal([]).status).toBe("failed");
  });
});
