import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  reducer,
  computeTotals,
  buildSummaryText,
  toPersisted,
  fromPersisted,
  type AppState,
  type RowPatch,
} from "./reducer";
import { saveState, loadState } from "./storage";
import type { PersistedState, Row } from "../types";

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

  test("updateRowは小数・NaN・InfinityのamountYenを拒否し行を変更しない", () => {
    const s = reducer(base, { type: "addRows", rows: [row({ id: "a", amountYen: 1000 })] });
    for (const invalid of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const next = reducer(s, { type: "updateRow", id: "a", patch: { amountYen: invalid } });
      expect(next.rows[0].amountYen).toBe(1000);
    }
  });

  test("updateRowはpatchにidが紛れ込んでも元のidを保持する(型はOmit<Row,\"id\">で禁止、実装側でも強制)", () => {
    const s = reducer(base, { type: "addRows", rows: [row({ id: "a" })] });
    const patch = { id: "b", label: "変更後" } as unknown as RowPatch;
    const next = reducer(s, { type: "updateRow", id: "a", patch });
    expect(next.rows.map((r) => r.id)).toEqual(["a"]);
    expect(next.rows[0].label).toBe("変更後");
  });

  test("addRowsは小数・NaN・InfinityのamountYenを含む行を追加しない", () => {
    const s = reducer(base, {
      type: "addRows",
      rows: [
        row({ id: "ok", amountYen: 1000 }),
        row({ id: "bad-decimal", amountYen: 1.5 }),
        row({ id: "bad-nan", amountYen: Number.NaN }),
        row({ id: "bad-inf", amountYen: Number.POSITIVE_INFINITY }),
      ],
    });
    expect(s.rows.map((r) => r.id)).toEqual(["ok"]);
  });

  test("addRowsはamountYen:nullを有効として追加する", () => {
    const s = reducer(base, { type: "addRows", rows: [row({ id: "n", amountYen: null })] });
    expect(s.rows.map((r) => r.id)).toEqual(["n"]);
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

describe("toPersisted/fromPersisted", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("toPersistedは6フィールドのみ保存する(candidates/thumbnailUrl/processing/saveFailedを含まない)", () => {
    const state: AppState = {
      month: "2026-07",
      saveFailed: true,
      rows: [
        {
          id: "a",
          payer: "husband",
          amountYen: 1200,
          label: "レシート",
          status: "needs-review",
          source: "ocr",
          candidates: [1200, 1280],
          thumbnailUrl: "blob:example",
          processing: true,
        },
      ],
    };

    const persisted = toPersisted(state);
    expect(persisted.rows).toEqual([
      { id: "a", payer: "husband", amountYen: 1200, label: "レシート", status: "needs-review", source: "ocr" },
    ]);
    expect(Object.keys(persisted.rows[0]).sort()).toEqual(["amountYen", "id", "label", "payer", "source", "status"]);

    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("candidates");
    expect(serialized).not.toContain("thumbnailUrl");
    expect(serialized).not.toContain("processing");
    expect(serialized).not.toContain("saveFailed");
  });

  test("updatedAtはvi.setSystemTimeで固定した時刻のISO文字列と完全一致する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));
    const state: AppState = { month: "2026-07", saveFailed: false, rows: [] };
    expect(toPersisted(state).updatedAt).toBe("2026-07-27T10:00:00.000Z");
  });

  test("fromPersistedはcandidates:[]とsaveFailed:falseを補完する", () => {
    const persisted: PersistedState = {
      version: 1,
      month: "2026-07",
      updatedAt: "2026-07-27T10:00:00.000Z",
      rows: [{ id: "a", payer: "husband", amountYen: 1200, label: "レシート", status: "confirmed", source: "manual" }],
    };

    const state = fromPersisted(persisted);
    expect(state.saveFailed).toBe(false);
    expect(state.rows).toEqual([
      {
        id: "a",
        payer: "husband",
        amountYen: 1200,
        label: "レシート",
        status: "confirmed",
        source: "manual",
        candidates: [],
      },
    ]);
  });

  test("fromPersistedは永続化データに紛れ込んだ余分なキー(thumbnailUrl/processing)を実行時Rowへ持ち込まない", () => {
    const persistedWithExtras = {
      version: 1,
      month: "2026-07",
      updatedAt: "2026-07-27T10:00:00.000Z",
      rows: [
        {
          id: "a",
          payer: "husband",
          amountYen: 1200,
          label: "レシート",
          status: "confirmed",
          source: "manual",
          thumbnailUrl: "blob:stale",
          processing: true,
        },
      ],
    } as unknown as PersistedState;

    const state = fromPersisted(persistedWithExtras);
    expect(state.rows[0]).not.toHaveProperty("thumbnailUrl");
    expect(state.rows[0]).not.toHaveProperty("processing");
    expect(Object.keys(state.rows[0]).sort()).toEqual([
      "amountYen",
      "candidates",
      "id",
      "label",
      "payer",
      "source",
      "status",
    ]);
  });

  test("負数・nullのamountYenが変化せずtoPersisted→fromPersistedを往復する", () => {
    const state: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [row({ id: "a", amountYen: -1280 }), row({ id: "b", amountYen: null, status: "failed" })],
    };

    const roundTripped = fromPersisted(toPersisted(state));
    expect(roundTripped.rows.map((r) => r.amountYen)).toEqual([-1280, null]);
  });

  test("saveState(toPersisted(state))→loadState→fromPersistedの統合往復", () => {
    const state: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [
        row({ id: "a", amountYen: -500, status: "confirmed" }),
        row({ id: "b", amountYen: null, status: "failed" }),
      ],
    };

    expect(saveState(toPersisted(state))).toBe(true);
    const loaded = loadState();
    expect(loaded).not.toBeNull();

    const restored = fromPersisted(loaded as PersistedState);
    expect(restored.month).toBe(state.month);
    expect(restored.saveFailed).toBe(false);
    expect(restored.rows).toEqual([
      {
        id: "a",
        payer: "husband",
        amountYen: -500,
        label: "レシート",
        status: "confirmed",
        source: "ocr",
        candidates: [],
      },
      {
        id: "b",
        payer: "husband",
        amountYen: null,
        label: "レシート",
        status: "failed",
        source: "ocr",
        candidates: [],
      },
    ]);
  });
});
