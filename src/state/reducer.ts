import type { Person, PersistedState, Row, VerificationStatus } from "../types";
import { PERSON_COLOR_COUNT } from "../personColor";

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
  | { type: "removePerson"; id: string }
  // v1.3(§16.4): 写真1枚のプレースホルダ行(placeholderId)を、パス1(検出)完了時に
  // N行(領域の数だけ)へ原子的に置換する。ラベル(「レシート N」)の採番はこの置換時に
  // 行う(newRows自体は採番前のid/payerIdのみ持つ)。
  //
  // task-26(Gemini連携、設計ドキュメント§19): Gemini経路は1回のAPI呼び出しで
  // 「何枚のレシートが写っているか」と「各合計金額」の両方が同時に判明するため、classicの
  // OCRキュー経由(空行→非同期結果反映の2段階)を経ずに、置換時点で確定済みの結果
  // (amountYen/status/candidates/processing/thumbnailUrl/previewUrl)を持つ行を直接
  // 作れるようにする。いずれも省略可能で、省略時は従来通り
  // amountYen:null/status:"failed"/candidates:[]/processing:true(thumbnailUrl/previewUrlは
  // undefined)になる(既存呼び出し元=onRegionsコールバックとの後方互換)。
  | {
      type: "replacePendingRow";
      placeholderId: string;
      newRows: Array<{
        id: string;
        payerId: string;
        amountYen?: number | null;
        status?: VerificationStatus;
        candidates?: number[];
        processing?: boolean;
        thumbnailUrl?: string;
        previewUrl?: string;
      }>;
    };

/** 円整数として妥当か(null許容)。NaN/Infinity/小数を拒否する。 */
function isYenAmount(value: number | null): boolean {
  return value === null || Number.isSafeInteger(value);
}

/** payerIdがpeopleに実在するか(参照整合性、Codexレビュー指摘I2)。v1では payer が
 *  "husband" | "wife" の合併型で型により保護されていたが、v2では単なるstringのため、
 *  reducer側でも保存時(isValidV2)と同じ制約を強制しないと、未知のpayerIdを持つ孤児行が
 *  画面上の状態にだけ入り込み(集計から金額が黙って脱落する一方、自動保存はisValidV2に
 *  拒否され続けるため画面と保存状態が分岐する)事故になる。 */
