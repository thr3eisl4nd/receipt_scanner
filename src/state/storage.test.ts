import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { saveState, loadState, clearState, currentMonth, STORAGE_KEY } from "./storage";
import type { PersistedState, Row } from "../types";

const valid: PersistedState = {
  version: 1,
  month: "2026-07",
  updatedAt: "2026-07-27T10:00:00.000Z",
  rows: [
    { id: "a", payer: "husband", amountYen: 1332, label: "レシート 1", status: "auto-high", source: "ocr" },
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, month: "x", updatedAt: "x", rows: "no" }));
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

  test("clearStateで消える", () => {
    saveState(valid);
    clearState();
    expect(loadState()).toBeNull();
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
