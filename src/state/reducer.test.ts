import { describe, expect, test } from "vitest";
import { reducer, computeTotals, buildSummaryText, type AppState } from "./reducer";
import type { Row } from "../types";

const row = (over: Partial<Row>): Row => ({
  id: Math.random().toString(36).slice(2),
  payer: "husband",
  amountYen: 1000,
  label: "レシート",
  status: "auto-high",
  source: "ocr",
  candidates: [],
  ...over,
});

const base: AppState = { month: "2026-07", rows: [], saveFailed: false };

describe("reducer", () => {
  test("addRows/updateRow/removeRow", () => {
    let s = reducer(base, { type: "addRows", rows: [row({ id: "a" }), row({ id: "b" })] });
    expect(s.rows).toHaveLength(2);
    s = reducer(s, { type: "updateRow", id: "a", patch: { amountYen: 500, status: "confirmed" } });
    expect(s.rows[0].amountYen).toBe(500);
    s = reducer(s, { type: "removeRow", id: "a" });
    expect(s.rows.map((r) => r.id)).toEqual(["b"]);
  });

  test("clearMonthで全行が消え月が変わる", () => {
    let s = reducer(base, { type: "addRows", rows: [row({})] });
    s = reducer(s, { type: "clearMonth", month: "2026-08" });
    expect(s.rows).toEqual([]);
    expect(s.month).toBe("2026-08");
  });
});

describe("computeTotals", () => {
  test("payer別合計と差額(夫-妻)。amountYen=nullは0扱い", () => {
    const t = computeTotals([
      row({ payer: "husband", amountYen: 100000 }),
      row({ payer: "wife", amountYen: 30000 }),
      row({ payer: "wife", amountYen: 10000 }),
      row({ payer: "wife", amountYen: null, status: "failed" }),
    ]);
    expect(t.husbandYen).toBe(100000);
    expect(t.wifeYen).toBe(40000);
    expect(t.deltaYen).toBe(60000);
  });

  test("負の金額(返品)も合算される", () => {
    const t = computeTotals([row({ amountYen: 1000 }), row({ amountYen: -300 })]);
    expect(t.husbandYen).toBe(700);
  });

  test("unconfirmedはneeds-reviewとfailedの件数", () => {
    const t = computeTotals([
      row({ status: "needs-review" }),
      row({ status: "failed", amountYen: null }),
      row({ status: "confirmed" }),
    ]);
    expect(t.unconfirmed).toBe(2);
  });
});

describe("buildSummaryText", () => {
  test("月・両者合計・差額方向を含む", () => {
    const s: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [row({ payer: "husband", amountYen: 100000 }), row({ payer: "wife", amountYen: 40000 })],
    };
    const text = buildSummaryText(s);
    expect(text).toContain("2026-07");
    expect(text).toContain("100,000");
    expect(text).toContain("40,000");
    expect(text).toContain("夫が 60,000円 多く支払い");
  });

  test("未確認があれば警告行を含む", () => {
    const s: AppState = { month: "2026-07", saveFailed: false, rows: [row({ status: "failed", amountYen: null })] };
    expect(buildSummaryText(s)).toContain("未確認 1件");
  });
});
