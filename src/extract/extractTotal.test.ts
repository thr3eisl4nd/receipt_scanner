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
  // バリアント: 含計/合针/合计/台計)は通常の強ラベルと同スコア(+50/+40)で扱うが、
  // Codexレビュー指摘I3によりauto-highの対象からは除外する(`labelKind === "exact"`のみ
  // 許可)。段階2(「合」単独)は弱い加点に留め、どの経路でもauto-highの60点に届かない
  // スコア設計であること(誤自動確定の数学的防止)もあわせて確認する。「計」単独・
  // 編集距離1のゆるい照合はCodexレビュー指摘I2により廃止した(下記の敵対テストを参照)。

  test("観測済みの崩れバリアント(含計/合针/合计/台計)はneeds-reviewまで回復するが、auto-highにはならない(Codexレビュー指摘I3)", () => {
    // 字形崩れである以上「合計」以外の語を誤って拾っている可能性を排除できないため、
    // auto-highへの自動確定は許可しない。failed→needs-reviewの回復効果自体は維持される
    // (amountYenが漏れずcandidatesの1位に来ること)。
    for (const variant of ["含計", "合针", "合计", "台計"]) {
      const r = extractTotal([line(variant, 140), line("¥1,332", 140, 200)]);
      expect(r.status).toBe("needs-review");
      expect(r.amountYen).toBe(1332);
    }
  });

  test("敵対テスト: 「台計」+ 通貨表記なしの数字はauto-highにならない(Codexレビュー指摘I3: 通貨記号すら不要な60点で自動確定していた穴)", () => {
    // 崩れバリアントは通常の強ラベルと同スコア(+50)で扱われるため、通貨記号がなくても
    // 50(nearStrong) + confidence満点10 = 60点に達し、修正前はauto-highになってしまっていた。
    const r = extractTotal([line("台計", 100, 0, 0.95), line("3", 100, 200, 0.95)]);
    expect(r.status).not.toBe("auto-high");
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

  test("「計」単独はもう弱ラベルとして扱わない(Codexレビュー指摘I2: 廃止)", () => {
    // 「計」は「3点計」のような数量表記の一部としても頻出する一般的な1文字であり、
    // 弱ラベルとして許容すると無関係な数量を金額候補へ格上げしてしまう(下記の
    // 「計 3点」敵対テストを参照)。実機で観測された脱落パターンは「合」の単独脱落のみ
    // だったため、「計」単独はラベルとして一致せず候補自体が生成されない(failed)。
    const r = extractTotal([line("計", 140), line("¥788", 140, 200)]);
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });

  test("編集距離1のゆるい照合はもう行わない(Codexレビュー指摘I2: 廃止、例: 合訃)", () => {
    // 「合訃」は「合計」への編集距離1(段階3のゆるい照合対象)だったが、対象を広げすぎて
    // いたため廃止した。「合訃」全体は「合」と完全一致しないため弱ラベルにも該当せず、
    // ラベルとして一致せず候補自体が生成されない(failed)。
    const r = extractTotal([line("合訃", 140), line("¥788", 140, 200)]);
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });

  test("弱ラベル経由の金額候補は通貨表記(¥/￥/円)が必須(Codexレビュー指摘I2の安全弁)", () => {
    // findMoneyTokensは通貨記号なしの裸の数字("788")もトークンとして拾うため、
    // 弱ラベル("合")と関連付けられても通貨表記がなければ候補から除外する。
    const r = extractTotal([line("合", 220), line("788", 220, 200)]);
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });

  // --- Codexレビュー指摘I2の敵対テスト: OCRが分割した一般的な数量表記が
  // needs-reviewへ誤って格上げされないこと ---

  test("敵対テスト: 「計」+「3点」はneeds-reviewへ格上げされない(I2)", () => {
    const r = extractTotal([line("計", 100, 0, 0.95), line("3点", 100, 200, 0.95)]);
    expect(r.status).not.toBe("needs-review");
  });

  test("敵対テスト: 「累計」+「500」はneeds-reviewへ格上げされない(I2: 編集距離1のゆるい照合廃止)", () => {
    const r = extractTotal([line("累計", 100, 0, 0.95), line("500", 100, 200, 0.95)]);
    expect(r.status).not.toBe("needs-review");
  });

  test("敵対テスト: 「商品計」+「4点」はneeds-reviewへ格上げされない(I2)", () => {
    const r = extractTotal([line("商品計", 100, 0, 0.95), line("4点", 100, 200, 0.95)]);
    expect(r.status).not.toBe("needs-review");
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

  // --- task-20: 実写真(real-photos/IMG_0201.jpeg)3領域のper-region OCR実測
  // (`.superpowers/sdd/task-20-report.md`)で新たに観測した崩れパターン ---

  test("観測済みの崩れバリアント(今計/合十)もneeds-reviewまで回復するが、auto-highにはならない(task-20)", () => {
    // 「今計」はtask-19調査、「合十」は本タスクで3回連続再現した「合計」の崩れ。
    for (const variant of ["今計", "合十"]) {
      const r = extractTotal([line(variant, 140), line("¥1,332", 140, 200)]);
      expect(r.status).toBe("needs-review");
      expect(r.amountYen).toBe(1332);
    }
  });

  test("「取引金額」の「取」脱落崩れ(引金額/引金额)はneeds-reviewまで回復する(task-20、実写真左領域実測)", () => {
    for (const variant of ["引金額", "引金额"]) {
      const r = extractTotal([line(variant, 140), line("￥3,084", 140, 200)]);
      expect(r.status).toBe("needs-review");
      expect(r.amountYen).toBe(3084);
      expect(r.candidates[0]).toBe(3084);
    }
  });

  test("安全弁: 正しくOCRできた「取引金額」はラベルとして扱わない(task-20)", () => {
    // 実写真右領域で、正しく認識された「取引金額」ラベルが無関係な断片金額「¥3」と
    // 同じ行に存在するケースを実測した(`.superpowers/sdd/task-20-report.md`)。これを
    // ラベルとして許可すると、src/ocr/queue.tsのSTATUS_RANK方式リトライ(同ランクへの
    // 遷移では上書きしない)により、1回目の認識がneeds-review(誤った値のまま)で
    // 確定してしまい、2回目の再試行(コントラスト強調)で正しい合計が取れていても
    // 採用されなくなる回帰を招く。そのため「取」を伴う正しい「取引金額」は意図的に
    // スコープ外とし、この行だけが唯一のラベル候補であればfailedのままであるべき。
    const r = extractTotal([line("取引金額", 140), line("¥3", 140, 200)]);
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });

  test("「金額」弱ラベル(task-20、実写真中央領域実測)はneeds-reviewまで回復し金額が候補1位になる", () => {
    const r = extractTotal([line("金額", 140), line("￥331", 140, 200)]);
    expect(r.status).toBe("needs-review");
    expect(r.amountYen).toBe(331);
    expect(r.candidates[0]).toBe(331);
  });

  test("「金額」弱ラベルは通貨表記なしでは候補にならない(task-20、既存の「合」弱ラベルと同じ安全弁)", () => {
    const r = extractTotal([line("金額", 220), line("331", 220, 200)]);
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });

  test("「金額」弱ラベルはどの経路でもauto-highにならない(高confidence・好条件でも、task-20)", () => {
    const r = extractTotal([
      line("金額", 400, 0, 0.99),
      line("¥331", 400, 200, 0.99),
    ]);
    expect(r.status).toBe("needs-review");
  });

  test("敵対テスト: 「金額」が明細の列見出しでも、離れた場所の本物の「合計」に勝てない(task-20)", () => {
    // 「品名」「単価」「金額」が別々のboxとして並ぶ列見出し(一般的なレイアウト)の
    // 直下に明細行の価格が来ても、「金額」経由の弱い候補(最大45点)が本物の
    // 「合計」(50点)に勝ってトップ候補に来てしまわないことを確認する。
    const r = extractTotal([
      line("品名", 40, 0), line("単価", 40, 150), line("金額", 40, 300),
      line("じゃがいも", 80, 0), line("¥150", 80, 200),
      line("にんじん", 120, 0), line("¥120", 120, 200),
      line("合計", 300, 0), line("¥270", 300, 200),
    ]);
    expect(r.status).toBe("auto-high");
    expect(r.amountYen).toBe(270);
  });

  // --- Codexレビュー(task-20)で追加検出された敵対テスト ---

  test("敵対テスト: 「税抜」+「金額」に分割されたOCR行は候補にならない(税抜金額≠合計、Codexレビュー指摘)", () => {
    // 「税抜金額」がOCRで「税抜」「金額」の2boxに分割されると、「金額」だけが弱ラベルの
    // 完全一致条件をすり抜けて拾われてしまう。「税抜」をREJECT_LABELSに追加したことで、
    // 同一行の「税抜」により候補ごと除外されることを確認する。
    const noOther = extractTotal([line("税抜", 100, 0), line("金額", 100, 60), line("¥500", 100, 200)]);
    expect(noOther.status).toBe("failed");
    expect(noOther.amountYen).toBeNull();

    const withRealTotal = extractTotal([
      line("税抜", 100, 0), line("金額", 100, 60), line("¥500", 100, 200),
      line("合計", 300, 0), line("¥1,650", 300, 200),
    ]);
    expect(withRealTotal.status).toBe("auto-high");
    expect(withRealTotal.amountYen).toBe(1650);
    expect(withRealTotal.candidates).toEqual([1650]); // 税抜金額の500がノイズ候補として残らない
  });

  test("敵対テスト: 「値引金額」「割引金額」「代引金額」は「引金額」崩れパターンとして誤爆しない(Codexレビュー指摘)", () => {
    // 当初の実装(否定後読み `/(?<!取)引金[額额]/`)はこれらに部分一致してしまっていた。
    // 行頭アンカーへの変更で、「引金額」が行の先頭に来る場合のみを対象にする。
    for (const label of ["値引金額", "割引金額", "代引金額"]) {
      const sameLine = extractTotal([line(`${label} ¥500`, 140)]);
      expect(sameLine.status).toBe("failed");
      expect(sameLine.amountYen).toBeNull();

      const below = extractTotal([line(label, 140), line("¥500", 160, 200)]);
      expect(below.status).toBe("failed");
      expect(below.amountYen).toBeNull();
    }
  });

  test("敵対テスト: 「只今計算中」は「今計」崩れパターンとして誤爆しない(Codexレビュー指摘)", () => {
    // 当初の実装(部分一致)は「只今計算中」に「今計」が部分文字列として含まれるため
    // 誤爆していた。行頭アンカーへの変更で解消したことを確認する。
    const r = extractTotal([line("只今計算中", 140), line("¥500", 140, 200)]);
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });

  test("境界ケース: 「お取引金額」「取 引金額」(空白入り)は「取引金額」と同様に対象外のまま(task-20)", () => {
    // どちらも「取」を伴う(正しい、または空白で分割された)読みであり、右領域で観測した
    // 「正しい取引金額+無関係な断片金額」の危険パターンと同種のため、意図的に対象外。
    for (const label of ["お取引金額", "取 引金額"]) {
      const r = extractTotal([line(label, 140), line("¥3,084", 140, 200)]);
      expect(r.status).toBe("failed");
      expect(r.amountYen).toBeNull();
    }
  });
});
