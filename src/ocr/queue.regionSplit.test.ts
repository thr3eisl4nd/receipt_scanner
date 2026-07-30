import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrEngine, OcrLine, OcrBox } from "./engine";
import type { ExtractResult } from "../extract/extractTotal";
import { createOcrQueue, type OcrQueueDeps, type RegionDescriptor, type RegionGroupFlags } from "./queue";
import type { SourceImage } from "../image/sourceImage";

/**
 * v1.3(複数レシート自動分割、設計ドキュメント§16)のqueue.ts統合テスト。
 *
 * `queue.test.ts`は「1枚の写真=1レシート」の従来動作(既存269テストの一部)を検証する。
 * 本ファイルは新規に追加された分岐: 複数領域検出時の`onRegions`通知+領域ごとのOCR、
 * `ambiguous`時のauto-high禁止(§16.3安全弁の敵対テスト)、`crop`/`forceSingle`指定による
 * 個別領域の再試行・回復導線(§16.4/§16.5)を検証する。
 */

vi.mock("../extract/extractTotal", () => ({ extractTotal: vi.fn() }));
import { extractTotal } from "../extract/extractTotal";
const extractTotalMock = vi.mocked(extractTotal);

function fakeCanvas(tag = "canvas"): HTMLCanvasElement {
  return { width: 1200, height: 800, tag } as unknown as HTMLCanvasElement;
}

function makeDeps(overrides: Partial<OcrQueueDeps> = {}): OcrQueueDeps {
  return {
    loadAsCanvas: vi.fn(async () => fakeCanvas("whole")),
    enhanceContrast: vi.fn((src) => src),
    toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
    toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    ...overrides,
  };
}

const line = (): OcrLine => ({ text: "x", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } });

function resultOf(status: ExtractResult["status"], amountYen: number | null, candidates: number[]): ExtractResult {
  return { amountYen, status, candidates };
}

/** 2つのレシート相当(各5行、水平に大きく離れた)box群。regionDetection.test.tsの
 *  twoReceiptsSideBySideと同じ形状(1200x800canvas前提)。 */
function twoReceiptsBoxes(): OcrBox[] {
  const receiptA: OcrBox[] = [
    { x: 10, y: 10, width: 200, height: 20 },
    { x: 10, y: 40, width: 180, height: 20 },
    { x: 10, y: 70, width: 190, height: 20 },
    { x: 10, y: 100, width: 150, height: 20 },
    { x: 10, y: 130, width: 170, height: 20 },
  ];
  const receiptB: OcrBox[] = receiptA.map((b) => ({ ...b, x: b.x + 500 }));
  return [...receiptA, ...receiptB];
}

function makeSourceImage(cropImpl?: (rect: unknown, maxEdge: number) => HTMLCanvasElement): SourceImage & {
  cropToCanvas: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let cropCount = 0;
  const cropToCanvas = vi.fn((rect: unknown, maxEdge: number) => {
    cropCount++;
    return cropImpl ? cropImpl(rect, maxEdge) : fakeCanvas(`crop-${cropCount}`);
  });
  return { width: 4000, height: 3000, cropToCanvas, close: vi.fn((): void => undefined) };
}

function makeEngine(recognizeImpl: (canvas: HTMLCanvasElement) => OcrLine[], detectImpl: () => Promise<OcrBox[]> | OcrBox[]): OcrEngine {
  return {
    initialize: vi.fn(async () => undefined),
    recognize: vi.fn(async (canvas: HTMLCanvasElement) => recognizeImpl(canvas)),
    detect: vi.fn(async () => detectImpl()),
    destroy: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  extractTotalMock.mockReset();
});

