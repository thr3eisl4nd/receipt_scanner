import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { GeminiSettingsPanel } from "./GeminiSettingsPanel";
import type { GeminiSettings } from "../gemini/settings";

afterEach(() => {
  cleanup();
});

const settings = (over: Partial<GeminiSettings> = {}): GeminiSettings => ({ apiKey: "", enabled: false, ...over });

describe("GeminiSettingsPanel", () => {
  it("初期状態では設定パネルは折りたたまれている(歯車ボタンのみ表示)", () => {
    render(<GeminiSettingsPanel settings={settings()} onApiKeyChange={vi.fn()} onEnabledChange={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /Gemini連携の設定/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Gemini APIキー")).toBeNull();
  });

  it("歯車ボタンをタップすると設定パネルが開く", () => {
    render(<GeminiSettingsPanel settings={settings()} onApiKeyChange={vi.fn()} onEnabledChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini連携の設定/ }));
    expect(screen.getByLabelText("Gemini APIキー")).toBeTruthy();
  });

  it("画像がGoogleに送信される旨の明示的な注意書きを表示する", () => {
    render(<GeminiSettingsPanel settings={settings()} onApiKeyChange={vi.fn()} onEnabledChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini連携の設定/ }));
    const notice = document.querySelector(".gemini-settings-notice");
    expect(notice?.textContent).toMatch(/Google/);
    expect(notice?.textContent).toMatch(/送信/);
  });

  it("APIキー入力を変更するとonApiKeyChangeが呼ばれる", () => {
    const onApiKeyChange = vi.fn();
    render(<GeminiSettingsPanel settings={settings()} onApiKeyChange={onApiKeyChange} onEnabledChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini連携の設定/ }));
    fireEvent.change(screen.getByLabelText("Gemini APIキー"), { target: { value: "AIzaSyTest" } });
    expect(onApiKeyChange).toHaveBeenCalledWith("AIzaSyTest");
  });

  it("APIキーが未設定(空)の間、有効化トグルはdisabledになる", () => {
    render(<GeminiSettingsPanel settings={settings({ apiKey: "" })} onApiKeyChange={vi.fn()} onEnabledChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini連携の設定/ }));
    const enabledToggle = screen.getByRole("checkbox", { name: /AI読み取り.*(有効|使う)/ }) as HTMLInputElement;
    expect(enabledToggle.disabled).toBe(true);
  });

  it("APIキー設定済みなら有効化トグルが操作可能になり、切り替えるとonEnabledChangeが呼ばれる", () => {
    const onEnabledChange = vi.fn();
    render(
      <GeminiSettingsPanel
        settings={settings({ apiKey: "AIzaSyTest", enabled: false })}
        onApiKeyChange={vi.fn()}
        onEnabledChange={onEnabledChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Gemini連携の設定/ }));
    const enabledToggle = screen.getByRole("checkbox", { name: /AI読み取り.*(有効|使う)/ }) as HTMLInputElement;
    expect(enabledToggle.disabled).toBe(false);
    fireEvent.click(enabledToggle);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("「キーの発行方法」の折りたたみガイドにAI Studioへのリンクを含む", () => {
    render(<GeminiSettingsPanel settings={settings()} onApiKeyChange={vi.fn()} onEnabledChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini連携の設定/ }));
    const link = screen.getByRole("link", { name: /aistudio\.google\.com|AI Studio/i });
    expect(link.getAttribute("href")).toContain("aistudio.google.com");
  });

  it("APIキー入力は既定でマスクされ(type=password)、表示切り替えボタンでtextに切り替わる", () => {
    render(<GeminiSettingsPanel settings={settings({ apiKey: "secret" })} onApiKeyChange={vi.fn()} onEnabledChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini連携の設定/ }));
    const input = screen.getByLabelText("Gemini APIキー") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /表示/ }));
    expect(input.type).toBe("text");
  });
});