function hasPayer(people: Person[], payerId: string): boolean {
  return people.some((p) => p.id === payerId);
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
        rows: [
          ...state.rows,
          ...action.rows.filter((r) => isYenAmount(r.amountYen) && hasPayer(state.people, r.payerId)),
        ],
      };
    case "updateRow":
      return {
        ...state,
        rows: state.rows.map((row) => {
          if (row.id !== action.id) return row;
          const next = { ...row, ...action.patch, id: row.id };
          if (!isYenAmount(next.amountYen)) return row;
          if (!hasPayer(state.people, next.payerId)) return row;
          return next;
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
          if (!isYenAmount(next.amountYen)) return row;
          if (!hasPayer(state.people, next.payerId)) return row;
          return next;
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
    // 「+ 人を追加」(設計ドキュメント§14.1)。初期名は「N人目」だが、削除後の再追加で
    // 単純な「現在の人数+1」を使うと既存の名前と衝突しうる(例: わたし(0)/2人目(1)/3人目(2)
    // →2人目を削除→追加すると「3人目」が2つできる)。使用中の名前を避けて連番を進める
    // (Codexレビュー指摘I3)。
    // colorIndexも同様に「現在の人数」をそのまま使うと削除後の再追加で既存の色と重複し、
    // 「色+名前で識別」(§14.1)という前提が崩れる。未使用のcolorIndexをパレット内から
    // 優先的に選び、全色使用中の場合のみ人数を丸め込んだ値へフォールバックする。
    case "addPerson": {
      const usedNames = new Set(state.people.map((p) => p.name));
      let number = state.people.length + 1;
      while (usedNames.has(`${number}人目`)) number += 1;

      const usedColors = new Set(
        state.people.map((p) => ((p.colorIndex % PERSON_COLOR_COUNT) + PERSON_COLOR_COUNT) % PERSON_COLOR_COUNT),
      );
      const colorIndex =
        Array.from({ length: PERSON_COLOR_COUNT }, (_, i) => i).find((i) => !usedColors.has(i)) ??
        state.people.length % PERSON_COLOR_COUNT;

      const person: Person = {
        id: crypto.randomUUID(),
        name: `${number}人目`,
        colorIndex,
      };
      return { ...state, people: [...state.people, person] };
    }
    // 名前のインライン編集(§14.1)。空文字(trim後)は不可で、その場合は何もしない
    // (UI側で空不可のバリデーションを行うが、reducer側でも不変条件として強制する)。
    // trim後の名前が自分以外の誰かと完全一致する場合も拒否する(Codexレビュー指摘I3:
    // 同名の人が複数いると、AddReceiptButtons/PeopleManagerのaria-label・コピー結果の
    // いずれも対象を一意に指し示せなくなる)。UI側(PersonNameEditor)でも同じ判定を行い
    // role="alert"でエラー表示するが、reducer側でも不変条件として強制する。
    case "renamePerson": {
      const trimmed = action.name.trim();
      if (trimmed === "") return state;
      const duplicate = state.people.some((p) => p.id !== action.id && p.name === trimmed);
      if (duplicate) return state;
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
    // v1.3(§16.4): プレースホルダ行(placeholderId)をN行へ原子的に置換する。
    // - placeholderIdが既に存在しない場合(ユーザーが処理中に行を削除した等)はno-op。
    // - processing中の行のみ対象(ユーザーが既に手修正して processing:false になった行は
    //   置換しない。手修正を無警告で消し去らないため、applyOcrResultと同じ考え方)。
    // - 元の行の位置(index)へそのままN行を挿入する(一覧内の並び順を保つ)。
    //
    // 採番(Codexレビュー最終ゲート指摘I3): プレースホルダ自身が既に自動採番ラベル
    // (「レシート k」)を持っている場合、その番号kを維持する。複数の写真を同時追加した
    // 直後は、各写真のプレースホルダが「レシート 1」「レシート 2」のように連番で
    // 既に確定しているため(`onFiles`のlabelFor)、後から展開されるプレースホルダの
    // 番号を使い切ってしまわないよう、k超の自動採番行をN-1(N=実際に追加される行数)
    // だけ同一action内でシフトしてから、新領域をk, k+1, ..., k+N-1とする。
    // プレースホルダのラベルが自動採番形式でない場合(テスト等での「解析中…」等)は、
    // 従来通り既存の最大番号の続きから採番する(フォールバック)。
    case "replacePendingRow": {
      const idx = state.rows.findIndex((r) => r.id === action.placeholderId);
      if (idx === -1) return state;
      if (!state.rows[idx].processing) return state;

      const placeholderNumber = parseReceiptLabelNumber(state.rows[idx].label);
      const rowsWithoutPlaceholder = [...state.rows.slice(0, idx), ...state.rows.slice(idx + 1)];
      const validNewRows = action.newRows.filter((nr) => hasPayer(state.people, nr.payerId));

      let labelFor: (offset: number) => string;
      let baseRows = rowsWithoutPlaceholder;

      if (placeholderNumber !== null) {
        const k = placeholderNumber;
        const shift = validNewRows.length - 1;
        labelFor = (offset) => `レシート ${k + offset - 1}`;
        if (shift !== 0) {
          baseRows = rowsWithoutPlaceholder.map((r) => {
            const n = parseReceiptLabelNumber(r.label);
            return n !== null && n > k ? { ...r, label: `レシート ${n + shift}` } : r;
          });
        }
      } else {
        labelFor = nextReceiptLabel(rowsWithoutPlaceholder);
      }

      // task-26: 呼び出し側(Gemini経路)が指定した確定済みの結果を採用する。amountYenは
      // 他アクション(addRows/updateRow等)と同じisYenAmount不変条件を適用し、不正な値
      // (NaN/Infinity/小数等)が来てもamountYen:null/status:"failed"へ安全側に落とす
      // (呼び出し側の実装ミス・レスポンス改変等に対する防御、Codexレビュー想定)。
      const newRows: Row[] = validNewRows.map((nr, i) => {
        const requestedAmount = nr.amountYen ?? null;
        const validAmount = isYenAmount(requestedAmount) ? requestedAmount : null;
        const status: VerificationStatus = isYenAmount(requestedAmount) ? (nr.status ?? "failed") : "failed";
        return {
          id: nr.id,
          payerId: nr.payerId,
          amountYen: validAmount,
          label: labelFor(i + 1),
          status,
          source: "ocr",
          candidates: nr.candidates ?? [],
          thumbnailUrl: nr.thumbnailUrl,
          previewUrl: nr.previewUrl,
          processing: nr.processing ?? true,
        };
      });

      return {
        ...state,
        rows: [...baseRows.slice(0, idx), ...newRows, ...baseRows.slice(idx)],
      };
    }
    default:
      return assertNever(action);
  }
}

const RECEIPT_LABEL_RE = /^レシート (\d+)$/;

/** ラベルが自動採番形式(「レシート N」)なら番号を、そうでなければnullを返す
 *  (Codexレビュー最終ゲート指摘I3: `replacePendingRow`が採番維持のシフト対象を
 *  判定するのに使う)。 */
function parseReceiptLabelNumber(label: string): number | null {
  const m = RECEIPT_LABEL_RE.exec(label);
  return m ? Number(m[1]) : null;
}

/**
 * 次の自動採番ラベルの番号を、現在の行群のラベルから導出する(v1.1「Task 12」・
 * v1.3「§16.4 採番は置換時に行う」で共通利用)。モジュールスコープの可変カウンタだと
 * ページ再読み込みのたびに1へリセットされ、保存済みの「レシート 3」等と新規行が
 * 番号衝突する(Codexレビュー指摘)。渡された行群から毎回導出することで、再読み込み後・
 * `replacePendingRow`による置換後のいずれでも継続した採番になる。
 */
export function nextReceiptLabel(rows: Row[]): (offset: number) => string {
  const max = rows.reduce((acc, r) => {
    const m = RECEIPT_LABEL_RE.exec(r.label);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return (offset: number) => `レシート ${max + offset}`;
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
