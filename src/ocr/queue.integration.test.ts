import { describe, expect, it, vi } from "vitest";
import type { OcrEngine } from "./engine";
import { createOcrQueue, type OcrQueueDeps } from "./queue";
import * as fx from "../extract/fixtures/synthetic";

/**
 * `queue.test.ts`は`extractTotal`をモックしてqueue自身の直列処理・再試行・結果反映
 * ロジックだけを検証している。それだけだとimport/型/結果マッピングの乖離
 * (例: `extractTotal`の戻り値の形が変わったのにqueue側のモックだけ追随していない等)を
 * 検出できないため(Codexレビュー指摘I4)、本ファイルでは`extractTotal`を一切モックせず、
 * 実装と合成`OcrLine[]`フィクスチャ(`extract/fixtures/synthetic.ts`)を組み合わせた
 * 薄い結合テストを1件だけ用意する。
 */

/** jsdomは実Canvas描画を持たないため、テスト用の薄いスタブを使う(queue.test.tsと同様)。 */
function fakeCanvas(): HTMLCanvasElement {
  return { width: 100, height: 100 } as unknown as HTMLCanvasElement;
}

describe("createOcrQueue (結合: 実extractTotal + 合成OcrLine[])", () => {
  it("supermarketフィクスチャに対し、実extractTotalの結果がそのままRowPatchへ反映される", async () => {
    const deps: OcrQueueDeps = {
      loadAsCanvas: vi.fn(async () => fakeCanvas()),
      enhanceContrast: vi.fn(() => fakeCanvas()),
      toThumbnailBlob: vi.fn(async () => new Blob(["thumb"])),
      toPreviewBlob: vi.fn(async () => new Blob(["preview"])),
    };
    const engine: OcrEngine = {
      initialize: vi.fn(async () => undefined),
      recognize: vi.fn(async () => fx.supermarket),
      destroy: vi.fn(async () => undefined),
    };

    const onResult = vi.fn();
    const queue = createOcrQueue(engine, { onStatus: vi.fn(), onResult, onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    queue.enqueue("a", new File([""], "receipt.png"));

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    // extract/extractTotal.test.tsの「標準レシート」ケースと同じ期待値(合計1,332円・auto-high)。
    expect(onResult).toHaveBeenCalledWith("a", {
      amountYen: 1332,
      status: "auto-high",
      candidates: [1332],
      processing: false,
    });
    // 1回目でauto-highなので、コントラスト補正での再試行は発生しないはず。
    expect(deps.enhanceContrast).not.toHaveBeenCalled();
    expect(engine.recognize).toHaveBeenCalledTimes(1);
  });
});
