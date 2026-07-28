import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import type { OcrEngine } from "./ocr/engine";
import type { RowPatch } from "./state/reducer";
import { STORAGE_KEY } from "./state/storage";
import App from "./App";

/**
 * App.tsxが実際に生成する`createPpuPaddleEngine()`はppu-paddle-ocr/web(ONNX実行環境)を
 * 読み込むため、jsdom環境のスモークテストでは実体を使わずダミーengineへ差し替える。
 * queue自体もengineへ触れる前にキャンバス処理(jsdomに無い実Canvas API)へ依存するため、
 * createOcrQueueもモックし、渡されたコールバック(onStatus/onResult)を捕捉して
 * テスト側からOCR完了を疑似的に発火できるようにする。
 *
 * `vi.mock`ファクトリ内から参照する変数は`vi.hoisted`で宣言する(Vitestのモジュール
 * モックはimportより先にhoistされるため、通常のトップレベル変数は未初期化になる)。
 * hoisted化した`vi.fn()`自体をspyとして使うことで、「エンジン/キューはアプリ寿命で
 * 1個だけ生成され、再描画のたびに再生成されない」という要件(オーケストレーター指示・
 * Codexレビュー指摘)を呼び出し回数で直接検証できるようにしている。
 */
const { createPpuPaddleEngineMock, createOcrQueueMock, enqueueMock, cancelAllMock, engineDestroyMock } = vi.hoisted(
  () => ({
    createPpuPaddleEngineMock: vi.fn(),
    createOcrQueueMock: vi.fn(),
    enqueueMock: vi.fn(),
    cancelAllMock: vi.fn(),
    engineDestroyMock: vi.fn(async () => undefined),
  }),
);

vi.mock("./ocr/ppuPaddleEngine", () => ({
  createPpuPaddleEngine: createPpuPaddleEngineMock,
}));

vi.mock("./ocr/queue", () => ({
  createOcrQueue: createOcrQueueMock,
}));

type Cb = { onStatus(text: string): void; onResult(id: string, patch: RowPatch): void };
let capturedCb: Cb | null = null;

function selectFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

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
      return { enqueue: enqueueMock, cancelAll: cancelAllMock };
    });
    enqueueMock.mockReset();
    cancelAllMock.mockReset();
    engineDestroyMock.mockClear();
  });

  // @testing-library/reactの自動cleanupはVitestの`globals: true`設定を前提に有効化される。
  // 本プロジェクトはvite.config.tsで`globals`を設定していないため自動cleanupが効かず、
  // 明示しないと前のテストのDOMがdocument.bodyに残ったまま`screen`クエリが衝突しうる
  // (Codexレビュー指摘)。
  afterEach(() => {
    cleanup();
  });

  it("初期表示: タイトル・取り込みボタン・空の一覧が表示される", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("レシート清算スキャナー");
    expect(screen.getAllByRole("button", { name: "アルバムから選ぶ" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "カメラで撮る" })).toHaveLength(2);

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

    // 行が即座に追加され、処理中バッジが出る
    const rows = container.querySelectorAll(".receipt-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText("処理中…")).toBeTruthy();

    // queueへ渡されたidを使い、OCR完了コールバックを疑似発火する
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [id] = enqueueMock.mock.calls[0] as [string, File];
    expect(capturedCb).not.toBeNull();
    capturedCb!.onResult(id, { amountYen: 1234, status: "auto-high", candidates: [], processing: false });

    // 金額が表示され、処理中バッジは消える
    const amountButton = await screen.findByRole("button", { name: "1,234円" });
    expect(within(rows[0] as HTMLElement).queryByText("処理中…")).toBeNull();

    // 金額タップで編集モードに入り、値を書き換えてblurで確定する
    fireEvent.click(amountButton);
    const editInput = screen.getByLabelText("金額(円)") as HTMLInputElement;
    expect(editInput.value).toBe("1234");
    fireEvent.change(editInput, { target: { value: "5000" } });
    fireEvent.blur(editInput);

    expect(await screen.findByRole("button", { name: "5,000円" })).toBeTruthy();
    // 手入力で確定した金額はステータスが「確認済」になる(source:"ocr"のため)
    expect(within(rows[0] as HTMLElement).getByText("確認済")).toBeTruthy();

    // 非数字を入力した場合は0円確定せず、直前の金額を維持する
    // (「除去後が空文字ならNumber("")===0で誤確定する」というCodexレビュー指摘の回帰テスト)
    fireEvent.click(screen.getByRole("button", { name: "5,000円" }));
    const editInput2 = screen.getByLabelText("金額(円)") as HTMLInputElement;
    fireEvent.change(editInput2, { target: { value: "abc" } });
    fireEvent.blur(editInput2);
    expect(await screen.findByRole("button", { name: "5,000円" })).toBeTruthy();

    // エンジン/キューは再描画(状態更新)を経ても1回だけ生成される
    // (「アプリ寿命で1個ずつ、再生成しない」という要件の直接検証)
    expect(createPpuPaddleEngineMock).toHaveBeenCalledTimes(1);
    expect(createOcrQueueMock).toHaveBeenCalledTimes(1);
  });

  it("夫⇄妻の切り替え、および削除ボタンで行を除去できる(削除時はサムネイルURLも解放)", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    try {
      const { container } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      const albumWifeInput = fileInputs[2] as HTMLInputElement;

      selectFile(albumWifeInput, new File(["x"], "r.png", { type: "image/png" }));

      const row = container.querySelector(".receipt-row") as HTMLElement;
      expect(within(row).getByText("→夫へ")).toBeTruthy();

      fireEvent.click(within(row).getByText("→夫へ"));
      expect(within(row).getByText("→妻へ")).toBeTruthy();

      fireEvent.click(within(row).getByText("削除"));
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledTimes(1);
    } finally {
      revokeSpy.mockRestore();
    }
  });

  it("アンマウント時に未処理OCRをキャンセルし、engineを破棄し、残っているサムネイルURLを全解放する", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    try {
      const { container, unmount } = render(<App />);
      const fileInputs = container.querySelectorAll('input[type="file"]');
      selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png", { type: "image/png" }));
      selectFile(fileInputs[2] as HTMLInputElement, new File(["b"], "b.png", { type: "image/png" }));
      expect(container.querySelectorAll(".receipt-row")).toHaveLength(2);

      unmount();

      expect(cancelAllMock).toHaveBeenCalledTimes(1);
      expect(engineDestroyMock).toHaveBeenCalledTimes(1);
      // 削除操作は一度もしていないので、アンマウント時のクリーンアップだけで2件分解放される
      expect(revokeSpy).toHaveBeenCalledTimes(2);
    } finally {
      revokeSpy.mockRestore();
    }
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
    selectFile(fileInputs[0] as HTMLInputElement, new File(["a"], "a.png", { type: "image/png" }));

    const labels = [...container.querySelectorAll(".row-label")].map((el) => el.textContent);
    expect(labels).toEqual(["レシート 3", "レシート 4"]);
  });
});
