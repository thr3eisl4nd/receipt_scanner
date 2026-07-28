import { useState } from "react";
import type { Row } from "../types";
import type { RowPatch } from "../state/reducer";

const STATUS_LABEL: Record<Row["status"], string> = {
  "auto-high": "自動読取",
  "needs-review": "要確認",
  confirmed: "確認済",
  manual: "手入力",
  failed: "読取失敗",
};

type Props = {
  row: Row;
  onPatch(id: string, patch: RowPatch): void;
  onRemove(id: string): void;
};

export function ReceiptRow({ row, onPatch, onRemove }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [zoomed, setZoomed] = useState(false);

  const startEdit = () => {
    setDraft(row.amountYen === null ? "" : String(row.amountYen));
    setEditing(true);
  };
  const commitEdit = () => {
    // 数字/マイナス以外を除去した結果が空文字なら未入力扱い(null)。
    // 「"abc"」等の非数字入力は`draft.trim() !== ""`だが除去後は空文字になり、
    // 素朴に`Number("")`(=0)を使うと意図せず0円で確定してしまうため、
    // 除去後の文字列そのもので空判定する(Codexレビュー指摘)。
    const cleaned = draft.replace(/[^-\d]/g, "");
    const v = cleaned === "" ? null : Number(cleaned);
    if (v !== null && Number.isSafeInteger(v)) {
      onPatch(row.id, { amountYen: v, status: row.source === "manual" ? "manual" : "confirmed", candidates: [] });
    }
    setEditing(false);
  };

  return (
    <li className={`receipt-row status-${row.status}`}>
      {row.thumbnailUrl && (
        <img
          src={row.thumbnailUrl}
          alt={`${row.label}のサムネイル`}
          className={zoomed ? "thumb zoomed" : "thumb"}
          onClick={() => setZoomed(!zoomed)}
        />
      )}
      <div className="row-main">
        <span className="row-label">{row.label}</span>
        <span className={`badge badge-${row.status}`}>
          {row.processing ? "処理中…" : STATUS_LABEL[row.status]}
        </span>
        {editing ? (
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => e.key === "Enter" && commitEdit()}
            aria-label="金額(円)"
          />
        ) : (
          <button type="button" className="amount" onClick={startEdit}>
            {row.amountYen === null ? "金額を入力" : `${row.amountYen.toLocaleString("ja-JP")}円`}
          </button>
        )}
        {row.status === "needs-review" && row.candidates.length > 1 && (
          <div className="candidates">
            候補:
            {row.candidates.map((c) => (
              <button key={c} type="button" onClick={() => onPatch(row.id, { amountYen: c, status: "confirmed", candidates: [] })}>
                {c.toLocaleString("ja-JP")}円
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="row-actions">
        <button type="button" onClick={() => onPatch(row.id, { payer: row.payer === "husband" ? "wife" : "husband" })}>
          {row.payer === "husband" ? "→妻へ" : "→夫へ"}
        </button>
        <button type="button" onClick={() => onRemove(row.id)}>削除</button>
      </div>
    </li>
  );
}
