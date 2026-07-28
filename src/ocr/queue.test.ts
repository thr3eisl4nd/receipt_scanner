import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrEngine, OcrLine } from "./engine";
import type { ExtractResult } from "../extract/extractTotal";
import { createOcrQueue, type OcrQueueDeps } from "./queue";

// extractTotalは複雑な座標ヒューリスティックを持つ純粋関数なので、queueのテストでは
// モックして戻り値を直接制御する(queueの直列処理・再試行・結果反映ロジックのみを検証する)。
vi.mock("../extract/extractTotal", () => ({ extractTotal: vi.fn() }));
import { extractTotal } from "../extract/extractTotal";
const extractTotalMock = vi.mocked(extractTotal);

/** jsdomは実Canvas描画(drawImage/getImageData)を持たないため、テスト用の薄いスタブを使う。 */
function fakeCanvas(): HTMLCanvasElement {
  return { width: 100, height: 100 } as unknown as HTMLCanvasElement;
}

function makeDeps(): OcrQueueDeps {
  return {
    loadAsCanvas: vi.fn(async () => fakeCanvas()),
    enhanceContrast: vi.fn(() => fakeCanvas()),
  };
}

function makeEngine(recognizeImpl: (canvas: HTMLCanvasElement) => OcrLine[] | Promise<OcrLine[]>): OcrEngine {
  return {
    initialize: vi.fn(async () => undefined),
    recognize: vi.fn(async (canvas: HTMLCanvasElement) => recognizeImpl(canvas)),
    destroy: vi.fn(async () => undefined),
  };
}

const line = (text = "x"): OcrLine => ({ text, confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } });

function resultOf(
  status: ExtractResult["status"],
  amountYen: number | null = 1000,
  candidates: number[] = [1000],
): ExtractResult {
  return { amountYen, status, candidates };
}

