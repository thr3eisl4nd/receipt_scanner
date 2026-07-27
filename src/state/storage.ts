import type { PersistedState } from "../types";

const STORAGE_KEY = "receipt-scanner:state:v1";

const PAYERS = new Set(["husband", "wife"]);
const STATUSES = new Set(["auto-high", "needs-review", "confirmed", "manual", "failed"]);
const SOURCES = new Set(["ocr", "manual"]);

function isValid(v: unknown): v is PersistedState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (typeof s.month !== "string" || typeof s.updatedAt !== "string") return false;
  if (!Array.isArray(s.rows)) return false;
  return s.rows.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const row = r as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      PAYERS.has(row.payer as string) &&
      (row.amountYen === null || Number.isSafeInteger(row.amountYen)) &&
      typeof row.label === "string" &&
      STATUSES.has(row.status as string) &&
      SOURCES.has(row.source as string)
    );
  });
}

/** 保存。失敗(容量超過等)はfalseを返す — 呼び出し側でUI表示すること。 */
export function saveState(state: PersistedState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
