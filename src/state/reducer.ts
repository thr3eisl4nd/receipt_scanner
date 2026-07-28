import type { PersistedState, Row } from "../types";

export type AppState = { month: string; rows: Row[]; saveFailed: boolean };

/** updateRowで許可するパッチ。`id`は対象外(型レベルでID上書きを禁止する)。 */
export type RowPatch = Partial<Omit<Row, "id">>;

export type Action =
  | { type: "hydrate"; state: AppState }
  | { type: "addRows"; rows: Row[] }
  | { type: "updateRow"; id: string; patch: RowPatch }
  | { type: "removeRow"; id: string }
  | { type: "clearMonth"; month: string }
  | { type: "setSaveFailed"; value: boolean };

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
    case "removeRow":
      return { ...state, rows: state.rows.filter((r) => r.id !== action.id) };
    case "clearMonth":
      return { month: action.month, rows: [], saveFailed: false };
    case "setSaveFailed":
      return { ...state, saveFailed: action.value };
    default:
      return assertNever(action);
  }
}

export function computeTotals(rows: Row[]) {
  const sum = (payer: string) =>
    rows.filter((r) => r.payer === payer).reduce((acc, r) => acc + (r.amountYen ?? 0), 0);
  const husbandYen = sum("husband");
  const wifeYen = sum("wife");
  return {
    husbandYen,
    wifeYen,
    deltaYen: husbandYen - wifeYen,
    unconfirmed: rows.filter((r) => r.status === "needs-review" || r.status === "failed").length,
  };
}

const yen = (n: number) => n.toLocaleString("ja-JP");

export function buildSummaryText(state: AppState): string {
  const t = computeTotals(state.rows);
  const direction =
    t.deltaYen > 0
      ? `夫が ${yen(t.deltaYen)}円 多く支払い`
      : t.deltaYen < 0
        ? `妻が ${yen(-t.deltaYen)}円 多く支払い`
        : "差額なし";
  const lines = [
    `${state.month} 清算`,
    `夫: ${yen(t.husbandYen)}円 (${state.rows.filter((r) => r.payer === "husband").length}件)`,
    `妻: ${yen(t.wifeYen)}円 (${state.rows.filter((r) => r.payer === "wife").length}件)`,
    `差額: ${direction}`,
  ];
  if (t.unconfirmed > 0) lines.push(`⚠ 未確認 ${t.unconfirmed}件`);
  return lines.join("\n");
}

export function toPersisted(state: AppState): PersistedState {
  return {
    version: 1,
    month: state.month,
    updatedAt: new Date().toISOString(),
    rows: state.rows.map(({ id, payer, amountYen, label, status, source }) => ({
      id,
      payer,
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
    rows: p.rows.map(
      ({ id, payer, amountYen, label, status, source }): Row => ({
        id,
        payer,
        amountYen,
        label,
        status,
        source,
        candidates: [],
      }),
    ),
  };
}
