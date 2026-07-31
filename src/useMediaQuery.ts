import { useEffect, useState } from "react";

/**
 * `window.matchMedia`をReactの状態として購読する小さなフック(Codexレビューv1.4指摘I3)。
 *
 * `SummaryPanel`がPC(>=1024px)で「合計」見出し+全員合計を常時表示し、スマホ・
 * タブレットでは折りたたみトグルを表示する、という描画の出し分けに使う。従来は
 * CSSの`display:none`/`display:block`だけで出し分けており、JSX側の`hidden`属性が
 * 実際の表示状態と一致しない状態(hidden属性が付いたままCSSでdisplay:blockに
 * 上書きされる)が生じていた。JS側でブレークポイントを判定し、`hidden`属性自体を
 * 正しい値にすることで、ネイティブの`hidden`セマンティクスを壊さずに描画を切り替える。
 *
 * jsdom(Vitestのテスト環境)は`matchMedia`未実装のため、存在しない環境では常に`false`
 * (=モバイル/タブレット扱い)を返す(ResizeObserverと同様のフォールバック方針、
 * `SummaryPanel.tsx`のResizeObserver未実装時ガードを参照)。
 */
export function useMediaQuery(query: string): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [matches, setMatches] = useState(() => (supported ? window.matchMedia(query).matches : false));

  useEffect(() => {
    if (!supported) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    // Safari <14等、addEventListener未対応の古いMediaQueryList向けフォールバック。
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, [query, supported]);

  return matches;
}
