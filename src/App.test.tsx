import { StrictMode, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import type { OcrEngine } from "./ocr/engine";
import type { RowPatch } from "./state/reducer";
import type { QueueStatusEvent } from "./ocr/queue";
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
  onThumbnail(id: string, blob: Blob): void;
  onPreview(id: string, blob: Blob): void;
  onResult(id: string, patch: RowPatch): void;
};
let capturedCb: Cb | null = null;

function selectFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

// 金額編集UI内の各ボタンは、複数行での重複を避けるためrow.label入りのaria-labelを
// 持つ(Codexレビュー再指摘I4/I9)。表示テキスト("確定"等)ではなくaria-labelで
// 一貫して取得するためのヘルパー。
const amountEditLabel = (label: string) => `${label}の金額を編集`;
const confirmLabel = (label: string) => `${label}の金額を確定`;
const signToggleLabel = (label: string) => `${label}を返品・取消として入力`;

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    capturedCb = null;

    createPpuPaddleEngineMock.mockReset().mockImplementation(
      (): OcrEngine => ({
        initialize: vi.fn(async () => undefined),
        recognize: vi.fn(async () => []),
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

  it("初期表示: タイトル・取り込みボタン・空の一覧が表示される", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("レシート清算スキャナー");
    // 夫妻で同じ視覚テキスト("アルバムから選ぶ"等)のボタンは、スクリーンリーダーの
    // ボタン一覧で対象を判別できるようaria-labelで行き先を明示する(Codexレビュー指摘I9)。
    expect(screen.getByRole("button", { name: "夫のレシートをアルバムから選ぶ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "妻のレシートをアルバムから選ぶ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "夫のレシートをカメラで撮る" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "妻のレシートをカメラで撮る" })).toBeTruthy();

    const list = container.querySelector(".receipt-list");
    expect(list?.children.length).toBe(0);
  });

  it("ファイル追加→処理中表示→OCR結果反映→金額タップ編集の一連の流れ", async () => {
    const { container } = render(<App />);

    const fileInputs = container.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBe(4);
    const albumHusbandInput = fileInputs[0] as HTMLInputElement;

    const file = new File(["dummy-bytes"], "receipt.png", { type: "image/png" });
    selectFile(albumHusbandInput, file);

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
    { failureKind: "ocr", message: "文字を読み取れませんでした。金額を手入力してください", canRetry: true },
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
      selectFile(fileInputs[2] as HTMLInputElement, new File(["b"], "b.png"));
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
    render(<App />);

    fireEvent.change(screen.getByLabelText("支出の名前"), { target: { value: "家賃" } });
    fireEvent.change(screen.getByLabelText("追加する金額(円)"), { target: { value: "80000" } });
    fireEvent.change(screen.getByLabelText("支払った人"), { target: { value: "wife" } });
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
      fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));

      // 確認ダイアログには現在の集計(夫合計)が含まれる
      expect(confirmSpy.mock.calls[0][0]).toContain("夫 1,000円");

      // 全行クリアされる
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
      // 表示中だったサムネイル・プレビューのObject URLが解放される(Codexレビュー指摘I1・最終ゲート指摘I2)
      expect(revokeSpy).toHaveBeenCalledTimes(2);

      // localStorageには旧行データを含まない、新しい(空の)月の状態が保存される
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
      expect(stored.rows).toEqual([]);

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

  it("新しい月を始める: 保存データの削除(clearState)が失敗した場合は中断し、行も保存データもpendingキャンセルも変更せずアラート表示する(Codexレビュー指摘: 中途半端な状態の防止)", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png"));
      const [id] = enqueueMock.mock.calls[0] as [string, File];
      act(() => {
        capturedCb!.onResult(id, { amountYen: 1000, status: "auto-high", candidates: [], processing: false });
      });
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);

      cancelAllMock.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "新しい月を始める" }));

      expect(alertSpy).toHaveBeenCalledWith("保存データを削除できませんでした。時間をおいて再試行してください。");
      // 中断されるため、行は残り、pendingキャンセルも呼ばれない(中途半端な後始末をしない)
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(1);
      expect(cancelAllMock).not.toHaveBeenCalled();
    } finally {
      removeItemSpy.mockRestore();
      alertSpy.mockRestore();
      confirmSpy.mockRestore();
    }
  });
});
