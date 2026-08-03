import { beforeEach, describe, expect, test } from "vitest";
import {
  API_KEY_STORAGE_KEY,
  ENABLED_STORAGE_KEY,
  isGeminiActive,
  loadGeminiSettings,
  saveGeminiApiKey,
  saveGeminiEnabled,
} from "./settings";

describe("gemini/settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("初回起動(未保存)時はapiKey:''・enabled:falseを返す", () => {
    expect(loadGeminiSettings()).toEqual({ apiKey: "", enabled: false });
  });

  test("saveGeminiApiKey/saveGeminiEnabledで保存した値をloadGeminiSettingsが読み込む", () => {
    expect(saveGeminiApiKey("AIzaSyTest1234")).toBe(true);
    expect(saveGeminiEnabled(true)).toBe(true);
    expect(loadGeminiSettings()).toEqual({ apiKey: "AIzaSyTest1234", enabled: true });
  });

  test("APIキーは既存のPersistedState(receipt-scanner:state:v1)とは別のlocalStorageキーに保存する(スキーマ非改変)", () => {
    saveGeminiApiKey("secret-key");
    expect(localStorage.getItem(API_KEY_STORAGE_KEY)).toBe("secret-key");
    // v2永続化スキーマのキー名と衝突しないこと
    expect(API_KEY_STORAGE_KEY).not.toBe("receipt-scanner:state:v1");
  });

  test("空文字を保存するとキー自体が削除される(以後loadGeminiSettingsは''を返す)", () => {
    saveGeminiApiKey("some-key");
    expect(saveGeminiApiKey("")).toBe(true);
    expect(localStorage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
    expect(loadGeminiSettings().apiKey).toBe("");
  });

  test("enabledはtrue/falseどちらも保存・復元できる", () => {
    saveGeminiEnabled(true);
    expect(loadGeminiSettings().enabled).toBe(true);
    saveGeminiEnabled(false);
    expect(loadGeminiSettings().enabled).toBe(false);
  });

  test("localStorageアクセス自体が例外を投げる場合はsaveがfalseを返し、loadは空/falseにフォールバックする", () => {
    const original = window.localStorage;
    const throwing: Storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      clear: () => {},
      key: () => null,
      length: 0,
    };
    try {
      Object.defineProperty(window, "localStorage", { value: throwing, configurable: true });
      expect(saveGeminiApiKey("x")).toBe(false);
      expect(saveGeminiEnabled(true)).toBe(false);
      expect(loadGeminiSettings()).toEqual({ apiKey: "", enabled: false });
    } finally {
      Object.defineProperty(window, "localStorage", { value: original, configurable: true });
    }
  });

  test("isGeminiActive: enabled:trueかつapiKeyが空白のみでない場合のみtrue", () => {
    expect(isGeminiActive({ apiKey: "abc", enabled: true })).toBe(true);
    expect(isGeminiActive({ apiKey: "abc", enabled: false })).toBe(false);
    expect(isGeminiActive({ apiKey: "", enabled: true })).toBe(false);
    expect(isGeminiActive({ apiKey: "   ", enabled: true })).toBe(false);
  });

  test("ENABLED_STORAGE_KEYもAPI_KEY_STORAGE_KEYも'receipt-scanner:gemini:'名前空間を使う", () => {
    expect(API_KEY_STORAGE_KEY.startsWith("receipt-scanner:gemini:")).toBe(true);
    expect(ENABLED_STORAGE_KEY.startsWith("receipt-scanner:gemini:")).toBe(true);
  });
});
