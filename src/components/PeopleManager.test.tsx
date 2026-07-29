import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import type { Person, Row } from "../types";
import { PeopleManager } from "./PeopleManager";

afterEach(() => {
  cleanup();
});

const row = (over: Partial<Row> = {}): Row => ({
  id: Math.random().toString(36).slice(2),
  payerId: "p1",
  amountYen: 1000,
  label: "レシート",
  status: "auto-high",
  source: "ocr",
  candidates: [],
  ...over,
});

describe("PeopleManager", () => {
  it("「+ 人を追加」ボタンでonAddを呼び出す", () => {
    const onAdd = vi.fn();
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={onAdd} onRename={vi.fn()} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "+ 人を追加" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("名前をタップして編集し、確定するとonRenameが呼ばれる", () => {
    const onRename = vi.fn();
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={onRename} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "わたしの名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  たろう  " } });
    fireEvent.blur(input);

    // trimして反映される
    expect(onRename).toHaveBeenCalledWith("p1", "たろう");
  });

  it("空文字(trim後)で確定しようとするとrole=alertでエラー表示し、onRenameを呼ばず編集を継続する", () => {
    const onRename = vi.fn();
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={onRename} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "わたしの名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("名前を入力してください");
    // 編集は継続している(入力欄が残っている)
    expect(screen.getByLabelText("人の名前")).toBeTruthy();
  });

  it("Escapeで編集をキャンセルし元の名前に戻る(onRenameは呼ばれない)", () => {
    const onRename = vi.fn();
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={onRename} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "わたしの名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "変更中" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "わたしの名前を編集" }).textContent).toBe("わたし");
  });

  it("最後の1人は削除ボタンがdisabledになり理由が表示される(設計ドキュメント§14.1)", () => {
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={vi.fn()} onRemove={vi.fn()} />);

    const deleteButton = screen.getByRole("button", { name: "わたしを削除" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(screen.getByText("最後の1人は削除できません")).toBeTruthy();
  });

  it("その人の行が残っている場合は削除ボタンがdisabledになり件数入りの理由が表示される", () => {
    const people: Person[] = [
      { id: "p1", name: "夫", colorIndex: 0 },
      { id: "p2", name: "妻", colorIndex: 1 },
    ];
    const rows = [row({ payerId: "p1" }), row({ payerId: "p1" })];
    render(<PeopleManager people={people} rows={rows} onAdd={vi.fn()} onRename={vi.fn()} onRemove={vi.fn()} />);

    const husbandItem = screen.getByRole("button", { name: "夫の名前を編集" }).closest("li") as HTMLElement;
    expect((within(husbandItem).getByRole("button", { name: "夫を削除" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(husbandItem).getByText("夫の行が2件あるため削除できません")).toBeTruthy();

    // 行が無い人(妻)は削除可能
    const wifeItem = screen.getByRole("button", { name: "妻の名前を編集" }).closest("li") as HTMLElement;
    expect((within(wifeItem).getByRole("button", { name: "妻を削除" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("行が0件かつ2人以上いれば削除ボタンが有効になり、クリックでonRemoveが呼ばれる", () => {
    const onRemove = vi.fn();
    const people: Person[] = [
      { id: "p1", name: "夫", colorIndex: 0 },
      { id: "p2", name: "妻", colorIndex: 1 },
    ];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={vi.fn()} onRemove={onRemove} />);

    const deleteButton = screen.getByRole("button", { name: "妻を削除" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);
    fireEvent.click(deleteButton);
    expect(onRemove).toHaveBeenCalledWith("p2");
  });
});
