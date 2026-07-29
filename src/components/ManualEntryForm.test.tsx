import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Person, Row } from "../types";
import { ManualEntryForm } from "./ManualEntryForm";

afterEach(() => {
  cleanup();
});

const people: Person[] = [
  { id: "husband-id", name: "夫", colorIndex: 0 },
  { id: "wife-id", name: "妻", colorIndex: 1 },
];

const nameInput = () => screen.getByLabelText("支出の名前") as HTMLInputElement;
const amountInput = () => screen.getByLabelText("追加する金額(円)") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: "追加" });
const signToggle = () => screen.getByRole("button", { name: "追加する金額を返品・取消として入力" });
const payerSelect = () => screen.getByLabelText("支払った人") as HTMLSelectElement;

describe("ManualEntryForm", () => {
  it("名前・金額・支払者を入力して追加すると、manual/source:manualの行がonAddへ渡され、入力欄がリセットされる", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={people} onAdd={onAdd} />);

    fireEvent.change(nameInput(), { target: { value: "家賃" } });
    fireEvent.change(amountInput(), { target: { value: "80000" } });
    fireEvent.change(payerSelect(), { target: { value: "wife-id" } });
    fireEvent.click(submitButton());

    expect(onAdd).toHaveBeenCalledTimes(1);
    const row = onAdd.mock.calls[0][0] as Row;
    expect(row).toMatchObject({
      payerId: "wife-id",
      amountYen: 80000,
      label: "家賃",
      status: "manual",
      source: "manual",
      candidates: [],
    });
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);

    // 追加後は名前・金額欄がクリアされる(支払った人の選択は維持される。同じ支払者の
    // 光熱費等をまとめて追加する操作を想定)
    expect(nameInput().value).toBe("");
    expect(amountInput().value).toBe("");
    expect(payerSelect().value).toBe("wife-id");
  });

  it("人リストから選択肢が動的生成される(設計ドキュメント§14.1)", () => {
    render(<ManualEntryForm people={people} onAdd={vi.fn()} />);
    const options = [...payerSelect().options].map((o) => ({ value: o.value, text: o.textContent }));
    expect(options).toEqual([
      { value: "husband-id", text: "夫が支払い" },
      { value: "wife-id", text: "妻が支払い" },
    ]);
    // 既定の選択は先頭の人
    expect(payerSelect().value).toBe("husband-id");
  });

  it("名前が空欄だとrole=alertでエラー表示し、名前欄だけにaria-invalid/aria-describedbyが付く(Codexレビュー指摘: エラー対象欄の明示)", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={people} onAdd={onAdd} />);

    fireEvent.change(amountInput(), { target: { value: "1000" } });
    fireEvent.click(submitButton());

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("名前を入力してください");
    expect(onAdd).not.toHaveBeenCalled();

    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().getAttribute("aria-describedby")).toBe(alert.id);
    // 金額欄はこのエラーの対象ではないので、誤ってinvalid扱いにしない
    expect(amountInput().getAttribute("aria-invalid")).toBe("false");
    expect(amountInput().hasAttribute("aria-describedby")).toBe(false);
  });

  it("金額が不正(除去してから解釈せずinvalid判定)だとrole=alertでエラー表示し、入力値を保持したまま追加されない。金額欄だけにaria-invalid/aria-describedbyが付く(ReceiptRowと同じparseYen方式)", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={people} onAdd={onAdd} />);

    fireEvent.change(nameInput(), { target: { value: "駐車場代" } });
    fireEvent.change(amountInput(), { target: { value: "12abc34" } });
    fireEvent.click(submitButton());

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("金額は数字で入力してください");
    expect(onAdd).not.toHaveBeenCalled();
    // 入力値は消えない(ユーザーが再度直せるように)
    expect(nameInput().value).toBe("駐車場代");
    expect(amountInput().value).toBe("12abc34");

    expect(amountInput().getAttribute("aria-invalid")).toBe("true");
    expect(amountInput().getAttribute("aria-describedby")).toBe(alert.id);
    expect(nameInput().getAttribute("aria-invalid")).toBe("false");
    expect(nameInput().hasAttribute("aria-describedby")).toBe(false);
  });

  it("金額欄は空欄もエラー扱いになる(手動追加はレシートのように空欄→failedへ倒れる仕組みがないため)", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={people} onAdd={onAdd} />);

    fireEvent.change(nameInput(), { target: { value: "電気代" } });
    fireEvent.click(submitButton());

    expect(screen.getByRole("alert").textContent).toContain("金額は数字で入力してください");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("全角数字・カンマ・円記号を含む金額を正しく解釈する(ReceiptRowのparseYenを流用)", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={people} onAdd={onAdd} />);

    fireEvent.change(nameInput(), { target: { value: "水道代" } });
    fireEvent.change(amountInput(), { target: { value: "１，２３４円" } });
    fireEvent.click(submitButton());

    expect((onAdd.mock.calls[0][0] as Row).amountYen).toBe(1234);
  });

  it("返品・取消として入力ボタン(符号切替)で負数を入力でき、キーボードのマイナスキーなしでも返品を追加できる", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={people} onAdd={onAdd} />);

    fireEvent.change(nameInput(), { target: { value: "商品券払い戻し" } });
    fireEvent.change(amountInput(), { target: { value: "500" } });
    expect(signToggle().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(signToggle());
    expect(signToggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(submitButton());

    expect((onAdd.mock.calls[0][0] as Row).amountYen).toBe(-500);
  });

  it("直接マイナス記号を入力しても負数として追加できる(手入力の返品)", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={people} onAdd={onAdd} />);

    fireEvent.change(nameInput(), { target: { value: "返品" } });
    fireEvent.change(amountInput(), { target: { value: "-1280" } });
    fireEvent.click(submitButton());

    expect((onAdd.mock.calls[0][0] as Row).amountYen).toBe(-1280);
  });

  it("人が1人のみでも選択肢が1件生成され、その人が既定で選択される", () => {
    const onAdd = vi.fn();
    render(<ManualEntryForm people={[{ id: "solo", name: "わたし", colorIndex: 0 }]} onAdd={onAdd} />);

    expect(payerSelect().value).toBe("solo");
    fireEvent.change(nameInput(), { target: { value: "食費" } });
    fireEvent.change(amountInput(), { target: { value: "1000" } });
    fireEvent.click(submitButton());

    expect((onAdd.mock.calls[0][0] as Row).payerId).toBe("solo");
  });
});
