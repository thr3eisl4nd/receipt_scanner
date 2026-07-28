import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrEngine, OcrLine } from "./engine";
import type { ExtractResult } from "../extract/extractTotal";
import { createOcrQueue, type OcrQueueDeps, type QueueStatusEvent } from "./queue";

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
    toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review"))
      .mockReturnValueOnce(resultOf("failed", null, []));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus, onResult: vi.fn(), onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith({ kind: "complete", done: 1, total: 1 }),
    );

    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      { kind: "preparing" },
      { kind: "processing", current: 1, total: 1 },
      { kind: "complete", done: 1, total: 1 },
    ]);
  });

  it("initializeはキュー全体で1回だけ呼ばれる", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    const failed = { amountYen: null, status: "failed", candidates: [], processing: false };
    expect(onResult).toHaveBeenCalledWith("a", failed);
    expect(onResult).toHaveBeenCalledWith("b", failed);
    expect(engine.recognize).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith({ kind: "model-error", message: "モデル準備に失敗しました" });
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
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
    };
    let recognizeCallCount = 0;
    const engine = makeEngine(() => {
      recognizeCallCount++;
      if (recognizeCallCount === 2) throw new Error("2nd recognize boom");
      return [line()];
    });
    extractTotalMock.mockReturnValueOnce(resultOf("needs-review", 900, [900]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValueOnce(resultOf("needs-review", 800, [800]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 300, [300]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
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
    const onStatus = vi.fn((event: QueueStatusEvent) => {
      if (event.kind === "complete" && !reentered) {
        reentered = true;
        queue.enqueue("b", new File([""], "b.png"));
      }
    });
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus, onResult: vi.fn(), onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));
    await vi.waitFor(() => expect(engine.recognize).toHaveBeenCalledTimes(1));

    queue.cancelAll();
    releaseFirst();

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith({ kind: "complete", done: 2, total: 2 }),
    );
  });

  it("recognizeへ渡るcanvasは1回目が元画像、2回目が補正後画像である", async () => {
    const original = fakeCanvas();
    const enhancedCanvas = fakeCanvas();
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => original),
      enhanceContrast: vi.fn(() => enhancedCanvas),
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(seenCanvases).toEqual([original, enhancedCanvas]);
  });

  it("完全にドレインした後の新しいバッチでもinitializeは再実行されない", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    queue.enqueue("b", new File([""], "b.png"));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    expect(engine.initialize).toHaveBeenCalledTimes(1);
  });

  // --- Codexレビュー指摘(直列保証の適用範囲/例外境界)の回帰テスト ---

  it("Aの補正再試行(2回目recognize)がgateで止まっている間、Bのloadは始まらない", async () => {
    const deps = makeDeps();
    let recognizeCallCount = 0;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => (releaseRetry = resolve));

    const engine = makeEngine(async () => {
      recognizeCallCount++;
      if (recognizeCallCount === 2) {
        // Aの再試行(補正版)recognizeをここで止める。最もメモリ負荷が高い局面。
        await retryGate;
      }
      return [line()];
    });
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review")) // Aの1回目 → 再試行トリガー
      .mockReturnValue(resultOf("auto-high")); // Aの2回目・Bの1回目とも

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));

    await vi.waitFor(() => expect(recognizeCallCount).toBe(2));

    // Aの再試行が止まっている間、Bはloadすら始まっていない
    expect(deps.loadAsCanvas).toHaveBeenCalledTimes(1);
    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();

    releaseRetry();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    expect(deps.loadAsCanvas).toHaveBeenCalledTimes(2);
    // Aは補正版もauto-highだったので補正版採用、Bは1回目からauto-high
    expect(onResult).toHaveBeenCalledWith("a", expect.objectContaining({ status: "auto-high" }));
    expect(onResult).toHaveBeenCalledWith("b", expect.objectContaining({ status: "auto-high" }));
  });

  it("同一engineを共有する2つのキューでも処理の同時実行数は1になる", async () => {
    const events: string[] = [];
    let gated = false;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    function makeTaggedDeps(tag: string): OcrQueueDeps {
      return {
        loadAsCanvas: vi.fn(async () => {
          events.push(`load-${tag}`);
          return fakeCanvas();
        }),
        enhanceContrast: vi.fn(() => fakeCanvas()),
        toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
      };
    }

    const engine = makeEngine(async () => {
      events.push("recognize-start");
      if (!gated) {
        gated = true;
        await firstGate;
      }
      events.push("recognize-end");
      return [line()];
    });
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const depsA = makeTaggedDeps("a");
    const depsB = makeTaggedDeps("b");
    const onResultA = vi.fn();
    const onResultB = vi.fn();
    const queue1 = createOcrQueue(engine, { onStatus: vi.fn(), onResult: onResultA, onThumbnail: vi.fn() }, depsA);
    const queue2 = createOcrQueue(engine, { onStatus: vi.fn(), onResult: onResultB, onThumbnail: vi.fn() }, depsB);

    queue1.enqueue("a", new File([""], "a.png"));
    queue2.enqueue("b", new File([""], "b.png"));

    await vi.waitFor(() => expect(events).toContain("recognize-start"));
    // どちらが先にレーンを取るかは決定的ではないが、片方が止まっている間に
    // もう片方のloadが始まっていないことは保証されるべき
    expect(events.filter((e) => e.startsWith("load-"))).toHaveLength(1);

    releaseFirst();
    await vi.waitFor(() => expect(onResultA).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onResultB).toHaveBeenCalledTimes(1));

    expect(events).toHaveLength(6);
    expect(events[0]).toMatch(/^load-/);
    expect(events[1]).toBe("recognize-start");
    expect(events[2]).toBe("recognize-end");
    expect(events[3]).toMatch(/^load-/);
    expect(events[3]).not.toBe(events[0]); // 2件目は1件目と異なるタグ(=待たされていた)
    expect(events[4]).toBe("recognize-start");
    expect(events[5]).toBe("recognize-end");
  });

  it("モデル準備中のonStatusがthrowしても再帰暴走せず、後続行が処理される", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onStatus = vi.fn((event: QueueStatusEvent) => {
      if (event.kind === "preparing") throw new Error("onStatus boom");
    });
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    try {
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

      expect(onResult).toHaveBeenCalledWith(
        "a",
        expect.objectContaining({ status: "auto-high" }),
      );
      expect(engine.initialize).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("onResultがthrowしても後続行の処理は継続される", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 100, [100]));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: string[] = [];
    const onResult = vi.fn((id: string) => {
      seen.push(id);
      if (id === "a") throw new Error("onResult boom");
    });
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));

    try {
      await vi.waitFor(() => expect(seen).toEqual(["a", "b"]));
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("完了通知からの再入enqueueは新バッチとしてカウンタをリセットする(「画像 1/1」表示)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 100, [100]));

    const onResult = vi.fn();
    let reentered = false;
    const onStatus = vi.fn((event: QueueStatusEvent) => {
      if (event.kind === "complete" && !reentered) {
        reentered = true;
        queue.enqueue("b", new File([""], "b.png"));
      }
    });
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    // 前バッチ(a)の完了通知内でenqueueされたb用の進捗表示は、前バッチのdone/totalを
    // 引きずった「画像 2/2」ではなく、新バッチとして「画像 1/1」になるべき
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      { kind: "preparing" },
      { kind: "processing", current: 1, total: 1 },
      { kind: "complete", done: 1, total: 1 },
      { kind: "processing", current: 1, total: 1 },
      { kind: "complete", done: 1, total: 1 },
    ]);
  });

  // --- Codexレビュー指摘I1(サムネイル)・I2(dispose)の回帰テスト ---

  it("loadAsCanvas直後にonThumbnailで縮小Blobを返す(OCR結果より前に届く)", async () => {
    const thumbBlob = new Blob(["thumb"]);
    const order: string[] = [];
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => {
        order.push("load");
        return fakeCanvas();
      }),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => {
        order.push("thumbnail");
        return thumbBlob;
      }),
    };
    const engine = makeEngine(() => {
      order.push("recognize");
      return [line()];
    });
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onThumbnail = vi.fn(() => order.push("onThumbnail"));
    const onResult = vi.fn(() => order.push("onResult"));
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onThumbnail).toHaveBeenCalledWith("a", thumbBlob);
    expect(order).toEqual(["load", "thumbnail", "onThumbnail", "recognize", "onResult"]);
  });

  it("サムネイル生成が失敗してもOCR結果には影響しない(best-effort)", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => fakeCanvas()),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => {
        throw new Error("thumbnail boom");
      }),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 100, [100]));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onResult = vi.fn();
    const onThumbnail = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    try {
      await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
      expect(onResult).toHaveBeenCalledWith("a", expect.objectContaining({ amountYen: 100 }));
      expect(onThumbnail).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("dispose()は新規enqueueを拒否し、実行中ジョブの完了を待ってから解決する。以降コールバックは呼ばれない", async () => {
    const deps = makeDeps();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const engine = makeEngine(async () => {
      await firstGate;
      return [line()];
    });
    extractTotalMock.mockReturnValue(resultOf("auto-high", 500, [500]));

    const onResult = vi.fn();
    const onStatus = vi.fn();
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    await vi.waitFor(() => expect(engine.recognize).toHaveBeenCalledTimes(1));

    let disposeSettled = false;
    const disposePromise = queue.dispose().then(() => {
      disposeSettled = true;
    });

    // 実行中(gateで止まっている)ジョブが完了するまでdisposeは解決しない
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposeSettled).toBe(false);

    // dispose後の新規enqueueは拒否される(pendingに積まれず、recognizeも呼ばれない)
    queue.enqueue("b", new File([""], "b.png"));

    releaseFirst();
    await disposePromise;
    expect(disposeSettled).toBe(true);

    // 実行中だった"a"の結果はdispose完了後なのでコールバックは発火しない
    expect(onResult).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "complete" }));
    // 拒否された"b"はrecognizeにすら到達しない
    expect(engine.recognize).toHaveBeenCalledTimes(1);
  });

  it("何も処理していない(真に空転)状態でのdispose()は即座に解決する", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult: vi.fn(), onThumbnail: vi.fn() }, deps);

    let settled = false;
    await queue.dispose().then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
  });
});
