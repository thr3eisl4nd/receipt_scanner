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
import type { Person, PersistedState, Row } from "../types";

const HUSBAND_ID = "husband-id";
const WIFE_ID = "wife-id";

const person = (over: Partial<Person>): Person => ({
  id: HUSBAND_ID,
  name: "夫",
  colorIndex: 0,
  ...over,
});

const row = (over: Partial<Row>): Row => ({
  id: Math.random().toString(36).slice(2),
  payerId: HUSBAND_ID,
  amountYen: 1000,
  label: "レシート",
  status: "auto-high",
  source: "ocr",
  candidates: [],
  ...over,
});

const twoPeople: Person[] = [person({ id: HUSBAND_ID, name: "夫", colorIndex: 0 }), person({ id: WIFE_ID, name: "妻", colorIndex: 1 })];

const base: AppState = { month: "2026-07", people: twoPeople, rows: [], saveFailed: false };

describe("reducer", () => {
  test("addRows/updateRow/removeRow", () => {
    let s = reducer(base, { type: "addRows", rows: [row({ id: "a" }), row({ id: "b" })] });
    expect(s.rows).toHaveLength(2);
    s = reducer(s, { type: "updateRow", id: "a", patch: { amountYen: 500, status: "confirmed" } });
    expect(s.rows[0].amountYen).toBe(500);
    s = reducer(s, { type: "removeRow", id: "a" });
    expect(s.rows.map((r) => r.id)).toEqual(["b"]);
  });

  test("setSaveFailedは同値なら同一stateを返す(Codexレビュー指摘M1: 不要な再描画の防止)", () => {
    const s = { ...base, saveFailed: false };
    const same = reducer(s, { type: "setSaveFailed", value: false });
    expect(same).toBe(s);

    const changed = reducer(s, { type: "setSaveFailed", value: true });
    expect(changed).not.toBe(s);
    expect(changed.saveFailed).toBe(true);
  });

  test("clearMonthで全行が消え月が変わるが、人(people)は引き継がれる(月をまたいで使い続けるため)", () => {
    let s = reducer(base, { type: "addRows", rows: [row({})] });
    s = reducer(s, { type: "clearMonth", month: "2026-08" });
    expect(s.rows).toEqual([]);
    expect(s.month).toBe("2026-08");
    expect(s.people).toEqual(twoPeople);
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

  test("applyOcrResultはprocessing:trueの行にのみパッチを適用する(Codexレビュー指摘C1)", () => {
    const s = reducer(base, {
      type: "addRows",
      rows: [row({ id: "a", amountYen: null, status: "failed", processing: true })],
    });
    const next = reducer(s, {
      type: "applyOcrResult",
      id: "a",
      patch: { amountYen: 1234, status: "auto-high", candidates: [], processing: false },
    });
    expect(next.rows[0]).toMatchObject({ amountYen: 1234, status: "auto-high", processing: false });
  });

  test("applyOcrResultはprocessing:falseの行(=手修正済み)には適用しない。OCR処理中の手修正が遅延結果で上書きされる回帰を防ぐ(Codexレビュー指摘C1)", () => {
    // 再現順序: 1) 行が処理中で表示 2) ユーザーが5,000円へ手修正(processing:falseになる)
    // 3) 数秒後に遅れて1,234円のOCR結果が到着 → 5,000円が無警告で上書きされてはならない
    let s = reducer(base, {
      type: "addRows",
      rows: [row({ id: "a", amountYen: null, status: "failed", processing: true })],
    });
    // ユーザーの手修正(ReceiptRow.commitEditと同じ形): processing:falseを含む
    s = reducer(s, {
      type: "updateRow",
      id: "a",
      patch: { amountYen: 5000, status: "confirmed", candidates: [], processing: false },
    });
    expect(s.rows[0]).toMatchObject({ amountYen: 5000, status: "confirmed", processing: false });

    // 遅延OCR結果が後から到着してもprocessing:falseの行には適用されない
    const next = reducer(s, {
      type: "applyOcrResult",
      id: "a",
      patch: { amountYen: 1234, status: "auto-high", candidates: [], processing: false },
    });
    expect(next.rows[0]).toMatchObject({ amountYen: 5000, status: "confirmed" });
    expect(next.rows[0]).toBe(s.rows[0]); // 対象外の行はmap内でも同一参照のまま(変更されていない証跡)
  });

  test("applyOcrResultも小数・NaN・InfinityのamountYenを拒否し行を変更しない", () => {
    const s = reducer(base, {
      type: "addRows",
      rows: [row({ id: "a", amountYen: 1000, processing: true })],
    });
    const next = reducer(s, {
      type: "applyOcrResult",
      id: "a",
      patch: { amountYen: Number.NaN, status: "auto-high", candidates: [], processing: false },
    });
    expect(next.rows[0].amountYen).toBe(1000);
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

describe("addPerson/renamePerson/removePerson", () => {
  const onePerson: AppState = {
    month: "2026-07",
    people: [person({ id: "p1", name: "わたし", colorIndex: 0 })],
    rows: [],
    saveFailed: false,
  };

  test("addPersonは「N人目」(現在の人数+1)を追加し、colorIndexは現在の人数を連番で使う", () => {
    let s = reducer(onePerson, { type: "addPerson" });
    expect(s.people).toHaveLength(2);
    expect(s.people[1]).toMatchObject({ name: "2人目", colorIndex: 1 });

    s = reducer(s, { type: "addPerson" });
    expect(s.people).toHaveLength(3);
    expect(s.people[2]).toMatchObject({ name: "3人目", colorIndex: 2 });

    // idはユニーク
    expect(new Set(s.people.map((p) => p.id)).size).toBe(3);
  });

  test("renamePersonはtrimして反映する", () => {
    const s = reducer(onePerson, { type: "renamePerson", id: "p1", name: "  たろう  " });
    expect(s.people[0].name).toBe("たろう");
  });

  test("renamePersonは空文字(trim後)を拒否し状態を変更しない", () => {
    const s = reducer(onePerson, { type: "renamePerson", id: "p1", name: "   " });
    expect(s).toBe(onePerson);
    expect(s.people[0].name).toBe("わたし");
  });

  test("removePersonは対象の人の行が1件でもあれば拒否する(設計ドキュメント§14.1)", () => {
    const twoP: AppState = {
      month: "2026-07",
      people: [person({ id: "p1", name: "夫" }), person({ id: "p2", name: "妻", colorIndex: 1 })],
      rows: [row({ id: "r1", payerId: "p1" })],
      saveFailed: false,
    };
    const s = reducer(twoP, { type: "removePerson", id: "p1" });
    expect(s).toBe(twoP);
    expect(s.people).toHaveLength(2);
  });

  test("removePersonは行が0件ならその人を削除できる", () => {
    const twoP: AppState = {
      month: "2026-07",
      people: [person({ id: "p1", name: "夫" }), person({ id: "p2", name: "妻", colorIndex: 1 })],
      rows: [row({ id: "r1", payerId: "p2" })],
      saveFailed: false,
    };
    const s = reducer(twoP, { type: "removePerson", id: "p1" });
    expect(s.people.map((p) => p.id)).toEqual(["p2"]);
  });

  test("removePersonは最後の1人を拒否する(行が0件でも)", () => {
    const s = reducer(onePerson, { type: "removePerson", id: "p1" });
    expect(s).toBe(onePerson);
    expect(s.people).toHaveLength(1);
  });

  test("removePersonは存在しないidを渡されても状態を変更しない", () => {
    const twoP: AppState = {
      month: "2026-07",
      people: [person({ id: "p1" }), person({ id: "p2", colorIndex: 1 })],
      rows: [],
      saveFailed: false,
    };
    const s = reducer(twoP, { type: "removePerson", id: "not-exist" });
    expect(s).toBe(twoP);
  });
});

describe("computeTotals", () => {
  test("人別合計。amountYen=nullは0扱い", () => {
    const t = computeTotals(twoPeople, [
      row({ payerId: HUSBAND_ID, amountYen: 100000 }),
      row({ payerId: WIFE_ID, amountYen: 30000 }),
      row({ payerId: WIFE_ID, amountYen: 10000 }),
      row({ payerId: WIFE_ID, amountYen: null, status: "failed" }),
    ]);
    expect(t.totals).toEqual([
      { personId: HUSBAND_ID, name: "夫", colorIndex: 0, amountYen: 100000, count: 1 },
      { personId: WIFE_ID, name: "妻", colorIndex: 1, amountYen: 40000, count: 3 },
    ]);
  });

  test("負の金額(返品)も合算される", () => {
    const t = computeTotals(twoPeople, [row({ payerId: HUSBAND_ID, amountYen: 1000 }), row({ payerId: HUSBAND_ID, amountYen: -300 })]);
    expect(t.totals[0].amountYen).toBe(700);
  });

  test("unconfirmedはneeds-reviewとfailedの件数", () => {
    const t = computeTotals(twoPeople, [
      row({ status: "needs-review" }),
      row({ status: "failed", amountYen: null }),
      row({ status: "confirmed" }),
    ]);
    expect(t.unconfirmed).toBe(2);
  });

  test("ちょうど2人のときのみ差額(方向付き)を算出する(設計ドキュメント§14.3)", () => {
    const t = computeTotals(twoPeople, [
      row({ payerId: HUSBAND_ID, amountYen: 100000 }),
      row({ payerId: WIFE_ID, amountYen: 40000 }),
    ]);
    expect(t.delta).toEqual({ moreId: HUSBAND_ID, amountYen: 60000 });
  });

  test("2人で差額0なら moreId:null (差額なし)", () => {
    const t = computeTotals(twoPeople, [
      row({ payerId: HUSBAND_ID, amountYen: 500 }),
      row({ payerId: WIFE_ID, amountYen: 500 }),
    ]);
    expect(t.delta).toEqual({ moreId: null, amountYen: 0 });
  });

  test("1人のときはdelta:null(差額行を出さない)", () => {
    const onePeople = [person({ id: "p1", name: "わたし" })];
    const t = computeTotals(onePeople, [row({ payerId: "p1", amountYen: 1000 })]);
    expect(t.delta).toBeNull();
  });

  test("3人以上のときはdelta:null(差額行を出さない)", () => {
    const threePeople = [
      person({ id: "p1", name: "A", colorIndex: 0 }),
      person({ id: "p2", name: "B", colorIndex: 1 }),
      person({ id: "p3", name: "C", colorIndex: 2 }),
    ];
    const t = computeTotals(threePeople, [
      row({ payerId: "p1", amountYen: 100000 }),
      row({ payerId: "p2", amountYen: 40000 }),
      row({ payerId: "p3", amountYen: 10000 }),
    ]);
    expect(t.delta).toBeNull();
    expect(t.totals.map((x) => x.amountYen)).toEqual([100000, 40000, 10000]);
  });
});

describe("buildSummaryText", () => {
  test("月・人別合計・差額方向を含む(2人)", () => {
    const s: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ payerId: HUSBAND_ID, amountYen: 100000 }), row({ payerId: WIFE_ID, amountYen: 40000 })],
    };
    const text = buildSummaryText(s);
    expect(text).toContain("2026-07");
    expect(text).toContain("夫: 100,000円 (1件)");
    expect(text).toContain("妻: 40,000円 (1件)");
    expect(text).toContain("差額: 夫が 60,000円 多く支払い");
  });

  test("1人のときは差額行を含まない", () => {
    const onePeople = [person({ id: "p1", name: "わたし" })];
    const s: AppState = {
      month: "2026-07",
      people: onePeople,
      saveFailed: false,
      rows: [row({ payerId: "p1", amountYen: 1000 })],
    };
    const text = buildSummaryText(s);
    expect(text).toContain("わたし: 1,000円 (1件)");
    expect(text).not.toContain("差額");
  });

  test("3人以上のときは各人の合計を列挙し、差額行を含まない", () => {
    const threePeople = [
      person({ id: "p1", name: "A", colorIndex: 0 }),
      person({ id: "p2", name: "B", colorIndex: 1 }),
      person({ id: "p3", name: "C", colorIndex: 2 }),
    ];
    const s: AppState = {
      month: "2026-07",
      people: threePeople,
      saveFailed: false,
      rows: [row({ payerId: "p1", amountYen: 100000 }), row({ payerId: "p2", amountYen: 40000 }), row({ payerId: "p3", amountYen: 10000 })],
    };
    const text = buildSummaryText(s);
    expect(text).toContain("A: 100,000円 (1件)");
    expect(text).toContain("B: 40,000円 (1件)");
    expect(text).toContain("C: 10,000円 (1件)");
    expect(text).not.toContain("差額");
  });

  test("未確認があれば警告行を含む", () => {
    const s: AppState = { month: "2026-07", people: twoPeople, saveFailed: false, rows: [row({ status: "failed", amountYen: null })] };
    expect(buildSummaryText(s)).toContain("未確認 1件");
  });
});

describe("toPersisted/fromPersisted", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("toPersistedはversion:2で、rowsは6フィールドのみ保存する(candidates/thumbnailUrl/processing/saveFailedを含まない)", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: true,
      rows: [
        {
          id: "a",
          payerId: HUSBAND_ID,
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
    expect(persisted.version).toBe(2);
    expect(persisted.people).toEqual(twoPeople);
    expect(persisted.rows).toEqual([
      { id: "a", payerId: HUSBAND_ID, amountYen: 1200, label: "レシート", status: "needs-review", source: "ocr" },
    ]);
    expect(Object.keys(persisted.rows[0]).sort()).toEqual(["amountYen", "id", "label", "payerId", "source", "status"]);

    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("candidates");
    expect(serialized).not.toContain("thumbnailUrl");
    expect(serialized).not.toContain("processing");
    expect(serialized).not.toContain("saveFailed");
  });

  test("updatedAtはvi.setSystemTimeで固定した時刻のISO文字列と完全一致する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));
    const state: AppState = { month: "2026-07", people: twoPeople, saveFailed: false, rows: [] };
    expect(toPersisted(state).updatedAt).toBe("2026-07-27T10:00:00.000Z");
  });

  test("fromPersistedはcandidates:[]とsaveFailed:falseを補完する", () => {
    const persisted: PersistedState = {
      version: 2,
      month: "2026-07",
      updatedAt: "2026-07-27T10:00:00.000Z",
      people: twoPeople,
      rows: [{ id: "a", payerId: HUSBAND_ID, amountYen: 1200, label: "レシート", status: "confirmed", source: "manual" }],
    };

    const state = fromPersisted(persisted);
    expect(state.saveFailed).toBe(false);
    expect(state.people).toEqual(twoPeople);
    expect(state.rows).toEqual([
      {
        id: "a",
        payerId: HUSBAND_ID,
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
      version: 2,
      month: "2026-07",
      updatedAt: "2026-07-27T10:00:00.000Z",
      people: twoPeople,
      rows: [
        {
          id: "a",
          payerId: HUSBAND_ID,
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
      "payerId",
      "source",
      "status",
    ]);
  });

  test("負数・nullのamountYenが変化せずtoPersisted→fromPersistedを往復する", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a", amountYen: -1280 }), row({ id: "b", amountYen: null, status: "failed" })],
    };

    const roundTripped = fromPersisted(toPersisted(state));
    expect(roundTripped.rows.map((r) => r.amountYen)).toEqual([-1280, null]);
  });

  test("saveState(toPersisted(state))→loadState→fromPersistedの統合往復", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
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
    expect(restored.people).toEqual(twoPeople);
    expect(restored.rows).toEqual([
      {
        id: "a",
        payerId: HUSBAND_ID,
        amountYen: -500,
        label: "レシート",
        status: "confirmed",
        source: "ocr",
        candidates: [],
      },
      {
        id: "b",
        payerId: HUSBAND_ID,
        amountYen: null,
        label: "レシート",
        status: "failed",
        source: "ocr",
        candidates: [],
      },
    ]);
  });
});
