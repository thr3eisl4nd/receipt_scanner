import { useState } from "react";
import type { Payer, Row } from "../types";
import { parseYenInput, toggleYenSign, isNegativeYenInput } from "../moneyInput";

type Props = { onAdd(row: Row): void };

/**
 * レシートのない支出(家賃・光熱費等)を「名前+金額+誰が払ったか」で追加するフォーム
 * (設計ドキュメント§5.4)。
 *
 * 金額の解釈・検証は`ReceiptRow`と共通の`src/moneyInput.ts`をそのまま流用する
 * (Task 10オーケストレーター指示: ブリーフの`Number(amount.replace(/[^-\d]/g, ""))`方式は
 * Task 9レビューI3で「除去してから解釈」の危険性を指摘され却下済みのパターンのため使わない。
 * Codexレビュー最終ゲート指摘Minor#1: 従来は`ReceiptRow`コンポーネントから直接importして
 * いたが、コンポーネント間の不自然な依存を解消するため共通モジュールへ切り出した)。
 * これにより全角数字・カンマ区切り・¥/円記号を同じ書式ルールで受理し、不正な入力
 * (例: "12abc34")を黙って別の金額として解釈せず編集を維持したままエラー表示できる。
 * 上限もOCRと同じ1,000万円(`MAX_YEN`)を適用する。
 */
/** どちらの入力欄のエラーかを保持する(Codexレビュー指摘: 単一のerror文字列だけだと、
 *  名前エラー時にも金額欄側にaria-invalid/aria-describedbyを出してしまい、
 *  スクリーンリーダー利用者に誤った欄を指し示すことになる)。 */
type FieldError = { field: "label" | "amount"; message: string };

const ERROR_ID = "manual-entry-error";

export function ManualEntryForm({ onAdd }: Props) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [payer, setPayer] = useState<Payer>("husband");
  const [error, setError] = useState<FieldError | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedLabel = label.trim();
    if (trimmedLabel === "") {
      setError({ field: "label", message: "名前を入力してください" });
      return;
    }
    const parsed = parseYenInput(amount);
    if (parsed === "invalid" || parsed === null) {
      setError({ field: "amount", message: "金額は数字で入力してください(例: 1200 / -300)" });
      return;
    }
    onAdd({
      id: crypto.randomUUID(),
      payer,
      amountYen: parsed,
      label: trimmedLabel,
      status: "manual",
      source: "manual",
      candidates: [],
    });
    setLabel("");
    setAmount("");
    setError(null);
  };

  // 符号切替・負数判定はReceiptRowと共通の実装(src/moneyInput.ts)を使う
  // (Codexレビュー最終ゲート指摘Minor#1: コンポーネント間の重複解消)。
  const toggleSign = () => {
    setError(null);
    setAmount((v) => toggleYenSign(v));
  };
  const isNegative = isNegativeYenInput(amount);

  return (
    <form className="manual-entry" onSubmit={submit}>
      <h2>レシート以外の支出を追加(家賃・光熱費など)</h2>
      <input
        value={label}
        onChange={(e) => {
          setLabel(e.target.value);
          setError(null);
        }}
        placeholder="名前(例: 家賃)"
        aria-label="支出の名前"
        aria-invalid={error?.field === "label"}
        aria-describedby={error?.field === "label" ? ERROR_ID : undefined}
      />
      <div className="manual-entry-amount">
        <input
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
          type="text"
          inputMode="numeric"
          placeholder="金額(円)"
          aria-label="追加する金額(円)"
          aria-invalid={error?.field === "amount"}
          aria-describedby={error?.field === "amount" ? ERROR_ID : undefined}
        />
        <button
          type="button"
          aria-pressed={isNegative}
          aria-label="追加する金額を返品・取消として入力"
          className="sign-toggle"
          onClick={toggleSign}
        >
          返品・取消として入力
        </button>
      </div>
      <select value={payer} onChange={(e) => setPayer(e.target.value as Payer)} aria-label="支払った人">
        <option value="husband">夫が支払い</option>
        <option value="wife">妻が支払い</option>
      </select>
      <button type="submit">追加</button>
      {error && (
        <p role="alert" id={ERROR_ID} className="manual-entry-error">
          {error.message}
        </p>
      )}
    </form>
  );
}
