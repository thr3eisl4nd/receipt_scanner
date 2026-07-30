import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrEngine, OcrLine } from "./engine";
import type { ExtractResult } from "../extract/extractTotal";
import { createOcrQueue, type OcrQueueDeps, type QueueStatusEvent } from "./queue";
import { UnsupportedFormatError, ImageTooLargeError, ImageDecodeError } from "../image/preprocess";

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
    toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
  };
}

/**
 * v1.3(複数レシート自動分割)で`OcrEngine`に`detect()`が追加された。既存の
 * queue.test.tsの大半は「1枚の写真=1レシート」の従来動作を検証するテストのため、
 * `detect()`の既定モックは単一box(1個)を返す。`buildLayoutDecision`は片側最小5box
 * 無いと分割候補にすらならないため、単一boxは常に`kind:"single"`(領域1つ=従来通り)
 * になり、これらのテストの前提(1回のrecognize/enhanceContrastで完結する既存パイプライン)
 * を変えない。
 */
const SINGLE_REGION_DETECT_BOX = [{ x: 0, y: 0, width: 100, height: 100 }];

function makeEngine(recognizeImpl: (canvas: HTMLCanvasElement) => OcrLine[] | Promise<OcrLine[]>): OcrEngine {
  return {
    initialize: vi.fn(async () => undefined),
    recognize: vi.fn(async (canvas: HTMLCanvasElement) => recognizeImpl(canvas)),
    detect: vi.fn(async () => SINGLE_REGION_DETECT_BOX),
    destroy: vi.fn(async () => undefined),
  };
}

const line = (text = "x"): OcrLine => ({ text, confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 10 } });