describe("createOcrQueue", () => {
  beforeEach(() => {
    extractTotalMock.mockReset();
  });

  it("1回目でauto-highなら再試行せず、そのまま結果を確定する", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValueOnce(resultOf("auto-high", 1200, [1200]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(engine.recognize).toHaveBeenCalledTimes(1);
    expect(deps.enhanceContrast).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 1200,
      status: "auto-high",
      candidates: [1200],
      processing: false,
    });
  });

  it("needs-reviewなら補正版で再試行し、補正版がauto-highならそちらを採用する", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review", 900, [900, 950]))
      .mockReturnValueOnce(resultOf("auto-high", 950, [950]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
    expect(engine.recognize).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 950,
      status: "auto-high",
      candidates: [950],
      processing: false,
    });
  });

  it("failedなら補正版で再試行する(失敗時のみではなくauto-high以外は常に再試行)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("auto-high", 700, [700]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 700,
      status: "auto-high",
      candidates: [700],
      processing: false,
    });
  });

  it("補正版もauto-highにならない場合は、元(1回目)の結果を維持する(補正で悪化するケース対策)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review", 900, [900, 950]))
      .mockReturnValueOnce(resultOf("failed", null, []));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    // 補正版(failed)ではなく元の結果(needs-review, 900)が採用される
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 900,
      status: "needs-review",
      candidates: [900, 950],
      processing: false,
    });
  });

  it("処理後にcanvasを明示解放する(width/height=1)。再試行時はenhanced版も解放する", async () => {
    const canvases: HTMLCanvasElement[] = [];
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => {
        const c = fakeCanvas();
        canvases.push(c);
        return c;
      }),
      enhanceContrast: vi.fn(() => {
        const c = fakeCanvas();
        canvases.push(c);
        return c;
      }),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review"))
      .mockReturnValueOnce(resultOf("failed", null, []));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(canvases).toHaveLength(2);
    for (const c of canvases) {
      expect(c.width).toBe(1);
      expect(c.height).toBe(1);
    }
  });

  it("複数件を直列(逐次)に処理し、並走しない", async () => {
    const deps = makeDeps();
    const order: string[] = [];
    let recognizeCallCount = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const engine = makeEngine(async () => {
      recognizeCallCount++;
      if (recognizeCallCount === 1) {
        order.push("start-1");
        await firstGate;
        order.push("end-1");
      } else {
        order.push(`call-${recognizeCallCount}`);
      }
      return [line()];
    });
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));

    // 1件目が完了するまで2件目のrecognizeは呼ばれないはず
    await vi.waitFor(() => expect(order).toContain("start-1"));
    expect(engine.recognize).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    expect(order).toEqual(["start-1", "end-1", "call-2"]);
  });

  it("onStatusでモデル準備中→進捗→完了を通知する", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onStatus = vi.fn();
    const queue = createOcrQueue(engine, { onStatus, onResult: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("完了 (1/1)"));

    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      "モデル準備中…",
      "画像 1/1 処理中…",
      "完了 (1/1)",
    ]);
  });

  it("initializeはキュー全体で1回だけ呼ばれる", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));
    queue.enqueue("c", new File([""], "c.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(3));
    expect(engine.initialize).toHaveBeenCalledTimes(1);
  });

  it("recognizeが例外を投げた場合、failedとして結果を返す(候補行の中断ではない)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => {
      throw new Error("recognize boom");
    });

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
    });
    expect(extractTotalMock).not.toHaveBeenCalled();
  });

  it("cancelAllは未処理分のみキャンセルし、処理済み/処理中の行は維持する", async () => {
    const deps = makeDeps();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const engine = makeEngine(async () => {
      await firstGate;
      return [line()];
    });
    extractTotalMock.mockReturnValue(resultOf("auto-high", 500, [500]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png")); // 処理中(gateで停止)
    queue.enqueue("b", new File([""], "b.png")); // 未処理→cancelAllで即失敗確定
    await vi.waitFor(() => expect(engine.recognize).toHaveBeenCalledTimes(1));

    queue.cancelAll();

    // bは即座にキャンセル結果を受け取る
    expect(onResult).toHaveBeenCalledWith("b", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
    });
    expect(onResult).toHaveBeenCalledTimes(1);

    // aは処理中断されず、gate解放後に正常結果で確定する(処理済みは維持)
    releaseFirst();
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith("a", {
        amountYen: 500,
        status: "auto-high",
        candidates: [500],
        processing: false,
      }),
    );
    expect(engine.recognize).toHaveBeenCalledTimes(1);
  });

  it("initialize()が失敗した場合、未処理分をすべてfailed確定しrecognizeは呼ばれない", async () => {
    const deps = makeDeps();
    const engine: OcrEngine = {
      initialize: vi.fn(async () => {
        throw new Error("init boom");
      }),
      recognize: vi.fn(async () => [line()]),
      destroy: vi.fn(async () => undefined),
    };

    const onResult = vi.fn();
    const onStatus = vi.fn();
    const queue = createOcrQueue(engine, { onStatus, onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    const failed = { amountYen: null, status: "failed", candidates: [], processing: false };
    expect(onResult).toHaveBeenCalledWith("a", failed);
    expect(onResult).toHaveBeenCalledWith("b", failed);
    expect(engine.recognize).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("モデル準備に失敗しました");
  });

  it("2回目のrecognizeが例外を投げても1回目の結果(needs-review)を維持し、両canvasを解放する", async () => {
    const canvases: HTMLCanvasElement[] = [];
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => {
        const c = fakeCanvas();
        canvases.push(c);
        return c;
      }),
      enhanceContrast: vi.fn(() => {
        const c = fakeCanvas();
        canvases.push(c);
        return c;
      }),
    };
    let recognizeCallCount = 0;
    const engine = makeEngine(() => {
      recognizeCallCount++;
      if (recognizeCallCount === 2) throw new Error("2nd recognize boom");
      return [line()];
    });
    extractTotalMock.mockReturnValueOnce(resultOf("needs-review", 900, [900]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 900,
      status: "needs-review",
      candidates: [900],
      processing: false,
    });
    expect(canvases).toHaveLength(2);
    for (const c of canvases) {
      expect(c.width).toBe(1);
      expect(c.height).toBe(1);
    }
  });

  it("enhanceContrastが例外を投げても1回目の結果を維持する(2回目recognizeは呼ばれない)", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => fakeCanvas()),
      enhanceContrast: vi.fn(() => {
        throw new Error("enhance boom");
      }),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValueOnce(resultOf("needs-review", 800, [800]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 800,
      status: "needs-review",
      candidates: [800],
      processing: false,
    });
    expect(engine.recognize).toHaveBeenCalledTimes(1);
  });

  it("1件目が完全に失敗しても2件目は逐次処理される", async () => {
    let loadCallCount = 0;
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => {
        loadCallCount++;
        if (loadCallCount === 1) throw new Error("load boom");
        return fakeCanvas();
      }),
      enhanceContrast: vi.fn(() => fakeCanvas()),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 300, [300]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
    });
    expect(onResult).toHaveBeenCalledWith("b", {
      amountYen: 300,
      status: "auto-high",
      candidates: [300],
      processing: false,
    });
  });

  it("完了通知(onStatus)コールバックから同期的にenqueueしても取りこぼさない", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 100, [100]));

    const onResult = vi.fn();
    let reentered = false;
    const onStatus = vi.fn((text: string) => {
      if (text.startsWith("完了") && !reentered) {
        reentered = true;
        queue.enqueue("b", new File([""], "b.png"));
      }
    });
    const queue = createOcrQueue(engine, { onStatus, onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    expect(onResult).toHaveBeenCalledWith("a", expect.objectContaining({ amountYen: 100 }));
    expect(onResult).toHaveBeenCalledWith("b", expect.objectContaining({ amountYen: 100 }));
  });

  it("cancelAll後の完了通知はキャンセル分を含めた件数になる(done/totalの整合性)", async () => {
    const deps = makeDeps();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const engine = makeEngine(async () => {
      await firstGate;
      return [line()];
    });
    extractTotalMock.mockReturnValue(resultOf("auto-high", 200, [200]));

    const onStatus = vi.fn();
    const queue = createOcrQueue(engine, { onStatus, onResult: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));
    await vi.waitFor(() => expect(engine.recognize).toHaveBeenCalledTimes(1));

    queue.cancelAll();
    releaseFirst();

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("完了 (2/2)"));
  });

  it("recognizeへ渡るcanvasは1回目が元画像、2回目が補正後画像である", async () => {
    const original = fakeCanvas();
    const enhancedCanvas = fakeCanvas();
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => original),
      enhanceContrast: vi.fn(() => enhancedCanvas),
    };
    const seenCanvases: HTMLCanvasElement[] = [];
    const engine = makeEngine((canvas) => {
      seenCanvases.push(canvas);
      return [line()];
    });
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review"))
      .mockReturnValueOnce(resultOf("auto-high"));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(seenCanvases).toEqual([original, enhancedCanvas]);
  });

  it("完全にドレインした後の新しいバッチでもinitializeは再実行されない", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    queue.enqueue("b", new File([""], "b.png"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    expect(engine.initialize).toHaveBeenCalledTimes(1);
  });
});
