import { useState } from "react";
import { buildSummaryText, computeTotals, type AppState } from "../state/reducer";

type Props = { state: AppState; onNewMonth(): void };

const yen = (n: number) => n.toLocaleString("ja-JP");

/**
 * 画面下部固定の集計パネル(設計ドキュメント§5.5/§6)。
 *
 * 表示するのは夫合計/妻合計/差額(方向付き)まで。清算額の自動計算(差額÷2)は
 * 絶対に行わない — 夫婦の清算ルールは折半ではなく、最終判断はユーザー自身が行う
 * (§2 要件確定事項)。合計・サマリー文言生成はTask 6-7で実装・テスト済みの
 * `computeTotals`/`buildSummaryText`をそのまま使う。
 */
export function SummaryPanel({ state, onNewMonth }: Props) {
  const [copied, setCopied] = useState(false);
  const t = computeTotals(state.rows);
  const direction =
    t.deltaYen > 0
      ? `夫が ${yen(t.deltaYen)}円 多く支払い`
      : t.deltaYen < 0
        ? `妻が ${yen(-t.deltaYen)}円 多く支払い`
        : "差額なし";

  const copy = async () => {
    if (t.unconfirmed > 0 && !window.confirm(`未確認が ${t.unconfirmed}件 あります。このままコピーしますか?`)) return;
    try {
      await navigator.clipboard.writeText(buildSummaryText(state));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.alert("コピーできませんでした");
    }
  };

  return (
    <section className="summary-panel" aria-label="集計">
      <div className="summary-totals">
        夫: <b>{yen(t.husbandYen)}円</b> / 妻: <b>{yen(t.wifeYen)}円</b>
      </div>
      <div className="delta">{direction}</div>
      {/* role="status"は付けない: App側のOCR進捗表示(role="status")と同一ロールで
          同時に存在しうると、アクセシブルネーム無しの複数status領域になり
          スクリーンリーダー・テスト双方から曖昧になる(Codexレビュー指摘)。この警告は
          ライブ更新の通知ではなく状態表示なので、通常のテキストで十分。 */}
      {t.unconfirmed > 0 && <div className="warn">⚠ 未確認 {t.unconfirmed}件</div>}
      <div className="panel-actions">
        <button type="button" onClick={copy}>
          {copied ? "コピーしました" : "結果をコピー"}
        </button>
        <button type="button" onClick={onNewMonth}>
          新しい月を始める
        </button>
      </div>
    </section>
  );
}
