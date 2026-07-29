import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { saveState, loadState, clearState, currentMonth, migrateV1ToV2, STORAGE_KEY } from "./storage";
import type { PersistedState, PersistedStateV1, Person, Row } from "../types";

const PERSON_ID = "person-a";

const valid: PersistedState = {
  version: 2,
  month: "2026-07",
  updatedAt: "2026-07-27T10:00:00.000Z",
  people: [{ id: PERSON_ID, name: "夫", colorIndex: 0 }],
  rows: [
    { id: "a", payerId: PERSON_ID, amountYen: 1332, label: "レシート 1", status: "auto-high", source: "ocr" },
  ],
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("storage", () => {
  test("save→loadで往復できる", () => {
    expect(saveState(valid)).toBe(true);
    expect(loadState()).toEqual(valid);
  });

  test("未保存ならnull", () => {
    expect(loadState()).toBeNull();
  });

  test("壊れたJSONはnull(例外を投げない)", () => {
    localStorage.setItem(STORAGE_KEY, "{oops");
    expect(loadState()).toBeNull();
  });

  test("スキーマ不一致(versionなし・rowsが配列でない)はnull", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99 }));
    expect(loadState()).toBeNull();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, month: "x", updatedAt: "x", people: [], rows: "no" }));
    expect(loadState()).toBeNull();
  });

  test.each([
    ["monthの形式不正", { ...valid, month: "x" }],
    ["存在しない月", { ...valid, month: "2026-13" }],
    ["updatedAtの形式不正", { ...valid, updatedAt: "x" }],
  ])("%sはnull", (_label, value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    expect(loadState()).toBeNull();
  });

  test("peopleが空配列はnull(1人以上が必須、設計ドキュメント§14.2)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...valid, people: [] }));
    expect(loadState()).toBeNull();
  });

  test("peopleの名前が空文字・colorIndexが負/非整数・idが重複しているとnull", () => {
    const cases: Person[][] = [
      [{ id: PERSON_ID, name: "", colorIndex: 0 }],
      [{ id: PERSON_ID, name: "夫", colorIndex: -1 }],
      [{ id: PERSON_ID, name: "夫", colorIndex: 1.5 }],
      [
        { id: PERSON_ID, name: "夫", colorIndex: 0 },
        { id: PERSON_ID, name: "妻", colorIndex: 1 },
      ],
    ];
    for (const people of cases) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...valid, people }));
      expect(loadState()).toBeNull();
    }
  });

  test("rows.payerIdがpeopleに存在しないとnull(参照整合性、設計ドキュメント§14.2)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...valid, rows: [{ ...valid.rows[0], payerId: "not-a-real-person" }] }),
    );
    expect(loadState()).toBeNull();
  });

  test("行IDが空文字だとnull(Codexレビュー指摘Minor#3)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...valid, rows: [{ ...valid.rows[0], id: "" }] }));
    expect(loadState()).toBeNull();
  });

  test("行IDが重複しているとnull(Codexレビュー指摘Minor#3: 重複するとupdateRow/removeRowが複数行へ同時作用してしまう)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...valid, rows: [valid.rows[0], { ...valid.rows[0], amountYen: 999 }] }),
    );
    expect(loadState()).toBeNull();
  });

  test("saveStateも重複した行IDを拒否する(false)", () => {
    expect(saveState({ ...valid, rows: [valid.rows[0], { ...valid.rows[0], amountYen: 999 }] })).toBe(false);
  });

  test("clearStateで消える(trueを返す)", () => {
    saveState(valid);
    expect(clearState()).toBe(true);
    expect(loadState()).toBeNull();
  });

  test("clearState: localStorage.removeItemが例外を投げてもクラッシュせずfalseを返す(Codexレビュー指摘: 呼び出し側が削除失敗を検知できる必要がある)", () => {
    saveState(valid);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(clearState()).toBe(false);
  });

  test("小数のamountYenは保存しない(false)", () => {
    const invalid: PersistedState = {
      ...valid,
      rows: [{ ...valid.rows[0], amountYen: 1.5 }],
    };

    expect(saveState(invalid)).toBe(false);
    expect(loadState()).toBeNull();
  });

  test("返金・取消の負数amountYenは保存でき往復できる", () => {
    const refund: PersistedState = {
      ...valid,
      rows: [{ ...valid.rows[0], amountYen: -1280 }],
    };

    expect(saveState(refund)).toBe(true);
    expect(loadState()).toEqual(refund);
  });

  test("容量超過時は例外を投げずfalseを返す", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    expect(saveState(valid)).toBe(false);
  });

  test("candidates/thumbnailUrl/processingが混入したRowでも余分なキーを保存しない", () => {
    const rowWithExtras: Row = {
      ...valid.rows[0],
      candidates: [1200, 1280],
      thumbnailUrl: "blob:example",
      processing: true,
    };

    expect(saveState({ ...valid, rows: [rowWithExtras] })).toBe(true);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("candidates");
    expect(raw).not.toContain("thumbnailUrl");
    expect(raw).not.toContain("processing");
    expect(loadState()).toEqual(valid);
  });

  test("currentMonthは現在のローカル年月を返す", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    expect(currentMonth()).toBe("2026-01");
    vi.useRealTimers();
  });
});

