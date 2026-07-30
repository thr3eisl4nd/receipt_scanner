import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  reducer,
  computeTotals,
  buildSummaryText,
  toPersisted,
  fromPersisted,
  nextReceiptLabel,
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

  test("addRowsは未知のpayerId(peopleに存在しない)を持つ行を拒否する(Codexレビュー指摘I2: 参照整合性)", () => {
    const s = reducer(base, {
      type: "addRows",
      rows: [row({ id: "ok", payerId: HUSBAND_ID }), row({ id: "orphan", payerId: "not-a-real-person" })],
    });
    expect(s.rows.map((r) => r.id)).toEqual(["ok"]);
  });

  test("updateRowはpatchで未知のpayerIdへ書き換えようとすると行を変更しない(Codexレビュー指摘I2)", () => {
    const s = reducer(base, { type: "addRows", rows: [row({ id: "a", payerId: HUSBAND_ID })] });
    const next = reducer(s, { type: "updateRow", id: "a", patch: { payerId: "not-a-real-person" } });
    expect(next.rows[0].payerId).toBe(HUSBAND_ID);
    expect(next.rows[0]).toBe(s.rows[0]); // 変更されていない証跡
  });

  test("applyOcrResultも未知のpayerIdへの書き換えを拒否する(Codexレビュー指摘I2)", () => {
    const s = reducer(base, {
      type: "addRows",
      rows: [row({ id: "a", payerId: HUSBAND_ID, amountYen: null, status: "failed", processing: true })],
    });
    const next = reducer(s, {
      type: "applyOcrResult",
      id: "a",
      patch: { payerId: "not-a-real-person", amountYen: 1000, status: "auto-high", processing: false },
    });
    expect(next.rows[0].payerId).toBe(HUSBAND_ID);
    expect(next.rows[0].amountYen).toBeNull();
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

  test("addPersonは削除後の再追加で名前・色が同時に重複しない(Codexレビュー指摘I3): わたし(0)/2人目(1)/3人目(2)→2人目削除→追加 で「わたし」「3人目」「4人目」・色0/2/1になる", () => {
    let s = reducer(onePerson, { type: "addPerson" }); // わたし, 2人目(color1)
    s = reducer(s, { type: "addPerson" }); // わたし, 2人目(color1), 3人目(color2)
    expect(s.people.map((p) => p.name)).toEqual(["わたし", "2人目", "3人目"]);

    const secondPersonId = s.people[1].id;
    s = reducer(s, { type: "removePerson", id: secondPersonId }); // わたし(color0), 3人目(color2)
    expect(s.people.map((p) => ({ name: p.name, colorIndex: p.colorIndex }))).toEqual([
      { name: "わたし", colorIndex: 0 },
      { name: "3人目", colorIndex: 2 },
    ]);

    s = reducer(s, { type: "addPerson" });
    // 「3人目」は既に使用中なので飛ばして「4人目」になる(名前の重複を避ける)
    // colorIndexは未使用の1が優先される(色の重複を避ける)
    expect(s.people).toHaveLength(3);
    expect(s.people.map((p) => p.name)).toEqual(["わたし", "3人目", "4人目"]);
    expect(s.people[2].colorIndex).toBe(1);
    // 名前・色のどちらも他の誰とも重複しない
    expect(new Set(s.people.map((p) => p.name)).size).toBe(3);
    expect(new Set(s.people.map((p) => p.colorIndex)).size).toBe(3);
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

  test("renamePersonはtrim後に他の誰かと完全一致する名前を拒否し状態を変更しない(Codexレビュー指摘I3)", () => {
    const twoP: AppState = {
      month: "2026-07",
      people: [person({ id: "p1", name: "夫" }), person({ id: "p2", name: "妻", colorIndex: 1 })],
      rows: [],
      saveFailed: false,
    };
    const s = reducer(twoP, { type: "renamePerson", id: "p1", name: "  妻  " });
    expect(s).toBe(twoP);
    expect(s.people[0].name).toBe("夫");
  });

  test("renamePersonは自分自身への改名(実質無変更)は重複扱いせず許可する", () => {
    const twoP: AppState = {
      month: "2026-07",
      people: [person({ id: "p1", name: "夫" }), person({ id: "p2", name: "妻", colorIndex: 1 })],
      rows: [],
      saveFailed: false,
    };
    const s = reducer(twoP, { type: "renamePerson", id: "p1", name: "夫" });
    expect(s.people[0].name).toBe("夫");
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

describe("replacePendingRow (v1.3 §16.4: プレースホルダ行→N行への原子的置換)", () => {
  test("プレースホルダ行を元の位置でN行に置換し、ラベルを置換時に採番する", () => {
    let s = reducer(base, {
      type: "addRows",
      rows: [
        row({ id: "before", label: "レシート 1", processing: false }),
        row({ id: "placeholder", label: "解析中…", processing: true }),
      ],
    });
    s = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "placeholder",
      newRows: [
        { id: "r1", payerId: HUSBAND_ID },
        { id: "r2", payerId: WIFE_ID },
      ],
    });

    // 元の位置(indexへ)にそのまま挿入され、前後の行の並びは変わらない
    expect(s.rows.map((r) => r.id)).toEqual(["before", "r1", "r2"]);
    expect(s.rows[1]).toMatchObject({
      id: "r1",
      payerId: HUSBAND_ID,
      label: "レシート 2",
      status: "failed",
      source: "ocr",
      amountYen: null,
      processing: true,
    });
    expect(s.rows[2]).toMatchObject({ id: "r2", payerId: WIFE_ID, label: "レシート 3" });
  });

  test("placeholderIdが既に存在しない(削除済み)場合は何もしない(no-op)", () => {
    const s = reducer(base, { type: "addRows", rows: [row({ id: "a" })] });
    const next = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "missing",
      newRows: [{ id: "r1", payerId: HUSBAND_ID }],
    });
    expect(next).toBe(s);
  });

  test("processing:falseの行(=既に手修正済み等)は対象外で置換しない", () => {
    const s = reducer(base, {
      type: "addRows",
      rows: [row({ id: "placeholder", label: "解析中…", processing: false })],
    });
    const next = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "placeholder",
      newRows: [{ id: "r1", payerId: HUSBAND_ID }],
    });
    expect(next).toBe(s);
    expect(next.rows.map((r) => r.id)).toEqual(["placeholder"]);
  });

  test("採番衝突なし: 既存の最大番号より後から連番になり、複数回の置換を経ても重複しない", () => {
    let s = reducer(base, {
      type: "addRows",
      rows: [
        row({ id: "existing", label: "レシート 5", processing: false }),
        row({ id: "ph1", label: "解析中…", processing: true }),
      ],
    });
    s = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "ph1",
      newRows: [
        { id: "r1", payerId: HUSBAND_ID },
        { id: "r2", payerId: HUSBAND_ID },
      ],
    });
    expect(s.rows.map((r) => r.label)).toEqual(["レシート 5", "レシート 6", "レシート 7"]);

    // 2回目の置換(別の写真)も既存ラベルと衝突しない
    s = reducer(s, { type: "addRows", rows: [row({ id: "ph2", label: "解析中…", processing: true })] });
    s = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "ph2",
      newRows: [{ id: "r3", payerId: HUSBAND_ID }],
    });
    const labels = s.rows.map((r) => r.label);
    expect(labels).toEqual(["レシート 5", "レシート 6", "レシート 7", "レシート 8"]);
    expect(new Set(labels).size).toBe(labels.length); // 重複なし
  });

  test("採番済みplaceholderを2件同時追加して順次展開しても、番号が維持されギャップ・重複が出ない(Codexレビュー最終ゲート指摘I3)", () => {
    // 実運用(App.tsx onFiles)では、複数写真を同時追加した時点で各プレースホルダは
    // 既に連番のラベル(「レシート 1」「レシート 2」)を持つ。従来実装は置換時に
    // 「プレースホルダを除いた行群の最大番号+1」から採番していたため、写真Aを
    // 2領域へ展開すると写真Bの「2」が最大値になり、Aが「3」「4」になってしまい
    // (「同じ番号から連番」という設計と矛盾し)、Bの展開時には「1」「2」が失われていた。
    let s = reducer(base, {
      type: "addRows",
      rows: [
        row({ id: "phA", label: "レシート 1", processing: true }),
        row({ id: "phB", label: "レシート 2", processing: true }),
      ],
    });

    // 写真A(プレースホルダ「レシート 1」)を先に2領域へ展開する。
    s = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "phA",
      newRows: [
        { id: "a1", payerId: HUSBAND_ID },
        { id: "a2", payerId: HUSBAND_ID },
      ],
    });
    // Aは自身の番号(1)から連番になり、後続の自動採番行(B=「レシート 2」)は
    // N-1(=1)だけシフトされ「レシート 3」になる(番号が失われない)。
    expect(s.rows.map((r) => ({ id: r.id, label: r.label }))).toEqual([
      { id: "a1", label: "レシート 1" },
      { id: "a2", label: "レシート 2" },
      { id: "phB", label: "レシート 3" },
    ]);

    // 続けて写真B(シフト後は「レシート 3」)を2領域へ展開する。
    s = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "phB",
      newRows: [
        { id: "b1", payerId: HUSBAND_ID },
        { id: "b2", payerId: HUSBAND_ID },
      ],
    });
    const labels = s.rows.map((r) => r.label);
    expect(labels).toEqual(["レシート 1", "レシート 2", "レシート 3", "レシート 4"]);
    expect(new Set(labels).size).toBe(labels.length); // 重複なし、ギャップなし
  });

  test("payerIdがpeopleに存在しないnewRowsエントリは除外する(参照整合性)", () => {
    const s = reducer(base, {
      type: "addRows",
      rows: [row({ id: "placeholder", label: "解析中…", processing: true })],
    });
    const next = reducer(s, {
      type: "replacePendingRow",
      placeholderId: "placeholder",
      newRows: [
        { id: "r1", payerId: HUSBAND_ID },
        { id: "bad", payerId: "unknown-person" },
      ],
    });
    expect(next.rows.map((r) => r.id)).toEqual(["r1"]);
  });

  test("nextReceiptLabelは既存ラベルの最大値の続きから採番する(移設後の単体テスト)", () => {
    const labelFor = nextReceiptLabel([row({ label: "レシート 2" }), row({ label: "レシート 7" }), row({ label: "手動行" })]);
    expect(labelFor(1)).toBe("レシート 8");
    expect(labelFor(2)).toBe("レシート 9");
  });
});