describe("createOcrQueue: 複数領域検出(v1.3)", () => {
  it("複数領域が検出された場合、onRegionsで通知したうえで元解像度から領域ごとにクロップしOCRする", async () => {
    const source = makeSourceImage();
    const deps = makeDeps({ loadSourceImage: vi.fn(async () => source) });
    const engine = makeEngine(() => [line()], () => twoReceiptsBoxes());
    extractTotalMock
      .mockReturnValueOnce(resultOf("auto-high", 788, [788]))
      .mockReturnValueOnce(resultOf("auto-high", 1150, [1150]));

    const onRegions = vi.fn();
    const onResult = vi.fn();
    const onThumbnail = vi.fn();
    const onStatus = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus, onRegions, onResult, onThumbnail, onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    // onRegionsは写真1枚につき1回、2領域分の記述子で発火する
    expect(onRegions).toHaveBeenCalledTimes(1);
    const [photoId, regions, flags] = onRegions.mock.calls[0] as [string, RegionDescriptor[], RegionGroupFlags];
    expect(photoId).toBe("photo-1");
    expect(regions).toHaveLength(2);
    expect(regions.map((r) => r.jobId)).toEqual(["photo-1#0", "photo-1#1"]);
    expect(flags).toEqual({ ambiguous: false, nearLimit: false });
    // crop矩形は正規化座標(0..1)
    for (const r of regions) {
      expect(r.crop.x).toBeGreaterThanOrEqual(0);
      expect(r.crop.x + r.crop.width).toBeLessThanOrEqual(1);
    }

    // 元解像度から領域ごとにクロップ(検出canvasの座標ではなく元画像の座標)
    expect(source.cropToCanvas).toHaveBeenCalledTimes(2);
    // 全領域処理後にSourceImageを解放する
    expect(source.close).toHaveBeenCalledTimes(1);

    // 各領域のjobIdでonResultが発火する(元のphotoJobIdではない)
    expect(onResult).toHaveBeenCalledWith("photo-1#0", expect.objectContaining({ amountYen: 788, status: "auto-high" }));
    expect(onResult).toHaveBeenCalledWith("photo-1#1", expect.objectContaining({ amountYen: 1150, status: "auto-high" }));
    // 元のphotoJobId自体ではonResultは発火しない
    expect(onResult).not.toHaveBeenCalledWith("photo-1", expect.anything());

    // サムネイル・プレビューも領域ごとのjobIdで発火する
    expect(onThumbnail).toHaveBeenCalledWith("photo-1#0", expect.any(Blob));
    expect(onThumbnail).toHaveBeenCalledWith("photo-1#1", expect.any(Blob));

    // 「この写真から2枚のレシートを見つけました」+ 領域ごとの進捗通知
    const statusKinds = onStatus.mock.calls.map((c) => c[0]);
    expect(statusKinds).toContainEqual({ kind: "regionsFound", count: 2 });
    expect(statusKinds).toContainEqual({ kind: "regionProcessing", current: 1, total: 2 });
    expect(statusKinds).toContainEqual({ kind: "regionProcessing", current: 2, total: 2 });
  });

  it("領域が1つ(kind:single)ならonRegionsは発火せず、元のphotoJobIdでonResultが発火する(1枚運用と完全互換)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()], () => [{ x: 0, y: 0, width: 100, height: 100 }]);
    extractTotalMock.mockReturnValueOnce(resultOf("auto-high", 1000, [1000]));

    const onRegions = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onRegions, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    expect(onRegions).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith("photo-1", expect.objectContaining({ amountYen: 1000, status: "auto-high" }));
  });

  it("onRegions未指定でも複数領域の処理自体は継続する(通知はbest-effort)", async () => {
    const source = makeSourceImage();
    const deps = makeDeps({ loadSourceImage: vi.fn(async () => source) });
    const engine = makeEngine(() => [line()], () => twoReceiptsBoxes());
    extractTotalMock.mockReturnValue(resultOf("auto-high", 500, [500]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));
    expect(onResult).toHaveBeenCalledWith("photo-1#0", expect.objectContaining({ amountYen: 500 }));
    expect(onResult).toHaveBeenCalledWith("photo-1#1", expect.objectContaining({ amountYen: 500 }));
  });

  it("複数領域処理中にloadSourceImageが失敗した場合、全領域のjobIdをfailedとして確定する", async () => {
    const deps = makeDeps({ loadSourceImage: vi.fn(async () => { throw new Error("decode boom"); }) });
    const engine = makeEngine(() => [line()], () => twoReceiptsBoxes());

    const onRegions = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onRegions, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));
    expect(onResult).toHaveBeenCalledWith("photo-1#0", expect.objectContaining({ status: "failed", failureKind: "image-decode" }));
    expect(onResult).toHaveBeenCalledWith("photo-1#1", expect.objectContaining({ status: "failed", failureKind: "image-decode" }));
    expect(extractTotalMock).not.toHaveBeenCalled();
  });
});

