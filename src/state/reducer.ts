import type { Person, PersistedState, Row } from "../types";

export type AppState = { month: string; people: Person[]; rows: Row[]; saveFailed: boolean };

/** updateRowで許可するパッチ。`id`は対象外(型レベルでID上書きを禁止する)。 */
export type RowPatch = Partial<Omit<Row, "id">>;

export type Action =
  | { type: "hydrate"; state: AppState }
  | { type: "addRows"; rows: Row[] }
  | { type: "updateRow"; id: string; patch: RowPatch }
  | { type: "applyOcrResult"; id: string; patch: RowPatch }
  | { type: "removeRow"; id: string }
  | { type: "clearMonth"; month: string }
  | { type: "setSaveFailed"; value: boolean }
  | { type: "addPerson" }
  | { type: "renamePerson"; id: string; name: string }
  | { type: "removePerson"; id: string };

/** 円整数として妥当か(null許容)。NaN/Infinity/小数を拒否する。 */
function isYenAmount(value: number | null): boolean {
  return value === null || Number.isSafeInteger(value);
}

function assertNever(value: never): never {
  throw new Error(`Unknown action: ${JSON.stringify(value)}`);
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return action.state;
    case "addRows":
      return {
        ...state,
        rows: [...state.rows, ...action.rows.filter((r) => isYenAmount(r.amountYen))],
      };
    case "updateRow":
      return {
        ...state,
        rows: state.rows.map((row) => {
          if (row.id !== action.id) return row;
          const next = { ...row, ...action.patch, id: row.id };
          return isYenAmount(next.amountYen) ? next : row;
        }),
      };
    // OCR結果専用のアクション。`processing:true`の行(=まだユーザーが手修正していない、
    // またはOCR結果を待っている行)にだけパッチを適用する。ユーザーが編集中/編集済みで
    // 既に`processing:false`になった行には適用しない。無条件に`updateRow`していると、
    // 「OCR処理中に手修正→数秒後に遅延到着したOCR結果が手修正を無警告で上書きする」という
    // 金額データ破損バグになる(Codexレビュー指摘C1)。手修正側(ReceiptRow.commitEdit等)は
    // 必ずpatchに`processing:false`を含めることで、以後の遅延OCR結果を無効化する。
    case "applyOcrResult":
      return {
        ...state,
        rows: state.rows.map((row) => {
          if (row.id !== action.id || !row.processing) return row;
          const next = { ...row, ...action.patch, id: row.id };
          return isYenAmount(next.amountYen) ? next : row;
        }),
      };
    case "removeRow":
      return { ...state, rows: state.rows.filter((r) => r.id !== action.id) };
    // 人(people)は月をまたいで使い続ける想定(§14.5「人ごとの履歴」はスコープ外だが、
    // 人そのものは家計を共にするメンバーであり月次でリセットする対象ではない)ため、
    // clearMonthではrowsのみ空にしstate.peopleをそのまま引き継ぐ。
    case "clearMonth":
      return { month: action.month, people: state.people, rows: [], saveFailed: false };
    // 同値なら同一state参照を返す(Codexレビュー指摘M1)。自動保存effectは
    // rows/month変更のたびに無条件でdispatchするため、これがないと保存結果が
    // 変わらなくても毎回新しいstateオブジェクトが生成され、不要な再描画が発生する。
    case "setSaveFailed":
      return state.saveFailed === action.value ? state : { ...state, saveFailed: action.value };
    // 「+ 人を追加」(設計ドキュメント§14.1)。初期名は「2人目」「3人目」…(現在の人数+1)、
    // colorIndexは現在の人数をそのまま使う連番(0始まり、削除後の再追加で重複しても実害はない)。
    case "addPerson": {
      const number = state.people.length + 1;
      const person: Person = {
        id: crypto.randomUUID(),
        name: `${number}人目`,
        colorIndex: state.people.length,
      };
      return { ...state, people: [...state.people, person] };
    }
    // 名前のインライン編集(§14.1)。空文字(trim後)は不可で、その場合は何もしない
    // (UI側で空不可のバリデーションを行うが、reducer側でも不変条件として強制する)。
    case "renamePerson": {
      const trimmed = action.name.trim();
      if (trimmed === "") return state;
      return {
        ...state,
        people: state.people.map((p) => (p.id === action.id ? { ...p, name: trimmed } : p)),
      };
    }
    // 人の削除(§14.1)。以下のいずれかに該当する場合は何もしない(UI側はボタンを
    // disabledにして理由を表示するが、reducer側でも不変条件として強制する):
    // 1) 対象が存在しない 2) 最後の1人 3) その人の行が1件以上残っている
    case "removePerson": {
      if (state.people.length <= 1) return state;
      if (!state.people.some((p) => p.id === action.id)) return state;
      if (state.rows.some((r) => r.payerId === action.id)) return state;
      return { ...state, people: state.people.filter((p) => p.id !== action.id) };
    }
    default:
      return assertNever(action);
  }
}