/** [仮説C]再試行ゲートのテスト専用: 行数・confidenceを個別に制御したいのでconfidenceを引数化する。 */
const lineWithConfidence = (confidence: number, text = "行"): OcrLine => ({
  text,
  confidence,
  box: { x: 0, y: 0, width: 10, height: 10 },
});

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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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

  it("failedかつ行数不足(sparse)なら補正版で再試行する(I5: failedのみ行数・confidenceゲートを適用)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("auto-high", 700, [700]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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

  it("1回目がfailedでも補正版がneeds-reviewに改善したら採用する(Codexレビュー指摘I4)", async () => {
    // 従来は「補正版がauto-highの場合のみ採用」だったため、[仮説A]の弱ラベル経由で
    // 設計上needs-review止まりの回復(1回目failed→補正後「合」+「¥788」がneeds-review
    // として読める)を取り逃し、failedのまま結果を返していた。ランク比較(failed(0) <
    // needs-review(1))により改善判定できるようにする。
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("needs-review", 788, [788]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 788,
      status: "needs-review",
      candidates: [788],
      processing: false,
    });
  });

  // --- [仮説C] コントラスト再試行のゲート(.superpowers/sdd/ocr-investigation.md Phase3仮説C)の回帰テスト ---
  // 従来は`status !== "auto-high"`のみで無条件に2回目のOCRを実行していたが、調査により
  // 「1回目のconfidenceが十分高く行数も十分あるのに読みにくい画像と誤判定して再試行し、
  // 処理時間だけが倍になる」ケースが判明した。1回目の認識行数・平均confidenceで
  // 「本当に読みにくい画像か」を判別し、そうでなければ2回目を省略する。
  //
  // Codexレビュー指摘I5により、この行数・平均confidenceによるゲートは`failed`にのみ
  // 適用するよう変更した(`needs-review`は無条件で常に再試行する。全行平均には
  // 抽出判断に無関係な行のconfidenceも含まれ、合計ラベル自体の低confidenceが埋もれて
  // 再試行を取り逃すケースがあったため、`needs-review`側は安全側に倒した)。
  // 以下のゲート系テストは、この変更に伴い`firstResult`のstatusを`failed`に統一した
  // (`needs-review`のままだと行数・confidenceの値に関わらず常に再試行されてしまい、
  // ゲート自体を検証できなくなるため)。

  it("needs-reviewは行数・平均confidenceに関わらず常に再試行する(Codexレビュー指摘I5)", async () => {
    const deps = makeDeps();
    // 20行、全行confidence0.95(行数・confidenceともゲート的には「再試行不要」水準)でも、
    // needs-reviewである以上は無条件に再試行するはず。
    const manyHighConfLines = Array.from({ length: 20 }, () => lineWithConfidence(0.95));
    const engine = makeEngine(() => manyHighConfLines);
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review", 900, [900, 950]))
      .mockReturnValueOnce(resultOf("auto-high", 950, [950]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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

  it("failedで高confidence・多数行なら再試行しない(仮説Cゲート改訂I5: gateはfailedのみに適用)", async () => {
    const deps = makeDeps();
    // 20行、全行confidence0.95(平均0.95 >= 閾値0.85、行数20 >= 閾値15) → ゲートは「再試行不要」と判定するはず
    const manyHighConfLines = Array.from({ length: 20 }, () => lineWithConfidence(0.95));
    const engine = makeEngine(() => manyHighConfLines);
    extractTotalMock.mockReturnValue(resultOf("failed", null, []));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(engine.recognize).toHaveBeenCalledTimes(1);
    expect(deps.enhanceContrast).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
      failureKind: "ocr", // I1: 通常経路のfailedにもfailureKindが付く
    });
  });

  it("failedで行数が十分でも平均confidenceが閾値未満なら再試行する(仮説Cゲート改訂I5)", async () => {
    const deps = makeDeps();
    // 20行(閾値15以上)だが全行confidence0.7(平均0.7 < 閾値0.85) → 再試行が発火するはず
    const manyLowConfLines = Array.from({ length: 20 }, () => lineWithConfidence(0.7));
    const engine = makeEngine(() => manyLowConfLines);
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("auto-high", 950, [950]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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

  it("failedで行数が閾値未満なら平均confidenceが高くても再試行する(仮説Cゲート改訂I5: 行数不足のsparse判定)", async () => {
    const deps = makeDeps();
    // 5行(閾値15未満)、全行confidence0.95(平均は高い) → 行数不足で再試行が発火するはず
    const fewHighConfLines = Array.from({ length: 5 }, () => lineWithConfidence(0.95));
    const engine = makeEngine(() => fewHighConfLines);
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("auto-high", 950, [950]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
    expect(engine.recognize).toHaveBeenCalledTimes(2);
  });

  // --- Minor: averageConfidenceの非有限値防御・境界値の回帰テスト ---
  // 全行平均confidenceに1件でもNaN/Infinityが混ざると、防御がない場合
  // `NaN < 0.85`/`Infinity < 0.85`は共にfalseになり、再試行を誤ってスキップしてしまう
  // (failedかつ行数がRETRY_MIN_LINES以上のケースでのみ顕在化する)。

  it("0行なら再試行する(境界値: 現在の実装通り、行数不足でsparse判定)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => []); // recognizeが0行を返す
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("auto-high", 700, [700]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
  });

  it("ちょうど15行・平均confidenceちょうど0.85なら再試行しない(境界値、仕様通り)", async () => {
    const deps = makeDeps();
    // 15行全部を0.85にすると浮動小数点の反復加算誤差で平均が0.85よりわずかに
    // 小さくなってしまう(0.85は2進数で正確に表現できないため)。1.0(12行)と
    // 0.25(3行)は2進数で正確に表現できる値なので、合計12.75・平均0.85が
    // ビット単位で正確に0.85になる組み合わせを使う。
    const exactBoundaryLines = [
      ...Array.from({ length: 12 }, () => lineWithConfidence(1.0)),
      ...Array.from({ length: 3 }, () => lineWithConfidence(0.25)),
    ];
    const engine = makeEngine(() => exactBoundaryLines);
    extractTotalMock.mockReturnValue(resultOf("failed", null, []));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(engine.recognize).toHaveBeenCalledTimes(1);
    expect(deps.enhanceContrast).not.toHaveBeenCalled();
  });

  it("平均confidence計算にNaNが混ざると再試行する(Minor: 非有限値は0扱いにする安全弁)", async () => {
    const deps = makeDeps();
    const linesWithNaN = [
      ...Array.from({ length: 14 }, () => lineWithConfidence(0.99)),
      lineWithConfidence(NaN),
    ];
    const engine = makeEngine(() => linesWithNaN);
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("auto-high", 700, [700]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
  });

  it("平均confidence計算にInfinityが混ざると再試行する(Minor: 非有限値は0扱いにする安全弁)", async () => {
    const deps = makeDeps();
    const linesWithInfinity = [
      ...Array.from({ length: 14 }, () => lineWithConfidence(0.99)),
      lineWithConfidence(Infinity),
    ];
    const engine = makeEngine(() => linesWithInfinity);
    extractTotalMock
      .mockReturnValueOnce(resultOf("failed", null, []))
      .mockReturnValueOnce(resultOf("auto-high", 700, [700]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(deps.enhanceContrast).toHaveBeenCalledTimes(1);
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
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock
      .mockReturnValueOnce(resultOf("needs-review"))
      .mockReturnValueOnce(resultOf("failed", null, []));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus, onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));
    queue.enqueue("c", new File([""], "c.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(3));
    expect(engine.initialize).toHaveBeenCalledTimes(1);
  });

  it("通常経路(例外なし)でextractTotalがfailedを返した場合もfailureKind:'ocr'を付与する(Codexレビュー指摘I1)", async () => {
    // 従来は例外catch経由のfailedにしかfailureKindが付かず、「OCRは成功したが合計を
    // 抽出できない」という主症状(通常経路のfailed)では撮り直し案内が表示されなかった。
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    // 1回目・2回目とも(再試行しても)failedのままにして、例外を経由せず
    // 通常経路でstatus:"failed"が確定するケースを再現する。
    extractTotalMock.mockReturnValue(resultOf("failed", null, []));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onResult).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({
        status: "failed",
        failureKind: "ocr",
      }),
    );
  });

  it("recognizeが例外を投げた場合、failedとして結果を返す(候補行の中断ではない)", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => {
      throw new Error("recognize boom");
    });

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    // OCR推論(recognize)自体の失敗はfailureKind:"ocr"として区別される(Codexレビュー
    // 最終ゲート指摘I1: 画像デコード失敗等と同じ「読取失敗」に潰さない)。
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
      failureKind: "ocr",
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
      detect: vi.fn(async () => SINGLE_REGION_DETECT_BOX),
      destroy: vi.fn(async () => undefined),
    };

    const onResult = vi.fn();
    const onStatus = vi.fn();
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    let recognizeCallCount = 0;
    const engine = makeEngine(() => {
      recognizeCallCount++;
      if (recognizeCallCount === 2) throw new Error("2nd recognize boom");
      return [line()];
    });
    extractTotalMock.mockReturnValueOnce(resultOf("needs-review", 900, [900]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValueOnce(resultOf("needs-review", 800, [800]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 300, [300]));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));
    queue.enqueue("b", new File([""], "b.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));

    // loadAsCanvas失敗は、instanceofで分類できない汎用Error(テストスタブ含む)の場合
    // "image-decode"にフォールバックする(Codexレビュー最終ゲート指摘I1)。
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
      failureKind: "image-decode",
    });
    expect(onResult).toHaveBeenCalledWith("b", {
      amountYen: 300,
      status: "auto-high",
      candidates: [300],
      processing: false,
    });
  });

  // --- Codexレビュー最終ゲート指摘I1(失敗種別の区別)の回帰テスト ---

  it("loadAsCanvasがUnsupportedFormatErrorを投げた場合、failureKind:'unsupported-format'として結果を返す", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => {
        throw new UnsupportedFormatError();
      }),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine = makeEngine(() => [line()]);
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.pdf"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
      failureKind: "unsupported-format",
    });
    // 未対応形式はOCR推論まで到達しない(サムネイル/プレビュー生成も行われない)
    expect(deps.toThumbnailBlob).not.toHaveBeenCalled();
    expect(deps.toPreviewBlob).not.toHaveBeenCalled();
    expect(extractTotalMock).not.toHaveBeenCalled();
  });

  it("loadAsCanvasがImageTooLargeErrorを投げた場合、failureKind:'image-too-large'として結果を返す", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => {
        throw new ImageTooLargeError();
      }),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine = makeEngine(() => [line()]);
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "huge.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
      failureKind: "image-too-large",
    });
  });

  it("loadAsCanvasがImageDecodeErrorを投げた場合も、failureKind:'image-decode'として結果を返す", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => {
        throw new ImageDecodeError();
      }),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine = makeEngine(() => [line()]);
    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "broken.jpg"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
      processing: false,
      failureKind: "image-decode",
    });
  });

  it("モデル初期化失敗によるfailedPatchにはfailureKindを付与しない(既に専用のmodel-errorバナーで原因を説明済みのため)", async () => {
    const deps = makeDeps();
    const engine: OcrEngine = {
      initialize: vi.fn(async () => {
        throw new Error("init boom");
      }),
      recognize: vi.fn(async () => [line()]),
      detect: vi.fn(async () => SINGLE_REGION_DETECT_BOX),
      destroy: vi.fn(async () => undefined),
    };

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: null,
      status: "failed",
      candidates: [],
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
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus, onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(seenCanvases).toEqual([original, enhancedCanvas]);
  });

  it("完全にドレインした後の新しいバッチでもinitializeは再実行されない", async () => {
    const deps = makeDeps();
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
        toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
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
    const queue1 = createOcrQueue(engine, { onStatus: vi.fn(), onResult: onResultA, onThumbnail: vi.fn(), onPreview: vi.fn() }, depsA);
    const queue2 = createOcrQueue(engine, { onStatus: vi.fn(), onResult: onResultB, onThumbnail: vi.fn(), onPreview: vi.fn() }, depsB);

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
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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

  it("loadAsCanvas直後にonThumbnail・onPreviewの両方で縮小Blobを返す(OCR結果より前に届く。Codexレビュー最終ゲート指摘I2でpreviewを追加)", async () => {
    const thumbBlob = new Blob(["thumb"]);
    const previewBlob = new Blob(["preview"]);
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
      toPreviewBlob: vi.fn(async () => {
        order.push("preview");
        return previewBlob;
      }),
    };
    const engine = makeEngine(() => {
      order.push("recognize");
      return [line()];
    });
    extractTotalMock.mockReturnValue(resultOf("auto-high"));

    const onThumbnail = vi.fn(() => order.push("onThumbnail"));
    const onPreview = vi.fn(() => order.push("onPreview"));
    const onResult = vi.fn(() => order.push("onResult"));
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail, onPreview }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(onThumbnail).toHaveBeenCalledWith("a", thumbBlob);
    expect(onPreview).toHaveBeenCalledWith("a", previewBlob);
    expect(order).toEqual(["load", "thumbnail", "onThumbnail", "preview", "onPreview", "recognize", "onResult"]);
  });

  it("サムネイル生成が失敗してもOCR結果には影響しない(best-effort)", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => fakeCanvas()),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => {
        throw new Error("thumbnail boom");
      }),
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 100, [100]));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onResult = vi.fn();
    const onThumbnail = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail, onPreview: vi.fn() }, deps);
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

  it("プレビュー生成が失敗してもOCR結果には影響しない(best-effort、Codexレビュー最終ゲート指摘I2)", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => fakeCanvas()),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
      toPreviewBlob: vi.fn(async () => {
        throw new Error("preview boom");
      }),
    };
    const engine = makeEngine(() => [line()]);
    extractTotalMock.mockReturnValue(resultOf("auto-high", 100, [100]));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onResult = vi.fn();
    const onPreview = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview }, deps);
    queue.enqueue("a", new File([""], "a.png"));

    try {
      await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
      expect(onResult).toHaveBeenCalledWith("a", expect.objectContaining({ amountYen: 100 }));
      expect(onPreview).not.toHaveBeenCalled();
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
    const queue = createOcrQueue(engine, { onStatus, onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
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
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult: vi.fn(), onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);

    let settled = false;
    await queue.dispose().then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
  });
});
