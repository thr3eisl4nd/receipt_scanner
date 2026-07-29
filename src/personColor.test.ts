import { describe, expect, test } from "vitest";
import { PERSON_COLOR_COUNT, personColorClass } from "./personColor";

describe("personColorClass", () => {
  test("0からパレット長-1まではそのままの番号のクラスになる", () => {
    for (let i = 0; i < PERSON_COLOR_COUNT; i++) {
      expect(personColorClass(i)).toBe(`person-color-${i}`);
    }
  });

  test("パレット長を超える値は巡回して丸め込まれる(削除・再追加で連番が増え続けても破綻しない)", () => {
    expect(personColorClass(PERSON_COLOR_COUNT)).toBe("person-color-0");
    expect(personColorClass(PERSON_COLOR_COUNT + 3)).toBe("person-color-3");
    expect(personColorClass(100)).toBe(`person-color-${100 % PERSON_COLOR_COUNT}`);
  });

  test("負数でも有効なクラス名(0以上)になる(想定外入力に対する防御)", () => {
    expect(personColorClass(-1)).toBe(`person-color-${PERSON_COLOR_COUNT - 1}`);
  });
});
