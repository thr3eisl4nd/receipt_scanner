import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { buildSummaryText, type AppState } from "../state/reducer";
import type { Row } from "../types";
import { SummaryPanel } from "./SummaryPanel";

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "id",
    payer: "husband",
    amountYen: 1000,
    label: "レシート",
    status: "confirmed",
    source: "ocr",
    candidates: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SummaryPanel", () => {
  it("夫合計/妻合計/差額(方向付き)のみを表示し、清算額(差額÷2)は一切表示しない(スペック§5.5/§6準拠)", () => {
    const state: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [
        row({ id: "a", payer: "husband", amountYen: 3000 }),
        row({ id: "b", payer: "wife", amountYen: 1000 }),
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

  it("差額0件のときは「差額なし」と表示する", () => {
    const state: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [row({ id: "a", payer: "husband", amountYen: 500 }), row({ id: "b", payer: "wife", amountYen: 500 })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    expect(screen.getByLabelText("集計").textContent).toContain("差額なし");
  });

  it("妻の方が多く払った場合は「妻が」の向きで表示する", () => {
    const state: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [row({ id: "a", payer: "husband", amountYen: 500 }), row({ id: "b", payer: "wife", amountYen: 2000 })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);
    expect(screen.getByLabelText("集計").textContent).toContain("妻が 1,500円 多く支払い");
  });

  it("needs-review/failed行がある場合のみ未確認警告を件数付きで表示する", () => {
    const clean: AppState = { month: "2026-07", saveFailed: false, rows: [row({ id: "a" })] };
    const { rerender } = render(<SummaryPanel state={clean} onNewMonth={vi.fn()} />);
    expect(screen.queryByText(/未確認/)).toBeNull();

    const withUnconfirmed: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [row({ id: "a" }), row({ id: "b", status: "failed", amountYen: null }), row({ id: "c", status: "needs-review" })],
    };
    rerender(<SummaryPanel state={withUnconfirmed} onNewMonth={vi.fn()} />);
    expect(screen.getByText("⚠ 未確認 2件")).toBeTruthy();
  });

  it("「新しい月を始める」ボタンはonNewMonthをそのまま呼び出す(確認ダイアログはApp側の責務)", () => {
    const onNewMonth = vi.fn();
    const state: AppState = { month: "2026-07", saveFailed: false, rows: [] };
    render(<SummaryPanel state={state} onNewMonth={onNewMonth} />);

    fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));
    expect(onNewMonth).toHaveBeenCalledTimes(1);
  });

  it("結果をコピー: buildSummaryTextの内容をクリップボードへ書き込み、2秒後にボタン表示が元に戻る", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();

    const state: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [row({ id: "a", payer: "husband", amountYen: 1000 })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

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
      saveFailed: false,
      rows: [row({ id: "a", status: "failed", amountYen: null })],
    };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

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

    const state: AppState = { month: "2026-07", saveFailed: false, rows: [row({ id: "a" })] };
    render(<SummaryPanel state={state} onNewMonth={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "結果をコピー" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalledWith("コピーできませんでした");
  });
});
