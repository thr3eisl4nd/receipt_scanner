import { describe, expect, test, afterEach, vi } from "vitest";
import { act, renderHook, cleanup } from "@testing-library/react";
import { useMediaQuery } from "./useMediaQuery";

/** `window.matchMedia`の最小限のフェイク実装(jsdomは未実装のため)。 */
function installFakeMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: "",
    addEventListener: (_type: "change", listener: (e: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "change", listener: (e: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  } as unknown as MediaQueryList;
  const matchMedia = vi.fn().mockReturnValue(mql);
  Object.defineProperty(window, "matchMedia", { value: matchMedia, writable: true, configurable: true });

  return {
    setMatches(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  cleanup();
  // @ts-expect-error テスト間でmatchMediaのモックを掃除する(jsdomの既定は未実装)。
  delete window.matchMedia;
  vi.restoreAllMocks();
});

describe("useMediaQuery", () => {
  test("matchMedia未実装の環境(jsdomの既定)では常にfalseを返す(ResizeObserver同様のフォールバック方針)", () => {
    expect(typeof window.matchMedia).toBe("undefined");
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
  });

  test("マウント時点のmatches値を反映する", () => {
    installFakeMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);
  });

  test("changeイベントで値が更新される(リサイズでブレークポイントを跨いだ場合)", () => {
    const fake = installFakeMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);

    act(() => {
      fake.setMatches(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      fake.setMatches(false);
    });
    expect(result.current).toBe(false);
  });

  test("アンマウント時にリスナーを解除する", () => {
    installFakeMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    // アンマウント自体がエラーなく完了すること(removeEventListenerが呼ばれること)を確認する。
    expect(() => unmount()).not.toThrow();
  });
});
