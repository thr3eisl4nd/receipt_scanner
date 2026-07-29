import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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

type NameEditorProps = { name: string; existingNames: string[]; onRename(name: string): void };

/** 名前のインライン編集(タップで編集、確定で反映)。空文字(trim後)、および
 *  自分以外の誰かとtrim後に完全一致する名前は確定させず、role=alertでエラー表示した
 *  まま編集を継続する(設計ドキュメント§14.1、後者はCodexレビュー指摘I3: 重複名は
 *  取り込みボタンのaria-label・コピー結果等で対象を一意に指せなくなる)。 */
function PersonNameEditor({ name, existingNames, onRename }: NameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 編集開始ボタン(name未編集時に表示)。Enter/Escapeによる編集終了時だけここへ
  // キーボードフォーカスを戻す(Codexレビュー指摘I5)。blur自体は入力欄のonBlurで
  // 拾うため、Tab移動・外部クリックによる通常のblurではブラウザ標準の遷移に任せ、
  // ここでは復帰させない。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  // editingがfalseになった直後、restoreFocusRefが立っていれば編集開始ボタンへ
  // フォーカスを戻す。ボタンはediting:false時にのみDOMへ存在するため、この
  // useEffect(コミット後に発火)のタイミングで初めてtriggerRef.currentが
  // 新しいボタン要素を指している。
  useEffect(() => {
    if (editing) return;
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setDraft(name);
    setError(null);
    setEditing(true);
  };

  const commit = (restoreFocus: boolean) => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setError("名前を入力してください");
      inputRef.current?.focus();
      return;
    }
    if (existingNames.includes(trimmed)) {
      setError("同じ名前が既にあります");
      inputRef.current?.focus();
      return;
    }
    onRename(trimmed);
    restoreFocusRef.current = restoreFocus;
    setEditing(false);
    setError(null);
  };

  const cancel = () => {
    setError(null);
    restoreFocusRef.current = true;
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // IME変換確定のEnterを誤ってコミットに使わない(ReceiptRowの金額編集と同じ方針)。
      if (!e.nativeEvent.isComposing) commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    return (
      <button ref={triggerRef} type="button" className="person-name" aria-label={`${name}の名前を編集`} onClick={startEdit}>
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
        onBlur={() => commit(false)}
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
          // 削除不可の理由テキストを、disabledな削除ボタンとaria-describedbyで
          // プログラム上関連付ける(Codexレビュー指摘Minor#2)。
          const reasonId = `person-delete-reason-${person.id}`;
          const otherNames = people.filter((p) => p.id !== person.id).map((p) => p.name);
          return (
            <li key={person.id} className={`person-item ${personColorClass(person.colorIndex)}`}>
              {/* 人別テーマカラーのドット(装飾のみ・色だけに頼らず名前テキストを併記、
                  設計ドキュメント§14.1・§14.4)。 */}
              <span className="person-dot" aria-hidden="true" />
              <PersonNameEditor
                name={person.name}
                existingNames={otherNames}
                onRename={(name) => onRename(person.id, name)}
              />
              <button
                type="button"
                aria-label={`${person.name}を削除`}
                aria-describedby={reason !== null ? reasonId : undefined}
                disabled={reason !== null}
                onClick={() => onRemove(person.id)}
              >
                削除
              </button>
              {reason && (
                <span id={reasonId} className="person-delete-reason">
                  {reason}
                </span>
              )}
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
