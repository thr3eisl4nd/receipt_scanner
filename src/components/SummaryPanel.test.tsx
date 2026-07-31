import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { buildSummaryText, type AppState } from "../state/reducer";
import type { Person, Row } from "../types";
import { SummaryPanel } from "./SummaryPanel";

const HUSBAND: Person = { id: "husband-id", name: "夫", colorIndex: 0 };
const WIFE: Person = { id: "wife-id", name: "妻", colorIndex: 1 };
const twoPeople = [HUSBAND, WIFE];

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "id",
    payerId: HUSBAND.id,
    amountYen: 1000,
    label: "レシート",
    status: "confirmed",
    source: "ocr",
    candidates: [],
    ...overrides,
  };
}

/** スマホ・タブレット(<1024px、既定折りたたみ)で本文操作ボタンをクリックする前に
 *  展開しておくためのヘルパー(Codexレビュー v1.4指摘I4: 既定値をexpanded:falseへ変更
 *  したため、本文内のボタンは展開しないとアクセシビリティツリー上見つからない)。 */
function expandSummary() {
  fireEvent.click(screen.getByRole("button", { name: /集計を展開/ }));
}

/** `window.matchMedia`をPC(>=1024px)向けにモックする(jsdomは未実装のため、既定では
 *  `useMediaQuery`は常にfalse=モバイル扱いを返す。Codexレビュー v1.4指摘I3のPC分岐を
 *  検証するために使う)。 */
function mockDesktopMatchMedia(matches: boolean) {
  const mql = {
    matches,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  } as unknown as MediaQueryList;
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn().mockReturnValue(mql),
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // @ts-expect-error jsdomの既定(matchMedia未実装)へ戻す。
  delete window.matchMedia;
});

