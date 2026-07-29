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

  it("他の人と同じ名前(trim後の完全一致)へ改名しようとするとrole=alertでエラー表示し、onRenameを呼ばず編集を継続する(Codexレビュー指摘I3)", () => {
    const onRename = vi.fn();
    const people: Person[] = [
      { id: "p1", name: "夫", colorIndex: 0 },
      { id: "p2", name: "妻", colorIndex: 1 },
    ];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={onRename} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "夫の名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  妻  " } });
    fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("同じ名前が既にあります");
    // 編集は継続している(入力欄が残っている)
    expect(screen.getByLabelText("人の名前")).toBeTruthy();
  });

  it("自分自身の現在の名前と同じ(実質無変更)場合は重複エラーにならずonRenameが呼ばれる", () => {
    const onRename = vi.fn();
    const people: Person[] = [
      { id: "p1", name: "夫", colorIndex: 0 },
      { id: "p2", name: "妻", colorIndex: 1 },
    ];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={onRename} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "夫の名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "夫" } });
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith("p1", "夫");
  });

  it("Enterで名前編集を確定すると、編集開始ボタンへキーボードフォーカスが戻る(Codexレビュー指摘I5)", () => {
    const onRename = vi.fn();
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={onRename} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "わたしの名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "たろう" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("p1", "たろう");
    // onRenameを呼んだ側(親)が実際に名前を更新するとは限らないテスト環境のため、
    // ここでは元のprops("わたし")のまま再表示されるボタンにフォーカスが戻ることを確認する。
    const trigger = screen.getByRole("button", { name: "わたしの名前を編集" });
    expect(document.activeElement).toBe(trigger);
  });

  it("Escapeで名前編集をキャンセルすると、編集開始ボタンへキーボードフォーカスが戻る(Codexレビュー指摘I5)", () => {
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={vi.fn()} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "わたしの名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "変更中" } });
    fireEvent.keyDown(input, { key: "Escape" });

    const trigger = screen.getByRole("button", { name: "わたしの名前を編集" });
    expect(document.activeElement).toBe(trigger);
  });

  it("外部クリック相当の通常blur(Tab等)で確定した場合はフォーカスを奪わない(Codexレビュー指摘I5)", () => {
    const onRename = vi.fn();
    // 削除ボタンがdisabledだと(最後の1人)フォーカス移動先に使えないため2人構成にする。
    const people: Person[] = [
      { id: "p1", name: "わたし", colorIndex: 0 },
      { id: "p2", name: "もう一人", colorIndex: 1 },
    ];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={onRename} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "わたしの名前を編集" }));
    const input = screen.getByLabelText("人の名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "たろう" } });
    // 他要素へフォーカスを移してからblurさせる(Tab移動・外部クリック相当)
    const otherButton = screen.getByRole("button", { name: "わたしを削除" }) as HTMLButtonElement;
    otherButton.focus();
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith("p1", "たろう");
    // 編集開始ボタン(再表示された「わたしの名前を編集」)へは戻さない
    const trigger = screen.getByRole("button", { name: "わたしの名前を編集" });
    expect(document.activeElement).not.toBe(trigger);
  });

  it("最後の1人は削除ボタンがdisabledになり理由が表示される(設計ドキュメント§14.1)", () => {
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={vi.fn()} onRemove={vi.fn()} />);

    const deleteButton = screen.getByRole("button", { name: "わたしを削除" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(screen.getByText("最後の1人は削除できません")).toBeTruthy();
  });

  it("削除disabledの理由テキストはaria-describedbyで削除ボタンとプログラム上関連付けられる(Codexレビュー指摘Minor#2)", () => {
    const people: Person[] = [{ id: "p1", name: "わたし", colorIndex: 0 }];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={vi.fn()} onRemove={vi.fn()} />);

    const deleteButton = screen.getByRole("button", { name: "わたしを削除" }) as HTMLButtonElement;
    const describedById = deleteButton.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const reasonEl = document.getElementById(describedById as string);
    expect(reasonEl?.textContent).toBe("最後の1人は削除できません");
  });

  it("削除可能(理由なし)なときはaria-describedbyを付与しない", () => {
    const people: Person[] = [
      { id: "p1", name: "夫", colorIndex: 0 },
      { id: "p2", name: "妻", colorIndex: 1 },
    ];
    render(<PeopleManager people={people} rows={[]} onAdd={vi.fn()} onRename={vi.fn()} onRemove={vi.fn()} />);

    const deleteButton = screen.getByRole("button", { name: "夫を削除" }) as HTMLButtonElement;
    expect(deleteButton.hasAttribute("aria-describedby")).toBe(false);
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
