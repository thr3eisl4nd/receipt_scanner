import { StrictMode, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import type { OcrEngine } from "./ocr/engine";
import type { RowPatch } from "./state/reducer";
import type { QueueStatusEvent, RegionDescriptor, RegionGroupFlags } from "./ocr/queue";
import type { FailureKind } from "./types";
import { STORAGE_KEY } from "./state/storage";
import App from "./App";

/**
 * App.tsxが実際に生成する`createPpuPaddleEngine()`はppu-paddle-ocr/web(ONNX実行環境)を
 * 読み込むため、jsdom環境のスモークテストでは実体を使わずダミーengineへ差し替える。
 * queue自体もengineへ触れる前にキャンバス処理(jsdomに無い実Canvas API)へ依存するため、
 * createOcrQueueもモックし、渡されたコールバック(onStatus/onThumbnail/onResult)を捕捉して
 * テスト側からOCR完了・サムネイル到着を疑似的に発火できるようにする。
 *
 * `vi.mock`ファクトリ内から参照する変数は`vi.hoisted`で宣言する(Vitestのモジュール
 * モックはimportより先にhoistされるため、通常のトップレベル変数は未初期化になる)。
 * hoisted化した`vi.fn()`自体をspyとして使うことで、「エンジン/キューはアプリ寿命で
 * 1個だけ生成され、再描画のたびに再生成されない」という要件(オーケストレーター指示・
 * Codexレビュー指摘)を呼び出し回数で直接検証できるようにしている。
 */
const {
  createPpuPaddleEngineMock,
  createOcrQueueMock,
  enqueueMock,
  cancelAllMock,
  disposeMock,
  engineDestroyMock,
} = vi.hoisted(() => ({
  createPpuPaddleEngineMock: vi.fn(),
  createOcrQueueMock: vi.fn(),
  enqueueMock: vi.fn(),
  cancelAllMock: vi.fn(),
  disposeMock: vi.fn(async () => undefined),
  engineDestroyMock: vi.fn(async () => undefined),
}));

vi.mock("./ocr/ppuPaddleEngine", () => ({
  createPpuPaddleEngine: createPpuPaddleEngineMock,
}));

vi.mock("./ocr/queue", () => ({
  createOcrQueue: createOcrQueueMock,
}));

type Cb = {
  onStatus(event: QueueStatusEvent): void;
  // v1.3(§16.4): 複数領域検出時の通知。既存テストの大半は発火させない(単一領域のまま)。
  onRegions?(photoJobId: string, regions: RegionDescriptor[], flags: RegionGroupFlags): void;
  onThumbnail(id: string, blob: Blob): void;
  onPreview(id: string, blob: Blob): void;
  onResult(id: string, patch: RowPatch): void;
};
let capturedCb: Cb | null = null;

function selectFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

/** スマホ・タブレット(<1024px、jsdomの既定)では集計パネルの本文が既定で折りたたまれて
 *  いる(Codexレビュー v1.4指摘I4: expanded初期値をfalseへ変更)。「新しい月を始める」
 *  ボタンは本文側にあるため、クリックする前に展開しておく。 */
function expandSummary() {
  fireEvent.click(screen.getByRole("button", { name: /集計を展開/ }));
}

// 金額編集UI内の各ボタンは、複数行での重複を避けるためrow.label入りのaria-labelを
// 持つ(Codexレビュー再指摘I4/I9)。表示テキスト("確定"等)ではなくaria-labelで
// 一貫して取得するためのヘルパー。
const amountEditLabel = (label: string) => `${label}の金額を編集`;
const confirmLabel = (label: string) => `${label}の金額を確定`;
const signToggleLabel = (label: string) => `${label}を返品・取消として入力`;

/**
 * v1.1(設計ドキュメント§14)でデフォルト状態は人1人(初期名「わたし」)になった
 * (Task 12)。夫/妻の付け替え・複数人分の取り込みボタン等、2人前提のテストは
 * この固定2人構成をlocalStorageへ直接書き込んでから`render(<App />)`する。
 */
const TWO_PEOPLE_STATE = {
  version: 2,
  month: "2026-07",
  updatedAt: "2026-07-27T10:00:00.000Z",
  people: [
    { id: "husband-id", name: "夫", colorIndex: 0 },
    { id: "wife-id", name: "妻", colorIndex: 1 },
  ],
  rows: [],
};

function seedTwoPeople() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(TWO_PEOPLE_STATE));
}

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    capturedCb = null;

    createPpuPaddleEngineMock.mockReset().mockImplementation(
      (): OcrEngine => ({
        initialize: vi.fn(async () => undefined),
        recognize: vi.fn(async () => []),
        // v1.3: OcrEngineに追加された検出専用API。App.test.tsxは`createOcrQueue`自体を
        // モックしているため実際には呼ばれないが、`OcrEngine`型を満たすために必要。
        detect: vi.fn(async () => []),
        destroy: engineDestroyMock,
      }),
    );
    createOcrQueueMock.mockReset().mockImplementation((_engine: unknown, cb: Cb) => {
      capturedCb = cb;
      return { enqueue: enqueueMock, cancelAll: cancelAllMock, dispose: disposeMock };
    });
    enqueueMock.mockReset();
    cancelAllMock.mockReset();
    disposeMock.mockReset().mockImplementation(async () => undefined);
    engineDestroyMock.mockClear();
  });

  // @testing-library/reactの自動cleanupはVitestの`globals: true`設定を前提に有効化される。
  // 本プロジェクトはvite.config.tsで`globals`を設定していないため自動cleanupが効かず、
  // 明示しないと前のテストのDOMが`document.body`に残ったまま`screen`クエリが衝突しうる
  // (Codexレビュー指摘)。
  afterEach(() => {
    cleanup();
  });

  it("初期表示: タイトル・人1人(わたし)分の取り込みボタン・空の一覧が表示される(設計ドキュメント§14.1のデフォルト状態)", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("レシート清算スキャナー");
    expect(screen.getByRole("button", { name: "わたしのレシートをアルバムから選ぶ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "わたしのレシートを撮る（カメラ）" })).toBeTruthy();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);

    const list = container.querySelector(".receipt-list");
    expect(list?.children.length).toBe(0);
  });

  it("取り込みボタン群の直下に撮り方ヒントを常時表示する(調査結論: 占有率が支配要因・傾きが副次要因、.superpowers/sdd/ocr-investigation.md)", () => {
    const { container } = render(<App />);

    const hint = container.querySelector(".capture-hint");
    // v1.3(§16の実装指示): 複数枚まとめて撮る場合の撮り方ヒントを追記した
    // (間隔を空けて並べることでXY-cutの領域分割精度が上がるため)。
    expect(hint?.textContent).toBe(
      "レシートを画面いっぱい・まっすぐ・ピントを合わせて撮ると読み取り精度が上がります。複数枚まとめて撮る場合は間隔を空けて並べてください。",
    );
    // ボタン群(.add-buttons)の直後(兄弟要素)に配置されている
    expect(container.querySelector(".add-buttons")?.nextElementSibling).toBe(hint);
  });

  it("取り込み導線は支払者セグメントで選択中の1人分だけを表示し、hidden inputは人数分だけ生成される(設計ドキュメント§17.7)", () => {
    // v1.4で「人×(アルバム/カメラ)ボタングリッド」から「①支払者セグメント選択
    // ②主CTA ③サブ導線」へ再構成した(旧: 全員分のボタンが同時に表示されていた)。
    // hidden file input方式そのものは人数分だけ維持される(重複検出等の既存機能に影響しない)。
    seedTwoPeople();
    const { container } = render(<App />);

    // 初期選択は人リストの先頭(夫)。夫のボタンだけが見え、妻のボタンはまだ無い。
    expect(screen.getByRole("button", { name: "夫のレシートをアルバムから選ぶ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "夫のレシートを撮る（カメラ）" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "妻のレシートをアルバムから選ぶ" })).toBeNull();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(4);

    // 支払者セグメントで「妻」を選ぶと、CTAのaria-labelが妻へ切り替わる(選択中を明示)。
    const wifeChip = screen.getByRole("button", { name: "妻" });
    expect(wifeChip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(wifeChip);
    expect(wifeChip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "妻のレシートをアルバムから選ぶ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "妻のレシートを撮る（カメラ）" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "夫のレシートをアルバムから選ぶ" })).toBeNull();

    // 「+ 人を追加」でhidden inputも増える(既に2人いるので新規追加分は「3人目」)
    fireEvent.click(screen.getByRole("button", { name: "+ 人を追加" }));
    expect(screen.getByRole("button", { name: "3人目" })).toBeTruthy();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(6);
  });

  it("人が1人のときは支払者セグメントを表示しない(選ぶ意味が無いため、設計ドキュメント§17.7)", () => {
    render(<App />); // デフォルト状態は人1人(わたし)
    expect(screen.queryByRole("group", { name: "支払った人を選択" })).toBeNull();
    expect(screen.getByRole("button", { name: "わたしのレシートを撮る（カメラ）" })).toBeTruthy();
  });

  it("人の改名は取り込みボタン・手動追加の選択肢へ反映され、行が残っている人の削除は拒否される(設計ドキュメント§14.1)", () => {
    seedTwoPeople();
    render(<App />);

    // 改名
    fireEvent.click(screen.getByRole("button", { name: "夫の名前を編集" }));
    fireEvent.change(screen.getByLabelText("人の名前"), { target: { value: "パパ" } });
    fireEvent.blur(screen.getByLabelText("人の名前"));

    expect(screen.getByRole("button", { name: "パパのレシートをアルバムから選ぶ" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "夫のレシートをアルバムから選ぶ" })).toBeNull();

    // 手動追加フォームの選択肢にも反映される
    const options = [...(screen.getByLabelText("支払った人") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["パパが支払い", "妻が支払い"]);

    // ファイルを1件追加すると、その人(パパ)の削除は拒否される
    const fileInputs = document.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));

    const deleteButton = screen.getByRole("button", { name: "パパを削除" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(screen.getByText(/パパの行が1件あるため削除できません/)).toBeTruthy();
  });

  it("ファイル追加→処理中表示→OCR結果反映→金額タップ編集の一連の流れ", async () => {
    const { container } = render(<App />);

    const fileInputs = container.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBe(2);
    const albumInput = fileInputs[0] as HTMLInputElement;

    const file = new File(["dummy-bytes"], "receipt.png", { type: "image/png" });
    selectFile(albumInput, file);

    // 行が即座に追加され、処理中バッジが出る。フル画像のObject URLはこの時点では
    // 作られない(サムネイルはOCRキューのonThumbnailで後から届く。Codexレビュー指摘I1)
    const rows = container.querySelectorAll(".receipt-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText("処理中…")).toBeTruthy();
    expect(rows[0].querySelector(".thumb-button")).toBeNull();

    // queueへ渡されたidを使い、OCR完了コールバックを疑似発火する
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    expect(capturedCb).not.toBeNull();
    act(() => {
      capturedCb!.onResult(id, { amountYen: 1234, status: "auto-high", candidates: [], processing: false });
    });

    // 金額が表示され、処理中バッジは消える
    const amountButton = await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(amountButton.textContent).toBe("1,234円");
    expect(within(rows[0] as HTMLElement).queryByText("処理中…")).toBeNull();

    // 金額タップで編集モードに入り、値を書き換えて「確定」ボタンで確定する
    fireEvent.click(amountButton);
    const editInput = screen.getByLabelText("金額(円)") as HTMLInputElement;
    expect(editInput.value).toBe("1234");
    fireEvent.change(editInput, { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: confirmLabel("レシート 1") }));

    const committedButton = await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(committedButton.textContent).toBe("5,000円");
    // 手入力で確定した金額はステータスが「確認済」になる(source:"ocr"のため)
    expect(within(rows[0] as HTMLElement).getByText("確認済")).toBeTruthy();

    // エンジン/キューは再描画(状態更新)を経ても1回だけ生成される
    // (「アプリ寿命で1個ずつ、再生成しない」という要件の直接検証)
    expect(createPpuPaddleEngineMock).toHaveBeenCalledTimes(1);
    expect(createOcrQueueMock).toHaveBeenCalledTimes(1);
  });

  it("OCR処理中に手修正した金額は、遅れて届いたOCR結果で上書きされない(Codexレビュー指摘C1)", async () => {
    // 再現順序: 1) 行が処理中で表示 2) ユーザーが5,000円へ手修正 3) 数秒後に
    // 遅れてOCR結果(1,234円)が到着 → 5,000円が無警告で上書きされてはならない
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];

    const amountButton = await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(amountButton.textContent).toBe("金額を入力");
    fireEvent.click(amountButton);
    const input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5000" } });
    fireEvent.blur(input);

    const committedButton = await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(committedButton.textContent).toBe("5,000円");
    expect(within(container.querySelector(".receipt-row") as HTMLElement).getByText("確認済")).toBeTruthy();

    // 遅延OCR結果が手修正の後に到着する
    act(() => {
      capturedCb!.onResult(id, { amountYen: 1234, status: "auto-high", candidates: [], processing: false });
    });

    expect(screen.getByRole("button", { name: amountEditLabel("レシート 1") }).textContent).toBe("5,000円");
  });

  it("OCR処理中に手修正した金額は、遅れて届いたOCR結果で上書きされない(再試行後の世代管理、Codexレビュー再指摘C1)", async () => {
    // 再現順序: 1) OCR-Aが実行中 2) ユーザーが空欄確定(processing:falseになる)
    // 3) 「再試行」でOCR-Bをenqueue(processing:trueに戻る) 4) 古いOCR-Aの結果が
    // 遅れて到着 → `row.processing===true`だけを見るガードでは、Bではなく古いAの
    // 結果が誤って適用されてしまう(単純なprocessingフラグだけでは世代を区別できない)
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [jobA] = enqueueMock.mock.calls[0] as [string, File];

    // 空欄確定でfailed/processing:falseにする
    fireEvent.click(await screen.findByRole("button", { name: amountEditLabel("レシート 1") }));
    fireEvent.change(screen.getByLabelText("金額(円)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: confirmLabel("レシート 1") }));
    expect(await screen.findByText("読取失敗")).toBeTruthy();

    // 再試行でOCR-B(新しいjobId)をenqueueする
    const retryButton = screen.getByRole("button", { name: "レシート 1を再試行" });
    fireEvent.click(retryButton);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    const [jobB] = enqueueMock.mock.calls[1] as [string, File];
    expect(jobB).not.toBe(jobA);
    expect(within(container.querySelector(".receipt-row") as HTMLElement).getByText("処理中…")).toBeTruthy();

    // 古いOCR-Aの結果が遅れて到着しても無視される(行は処理中のまま)
    act(() => {
      capturedCb!.onResult(jobA, { amountYen: 9999, status: "auto-high", candidates: [], processing: false });
    });
    expect(within(container.querySelector(".receipt-row") as HTMLElement).getByText("処理中…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: amountEditLabel("レシート 1") })?.textContent).not.toBe("9,999円");

    // OCR-Bの結果は正しく適用される
    act(() => {
      capturedCb!.onResult(jobB, { amountYen: 4321, status: "auto-high", candidates: [], processing: false });
    });
    expect(screen.getByRole("button", { name: amountEditLabel("レシート 1") }).textContent).toBe("4,321円");
  });

  it("金額入力: 全角数字を受理し、非数字は編集を閉じずrole=alertで表示し、符号切替で負数入力でき、空欄はnull確定する(Codexレビュー指摘I3・I4)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    act(() => {
      capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
    });

    const row = () => container.querySelector(".receipt-row") as HTMLElement;
    const amountButton = () => screen.getByRole("button", { name: amountEditLabel("レシート 1") });
    const confirmButton = () => screen.getByRole("button", { name: confirmLabel("レシート 1") });

    // 全角数字は受理される("１２３４"→1,234円)
    fireEvent.click(await screen.findByRole("button", { name: amountEditLabel("レシート 1") }));
    let input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "１２３４" } });
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(amountButton().textContent).toBe("1,234円"));

    // 非数字入力は編集を閉じず、role=alertでエラーを表示する(「除去してから解釈」で
    // 別金額になっていた旧実装のバグ回帰テスト)
    fireEvent.click(amountButton());
    input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12abc34" } });
    fireEvent.click(confirmButton());
    expect(within(row()).getByRole("alert").textContent).toContain("金額は数字で入力してください");
    expect(screen.getByLabelText("金額(円)")).toBeTruthy(); // 編集は閉じていない、元の値も上書きされない

    // "円"のみ・カンマだけ・桁区切り誤り・数字中の空白混入は、部分除去せず全体として
    // invalid判定する(Codexレビュー再指摘I3: 除去してから解釈する方式だと
    // "円"→空欄扱い、"1,00"→100、"1 2"→12のように誤って解釈されてしまっていた)
    for (const bad of ["円", ",,,", "1,00", "1 2", "1円2"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(confirmButton());
      expect(within(row()).getByRole("alert")).toBeTruthy();
      input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    }

    // 符号切替ボタンで負数入力できる(iPhoneの数値キーボードにマイナスキーがない対策)
    fireEvent.change(input, { target: { value: "500" } });
    const signButton = screen.getByRole("button", { name: signToggleLabel("レシート 1") });
    expect(signButton.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(signButton);
    expect(signButton.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(amountButton().textContent).toBe("-500円"));

    // 空欄コミットはnull確定(OCR由来行はstatus:"failed"に戻る)
    fireEvent.click(amountButton());
    input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(amountButton().textContent).toBe("金額を入力"));
    expect(within(row()).getByText("読取失敗")).toBeTruthy();
  });

  it("キーボード操作: Escapeで編集をキャンセルし金額ボタンへフォーカスを戻す。Enterは変換確定中(isComposing)なら確定しない(Codexレビュー指摘I5・M3)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    act(() => {
      capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
    });

    const amountButton = await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(amountButton.textContent).toBe("1,000円");
    fireEvent.click(amountButton);
    const input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "9999" } });

    fireEvent.keyDown(input, { key: "Escape" });

    // キャンセルされ元の金額のまま、金額ボタンへフォーカスが戻る
    const restoredButton = screen.getByRole("button", { name: amountEditLabel("レシート 1") });
    expect(restoredButton.textContent).toBe("1,000円");
    expect(document.activeElement).toBe(restoredButton);

    // IME変換確定中のEnterはコミットしない(直接commitEditを呼ばず、blur()経由に一本化しているため)
    fireEvent.click(restoredButton);
    const input2 = screen.getByLabelText("金額(円)") as HTMLInputElement;
    input2.focus();
    fireEvent.change(input2, { target: { value: "2000" } });
    fireEvent.keyDown(input2, { key: "Enter", isComposing: true });
    expect(screen.getByLabelText("金額(円)")).toBeTruthy(); // まだ編集中

    // isComposingでないEnterはblur()を経由してコミットする
    fireEvent.keyDown(input2, { key: "Enter", isComposing: false });
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: amountEditLabel("レシート 1") }).textContent).toBe("2,000円"),
    );
  });

  it("金額編集: 符号切替・確定・キャンセルボタンへポインターでフォーカスが移ってもinputがblurコミットしない(Codexレビュー再指摘I1)", async () => {
    // 実ブラウザではボタンをポインターで押すとinputのblurが先に発火し、コミットが
    // 先走って意図しない挙動(特に「キャンセル」ボタンが実質コミットになる)を招く
    // 恐れがあった。エディタ内へのフォーカス移動時はblurでコミットしないことを検証する。
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    act(() => {
      capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
    });

    fireEvent.click(await screen.findByRole("button", { name: amountEditLabel("レシート 1") }));
    const input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9999" } });

    const signButton = screen.getByRole("button", { name: signToggleLabel("レシート 1") });
    // relatedTargetがエディタ内(符号切替ボタン)へのフォーカス移動を模したblur
    fireEvent.blur(input, { relatedTarget: signButton });

    // コミットされておらず、編集は引き続き開いたまま(金額トリガーボタンは編集中は
    // 描画されないため、これがnullであること自体が「編集が閉じていない」証跡になる)
    expect(screen.getByLabelText("金額(円)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: amountEditLabel("レシート 1") })).toBeNull();
    expect((screen.getByLabelText("金額(円)") as HTMLInputElement).value).toBe("9999");
  });

  it("金額編集: Tabで編集欄の外(削除ボタン等)へ移動した場合はコミット後にフォーカスを奪い返さない(Codexレビュー再指摘Important)", async () => {
    // 無条件にfocusEpochを進めて金額ボタンへフォーカスを戻すと、ユーザーがTabで
    // 次の要素(例: 削除ボタン)へ意図的に移動しただけでも、コミット後に金額ボタンへ
    // 強制的に引き戻されてしまう。明示的な確定操作(確定ボタン・Enter・Escape)以外の
    // 暗黙blurではフォーカスを奪わないことを検証する。
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    act(() => {
      capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
    });

    fireEvent.click(await screen.findByRole("button", { name: amountEditLabel("レシート 1") }));
    const input = screen.getByLabelText("金額(円)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2000" } });

    const deleteButton = screen.getByRole("button", { name: "レシート 1（1行目）を削除" });
    // Tabで削除ボタンへ移動したことを模したblur(relatedTargetが編集欄の外の実要素)
    fireEvent.blur(input, { relatedTarget: deleteButton });

    // コミットはされる(値は反映される)が、フォーカスは削除ボタンへ移動したままで
    // 金額ボタンへ奪い返されない
    expect(await screen.findByRole("button", { name: amountEditLabel("レシート 1") })).toBeTruthy();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: amountEditLabel("レシート 1") }));
  });

  it("OCR成功後は再試行用に保持していたFileを解放し、その後空欄確定でfailedへ戻っても再試行ボタンは出ない(Codexレビュー再指摘Important)", async () => {
    // `retryFilesRef`が成功済み行のFileまでセッション終了まで保持し続けると、
    // 320pxサムネイル化によるメモリ削減の効果が大量取り込み時に失われる。
    // OCRが成功した時点でそのFileは解放され、後で(手修正等により)failedへ戻っても
    // 再試行はできない(手動で金額を入力する以外の手段がなくなる)ことを確認する。
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    act(() => {
      capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
    });

    // 空欄確定でfailedへ戻す
    fireEvent.click(await screen.findByRole("button", { name: amountEditLabel("レシート 1") }));
    fireEvent.change(screen.getByLabelText("金額(円)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: confirmLabel("レシート 1") }));
    expect(await screen.findByText("読取失敗")).toBeTruthy();

    // OCR成功時に既にFileが解放されているため、再試行ボタンは表示されない
    expect(screen.queryByRole("button", { name: "レシート 1を再試行" })).toBeNull();
  });

  it("拡大オーバーレイ内ではTabが背景要素へ抜けない(Codexレビュー再指摘Important: aria-modalの実効性)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    act(() => {
      capturedCb!.onThumbnail(id, new Blob(["thumb"]));
    });

    const thumbButton = await screen.findByRole("button", { name: "レシート 1の画像を拡大" });
    fireEvent.click(thumbButton);
    const overlay = screen.getByRole("dialog", { name: "レシート 1の拡大画像" });

    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const prevented = !overlay.dispatchEvent(tabEvent);
    expect(prevented).toBe(true);
  });

  it("onThumbnailで届いたBlobをサムネイル画像として表示する。拡大表示は行外のオーバーレイになりタップで閉じる(Codexレビュー指摘I1・I6)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onThumbnail(id, new Blob(["thumb"]));
    });

    const thumbButton = await screen.findByRole("button", { name: "レシート 1の画像を拡大" });
    expect(thumbButton.querySelector("img")).toBeTruthy();
    expect(thumbButton.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".thumb-overlay")).toBeNull();

    fireEvent.click(thumbButton);
    expect(thumbButton.getAttribute("aria-expanded")).toBe("true");
    const overlay = screen.getByRole("dialog", { name: "レシート 1の拡大画像" });
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    // createPortalでdocument.body直下へ描画される(Codexレビュー v1.2指摘I1)。
    // `clip-path`を持つ`.receipt-paper`の子孫のままだと、固定要素であっても祖先の
    // クリッピング領域の外へは描画されない(WebKit bug 152548)ため、祖先に
    // `.receipt-paper`が無いことを直接検証する。
    expect(overlay.closest(".receipt-paper")).toBeNull();
    // 開いた直後は閉じるボタンへフォーカスが移る(Codexレビュー再指摘I5)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "拡大画像を閉じる" }));
    // 拡大中も行の他の操作(削除・金額)は変わらず操作できる(旧実装は行内width:100%で
    // レイアウトが壊れていた。Codexレビュー指摘I6)
    expect(screen.getByRole("button", { name: "レシート 1（1行目）を削除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: amountEditLabel("レシート 1") })).toBeTruthy();

    // Escapeキーでも閉じられ、閉じるとサムネイルボタンへフォーカスが戻る(Codexレビュー再指摘I5)
    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(thumbButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(thumbButton);

    // タップでも閉じられる
    fireEvent.click(thumbButton);
    fireEvent.click(screen.getByRole("dialog", { name: "レシート 1の拡大画像" }));
    expect(thumbButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("拡大オーバーレイはpreviewUrlが届くとthumbnailUrlより優先して表示し、previewUrl未着時はthumbnailUrlにフォールバックする(Codexレビュー最終ゲート指摘I2)", async () => {
    const createSpy = vi.spyOn(URL, "createObjectURL");
    try {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
      const [id] = enqueueMock.mock.calls[0] as [string, File];

      act(() => {
        capturedCb!.onThumbnail(id, new Blob(["thumb"]));
      });
      const thumbnailUrl = createSpy.mock.results[0].value as string;

      const thumbButton = await screen.findByRole("button", { name: "レシート 1の画像を拡大" });
      fireEvent.click(thumbButton);
      // previewUrl未着時はthumbnailUrlにフォールバックする
      expect((document.querySelector(".thumb-overlay-img") as HTMLImageElement).getAttribute("src")).toBe(
        thumbnailUrl,
      );
      fireEvent.click(screen.getByRole("dialog", { name: "レシート 1の拡大画像" })); // 一旦閉じる

      act(() => {
        capturedCb!.onPreview(id, new Blob(["preview"]));
      });
      const previewUrl = createSpy.mock.results[1].value as string;
      expect(previewUrl).not.toBe(thumbnailUrl);

      // previewUrlが届いた後は、拡大時にそちらが優先表示される
      fireEvent.click(thumbButton);
      expect((document.querySelector(".thumb-overlay-img") as HTMLImageElement).getAttribute("src")).toBe(
        previewUrl,
      );
    } finally {
      createSpy.mockRestore();
    }
  });

  const failureKindCases: Array<{ failureKind: FailureKind; message: string; canRetry: boolean }> = [
    { failureKind: "image-decode", message: "画像を読み込めません。JPEGまたはPNGで追加してください", canRetry: false },
    { failureKind: "unsupported-format", message: "この画像形式には対応していません", canRetry: false },
    { failureKind: "image-too-large", message: "画像が大きすぎます。縮小してから追加してください", canRetry: false },
    {
      failureKind: "ocr",
      message: "文字を読み取れませんでした。画面いっぱいに撮り直すか、金額を手入力してください",
      canRetry: true,
    },
  ];

  for (const testCase of failureKindCases) {
    it(`failureKind:"${testCase.failureKind}"は「${testCase.message}」(role=alert)を表示し、再試行ボタンは${testCase.canRetry ? "維持する" : "出さない(同じFileを再試行しても同じ結果になるため)"}(Codexレビュー最終ゲート指摘I1)`, async () => {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
      const [id] = enqueueMock.mock.calls[0] as [string, File];

      act(() => {
        capturedCb!.onResult(id, {
          amountYen: null,
          status: "failed",
          candidates: [],
          processing: false,
          failureKind: testCase.failureKind,
        });
      });

      const row = container.querySelector(".receipt-row") as HTMLElement;
      expect(within(row).getByRole("alert").textContent).toBe(testCase.message);
      if (testCase.canRetry) {
        expect(within(row).getByRole("button", { name: "レシート 1を再試行" })).toBeTruthy();
      } else {
        expect(within(row).queryByRole("button", { name: "レシート 1を再試行" })).toBeNull();
      }
    });
  }

  it("処理中の行はis-processingクラスになり、failed系の色クラスとは分離される(Codexレビュー指摘M2)", () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));

    const row = container.querySelector(".receipt-row") as HTMLElement;
    expect(row.className).toContain("is-processing");
    expect(row.className).not.toContain("status-failed");
  });

  it("失敗行の再試行ボタンでファイルを再enqueueし、行がprocessing:trueへ戻る(Codexレビュー指摘I8)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id, file] = enqueueMock.mock.calls[0] as [string, File];
    act(() => {
      capturedCb!.onResult(id, { amountYen: null, status: "failed", candidates: [], processing: false });
    });

    const retryButton = await screen.findByRole("button", { name: "レシート 1を再試行" });
    enqueueMock.mockClear();
    fireEvent.click(retryButton);

    expect(within(container.querySelector(".receipt-row") as HTMLElement).getByText("処理中…")).toBeTruthy();
    // 再試行は新しいjobIdを発行してenqueueする(同じFileだが、古いjobとは異なるid。
    // Codexレビュー再指摘C1: 同じidを使い回すと、後から遅れて届く古いOCR結果の
    // 世代を区別できなくなる)
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [retryJobId, retryFile] = enqueueMock.mock.calls[0] as [string, File];
    expect(retryJobId).not.toBe(id);
    expect(retryFile).toBe(file);
  });

  it("モデル初期化失敗はrole=alertで表示され、再試行ボタンで失敗行をまとめて再enqueueする(Codexレビュー指摘I8)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id, file] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onStatus({ kind: "model-error", message: "モデル準備に失敗しました" });
      capturedCb!.onResult(id, { amountYen: null, status: "failed", candidates: [], processing: false });
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("モデル準備に失敗しました");

    enqueueMock.mockClear();
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [retryJobId, retryFile] = enqueueMock.mock.calls[0] as [string, File];
    expect(retryJobId).not.toBe(id);
    expect(retryFile).toBe(file);
  });

  it("処理中は一括キャンセルボタンが表示され、押すと実行中の行も含めて即座に失敗確定し、後から届く結果は無視される(Codexレビュー再指摘I2)", () => {
    // `queue.cancelAll()`はキュー内の未処理(pending)分しか止められず、実行中の
    // ONNX推論は実際には中断できない。「すべてキャンセル」を押した時点でprocessing中の
    // 行は(pending/実行中を問わず)即座に論理キャンセル(failed/processing:false)し、
    // 後から遅れて届く結果は無視されるべき。
    const { container } = render(<App />);
    expect(screen.queryByRole("button", { name: "すべてキャンセル" })).toBeNull();

    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [jobId] = enqueueMock.mock.calls[0] as [string, File];

    const cancelButton = screen.getByRole("button", { name: "すべてキャンセル" });
    fireEvent.click(cancelButton);
    expect(cancelAllMock).toHaveBeenCalledTimes(1);

    const row = container.querySelector(".receipt-row") as HTMLElement;
    expect(within(row).getByText("読取失敗")).toBeTruthy();
    expect(row.className).not.toContain("is-processing");
    expect(screen.queryByRole("button", { name: "すべてキャンセル" })).toBeNull();

    // 実行中だった(=キャンセル前にenqueueされていた)jobの結果が後から届いても無視される
    act(() => {
      capturedCb!.onResult(jobId, { amountYen: 4321, status: "auto-high", candidates: [], processing: false });
    });
    expect(within(row).getByText("読取失敗")).toBeTruthy();
    expect(screen.getByRole("button", { name: amountEditLabel("レシート 1") }).textContent).toBe("金額を入力");
  });

  it("進捗はrole=statusでaria-live=politeに表示される(preparing/processing/complete)", () => {
    render(<App />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");

    act(() => {
      capturedCb!.onStatus({ kind: "preparing" });
    });
    expect(screen.getByRole("status").textContent).toBe("モデル準備中…");

    act(() => {
      capturedCb!.onStatus({ kind: "processing", current: 1, total: 3 });
    });
    expect(screen.getByRole("status").textContent).toBe("画像 1/3 処理中…");

    act(() => {
      capturedCb!.onStatus({ kind: "complete", done: 3, total: 3 });
    });
    expect(screen.getByRole("status").textContent).toBe("完了 (3/3)");
  });

  it("OCR完了後にneeds-review/failed行が残っている場合、ステータス領域(aria-live)に「金額確認待ち N件」を表示する(Codexレビュー最終ゲート指摘Minor#3・設計ドキュメント§5.2)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    selectFile(fileInputs[0] as HTMLInputElement, new File(["b"], "b.png"));
    const [idA] = enqueueMock.mock.calls[0] as [string, File];
    const [idB] = enqueueMock.mock.calls[1] as [string, File];

    act(() => {
      capturedCb!.onResult(idA, { amountYen: 900, status: "needs-review", candidates: [900, 950], processing: false });
      capturedCb!.onResult(idB, { amountYen: null, status: "failed", candidates: [], processing: false });
      capturedCb!.onStatus({ kind: "complete", done: 2, total: 2 });
    });

    expect(screen.getByRole("status").textContent).toBe("金額確認待ち 2件");
  });

  it("夫⇄妻の切り替え、および削除ボタンで行を除去できる(削除時はサムネイル・プレビューURLも解放)", async () => {
    seedTwoPeople();
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    try {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      const albumWifeInput = fileInputs[2] as HTMLInputElement;

      selectFile(albumWifeInput, new File(["x"], "r.png", { type: "image/png" }));
      const [id] = enqueueMock.mock.calls[0] as [string, File];
      act(() => {
        capturedCb!.onThumbnail(id, new Blob(["x"]));
        capturedCb!.onPreview(id, new Blob(["x-preview"]));
      });
      await screen.findByRole("button", { name: "レシート 1の画像を拡大" });

      const row = container.querySelector(".receipt-row") as HTMLElement;
      expect(within(row).getByText("→夫へ")).toBeTruthy();

      fireEvent.click(within(row).getByText("→夫へ"));
      expect(within(row).getByText("→妻へ")).toBeTruthy();

      fireEvent.click(within(row).getByText("削除"));
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
      // サムネイル用・プレビュー用の2件のObject URLが解放される(Codexレビュー指摘I1・最終ゲート指摘I2)
      expect(revokeSpy).toHaveBeenCalledTimes(2);
    } finally {
      revokeSpy.mockRestore();
    }
  });

  it("複数行があっても削除・payer切替ボタンのアクセシブルネームが行ごとに一意になる(Codexレビュー指摘I9)", () => {
    seedTwoPeople();
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    selectFile(fileInputs[0] as HTMLInputElement, new File(["b"], "b.png"));
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(2);

    expect(screen.getByRole("button", { name: "レシート 1（1行目）を削除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "レシート 2（2行目）を削除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "レシート 1（1行目）を妻の支払いへ変更" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "レシート 2（2行目）を妻の支払いへ変更" })).toBeTruthy();
  });

  it("人が1人しかいないときは行の付け替え(→次の人へ)ボタンを表示しない(設計ドキュメント§14.1)", () => {
    const { container } = render(<App />); // デフォルト状態は人1人(わたし)
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));

    const row = container.querySelector(".receipt-row") as HTMLElement;
    // 現在の支払者は色+テキストで表示される
    expect(within(row).getByText("わたし")).toBeTruthy();
    // 付け替え先が無いため、循環ボタン自体が存在しない
    expect(within(row).queryByRole("button", { name: /支払いへ変更/ })).toBeNull();
  });

  it("人が3人のときは「→次の人へ」ボタンで人の並び順に循環する(2人時は実質トグル、設計ドキュメント§14.1)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        month: "2026-07",
        updatedAt: "2026-07-27T10:00:00.000Z",
        people: [
          { id: "p1", name: "Aさん", colorIndex: 0 },
          { id: "p2", name: "Bさん", colorIndex: 1 },
          { id: "p3", name: "Cさん", colorIndex: 2 },
        ],
        rows: [],
      }),
    );
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]'); // Aさんのアルバム入力
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));

    const row = container.querySelector(".receipt-row") as HTMLElement;
    expect(within(row).getByText("Aさん")).toBeTruthy();
    expect(within(row).getByText("→Bさんへ")).toBeTruthy();

    fireEvent.click(within(row).getByText("→Bさんへ"));
    expect(within(row).getByText("Bさん")).toBeTruthy();
    expect(within(row).getByText("→Cさんへ")).toBeTruthy();

    fireEvent.click(within(row).getByText("→Cさんへ"));
    expect(within(row).getByText("Cさん")).toBeTruthy();
    // 3人目の次は先頭(Aさん)へ循環する
    expect(within(row).getByText("→Aさんへ")).toBeTruthy();
  });

  it("同名の手動行が複数あっても、行番号によって削除ボタンのアクセシブルネームが一意になる(Codexレビュー最終ゲート指摘Minor#2)", () => {
    // 手動追加は行の名前をユーザーが自由入力するため、「家賃」を2回追加する等で
    // row.labelだけでは削除ボタンのアクセシブルネームが衝突しうる。行番号を含めることで
    // 一意性を保証する。
    render(<App />);
    for (let i = 0; i < 2; i++) {
      fireEvent.change(screen.getByLabelText("支出の名前"), { target: { value: "家賃" } });
      fireEvent.change(screen.getByLabelText("追加する金額(円)"), { target: { value: "80000" } });
      fireEvent.click(screen.getByRole("button", { name: "追加" }));
    }

    expect(screen.getAllByText("家賃")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "家賃（1行目）を削除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "家賃（2行目）を削除" })).toBeTruthy();
  });

  it("アンマウント時にqueue.dispose()を待ってからengineを破棄し、残っているサムネイル・プレビューURLを全解放する(Codexレビュー指摘I2・最終ゲート指摘I2)", async () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    try {
      const { container, unmount } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
      selectFile(fileInputs[0] as HTMLInputElement, new File(["b"], "b.png"));
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(2);

      // 両行にサムネイル・プレビューが届いた状態にする(I1: 追加直後はthumbnailUrlを
      // 持たない。最終ゲート指摘I2: previewUrlも同様)
      const [idA] = enqueueMock.mock.calls[0] as [string, File];
      const [idB] = enqueueMock.mock.calls[1] as [string, File];
      act(() => {
        capturedCb!.onThumbnail(idA, new Blob(["a"]));
        capturedCb!.onThumbnail(idB, new Blob(["b"]));
        capturedCb!.onPreview(idA, new Blob(["preview-a"]));
        capturedCb!.onPreview(idB, new Blob(["preview-b"]));
      });

      unmount();

      expect(disposeMock).toHaveBeenCalledTimes(1);
      // dispose()の解決を待ってからengine.destroy()が呼ばれる(cancelAll()は未処理分しか
      // 止めないため、実行中のONNXセッションと競合したままengineを破棄していた旧実装の
      // 回帰テスト。Codexレビュー指摘I2)
      await vi.waitFor(() => expect(engineDestroyMock).toHaveBeenCalledTimes(1));
      // アンマウント時のクリーンアップで2件分のサムネイルURL+2件分のプレビューURLが解放される
      expect(revokeSpy).toHaveBeenCalledTimes(4);
    } finally {
      revokeSpy.mockRestore();
    }
  });

  it("<StrictMode>の開発時二重effect実行後も正常に機能し、アンマウントで例外なく後始末される(Codexレビュー指摘I2・M3)", () => {
    const { container, unmount } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // StrictModeのmount→cleanup→mount(開発時のみ)を経ても、ファイル追加が正常に
    // OCRキューへ渡ることを確認する(=disposeされた古いqueueに固定されたままにならない)。
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));

    expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
    expect(enqueueMock).toHaveBeenCalled();

    expect(() => unmount()).not.toThrow();
  });

  it("永続化された行のラベル番号(例:「レシート 3」)より後の番号から採番を継続する(再読み込み後の重複防止)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        month: "2026-07",
        updatedAt: "2026-07-27T10:00:00.000Z",
        rows: [
          { id: "x", payer: "husband", amountYen: 1000, label: "レシート 3", status: "confirmed", source: "ocr" },
        ],
      }),
    );

    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));

    const labels = [...container.querySelectorAll(".row-label")].map((el) => el.textContent);
    expect(labels).toEqual(["レシート 3", "レシート 4"]);
  });

  it("手動追加フォームから行を追加すると一覧・集計に反映される(Task 10)", () => {
    seedTwoPeople();
    render(<App />);

    fireEvent.change(screen.getByLabelText("支出の名前"), { target: { value: "家賃" } });
    fireEvent.change(screen.getByLabelText("追加する金額(円)"), { target: { value: "80000" } });
    fireEvent.change(screen.getByLabelText("支払った人"), { target: { value: "wife-id" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByText("家賃")).toBeTruthy();
    expect(screen.getByRole("button", { name: "家賃の金額を編集" }).textContent).toBe("80,000円");
    expect(screen.getByText("手入力")).toBeTruthy();

    const summary = screen.getByLabelText("集計");
    expect(summary.textContent).toContain("80,000円");
  });

  it("手動追加: 名前が空欄だとrole=alertでエラー表示され、一覧に行は追加されない", () => {
    const { container } = render(<App />);

    fireEvent.change(screen.getByLabelText("追加する金額(円)"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByRole("alert").textContent).toContain("名前を入力してください");
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
  });

  it("手動追加: 不正な金額(除去してから解釈しない、ReceiptRowと同じparseYen方式)はエラー表示され追加されない", () => {
    const { container } = render(<App />);

    fireEvent.change(screen.getByLabelText("支出の名前"), { target: { value: "駐車場代" } });
    fireEvent.change(screen.getByLabelText("追加する金額(円)"), { target: { value: "12abc34" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByRole("alert").textContent).toContain("金額は数字で入力してください");
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
  });

  it("手動追加: 返品・取消として入力ボタン(符号切替)で負数を追加できる", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("支出の名前"), { target: { value: "返金" } });
    fireEvent.change(screen.getByLabelText("追加する金額(円)"), { target: { value: "1280" } });
    fireEvent.click(screen.getByRole("button", { name: "追加する金額を返品・取消として入力" }));
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByRole("button", { name: "返金の金額を編集" }).textContent).toBe("-1,280円");
  });

  it("新しい月を始める: 確認ダイアログでキャンセルすると何も変わらない", () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      expandSummary();
      fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("新しい月を始める: 確認して開始すると全行クリア・サムネイルURL解放・保存データ消去・重複検出/再試行用Fileのリセットまで行われる(Task 9レポート予告の統合ポイント)", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      const file = new File(["a"], "dup.png", { type: "image/png" });
      selectFile(fileInputs[0] as HTMLInputElement, file);
      const [id] = enqueueMock.mock.calls[0] as [string, File];
      act(() => {
        capturedCb!.onThumbnail(id, new Blob(["thumb"]));
        capturedCb!.onPreview(id, new Blob(["preview"]));
        capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
      });
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);

      revokeSpy.mockClear();
      expandSummary();
      fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));

      // 確認ダイアログには現在の集計(人別合計)が含まれる
      expect(confirmSpy.mock.calls[0][0]).toContain("わたし 1,000円");

      // 全行クリアされる
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
      // 表示中だったサムネイル・プレビューのObject URLが解放される(Codexレビュー指摘I1・最終ゲート指摘I2)
      expect(revokeSpy).toHaveBeenCalledTimes(2);

      // localStorageには旧行データを含まない、新しい(空の)月の状態が保存される
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
      expect(stored.rows).toEqual([]);
      // 人(people)は月をまたいで引き継がれる(設計ドキュメント§14.5: 人ごとの履歴はスコープ外だが、
      // 人そのものは家計を共にするメンバーであり月次リセット対象ではない)
      expect(stored.people).toHaveLength(1);
      expect(stored.people[0].name).toBe("わたし");
      expect(screen.getByRole("button", { name: "わたしのレシートをアルバムから選ぶ" })).toBeTruthy();

      // 重複検出用Set(seenFiles)がクリアされているため、同じファイルを再度追加しても
      // 「追加済みのようです」の確認ダイアログは出ない
      confirmSpy.mockClear();
      selectFile(fileInputs[0] as HTMLInputElement, file);
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      revokeSpy.mockRestore();
      confirmSpy.mockRestore();
    }
  });

  it("新しい月を始める: 処理中の行があってもpending中のOCRジョブをキャンセルし、リセット後に遅れて届く結果・サムネイルは無視される(Codexレビュー指摘: cancelAll()漏れ)", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "processing.png"));
      const [id] = enqueueMock.mock.calls[0] as [string, File];
      expect(within(container.querySelector(".receipt-row") as HTMLElement).getByText("処理中…")).toBeTruthy();

      cancelAllMock.mockClear();
      expandSummary();
      fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));

      // pending中のOCRジョブがキャンセルされる(呼ばないと旧月の画像がバックグラウンドで
      // OCR処理され続け、新しい月の画像処理がその後ろに並んでしまう)
      expect(cancelAllMock).toHaveBeenCalledTimes(1);
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);

      // 旧jobIdに対する遅延結果・サムネイルが届いてもクラッシュせず、行も復活しない
      expect(() => {
        act(() => {
          capturedCb!.onThumbnail(id, new Blob(["late"]));
          capturedCb!.onResult(id, { amountYen: 9999, status: "auto-high", candidates: [], processing: false });
        });
      }).not.toThrow();
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("新しい月を始める: 新しい状態の保存(saveState)が失敗した場合は中断し、行も旧月のlocalStorageもpendingキャンセルも変更せずアラート表示する(Codexレビュー指摘I1: 削除してから保存する非原子的な旧実装は、削除成功〜保存完了の間に失敗するとpeopleごと失われる窓があった)", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    try {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
      const [id] = enqueueMock.mock.calls[0] as [string, File];
      act(() => {
        capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
      });
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
      // 新しい月へ切り替える前の、旧月のlocalStorage内容を保持しておく
      const before = localStorage.getItem(STORAGE_KEY);
      expect(before).not.toBeNull();

      // 新しい空状態を同キーへ上書き保存する呼び出しだけを失敗させる
      // (removeItemではなくsetItemを失敗させる。旧実装のclearState=removeItemはもう
      // 呼ばれないため、原子的上書きの失敗経路を検証するにはsetItemを狙う必要がある)。
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });
      cancelAllMock.mockClear();
      expandSummary();
      fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));
      setItemSpy.mockRestore();

      expect(alertSpy).toHaveBeenCalledWith("新しい月の状態を保存できませんでした。時間をおいて再試行してください。");
      // 中断されるため、行は残り、pendingキャンセルも呼ばれない(中途半端な後始末をしない)
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
      expect(cancelAllMock).not.toHaveBeenCalled();
      // 削除してから保存、ではなく原子的上書きのため、失敗時は旧月のlocalStorageがそのまま残る
      expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    } finally {
      alertSpy.mockRestore();
      confirmSpy.mockRestore();
    }
  });

  it("集計パネル(.summary-panel)は<main>の中にある(Codexレビュー v1.2再指摘I4: 集計・月切替を<main>の外へ出すと主要コンテンツのランドマークが分断されるため、main内・.receipt-paperの外へ戻した)", () => {
    render(<App />);
    expect(screen.getByLabelText("集計").closest("main")).not.toBeNull();
  });

  it("印字アニメーションのstaggerは一覧全体の行番号ではなく追加バッチ内のindexを基準にする(Codexレビュー v1.2再指摘I5)", () => {
    // 旧実装は`rowNumber`(一覧全体の通し番号)から逆算していたため、既存行が
    // 10件以上ある状態で1件だけ追加しても`Math.min(11, 9) * 60 = 540ms`待たされていた。
    // 新実装は「このバッチ内のindex」を基準にするため、単独追加は常に0msになる。
    const { container } = render(<App />);
    const albumInput = container.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;

    for (let i = 0; i < 11; i++) {
      selectFile(albumInput, new File([`f${i}`], `f${i}.png`));
    }
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(11);

    selectFile(albumInput, new File(["solo"], "solo.png"));
    const rows = container.querySelectorAll(".receipt-row");
    expect(rows).toHaveLength(12);
    expect((rows[11] as HTMLElement).style.animationDelay).toBe("0ms");
  });

  it("複数ファイルを同時追加した場合はバッチ内indexで60msずつずらす(0ms/60ms/120ms、Codexレビュー v1.2再指摘I5)", () => {
    const { container } = render(<App />);
    const albumInput = container.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;

    fireEvent.change(albumInput, {
      target: { files: [new File(["a"], "a.png"), new File(["b"], "b.png"), new File(["c"], "c.png")] },
    });

    const rows = container.querySelectorAll(".receipt-row");
    expect(rows).toHaveLength(3);
    expect((rows[0] as HTMLElement).style.animationDelay).toBe("0ms");
    expect((rows[1] as HTMLElement).style.animationDelay).toBe("60ms");
    expect((rows[2] as HTMLElement).style.animationDelay).toBe("120ms");
  });

  // --- v1.3(複数レシート自動分割、設計ドキュメント§16)の統合テスト ---
  // queue自体はモックされているため、実際の検出・XY-cutは走らない。ここではApp.tsxが
  // `onRegions`/`onResult`をどう配線しているか(§16.4のプレースホルダ→N行の原子的置換、
  // 領域ごとのjobIdでのOCR結果反映)、および§16.5の回復導線を検証する。

  it("onRegionsで1枚の写真がN行へ置換され、領域ごとのjobIdでOCR結果が正しい行へ反映される(§16.4)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    selectFile(fileInputs[0] as HTMLInputElement, file);

    // 選択直後は1行(「レシート 1」)のまま
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
    const [photoJobId] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onRegions!(
        photoJobId,
        [
          { jobId: "region-0", crop: { x: 0, y: 0, width: 0.5, height: 1 } },
          { jobId: "region-1", crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
        ],
        { ambiguous: false, nearLimit: false },
      );
    });

    // プレースホルダ1行が2行へ置換され、採番は置換時に連番(「レシート 1」「レシート 2」)
    const rows = container.querySelectorAll(".receipt-row");
    expect(rows).toHaveLength(2);
    expect(container.querySelectorAll(".row-label")[0].textContent).toBe("レシート 1");
    expect(container.querySelectorAll(".row-label")[1].textContent).toBe("レシート 2");

    // サムネイルも領域ごとのjobIdで正しい行へ届く(実際のqueueと同じ順序: サムネイル→OCR結果)
    act(() => {
      capturedCb!.onThumbnail("region-0", new Blob(["thumb-0"]));
    });
    expect(await screen.findByRole("button", { name: "レシート 1の画像を拡大" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "レシート 2の画像を拡大" })).toBeNull();

    // 領域ごとのjobId("region-0"/"region-1")でOCR結果が届き、正しい行へ反映される
    act(() => {
      capturedCb!.onResult("region-0", { amountYen: 500, status: "auto-high", candidates: [], processing: false });
      capturedCb!.onResult("region-1", { amountYen: 800, status: "needs-review", candidates: [800, 900], processing: false });
    });

    const amount1 = await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(amount1.textContent).toBe("500円");
    const amount2 = screen.getByRole("button", { name: amountEditLabel("レシート 2") });
    expect(amount2.textContent).toBe("800円");
    expect(within(container.querySelectorAll(".receipt-row")[1] as HTMLElement).getByText("要確認")).toBeTruthy();
  });

  it("領域が1つ(onRegions未発火)の通常写真には§16.5の回復導線は表示されない(既存動作に退行なし)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
    const [id] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
    });

    await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(container.querySelector(".region-group-recovery")).toBeNull();
  });

  it("写真単位の「◯枚のレシートを見つけました」通知がaria-live領域に表示される(§16.4)", () => {
    render(<App />);
    const status = screen.getByRole("status");

    act(() => {
      capturedCb!.onStatus({ kind: "regionsFound", count: 3 });
    });
    expect(status.textContent).toBe("この写真から3枚のレシートを見つけました");

    act(() => {
      capturedCb!.onStatus({ kind: "regionProcessing", current: 2, total: 3 });
    });
    expect(status.textContent).toBe("2/3枚目を読取中…");
  });

  it("ambiguous(§16.3安全弁)なグループには回復導線が表示され、「写真全体を1枚として読み直す」で同じFileを検出スキップで読み直す(§16.5)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    selectFile(fileInputs[0] as HTMLInputElement, file);
    const [photoJobId] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onRegions!(photoJobId, [{ jobId: "amb-0", crop: { x: 0, y: 0, width: 1, height: 1 } }], {
        ambiguous: true,
        nearLimit: false,
      });
    });
    act(() => {
      // §16.3の安全弁により、queue側で既にneeds-reviewへ格下げされた結果が届く想定
      capturedCb!.onResult("amb-0", { amountYen: 700, status: "needs-review", candidates: [700], processing: false });
    });

    await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(screen.getByText("写真全体を1枚として読み直す")).toBeTruthy();
    expect(screen.getByText("削除して撮り直す")).toBeTruthy();

    enqueueMock.mockClear();
    fireEvent.click(screen.getByText("写真全体を1枚として読み直す"));

    // 旧行は削除され、新しい1行(同じ番号から再スタート)が追加され処理中になる
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
    expect(container.querySelector(".row-label")?.textContent).toBe("レシート 1");
    expect(within(container.querySelector(".receipt-row") as HTMLElement).getByText("処理中…")).toBeTruthy();

    // 同じFileで、検出をスキップする(forceSingle:true)新しいjobIdをenqueueする
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [newJobId, retriedFile, options] = enqueueMock.mock.calls[0] as [string, File, { forceSingle?: boolean } | undefined];
    expect(newJobId).not.toBe(photoJobId);
    expect(retriedFile).toBe(file);
    expect(options?.forceSingle).toBe(true);

    // 回復導線自体は(グループが解消されたため)消える
    expect(container.querySelector(".region-group-recovery")).toBeNull();
  });

  it("「写真全体を1枚として読み直す」が失敗した後、通常の「再試行」でもforceSingleを維持する(Codexレビュー最終ゲート指摘I5)", async () => {
    // 維持しないと、読み直し失敗後に通常の「再試行」を押した際に通常の検出経路へ
    // 戻ってしまい、再び誤分割されうる。
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    selectFile(fileInputs[0] as HTMLInputElement, file);
    const [photoJobId] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onRegions!(photoJobId, [{ jobId: "amb-0", crop: { x: 0, y: 0, width: 1, height: 1 } }], {
        ambiguous: true,
        nearLimit: false,
      });
      capturedCb!.onResult("amb-0", { amountYen: 700, status: "needs-review", candidates: [700], processing: false });
    });

    await screen.findByText("写真全体を1枚として読み直す");
    enqueueMock.mockClear();
    fireEvent.click(screen.getByText("写真全体を1枚として読み直す"));

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [rereadJobId] = enqueueMock.mock.calls[0] as [string, File];

    // 「写真全体を1枚として読み直す」自体が失敗する
    act(() => {
      capturedCb!.onResult(rereadJobId, { amountYen: null, status: "failed", candidates: [], processing: false });
    });
    const retryButton = await screen.findByRole("button", { name: "レシート 1を再試行" });

    enqueueMock.mockClear();
    fireEvent.click(retryButton);

    // 通常の「再試行」ボタンを押しても、forceSingle:trueを維持したままenqueueする
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [, retriedFile, options] = enqueueMock.mock.calls[0] as [string, File, { forceSingle?: boolean } | undefined];
    expect(retriedFile).toBe(file);
    expect(options?.forceSingle).toBe(true);
  });

  it("処理中(展開直後でOCR結果待ち)のグループには回復ボタンを表示しない(Codexレビュー最終ゲート指摘M1)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["photo"], "photo.jpg", { type: "image/jpeg" }));
    const [photoJobId] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onRegions!(
        photoJobId,
        [
          { jobId: "region-0", crop: { x: 0, y: 0, width: 0.5, height: 1 } },
          { jobId: "region-1", crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
        ],
        { ambiguous: false, nearLimit: false },
      );
    });

    // 展開直後、両行はまだstatus:"failed", processing:trueの状態(OCR結果待ち)。
    // 従来はstatus==="failed"だけを見ていたため、この時点で誤って回復ボタンが
    // 表示されてしまっていた。
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(2);
    expect(container.querySelectorAll(".is-processing")).toHaveLength(2);
    expect(container.querySelector(".region-group-recovery")).toBeNull();

    // 両領域とも成功すれば、引き続き回復ボタンは表示されない。
    act(() => {
      capturedCb!.onResult("region-0", { amountYen: 500, status: "auto-high", candidates: [], processing: false });
      capturedCb!.onResult("region-1", { amountYen: 800, status: "auto-high", candidates: [], processing: false });
    });
    await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(container.querySelector(".region-group-recovery")).toBeNull();
  });

  it("全領域成功後(ambiguous/nearLimitなし)はPhotoGroupを解放し、その後1行を手動で失敗状態にしても回復導線は再表示されない(Codexレビュー最終ゲート指摘I7)", async () => {
    // グループが解放されずに残っていると、この後の「1行を空欄確定してfailedへ戻す」
    // 操作でhasFailed経由の回復導線が復活してしまうはず。解放済みならグループの
    // エントリ自体が無いため、再表示されない。
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    selectFile(fileInputs[0] as HTMLInputElement, file);
    const [photoJobId] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onRegions!(
        photoJobId,
        [
          { jobId: "region-0", crop: { x: 0, y: 0, width: 0.5, height: 1 } },
          { jobId: "region-1", crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
        ],
        { ambiguous: false, nearLimit: false },
      );
      capturedCb!.onResult("region-0", { amountYen: 500, status: "auto-high", candidates: [], processing: false });
      capturedCb!.onResult("region-1", { amountYen: 800, status: "auto-high", candidates: [], processing: false });
    });

    await screen.findByRole("button", { name: amountEditLabel("レシート 1") });
    expect(container.querySelector(".region-group-recovery")).toBeNull();

    // レシート1の金額を空欄確定してfailedへ戻す
    fireEvent.click(screen.getByRole("button", { name: amountEditLabel("レシート 1") }));
    fireEvent.change(screen.getByLabelText("金額(円)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: confirmLabel("レシート 1") }));
    await screen.findByText("読取失敗");

    // PhotoGroupは既に解放済みのため、回復導線は再表示されない
    expect(container.querySelector(".region-group-recovery")).toBeNull();
  });

  it("「削除して撮り直す」でグループの全行が削除される(§16.5)", async () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    selectFile(fileInputs[0] as HTMLInputElement, new File(["photo"], "photo.jpg"));
    const [photoJobId] = enqueueMock.mock.calls[0] as [string, File];

    act(() => {
      capturedCb!.onRegions!(
        photoJobId,
        [
          { jobId: "region-0", crop: { x: 0, y: 0, width: 0.5, height: 1 } },
          { jobId: "region-1", crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
        ],
        { ambiguous: false, nearLimit: true },
      );
      capturedCb!.onResult("region-0", { amountYen: null, status: "failed", candidates: [], processing: false });
    });

    await screen.findByText("削除して撮り直す");
    expect(container.querySelectorAll(".receipt-row")).toHaveLength(2);

    fireEvent.click(screen.getByText("削除して撮り直す"));

    expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
    expect(container.querySelector(".region-group-recovery")).toBeNull();
  });
});