export type PersonTotal = { personId: string; name: string; colorIndex: number; amountYen: number; count: number };

/** ちょうど2人のときのみ算出される、方向付きの差額(設計ドキュメント§14.3)。
 *  `moreId:null`は差額0(=「差額なし」)を表す。1人・3人以上のときはnull(表示自体をしない)。 */
export type Delta = { moreId: string | null; amountYen: number } | null;

export function computeTotals(people: Person[], rows: Row[]) {
  const totals: PersonTotal[] = people.map((p) => {
    const personRows = rows.filter((r) => r.payerId === p.id);
    return {
      personId: p.id,
      name: p.name,
      colorIndex: p.colorIndex,
      amountYen: personRows.reduce((acc, r) => acc + (r.amountYen ?? 0), 0),
      count: personRows.length,
    };
  });

  let delta: Delta = null;
  if (totals.length === 2) {
    const diff = totals[0].amountYen - totals[1].amountYen;
    delta =
      diff === 0
        ? { moreId: null, amountYen: 0 }
        : diff > 0
          ? { moreId: totals[0].personId, amountYen: diff }
          : { moreId: totals[1].personId, amountYen: -diff };
  }

  return {
    totals,
    delta,
    unconfirmed: rows.filter((r) => r.status === "needs-review" || r.status === "failed").length,
  };
}

const yen = (n: number) => n.toLocaleString("ja-JP");

/** 差額行のテキストを組み立てる。deltaがnull(1人・3人以上)ならnullを返す(呼び出し側で行自体を省く)。
 *  `SummaryPanel`表示と`buildSummaryText`(コピー用テキスト)の両方から共通で使う。 */
export function formatDelta(totals: PersonTotal[], delta: Delta): string | null {
  if (!delta) return null;
  if (delta.moreId === null) return "差額なし";
  const person = totals.find((t) => t.personId === delta.moreId);
  return `${person?.name ?? "?"}が ${yen(delta.amountYen)}円 多く支払い`;
}

export function buildSummaryText(state: AppState): string {
  const t = computeTotals(state.people, state.rows);
  const lines = [`${state.month} 清算`];
  for (const total of t.totals) {
    lines.push(`${total.name}: ${yen(total.amountYen)}円 (${total.count}件)`);
  }
  const direction = formatDelta(t.totals, t.delta);
  if (direction !== null) lines.push(`差額: ${direction}`);
  if (t.unconfirmed > 0) lines.push(`⚠ 未確認 ${t.unconfirmed}件`);
  return lines.join("\n");
}

export function toPersisted(state: AppState): PersistedState {
  return {
    version: 2,
    month: state.month,
    updatedAt: new Date().toISOString(),
    people: state.people.map(({ id, name, colorIndex }) => ({ id, name, colorIndex })),
    rows: state.rows.map(({ id, payerId, amountYen, label, status, source }) => ({
      id,
      payerId,
      amountYen,
      label,
      status,
      source,
    })),
  };
}

export function fromPersisted(p: PersistedState): AppState {
  return {
    month: p.month,
    saveFailed: false,
    people: p.people.map(({ id, name, colorIndex }) => ({ id, name, colorIndex })),
    rows: p.rows.map(
      ({ id, payerId, amountYen, label, status, source }): Row => ({
        id,
        payerId,
        amountYen,
        label,
        status,
        source,
        candidates: [],
      }),
    ),
  };
}
