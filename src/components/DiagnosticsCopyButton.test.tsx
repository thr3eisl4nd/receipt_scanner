import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { DiagnosticsCopyButton } from "./DiagnosticsCopyButton";
import type { PhotoDiagnostics } from "../ocr/queue";

/**
 * task-22: 実機診断データのコピーボタン。`SummaryPanel`の「結果をコピー」
 * (`SummaryPanel.test.tsx`)と同じフィードバックパターン(2秒間ラベルを差し替え)を
 * 踏襲しているかを検証する。
 */

function sampleDiagnostics(): PhotoDiagnostics {
  return {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    photoW: 4000,
    photoH: 3000,
    detectCanvasW: 1200,
    detectCanvasH: 800,
    rawBoxes: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
    decision: { kind: "single", regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DiagnosticsCopyButton", () => {
  it("診断データが取得できる場合、JSON整形文字列をクリップボードへ書き込み、2秒後にボタン表示が元に戻る", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();

    const diagnostics = sampleDiagnostics();
    render(<DiagnosticsCopyButton getDiagnostics={() => diagnostics} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "診断データをコピー" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(diagnostics, null, 2));
    // 画像データ・OCR認識テキストを含まないことをコピー内容からも確認する。
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).not.toContain("recognize");
    expect(copiedText).not.toContain("base64");
    expect(screen.getByRole("button", { name: "コピーしました" })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button", { name: "診断データをコピー" })).toBeTruthy();
  });

  it("診断データが無い(直近の写真ジョブがまだ無い)場合、クリップボードへ書き込まずwindow.alertで案内する", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    render(<DiagnosticsCopyButton getDiagnostics={() => null} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "診断データをコピー" }));
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("診断データがありません"));
    expect(screen.getByRole("button", { name: "診断データをコピー" })).toBeTruthy();
  });

  it("クリップボードAPIが失敗したらwindow.alertでエラーを伝える(SummaryPanelの既存パターンを踏襲)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    render(<DiagnosticsCopyButton getDiagnostics={() => sampleDiagnostics()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "診断データをコピー" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalledWith("コピーできませんでした");
    // 失敗時は「コピーしました」へ切り替わらない
    expect(screen.getByRole("button", { name: "診断データをコピー" })).toBeTruthy();
  });

  it("label/classNameを指定するとボタン表示・クラスへ反映される(SummaryPanel隅の控えめな導線用)", () => {
    render(<DiagnosticsCopyButton getDiagnostics={() => null} label="診断データ" className="diagnostics-link" />);
    const button = screen.getByRole("button", { name: "診断データ" });
    expect(button.className).toBe("diagnostics-link");
  });

  it("クリック時点の最新の取得関数の戻り値を使う(refの更新を再レンダー無しで反映できる)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    let current: PhotoDiagnostics | null = null;
    render(<DiagnosticsCopyButton getDiagnostics={() => current} />);

    // マウント後に値が変わっても、コンポーネント自体は再レンダーされない
    // (App.tsx側はrefで保持するため)。クリック時に都度呼び出す`getDiagnostics`が
    // 最新値を返せば正しくコピーされることを確認する。
    current = sampleDiagnostics();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "診断データをコピー" }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(current, null, 2));
  });

  // --- Codexレビュー指摘(Minor)の回帰テスト: タイマーの取り違え・放置 ---
  it("2秒以内に連打しても、後発のクリックのフィードバック表示が先発のタイマーで早期に打ち消されない", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();

    render(<DiagnosticsCopyButton getDiagnostics={() => sampleDiagnostics()} />);
    // ラベルがクリックのたびに変わる(「診断データをコピー」⇄「コピーしました」)ため、
    // 名前を固定せずroleのみで取得する(このコンポーネント単体レンダーではボタンは1つ)。
    const button = () => screen.getByRole("button");

    await act(async () => {
      fireEvent.click(button());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "コピーしました" })).toBeTruthy();

    // 1.5秒後(まだ最初のタイマーは残り0.5秒)に再クリックする。
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await act(async () => {
      fireEvent.click(button());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "コピーしました" })).toBeTruthy();

    // 先発タイマー基準の残り0.5秒が経過しても、後発クリックからは2秒経っていないので
    // 表示は「コピーしました」のまま(先発タイマーが後発の表示を打ち消していないことの確認)。
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("button", { name: "コピーしました" })).toBeTruthy();

    // 後発クリックから2秒経過すると元に戻る。
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("button", { name: "診断データをコピー" })).toBeTruthy();
  });

  it("コピー成功後、フィードバック表示が戻る前にアンマウントしても例外にならない(タイマーをクリーンアップする)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const { unmount } = render(<DiagnosticsCopyButton getDiagnostics={() => sampleDiagnostics()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "診断データをコピー" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "コピーしました" })).toBeTruthy();

    expect(() => unmount()).not.toThrow();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // アンマウント後にタイマーが進んでも(クリーンアップ済みのため)何も起きない。
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(2000);
      });
    }).not.toThrow();
  });
});