describe("SummaryPanel", () => {
  it("人別合計/差額(方向付き)のみを表示し、清算額(差額÷2)は一切表示しない(スペック§5.5/§6・§14.3準拠)", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [
        row({ id: "a", payerId: HUSBAND.id, amountYen: 3000 }),
        row({ id: "b", payerId: WIFE.id, amountYen: 1000 }),
      ],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

    const panel = screen.getByLabelText("集計");
    expect(panel.textContent).toContain("3,000円");
    expect(panel.textContent).toContain("1,000円");
    expect(panel.textContent).toContain("夫が 2,000円 多く支払い");
    // 折半での清算額(1,000円)は絶対に表示してはならない
    expect(panel.textContent).not.toContain("清算額");
    expect(panel.textContent).not.toMatch(/1,000円.*払[えっ]/);
  });

  it("差額0件のときは「差額なし」と表示する(2人)", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a", payerId: HUSBAND.id, amountYen: 500 }), row({ id: "b", payerId: WIFE.id, amountYen: 500 })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    expect(screen.getByLabelText("集計").textContent).toContain("差額なし");
  });

  it("妻の方が多く払った場合は「妻が」の向きで表示する", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a", payerId: HUSBAND.id, amountYen: 500 }), row({ id: "b", payerId: WIFE.id, amountYen: 2000 })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    expect(screen.getByLabelText("集計").textContent).toContain("妻が 1,500円 多く支払い");
  });

  it("人が1人のときは差額行を表示しない(設計ドキュメント§14.3)", () => {
    const state: AppState = {
      month: "2026-07",
      people: [{ id: "solo", name: "わたし", colorIndex: 0 }],
      saveFailed: false,
      rows: [row({ id: "a", payerId: "solo", amountYen: 1000 })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    const panel = screen.getByLabelText("集計");
    expect(panel.textContent).toContain("1,000円");
    expect(panel.textContent).not.toContain("差額");
  });

  it("人が3人のときは各人の合計を表示し、差額行は表示しない(設計ドキュメント§14.3)", () => {
    const threePeople: Person[] = [
      { id: "p1", name: "A", colorIndex: 0 },
      { id: "p2", name: "B", colorIndex: 1 },
      { id: "p3", name: "C", colorIndex: 2 },
    ];
    const state: AppState = {
      month: "2026-07",
      people: threePeople,
      saveFailed: false,
      rows: [
        row({ id: "a", payerId: "p1", amountYen: 3000 }),
        row({ id: "b", payerId: "p2", amountYen: 2000 }),
        row({ id: "c", payerId: "p3", amountYen: 1000 }),
      ],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    const panel = screen.getByLabelText("集計");
    expect(panel.textContent).toContain("3,000円");
    expect(panel.textContent).toContain("2,000円");
    expect(panel.textContent).toContain("1,000円");
    expect(panel.textContent).not.toContain("差額");
  });

  it("needs-review/failed行がある場合のみ未確認警告を件数付きで表示する", () => {
    const clean: AppState = { month: "2026-07", people: twoPeople, saveFailed: false, rows: [row({ id: "a" })] };
    const { rerender } = render(<SummaryPanel state={clean} onNewMonth={vi.fn()} />);
    expect(screen.queryByText(/未確認/)).toBeNull();

    const withUnconfirmed: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a" }), row({ id: "b", status: "failed", amountYen: null }), row({ id: "c", status: "needs-review" })],
    };
    rerender(<SummaryPanel state={withUnconfirmed} onNewMonth={vi.fn()} />);
    expect(screen.getByText("⚠ 未確認 2件")).toBeTruthy();
  });

  it("「新しい月を始める」ボタンはonNewMonthをそのまま呼び出す(確認ダイアログはApp側の責務)", () => {
    const onNewMonth = vi.fn();
    const state: AppState = { month: "2026-07", people: twoPeople, saveFailed: false, rows: [] };
    render(<SummaryPanel state={state} onNewMonth={onNewMonth} />);

    // 既定は折りたたみ(Codexレビュー v1.4指摘I4)のため、本文操作ボタンは展開してから
    // クリックする。
    expandSummary();
    fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));
    expect(onNewMonth).toHaveBeenCalledTimes(1);
  });

  it("結果をコピー: buildSummaryTextの内容をクリップボードへ書き込み、2秒後にボタン表示が元に戻る", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();

    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a", payerId: HUSBAND.id, amountYen: 1000 })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    expandSummary();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "結果をコピー" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(buildSummaryText(state));
    expect(screen.getByRole("button", { name: "コピーしました" })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button", { name: "結果をコピー" })).toBeTruthy();
  });

  it("未確認が残っている場合、コピー前に確認ダイアログを出し、キャンセルするとクリップボードへ書き込まない", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a", status: "failed", amountYen: null })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    expandSummary();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "結果をコピー" }));
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("未確認が 1件"));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "結果をコピー" })).toBeTruthy();
  });

  it("クリップボードAPIが失敗したらwindow.alertでエラーを伝える", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    const state: AppState = { month: "2026-07", people: twoPeople, saveFailed: false, rows: [row({ id: "a" })] };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    expandSummary();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "結果をコピー" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalledWith("コピーできませんでした");
  });

  it("折りたたみトグル(設計ドキュメント§17.9改訂・Codexレビュー v1.4指摘I4): 既定は折りたたみ状態で、トグルで展開・再度の折りたたみができる", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a", payerId: HUSBAND.id, amountYen: 3000 }), row({ id: "b", payerId: WIFE.id, amountYen: 1000 })],
    };
    const { container } = render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

    // 既定(折りたたみ)でも合計行(トグル)には4,000円(全員の合計)が出ているが、
    // 内訳(3,000円/1,000円)を含む本文はhidden属性でアクセシビリティツリーから
    // 除外されている(hidden属性はテキストノード自体を削除するわけではないため、
    // ここでは`hidden`プロパティで検証する。`getByText`はhidden配下でも見つかって
    // しまうため内訳の非表示確認には使わない)。
    const toggle = screen.getByRole("button", { name: /集計を展開/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("4,000円");
    const body = container.querySelector(".summary-body") as HTMLElement;
    expect(body.hidden).toBe(true);

    // トグルを押すと展開され、内訳(本文)がhidden属性で見えるようになる。
    fireEvent.click(toggle);
    const expandedToggle = screen.getByRole("button", { name: /集計を折りたたむ/ });
    expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    expect(screen.getByText("3,000円")).toBeTruthy();

    // もう一度押すと折りたたみに戻る。
    fireEvent.click(expandedToggle);
    expect(screen.getByRole("button", { name: /集計を展開/ }).getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
  });

  it("折りたたみトグルは`aria-label`でボタン名を丸ごと上書きせず、見た目のラベル(合計・金額)を含んだアクセシブルネームを構成する(Codexレビュー v1.4指摘I5: WCAG 2.5.3 Label in Name)", () => {
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [
        row({ id: "a", payerId: HUSBAND.id, amountYen: 4000 }),
        row({ id: "b", payerId: WIFE.id, status: "needs-review", amountYen: 0 }),
      ],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: /^合計4,000円/ });
    // 見た目のラベル「合計」「4,000円」がアクセシブルネームの先頭に含まれる(Label in Name)。
    expect(toggle.textContent?.startsWith("合計")).toBe(true);
    // 折りたたみ時、未確認件数はドットが`aria-hidden`でも`.sr-only`テキストとして
    // アクセシブルネームに含まれる(従来はドットのみでスクリーンリーダーへ伝わらなかった)。
    expect(toggle.textContent).toContain("未確認 1件");
  });

  it("PC(>=1024px、Codexレビュー v1.4指摘I3): 折りたたみトグルの代わりに「合計」見出しと全員合計を常時表示し、本文は常に表示状態(hidden=false)になる", () => {
    mockDesktopMatchMedia(true);
    const state: AppState = {
      month: "2026-07",
      people: twoPeople,
      saveFailed: false,
      rows: [row({ id: "a", payerId: HUSBAND.id, amountYen: 3000 }), row({ id: "b", payerId: WIFE.id, amountYen: 1000 })],
    };
    const { container } = render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

    // トグルボタン自体が存在しない(PCでは折りたたみに意味が無いため)。
    expect(screen.queryByRole("button", { name: /集計を(展開|折りたたむ)/ })).toBeNull();

    const heading = container.querySelector(".summary-desktop-heading") as HTMLElement;
    expect(heading).toBeTruthy();
    expect(heading.textContent).toContain("合計");
    expect(heading.textContent).toContain("4,000円");

    // 本文の`hidden`属性は常にfalse(CSSのdisplay:blockでの上書きに頼らない、指摘I3)。
    const body = container.querySelector(".summary-body") as HTMLElement;
    expect(body.hidden).toBe(false);
    expect(screen.getByText("3,000円")).toBeTruthy();
    expect(screen.getByText("1,000円")).toBeTruthy();
  });

  it("マウント時にResizeObserverで実高さを--summary-panel-heightへ反映し、アンマウントで解除する(Codexレビュー v1.2再指摘I2)", () => {
    // サマリーは「1人1行」で可変高になったため、`.receipt-paper`側の固定230px予約では
    // 人数・名前の長さによって最終コンテンツが隠れる退行があった。ResizeObserverで
    // 実測した高さがCSSカスタムプロパティへ反映されることを検証する
    // (jsdomは実レイアウトを行わないため、`getBoundingClientRect`をスタブして
    // 「観測された高さがそのままpxで反映される」という配線自体を確認する)。
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 274.4,
      width: 640,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect);

    try {
      const state: AppState = { month: "2026-07", people: twoPeople, saveFailed: false, rows: [row({ id: "a" })] };
      const { unmount } = render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

      // Math.ceil(274.4) = 275
      expect(document.documentElement.style.getPropertyValue("--summary-panel-height")).toBe("275px");

      unmount();
      expect(document.documentElement.style.getPropertyValue("--summary-panel-height")).toBe("");
    } finally {
      rectSpy.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
