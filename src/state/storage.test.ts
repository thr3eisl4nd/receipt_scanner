import { beforeEach, describe, expect, test } from "vitest";
import { saveState, loadState, clearState, currentMonth } from "./storage";
import type { PersistedState } from "../types";

const valid: PersistedState = {
  version: 1,
  month: "2026-07",
  updatedAt: "2026-07-27T10:00:00.000Z",
  rows: [
    { id: "a", payer: "husband", amountYen: 1332, label: "レシート 1", status: "auto-high", source: "ocr" },
  ],
};

beforeEach(() => localStorage.clear());

describe("storage", () => {
  test("save→loadで往復できる", () => {
    expect(saveState(valid)).toBe(true);
    expect(loadState()).toEqual(valid);
  });

  test("未保存ならnull", () => {
    expect(loadState()).toBeNull();
  });

  test("壊れたJSONはnull(例外を投げない)", () => {
    localStorage.setItem("receipt-scanner:state:v1", "{oops");
    expect(loadState()).toBeNull();
  });

  test("スキーマ不一致(versionなし・rowsが配列でない)はnull", () => {
    localStorage.setItem("receipt-scanner:state:v1", JSON.stringify({ version: 99 }));
    expect(loadState()).toBeNull();
    localStorage.setItem("receipt-scanner:state:v1", JSON.stringify({ version: 1, month: "x", updatedAt: "x", rows: "no" }));
    expect(loadState()).toBeNull();
  });

  test("clearStateで消える", () => {
    saveState(valid);
    clearState();
    expect(loadState()).toBeNull();
  });

  test("currentMonthはYYYY-MM形式", () => {
    expect(currentMonth()).toMatch(/^\d{4}-\d{2}$/);
  });
});
