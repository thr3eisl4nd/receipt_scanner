import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrEngine, OcrLine, OcrBox } from "./engine";
import type { ExtractResult } from "../extract/extractTotal";
import { createOcrQueue, type OcrQueueDeps, type PhotoDiagnostics } from "./queue";
import type { SourceImage } from "../image/sourceImage";

/**
 * task-22: 実機診断データ収集(`PhotoDiagnostics`/`onDiagnostics`)の単体テスト。
 *
 * iPhone Safari固有のマルチレシート誤分割(デスクトップでは再現せず、実機の`rawBoxes`
 * 採取が必要)をユーザーの実機から回収するための検出パス(パス1、`processNewPhoto`)
 * スナップショットが、(1)画像データ・OCR認識テキストを含まないこと、(2)座標が検出用
 * canvas寸法に対する正規化座標(0..1、小数3桁丸め・境界を超えない)であること、
 * (3)`decision.kind`に関わらず(single/multiple/ambiguous)発火すること、(4)検出を
 * やり直さない`crop`/`forceSingle`再試行やキャンセル済みジョブでは発火しないこと、
 * (5)`onDiagnostics`が第1引数に`photoJobId`を伴うこと(Codexレビュー指摘:
 * 呼び出し側が「今も有効なジョブか」を検証できるようにするため)を検証する。
 */

vi.mock("../extract/extractTotal", () => ({ extractTotal: vi.fn() }));
import { extractTotal } from "../extract/extractTotal";
const extractTotalMock = vi.mocked(extractTotal);

function fakeCanvas(width: number, height: number): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement;
}

function makeSourceImage(
  width: number,
  height: number,
  detectCanvasWidth: number,
  detectCanvasHeight: number,
): SourceImage & { cropToCanvas: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    width,
    height,
    // v1.3のprocessNewPhotoは検出用(1200px相当)canvasも領域クロップ用(1600px相当)canvasも
    // 同一SourceImageのcropToCanvasから作る。本テストは検出パスの診断データのみを見るため、
    // 常に同じ寸法のcanvasを返す単純なスタブでよい。
    cropToCanvas: vi.fn(() => fakeCanvas(detectCanvasWidth, detectCanvasHeight)),
    close: vi.fn((): void => undefined),
  };
}

function makeDeps(source: SourceImage): OcrQueueDeps {
  return {
    loadAsCanvas: vi.fn(async () => fakeCanvas(1600, 1200)),
    enhanceContrast: vi.fn((src) => src),
    toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
    toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    loadSourceImage: vi.fn(async () => source),
  };
}

const line = (): OcrLine => ({ text: "x", confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } });

function resultOf(status: ExtractResult["status"], amountYen: number | null, candidates: number[]): ExtractResult {
  return { amountYen, status, candidates };
}

function makeEngine(detectImpl: () => Promise<OcrBox[]> | OcrBox[]): OcrEngine {
  return {
    initialize: vi.fn(async () => undefined),
    recognize: vi.fn(async () => [line()]),
    detect: vi.fn(async () => detectImpl()),
    destroy: vi.fn(async () => undefined),
  };
}

/** 2つのレシート相当(各5行、水平に大きく離れた)box群(1200x800canvas前提、
 *  queue.regionSplit.test.tsのtwoReceiptsBoxesと同じ形状)。kind:"multiple"を誘発する。 */
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

beforeEach(() => {
  extractTotalMock.mockReset();
  extractTotalMock.mockReturnValue(resultOf("auto-high", 100, [100]));
});

