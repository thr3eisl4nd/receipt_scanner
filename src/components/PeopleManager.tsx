import { useRef, useState, type KeyboardEvent } from "react";
import type { Person, Row } from "../types";
import { personColorClass } from "../personColor";

type Props = {
  people: Person[];
  rows: Row[];
  onAdd(): void;
  onRename(id: string, name: string): void;
  onRemove(id: string): void;
};

/**
 * 人の削除ボタンをdisabledにすべき理由(設計ドキュメント§14.1: 「その人の行が0件のときのみ
 * 可能」「最後の1人は削除不可」)。理由がなければ削除可能(null)。
 */
function deleteDisabledReason(person: Person, peopleCount: number, rows: Row[]): string | null {
  if (peopleCount <= 1) return "最後の1人は削除できません";
  const count = rows.filter((r) => r.payerId === person.id).length;
  if (count > 0) return `${person.name}の行が${count}件あるため削除できません`;
  return null;
}

type NameEditorProps = { name: string; onRename(name: string): void };

/** 名前のインライン編集(タップで編集、確定で反映)。空文字(trim後)は確定させず、
 *  role=alertでエラー表示したまま編集を継続する(設計ドキュメント§14.1)。 */
function PersonNameEditor({ name, onRename }: NameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(name);
    setError(null);
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setError("名前を入力してください");
      inputRef.current?.focus();
      return;
    }
    onRename(trimmed);
    setEditing(false);
    setError(null);
  };

  const cancel = () => {
    setError(null);
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // IME変換確定のEnterを誤ってコミットに使わない(ReceiptRowの金額編集と同じ方針)。
      if (!e.nativeEvent.isComposing) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    return (
      <button type="button" className="person-name" aria-label={`${name}の名前を編集`} onClick={startEdit}>
        {name}
      </button>
    );
  }

  return (
    <span className="person-name-editor">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        autoFocus
        aria-label="人の名前"
        aria-invalid={error !== null}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={commit}
      />
      {error && (
        <p role="alert" className="person-name-error">
          {error}
        </p>
      )}
    </span>
  );
}

export function PeopleManager({ people, rows, onAdd, onRename, onRemove }: Props) {
  return (
    <section className="people-manager" aria-label="人の管理">
      <ul className="people-list">
        {people.map((person) => {
          const reason = deleteDisabledReason(person, people.length, rows);
          return (
            <li key={person.id} className={`person-item ${personColorClass(person.colorIndex)}`}>
              {/* 人別テーマカラーのドット(装飾のみ・色だけに頼らず名前テキストを併記、
                  設計ドキュメント§14.1・§14.4)。 */}
              <span className="person-dot" aria-hidden="true" />
              <PersonNameEditor name={person.name} onRename={(name) => onRename(person.id, name)} />
              <button
                type="button"
                aria-label={`${person.name}を削除`}
                disabled={reason !== null}
                onClick={() => onRemove(person.id)}
              >
                削除
              </button>
              {reason && <span className="person-delete-reason">{reason}</span>}
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={onAdd}>
        + 人を追加
      </button>
    </section>
  );
}