describe("createOcrQueue: ambiguous時のauto-high禁止(§16.3安全弁、敵対テスト)", () => {
  it("detect()が0boxを返す(ambiguousフォールバック)場合、extractTotalがauto-highを返してもneeds-reviewへ格下げする", async () => {
    const source = makeSourceImage();
    const deps = makeDeps({ loadSourceImage: vi.fn(async () => source) });
    const engine = makeEngine(() => [line()], () => []); // 0box → mergeBoxesIntoLines→lines.length===0→ambiguous
    // extractTotalは(誤って)auto-highを返す — これが最終結果にそのまま出てはならない
    extractTotalMock.mockReturnValue(resultOf("auto-high", 9999, [9999]));

    const onRegions = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onRegions, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    // ambiguousも1領域として onRegions 経由で通知される(グループUIの回復導線のため)
    expect(onRegions).toHaveBeenCalledTimes(1);
    const [, regions, flags] = onRegions.mock.calls[0] as [string, RegionDescriptor[], RegionGroupFlags];
    expect(regions).toHaveLength(1);
    expect(flags.ambiguous).toBe(true);

    // 金額・候補は保持されるが、statusはauto-highではなくneeds-reviewへ格下げされる
    expect(onResult).toHaveBeenCalledWith(
      "photo-1#0",
      expect.objectContaining({ amountYen: 9999, candidates: [9999], status: "needs-review" }),
    );
  });

  it("ambiguousでも本来failed/needs-reviewだった結果はそのまま(格下げは既にauto-highの場合のみ)", async () => {
    const source = makeSourceImage();
    const deps = makeDeps({ loadSourceImage: vi.fn(async () => source) });
    const engine = makeEngine(() => [line()], () => []);
    extractTotalMock.mockReturnValue(resultOf("needs-review", 500, [500, 600]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith("photo-1#0", expect.objectContaining({ status: "needs-review", amountYen: 500 }));
  });

  it("detect()自体が例外を投げた場合も安全側(ambiguous相当)にフォールバックし、auto-highを禁止する", async () => {
    const source = makeSourceImage();
    const deps = makeDeps({ loadSourceImage: vi.fn(async () => source) });
    const engine: OcrEngine = {
      initialize: vi.fn(async () => undefined),
      recognize: vi.fn(async () => [line()]),
      detect: vi.fn(async () => {
        throw new Error("detect boom");
      }),
      destroy: vi.fn(async () => undefined),
    };
    extractTotalMock.mockReturnValue(resultOf("auto-high", 777, [777]));

    const onResult = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    try {
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
      expect(onResult).toHaveBeenCalledWith("photo-1#0", expect.objectContaining({ status: "needs-review", amountYen: 777 }));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("createOcrQueue: 個別領域の再試行・回復導線(§16.4/§16.5)", () => {
  it("cropを指定したenqueueは検出をやり直さず、loadSourceImageで元解像度からその領域だけをクロップする", async () => {
    const source = makeSourceImage();
    const loadSourceImageMock = vi.fn(async () => source);
    const deps = makeDeps({ loadSourceImage: loadSourceImageMock });
    const engine = makeEngine(() => [line()], () => {
      throw new Error("detect should not be called on crop retry");
    });
    extractTotalMock.mockReturnValueOnce(resultOf("auto-high", 300, [300]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    const file = new File([""], "photo.jpg");
    const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    queue.enqueue("retry-job", file, { crop });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    expect(engine.detect).not.toHaveBeenCalled();
    expect(loadSourceImageMock).toHaveBeenCalledWith(file);
    expect(source.cropToCanvas).toHaveBeenCalledWith(crop, 1600);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("retry-job", expect.objectContaining({ amountYen: 300, status: "auto-high" }));
  });

  it("forceSingleを指定したenqueueは検出をスキップし、写真全体をloadAsCanvas経由でOCRする(§16.5「写真全体を1枚として読み直す」)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()], () => {
      throw new Error("detect should not be called with forceSingle");
    });
    extractTotalMock.mockReturnValueOnce(resultOf("auto-high", 800, [800]));

    const onRegions = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onRegions, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    const file = new File([""], "photo.jpg");
    queue.enqueue("retry-job", file, { forceSingle: true });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    expect(engine.detect).not.toHaveBeenCalled();
    expect(deps.loadAsCanvas).toHaveBeenCalledWith(file);
    expect(onRegions).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith("retry-job", expect.objectContaining({ amountYen: 800, status: "auto-high" }));
  });

  it("crop再試行でloadSourceImageが失敗した場合、原因別のfailureKindでfailed確定する", async () => {
    const deps = makeDeps({
      loadSourceImage: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const engine = makeEngine(() => [line()], () => []);

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("retry-job", new File([""], "photo.jpg"), { crop: { x: 0, y: 0, width: 1, height: 1 } });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith(
      "retry-job",
      expect.objectContaining({ status: "failed", failureKind: "image-decode" }),
    );
  });
});
