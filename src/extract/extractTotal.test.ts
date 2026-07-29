import { describe, expect, test } from "vitest";
import { extractTotal } from "./extractTotal";
import * as fx from "./fixtures/synthetic";
import { line } from "./fixtures/synthetic";

describe("extractTotal", () => {
  test("標準レシート: 合計を採用し、お預り・お釣り・小計を選ばない", () => {
    const r = extractTotal(fx.supermarket);
    expect(r.amountYen).toBe(1332);
    expect(r.status).toBe("auto-high");
  });

  test("税率別表記: 8%/10%対象ではなく合計を採用", () => {
    const r = extractTotal(fx.taxBreakdown);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("キーワードなし: failed(最大値フォールバック禁止)", () => {
    const r = extractTotal(fx.truncated);
    expect(r.amountYen).toBeNull();
    expect(r.status).toBe("failed");
    expect(r.candidates).toEqual([]); // キーワード無しなら候補も出さない
  });

  test("キーワードの1行下の金額も拾う", () => {
    const r = extractTotal(fx.totalOnNextLine);
    expect(r.amountYen).toBe(3980);
    expect(r.status).toBe("auto-high");
  });

  test("現計+全角末尾ハイフン", () => {
    const r = extractTotal(fx.genkei);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("空入力はfailed", () => {
    expect(extractTotal([]).status).toBe("failed");
  });

  // --- Task 3 レビュー指摘の回帰テスト ---

  test("合計の下にお預りが挟まる金額をauto-highにしない", () => {
    const r = extractTotal([line("合計", 100), line("お預り", 120), line("¥5,000", 140, 200)]);
    expect(r.status).not.toBe("auto-high");
  });

  test("別カラム(左)の金額を合計に結び付けない", () => {
    // 金額がラベルより左にある → 同一行扱いしない
    const r = extractTotal([line("¥8,000", 100, 0), line("合計", 100, 500)]);
    expect(r.amountYen === 8000 && r.status === "auto-high").toBe(false);
  });

  test("低confidenceの合計行はauto-highにしない", () => {
    const r = extractTotal([line("合計", 140), line("¥1,332", 140, 200, 0.6)]);
    expect(r.status).toBe("needs-review");
  });

  test("同額重複でスコア差を過大評価しない", () => {
    // 1位(合計¥7,000)と2位(お会計¥6,980)の真のスコア差はわずか(5点)。
    // ¥6,980と同額・低スコアの候補(belowStrong経由、通貨記号なしでスコアが下がる)が
    // 後方に存在するため、重複除去が「最大スコアを保持」せず後勝ちで低スコアを
    // 残してしまう実装だと¥6,980側の代表スコアが見かけ上20点差まで開いてしまい
    // auto-highに誤判定する。最大スコアを保持していれば真の差(5点)により
    // needs-reviewとなるはず。
    const r = extractTotal([
      line("お会計", 100), line("¥6,980", 100, 200),
      line("合計", 300), line("¥7,000", 300, 200),
      line("6980", 340),
    ]);
    expect(r.status).toBe("needs-review");
  });

  test("強ラベルと除外語が同居する行はauto-highにしない", () => {
    const r = extractTotal([line("合計 ¥1,100 内税 ¥100", 140)]);
    expect(r.status).toBe("needs-review");
    expect(r.candidates).toContain(1100);
  });

  // --- Codexレビューで追加検出された回帰テスト ---

  test("合計の下にお預りが挟まる金額(結果の中身も確認)", () => {
    // 上のテストの`not.toBe("auto-high")`だけだと「候補ごと消えて failed になる」
    // ような誤実装でも通ってしまうため、amountYen・candidatesまで明示する。
    const r = extractTotal([line("合計", 100), line("お預り", 120), line("¥5,000", 140, 200)]);
    expect(r.status).toBe("needs-review");
    expect(r.amountYen).toBe(5000);
    expect(r.candidates).toEqual([5000]);
  });

  test("直下最近傍の探索は isJustBelow の窓に限定しない", () => {
    // ¥999(dy=8)はラベルに最も近い金額行だが、isJustBelowの下限(行高の0.5倍=10)より
    // 近すぎるため belowStrong 候補にすらならない。だからといって窓の外側にある
    // より近い金額行の存在を無視して、窓内で一番近い¥5,000(dy=30)を
    // 「直下最近傍」と誤判定してはならない。
    const r = extractTotal([line("合計", 100, 100), line("¥999", 108, 0), line("¥5,000", 130, 200)]);
    expect(r.status).not.toBe("auto-high");
  });

  test("対応する強ラベル行は配列順ではなく最近傍で選ぶ", () => {
    // "合計"(高confidence, 遠い)と"お会計"(低confidence, 金額に近い)の両方が
    // belowStrongの対象になり得る。配列に先に出てくる"合計"を機械的に選んでしまうと
    // 本来近傍にある低confidenceラベル"お会計"の存在を見逃し、confidenceゲートを
    // すり抜けてauto-highになってしまう。
    const r = extractTotal([
      line("合計", 100, 0, 0.95),
      line("お会計", 120, 0, 0.5),
      line("¥5,000", 140, 200, 0.95),
    ]);
    expect(r.status).not.toBe("auto-high");
  });

  test("強ラベルと除外語が同居する単一金額行はauto-high不可(除外語ゲート単体の検証)", () => {
    const r = extractTotal([line("合計 内税 ¥1,100", 140)]);
    expect(r.status).toBe("needs-review");
    expect(r.candidates).toEqual([1100]);
  });

  test("除外語がなくても1行に複数金額があればauto-high不可(複数トークンゲート単体の検証)", () => {
    const r = extractTotal([line("合計 ¥1,100 ¥100", 140)]);
    expect(r.status).toBe("needs-review");
    expect(r.candidates).toEqual([1100, 100]);
  });

  // --- [仮説A] ラベルのOCR崩れ耐性(.superpowers/sdd/ocr-investigation.md Phase3仮説A)---
  // 調査で観測された「合計」のOCR誤認識パターンへの耐性を検証する。段階1(観測済み崩れ
  // バリアント)は通常の強ラベルと同じ扱い、段階2/3(単独文字・ゆるい照合)は弱い加点に留め、
  // どの経路でもauto-highの60点に届かないスコア設計であること(誤自動確定の数学的防止)も
  // あわせて確認する。

  test("観測済みの崩れバリアント(含計/合针/合计/台計)は通常の強ラベルと同じくauto-highになりうる", () => {
    for (const variant of ["含計", "合针", "合计", "台計"]) {
      const r = extractTotal([line(variant, 140), line("¥1,332", 140, 200)]);
      expect(r.status).toBe("auto-high");
      expect(r.amountYen).toBe(1332);
    }
  });

  test("「合」単独(調査で観測した崩れケース、¥788)はneeds-review・788が候補1位になる", () => {
    // 調査レポート7.2節の実データ(anchor画像)を模したケース: 「合計」が「合」1文字に
    // 脱落し、小計・8%対象・内消費税・お預りが周囲に並ぶ。
    const r = extractTotal([
      line("小計", 100), line("¥788", 100, 200),
      line("8%対象", 140), line("¥788", 140, 200),
      line("内消費税", 180), line("¥58", 180, 200),
      line("合", 220), line("¥788", 220, 200),
      line("お預り", 260), line("¥1,000", 260, 200),
    ]);
    expect(r.status).toBe("needs-review");
    expect(r.amountYen).toBe(788);
    expect(r.candidates[0]).toBe(788);
  });

  test("「計」単独でも同様にneeds-review止まりで拾える(auto-highにはならない)", () => {
    const r = extractTotal([line("計", 140), line("¥788", 140, 200)]);
    expect(r.status).toBe("needs-review");
    expect(r.amountYen).toBe(788);
  });

  test("短い行に限定したゆるい照合(編集距離1)でも「合計」の崩れを拾える(例: 合訃)", () => {
    const r = extractTotal([line("合訃", 140), line("¥788", 140, 200)]);
    expect(r.status).toBe("needs-review");
    expect(r.amountYen).toBe(788);
  });

  test("安全弁: 「小計」は編集距離1で「合計」に近いが弱ラベルとして誤認識しない(REJECT_LABELS優先)", () => {
    // 「小計」だけが残り「合計」ラベルが完全に消失した敵対的ケース。
    // 小計自体が弱ラベル候補になってしまうと、REJECT_LABELSによる同一行減点(-100)を
    // 回避してauto-high誤爆に繋がりかねないため、明示的に除外する安全弁がある。
    const r = extractTotal([
      line("小計", 100), line("¥1,234", 100, 200),
      line("お預り", 140), line("¥2,000", 140, 200),
      line("お釣り", 180), line("¥766", 180, 200),
    ]);
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });

  test("弱ラベル経由の候補はどの経路でもauto-highにならない(高confidence・好条件でも)", () => {
    // 「合」単独ラベル自体が高confidenceで、円記号あり・下半分配置など好条件が揃っても、
    // スコア設計上60点に届かないためauto-highへは到達しない。
    const r = extractTotal([
      line("合", 400, 0, 0.99),
      line("¥788", 400, 200, 0.99),
    ]);
    expect(r.status).toBe("needs-review");
  });

  test("既存の回帰フィクスチャ(標準レシート等)は本変更で結果が変わらない", () => {
    expect(extractTotal(fx.supermarket).status).toBe("auto-high");
    expect(extractTotal(fx.supermarket).amountYen).toBe(1332);
    expect(extractTotal(fx.taxBreakdown).status).toBe("auto-high");
    expect(extractTotal(fx.genkei).status).toBe("auto-high");
    expect(extractTotal(fx.truncated).status).toBe("failed");
  });
});