describe("v1→v2自動移行(設計ドキュメント§14.2)", () => {
  const v1Base = (rows: PersistedStateV1["rows"]): PersistedStateV1 => ({
    version: 1,
    month: "2026-07",
    updatedAt: "2026-07-27T10:00:00.000Z",
    rows,
  });

  test("husband行のみ: 「夫」「妻」の両方を常に生成し(v1利用者は夫婦2人運用だったため)、行は夫のpayerIdのみを参照する", () => {
    const v1 = v1Base([
      { id: "a", payer: "husband", amountYen: 1000, label: "レシート 1", status: "confirmed", source: "ocr" },
      { id: "b", payer: "husband", amountYen: 2000, label: "レシート 2", status: "auto-high", source: "ocr" },
    ]);
    const v2 = migrateV1ToV2(v1);

    expect(v2.version).toBe(2);
    expect(v2.month).toBe(v1.month);
    expect(v2.updatedAt).toBe(v1.updatedAt);
    expect(v2.people).toHaveLength(2);
    expect(v2.people[0]).toMatchObject({ name: "夫", colorIndex: 0 });
    expect(v2.people[1]).toMatchObject({ name: "妻", colorIndex: 1 });
    const husbandId = v2.people[0].id;
    expect(v2.rows).toEqual([
      { id: "a", payerId: husbandId, amountYen: 1000, label: "レシート 1", status: "confirmed", source: "ocr" },
      { id: "b", payerId: husbandId, amountYen: 2000, label: "レシート 2", status: "auto-high", source: "ocr" },
    ]);
  });

  test("wife行のみ: 「夫」「妻」の両方を常に生成し、行は妻のpayerIdのみを参照する", () => {
    const v1 = v1Base([
      { id: "a", payer: "wife", amountYen: 3000, label: "レシート 1", status: "manual", source: "manual" },
    ]);
    const v2 = migrateV1ToV2(v1);

    expect(v2.people).toHaveLength(2);
    expect(v2.people[0]).toMatchObject({ name: "夫", colorIndex: 0 });
    expect(v2.people[1]).toMatchObject({ name: "妻", colorIndex: 1 });
    expect(v2.rows).toEqual([
      { id: "a", payerId: v2.people[1].id, amountYen: 3000, label: "レシート 1", status: "manual", source: "manual" },
    ]);
  });

  test("husband/wife混在: 両方の人を生成し、各行が対応するpayerIdを参照する", () => {
    const v1 = v1Base([
      { id: "a", payer: "husband", amountYen: 1000, label: "レシート 1", status: "confirmed", source: "ocr" },
      { id: "b", payer: "wife", amountYen: 2000, label: "レシート 2", status: "confirmed", source: "ocr" },
      { id: "c", payer: "husband", amountYen: null, label: "レシート 3", status: "failed", source: "ocr" },
    ]);
    const v2 = migrateV1ToV2(v1);

    expect(v2.people).toHaveLength(2);
    expect(v2.people[0]).toMatchObject({ name: "夫", colorIndex: 0 });
    expect(v2.people[1]).toMatchObject({ name: "妻", colorIndex: 1 });
    const husbandId = v2.people[0].id;
    const wifeId = v2.people[1].id;
    expect(v2.rows.map((r) => r.payerId)).toEqual([husbandId, wifeId, husbandId]);
    // idやamountYen等、payer以外のフィールドはそのまま保持される(データを一切失わない)
    expect(v2.rows[2]).toMatchObject({ id: "c", amountYen: null, label: "レシート 3", status: "failed" });
  });

  test("行IDが重複していても、丸ごと拒否せず2件目以降を新UUIDへ再採番して全行を保持する(Codexレビュー指摘Minor#3)", () => {
    const v1 = v1Base([
      { id: "dup", payer: "husband", amountYen: 1000, label: "レシート 1", status: "confirmed", source: "ocr" },
      { id: "dup", payer: "wife", amountYen: 2000, label: "レシート 2", status: "confirmed", source: "ocr" },
      { id: "dup", payer: "husband", amountYen: 3000, label: "レシート 3", status: "confirmed", source: "ocr" },
    ]);
    const v2 = migrateV1ToV2(v1);

    // データを1件も捨てない
    expect(v2.rows).toHaveLength(3);
    // 最初に登場したIDはそのまま、2件目以降は新しいIDへ差し替わり全行が一意になる
    expect(v2.rows[0].id).toBe("dup");
    expect(v2.rows[1].id).not.toBe("dup");
    expect(v2.rows[2].id).not.toBe("dup");
    expect(new Set(v2.rows.map((r) => r.id)).size).toBe(3);
    // id以外のフィールドは維持される
    expect(v2.rows.map((r) => r.amountYen)).toEqual([1000, 2000, 3000]);
    // 再採番後も含めisValidV2相当(行ID一意)を満たすため、そのまま保存できる
    expect(saveState(v2)).toBe(true);
  });

  test("行IDが空文字のv1データはisValidV1に拒否され、loadStateはnullを返す(v2としても不正なので移行されない)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        v1Base([{ id: "", payer: "husband", amountYen: 1000, label: "レシート 1", status: "confirmed", source: "ocr" }]),
      ),
    );
    expect(loadState()).toBeNull();
  });

  test("空(rowsが0件)でも「夫」「妻」の両方を生成する(v1利用者は夫婦2人運用だったため、行の有無に関わらず両方生成する)", () => {
    const v1 = v1Base([]);
    const v2 = migrateV1ToV2(v1);

    expect(v2.people).toHaveLength(2);
    expect(v2.people[0]).toMatchObject({ name: "夫", colorIndex: 0 });
    expect(v2.people[1]).toMatchObject({ name: "妻", colorIndex: 1 });
    expect(v2.rows).toEqual([]);
  });

  test("移行結果はisValidV2相当の検証を満たし、loadStateでv1データを読むと自動的にv2として返る(両方の人が生成される)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        v1Base([{ id: "a", payer: "wife", amountYen: 500, label: "レシート 1", status: "confirmed", source: "ocr" }]),
      ),
    );

    const loaded = loadState();
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(2);
    expect(loaded?.people).toHaveLength(2);
    expect(loaded?.people.map((p) => p.name)).toEqual(["夫", "妻"]);
    expect(loaded?.rows[0].payerId).toBe(loaded?.people[1].id);
  });
});
