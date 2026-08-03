import { beforeEach, describe, expect, test } from "vitest";
import {
  API_KEY_STORAGE_KEY,
  ENABLED_STORAGE_KEY,
  forgetGeminiSettings,
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

  test("enabledはtrue/falseどちらも保存・復元できる(APIキー設定済みの場合)", () => {
    saveGeminiApiKey("some-key");
    saveGeminiEnabled(true);
    expect(loadGeminiSettings().enabled).toBe(true);
    saveGeminiEnabled(false);
    expect(loadGeminiSettings().enabled).toBe(false);
  });

  // Codexレビュー指摘Important#3: APIキーが空のままenabled:trueが保存されている
  // (直接localStorageを編集された等の)状態でも、読み込み側で不変条件を強制する。
  test("APIキーが空の状態でenabled:trueが保存されていても、loadGeminiSettingsはenabled:falseに矯正する", () => {
    saveGeminiEnabled(true);
    expect(localStorage.getItem(ENABLED_STORAGE_KEY)).toBe("1"); // 保存自体はそのまま行われる
    expect(loadGeminiSettings()).toEqual({ apiKey: "", enabled: false });
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

  // task-27セキュリティレビュー指摘(Medium): localStorageはオリジン単位のため、平文APIキーを
  // 能動的に削除できる導線が必要。forgetGeminiSettingsはキー削除・無効化を一括で行う。
  test("forgetGeminiSettings: 保存済みのAPIキーを削除し、有効フラグもfalseへ戻す", () => {
    saveGeminiApiKey("AIzaSyTest1234");
    saveGeminiEnabled(true);
    expect(forgetGeminiSettings()).toBe(true);
    expect(localStorage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
    expect(loadGeminiSettings()).toEqual({ apiKey: "", enabled: false });
  });
});