describe("createOcrQueue: 実機診断データ収集(task-22)", () => {
  it("kind:single(1box)の場合、正規化座標(検出canvas寸法基準、小数3桁)でphotoJobId付きのonDiagnosticsが1回発火する", async () => {
    const source = makeSourceImage(4000, 2000, 1000, 1000);
    const deps = makeDeps(source);
    // 1boxのみ: mergeBoxesIntoLinesが1行のまま、findBestSplitはgap候補が無いためnull
    // →分割されず、region bboxはこのbox自体と一致する(kind:"single")。
    const engine = makeEngine(() => [{ x: 100, y: 200, width: 300, height: 400 }]);

    const onDiagnostics = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onDiagnostics).toHaveBeenCalledTimes(1));

    // 第1引数はenqueue()に渡したphotoJobId(onRegionsと同じ引数、Codexレビュー指摘)。
    const [jobId, diagnostics] = onDiagnostics.mock.calls[0] as [string, PhotoDiagnostics];
    expect(jobId).toBe("photo-1");
    expect(diagnostics.photoW).toBe(4000);
    expect(diagnostics.photoH).toBe(2000);
    expect(diagnostics.detectCanvasW).toBe(1000);
    expect(diagnostics.detectCanvasH).toBe(1000);
    expect(diagnostics.userAgent).toBe(navigator.userAgent);
    expect(diagnostics.rawBoxes).toEqual([{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }]);
    expect(diagnostics.decision.kind).toBe("single");
    // 単一box=単一領域なので、領域bboxはbox自体と一致する。
    expect(diagnostics.decision.regions).toEqual([{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }]);

    // プライバシー: 画像データ・OCR認識テキストを含む余計なキーが無いことを確認する。
    expect(Object.keys(diagnostics).sort()).toEqual(
      ["decision", "detectCanvasH", "detectCanvasW", "photoH", "photoW", "rawBoxes", "userAgent"].sort(),
    );
  });

  it("座標は四捨五入(切り捨てではない)で小数3桁に丸められる(開始点・終了点をそれぞれ丸めてからサイズを差分計算する)", async () => {
    const source = makeSourceImage(1000, 1000, 2000, 2000);
    const deps = makeDeps(source);
    // 開始点667/2000=0.3335ちょうど → 四捨五入で0.334(切り捨てなら0.333になり区別できる)。
    // 終了点(667+667)/2000=0.667ちょうど(丸め不要)。widthは終了点0.667と開始点0.334の
    // 差分として0.333になる(box.width/total=667/2000=0.3335を素朴に丸めた0.334とは
    // 一致しない。これは「開始点・終了点それぞれの丸め値の差」を採用したことによる意図した
    // 挙動で、x+widthが丸め後の終了点と必ず一致することを保証するための設計)。
    const engine = makeEngine(() => [{ x: 667, y: 667, width: 667, height: 667 }]);

    const onDiagnostics = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onDiagnostics).toHaveBeenCalledTimes(1));
    const [, diagnostics] = onDiagnostics.mock.calls[0] as [string, PhotoDiagnostics];
    expect(diagnostics.rawBoxes).toEqual([{ x: 0.334, y: 0.334, width: 0.333, height: 0.333 }]);
  });

  // --- Codexレビュー指摘(Moderate): x/widthを独立に丸めると合計が1をわずかに超えうる ---
  it("x+width・y+heightは、開始点とサイズを独立に丸めても1を超えない(端点基準で丸める)", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    // 幅1200pxに対しx=3,width=1197: 独立に丸めると x:0.003 + width:0.998 = 1.001 (>1)になる
    // ことを実測済み(修正前の挙動)。高さ800pxに対してもy=2,height=798で同じ境界を作る。
    const engine = makeEngine(() => [{ x: 3, y: 2, width: 1197, height: 798 }]);

    const onDiagnostics = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onDiagnostics).toHaveBeenCalledTimes(1));
    const [, diagnostics] = onDiagnostics.mock.calls[0] as [string, PhotoDiagnostics];
    const box = diagnostics.rawBoxes[0];
    // box.x+box.widthは画像端(1200px)ちょうどなので、終了点は正規化後ぴったり1になり、
    // 開始点(0.003)との差としてwidthが0.997と求まる(独立丸めなら0.003+0.998=1.001と
    // なり1を超えていた、修正前の挙動)。
    expect(box).toEqual({ x: 0.003, y: 0.003, width: 0.997, height: 0.997 });
    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
    expect(box.x + box.width).toBeCloseTo(1, 10);
    expect(box.y + box.height).toBeCloseTo(1, 10);
  });

  it("kind:multiple(2レシート相当)の場合、rawBoxes/decision.regionsが正しい件数で発火する", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    const engine = makeEngine(() => twoReceiptsBoxes());

    const onDiagnostics = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    // 2領域分のOCR結果が出るまで待つ(diagnosticsは検出パス完了時点で先に発火している)。
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    expect(onDiagnostics).toHaveBeenCalledTimes(1); // 写真1枚につき1回のみ(領域ごとではない)
    const [jobId, diagnostics] = onDiagnostics.mock.calls[0] as [string, PhotoDiagnostics];
    expect(jobId).toBe("photo-1");
    expect(diagnostics.decision.kind).toBe("multiple");
    expect(diagnostics.rawBoxes).toHaveLength(10); // twoReceiptsBoxes()の生box数(5+5)
    expect(diagnostics.decision.regions).toHaveLength(2);
    // 全座標が0..1の正規化範囲内であること
    for (const r of [...diagnostics.rawBoxes, ...diagnostics.decision.regions]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1);
      expect(r.y + r.height).toBeLessThanOrEqual(1);
    }
  });

  it("kind:ambiguous(detect()が0boxを返す)の場合、rawBoxesは空でfallbackRegionが写真全体(0,0,1,1)として発火する", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    const engine = makeEngine(() => []);

    const onDiagnostics = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onDiagnostics).toHaveBeenCalledTimes(1));
    const [, diagnostics] = onDiagnostics.mock.calls[0] as [string, PhotoDiagnostics];
    expect(diagnostics.decision.kind).toBe("ambiguous");
    expect(diagnostics.rawBoxes).toEqual([]);
    expect(diagnostics.decision.regions).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
  });

  it("detect()自体が例外を投げた場合(安全側フォールバック)もrawBoxes空・ambiguousとして発火する", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    const engine: OcrEngine = {
      initialize: vi.fn(async () => undefined),
      recognize: vi.fn(async () => [line()]),
      detect: vi.fn(async () => {
        throw new Error("detect boom");
      }),
      destroy: vi.fn(async () => undefined),
    };

    const onDiagnostics = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    try {
      await vi.waitFor(() => expect(onDiagnostics).toHaveBeenCalledTimes(1));
      const [, diagnostics] = onDiagnostics.mock.calls[0] as [string, PhotoDiagnostics];
      expect(diagnostics.rawBoxes).toEqual([]);
      expect(diagnostics.decision.kind).toBe("ambiguous");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("onDiagnostics未指定でも通常の処理は継続する(通知はbest-effort)", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    const engine = makeEngine(() => [{ x: 0, y: 0, width: 100, height: 100 }]);

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith("photo-1", expect.objectContaining({ amountYen: 100 }));
  });

  it("onDiagnosticsコールバックが例外を投げても、行の処理自体は継続する(他のemit*系コールバックと同じbest-effort保証)", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    const engine = makeEngine(() => [{ x: 0, y: 0, width: 100, height: 100 }]);

    const onDiagnostics = vi.fn(() => {
      throw new Error("callback boom");
    });
    const onResult = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    try {
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
      expect(onDiagnostics).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith("photo-1", expect.objectContaining({ amountYen: 100, status: "auto-high" }));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("cropを指定した個別領域の再試行では検出をやり直さないため、onDiagnosticsは発火しない", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    const engine = makeEngine(() => {
      throw new Error("detect should not be called on crop retry");
    });

    const onDiagnostics = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("retry-job", new File([""], "photo.jpg"), { crop: { x: 0, y: 0, width: 1, height: 1 } });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onDiagnostics).not.toHaveBeenCalled();
  });

  it("forceSingleを指定した再試行では検出をスキップするため、onDiagnosticsは発火しない", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    const engine = makeEngine(() => {
      throw new Error("detect should not be called with forceSingle");
    });

    const onDiagnostics = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("retry-job", new File([""], "photo.jpg"), { forceSingle: true });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onDiagnostics).not.toHaveBeenCalled();
  });

  // --- Codexレビュー指摘(Important): キャンセル済みジョブの診断データが後から届く回帰テスト ---
  it("detect()進行中にcancelAll()されたジョブは、検出完了後もonDiagnosticsが発火しない", async () => {
    const source = makeSourceImage(4000, 3000, 1200, 800);
    const deps = makeDeps(source);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const engine: OcrEngine = {
      initialize: vi.fn(async () => undefined),
      recognize: vi.fn(async () => [line()]),
      detect: vi.fn(async () => {
        await gate; // cancelAll()が呼ばれるまでdetect()の解決を止める
        return [{ x: 0, y: 0, width: 100, height: 100 }];
      }),
      destroy: vi.fn(async () => undefined),
    };

    const onDiagnostics = vi.fn();
    const onResult = vi.fn();
    const queue = createOcrQueue(
      engine,
      { onStatus: vi.fn(), onDiagnostics, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() },
      deps,
    );
    queue.enqueue("photo-1", new File([""], "photo.jpg"));

    await vi.waitFor(() => expect(engine.detect).toHaveBeenCalledTimes(1));
    queue.cancelAll(); // detect()がまだ解決していないうちにキャンセルする(cancelGenerationを進める)
    releaseGate();

    // kind:singleの経路自体はcancelGenerationを見ないため処理は最後まで進み、onResultは
    // 発火する(この後方互換動作は本タスクの変更対象外)。ここで検証したいのは、検出パス
    // 直後の`emitDiagnostics`呼び出し自体が`canceled(item)`ガードにより発火しないこと。
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onDiagnostics).not.toHaveBeenCalled();
  });
});
