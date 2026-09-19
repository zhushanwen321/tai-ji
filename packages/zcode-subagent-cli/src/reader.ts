// src/execution/engine/engines/zcode/reader.ts
//
// ZcodeEngine reader（P3）：sqlite 只读读取 session/message/part 三级 JOIN →
// SessionView（设计 D6 read 降级链第①级）。
//
// 双端复用约束（设计 §3.3.7）：本模块是唯一允许被 taiji runtime import 的引擎
// 模块——必须保持无状态纯函数、无 spawn/进程依赖、不 import 同包 launcher/
// preparer/parser（依赖仅 node 内置 + 中立类型 + 纯常量）。runtime 侧经 workspace
// 依赖引入（P5 打包登记 tsup noExternal）。
//
// 依赖选型：node:sqlite（零依赖）。依据：仓根 engines node>=22.19.0，node:sqlite
// 自 22.13 起免 flag 可用（本机 v24.11.1 实测通过）；better-sqlite3 是原生模块，
// 会引入 electron rebuild / pi 进程 ABI 匹配两重打包负担（项目关键规则 12②）。
// 防御：动态 import——不支持的环境（老 node）抛结构化错误供调用方降级②③级，
// 不炸模块加载。
//
// 表结构（2026-08-25 实测 0.16.5，16 表 WAL）：
//   session(id, ..., time_created, ...) / message(id, session_id, sequence, data)
//   / part(id, message_id, session_id, sequence, data)
//   message.data: {role: 'user'|'assistant', ...}；part.data: {type: 'text'|'reasoning'|
//   'tool'|'step-start'|'step-finish', ...}（tool 的 state 是 JSON 字符串（旧形态）或
//   内嵌对象（0.16.5+ 实测全库））。
//   schema_migration 表存在——CLI 升级迁移表结构，漂移由结构化错误暴露（降级链兜底）。

import * as fs from "node:fs";

// [W5 迁移] 本文件随包迁入 zcode-subagent-cli（引擎包内 tsconfig 开
// allowImportingTsExtensions，相对 import 用 .ts 形态）；core 侧原件保留至 W11。
import type {
  AgentUsage,
  AgentUsageTotal,
  ReplayedTurn,
  SessionView,
  ToolCall,
} from "@zhushanwen/subagent-engine-sdk";
import { ZCODE_ENGINE_ID } from "./constants.ts";

// ============================================================
// 结构化错误（供调用方降级②③级——不静默）
// ============================================================

export type ZcodeReaderErrorCode = "engine_session_read_failed";

export class ZcodeReaderError extends Error {
  readonly code: ZcodeReaderErrorCode;
  /** 原始失败细节（缺文件/表漂移/运行时不支持）。 */
  readonly detail: string;

  constructor(detail: string, hint?: string) {
    super(
      `[engine_session_read_failed] zcode 原生 session 读取失败：${detail}。` +
        (hint ?? "调用方应降级到第②级（宿主 event journal）或第③级（outcome-only）。"),
    );
    this.name = "ZcodeReaderError";
    this.code = "engine_session_read_failed";
    this.detail = detail;
  }
}

// ============================================================
// 行数据 guard（sqlite 驱动返回 unknown，禁 any）
// ============================================================

interface MessageRow {
  id: string;
  data: string;
}

interface PartRow {
  data: string;
}

interface ParsedMessage {
  role?: unknown;
}

interface ParsedPart {
  type?: unknown;
  text?: unknown;
  tool?: unknown;
  state?: unknown;
  cost?: unknown;
  tokens?: unknown;
}

/** sqlite 驱动的最小消费面（node:sqlite DatabaseSync 结构子集，测试可注入）。 */
type SqliteDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
};

function parseJsonField(raw: string, ctx: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch (err) {
    throw new ZcodeReaderError(
      `${ctx} 行 data 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
      "db 内容损坏或版本不兼容——调用方应降级到第②级（宿主 event journal）。",
    );
  }
}

function finiteOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** step-finish tokens 形状 {total, input, output, reasoning, cache:{read, write}} → AgentUsage。 */
function usageFromStepFinish(part: ParsedPart): AgentUsage | undefined {
  const tokens = part.tokens;
  if (typeof tokens !== "object" || tokens === null) return undefined;
  const t = tokens as Record<string, unknown>;
  const cache = typeof t.cache === "object" && t.cache !== null ? (t.cache as Record<string, unknown>) : {};
  if (t.input === undefined && t.output === undefined) return undefined;
  return {
    input: finiteOr(t.input, 0),
    output: finiteOr(t.output, 0),
    cacheRead: finiteOr(cache.read, 0),
    cacheWrite: finiteOr(cache.write, 0),
  };
}

/** tool part 的 state（内嵌对象为主，JSON 字符串为旧形态兼容）→ 中立 ToolCall。 */
function toolFromPart(part: ParsedPart): ToolCall {
  const toolName = typeof part.tool === "string" ? part.tool : "unknown";
  // state 双形态：0.16.5+ 宿主库全量为内嵌 JSON 对象（$.state.status 可 SQL 直取，
  // 34 万条 tool part 字符串形态 0 条）；更早版本为 JSON 字符串。两形态都非法时降级
  // state=undefined（status 落 'unknown'）
  let state: Record<string, unknown> | undefined;
  if (typeof part.state === "object" && part.state !== null && !Array.isArray(part.state)) {
    state = part.state as Record<string, unknown>;
  } else if (typeof part.state === "string") {
    try {
      const v: unknown = JSON.parse(part.state);
      state = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      state = undefined;
    }
  }
  const status = typeof state?.status === "string" ? state.status : "unknown";
  const output = state?.output;
  // error 态错误文本在 state.error（宿主库实测 error 态 output 恒空）——ToolCall 形态
  // 无 error 字段位，文本以 content 形态进 result（错误原因必须可见，设计 §3.4 T4 精神）
  const errorText = status !== "completed" && typeof state?.error === "string" ? state.error : undefined;
  // 输出形态（实测）：string（内容）或 object（结构化）——分别映射到 pi ToolCallResult
  // 的 content[] / details，不发明第二形状；errorText 优先于 output（T4：error ?? output）
  const result =
    errorText !== undefined
      ? { content: [errorText] }
      : typeof output === "string"
        ? { content: [output] }
        : typeof output === "object" && output !== null
          ? { details: output }
          : undefined;
  return {
    toolName,
    ...(state?.input !== undefined ? { args: state.input } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(status !== "completed" ? { isError: true } : {}),
  };
}

// ============================================================
// SessionView 派生（turn = assistant 消息内 step-start…step-finish 段）
// ============================================================

interface TurnAcc {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usageDelta?: AgentUsage;
}

class TotalsAcc {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  cost = 0;
  has = false;

  add(u: AgentUsage): void {
    this.has = true;
    this.input += u.input;
    this.output += u.output;
    this.cacheRead += u.cacheRead;
    this.cacheWrite += u.cacheWrite;
    this.cost += u.cost ?? 0;
  }

  toTotal(): AgentUsageTotal | undefined {
    if (!this.has) return undefined;
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      cost: this.cost,
      total: this.input + this.output + this.cacheRead + this.cacheWrite,
    };
  }
}

function closeTurn(acc: TurnAcc | null, turns: ReplayedTurn[], totals: TotalsAcc): void {
  if (acc === null) return;
  turns.push({ text: acc.text, thinking: acc.thinking, toolCalls: acc.toolCalls, closed: true });
  if (acc.usageDelta !== undefined) totals.add(acc.usageDelta);
}

function rowToMessageRow(v: unknown): MessageRow {
  if (typeof v === "object" && v !== null && "id" in v && "data" in v) {
    const r = v as { id: unknown; data: unknown };
    if (typeof r.id === "string" && typeof r.data === "string") return { id: r.id, data: r.data };
  }
  throw new ZcodeReaderError("message 行形状异常（id/data 列缺失或类型漂移）");
}

function rowToPartRow(v: unknown): PartRow {
  if (typeof v === "object" && v !== null && "data" in v) {
    const r = v as { data: unknown };
    if (typeof r.data === "string") return { data: r.data };
  }
  throw new ZcodeReaderError("part 行形状异常（data 列缺失或类型漂移）");
}

function resolveSessionId(db: SqliteDb, sessionId: string | undefined): string {
  if (sessionId !== undefined) {
    const hit = db.prepare("SELECT id FROM session WHERE id = ?").get(sessionId);
    if (hit === undefined) {
      throw new ZcodeReaderError(
        `session 不存在：${sessionId}`,
        "sessionId 可能来自已清理的池——降级到 outcome-only。",
      );
    }
    return sessionId;
  }
  const latest = db
    .prepare("SELECT id FROM session ORDER BY time_created DESC LIMIT 1")
    .get() as { id?: unknown } | undefined;
  if (latest === undefined || typeof latest.id !== "string") {
    throw new ZcodeReaderError("db 内无任何 session 行");
  }
  return latest.id;
}

/** part JOIN 查询按 message_id 分组（mid 列缺失的行跳过——形状防御）。 */
function loadGroupedParts(db: SqliteDb, sessionId: string): Map<string, PartRow[]> {
  // part.sequence 是 message 内局部序（实测：user part 0 / assistant parts 0..n）——
  // JOIN message 按 (message.sequence, part.sequence) 还原时序，再按 message_id 分组
  const grouped = new Map<string, PartRow[]>();
  for (const raw of db
    .prepare(
      "SELECT part.message_id AS mid, part.data AS data FROM part " +
        "JOIN message ON part.message_id = message.id " +
        "WHERE part.session_id = ? ORDER BY message.sequence, part.sequence",
    )
    .all(sessionId)) {
    if (typeof raw !== "object" || raw === null || !("mid" in raw)) continue;
    const mid = String((raw as { mid: unknown }).mid);
    const arr = grouped.get(mid) ?? [];
    arr.push(rowToPartRow(raw));
    grouped.set(mid, arr);
  }
  return grouped;
}

/** 首段直入、后续段 "\n" 拼接（text / reasoning 共用；text 字段缺失按空串）。 */
function appendPartText(current: string, part: ParsedPart): string {
  return current === "" ? String(part.text ?? "") : current + "\n" + String(part.text ?? "");
}

/**
 * 单个 part 归入当前 turn（无 turn 则开），返回归入后的累积器（step-finish 闭合后为
 * null）。step-start 等边界标记：开 turn 交给首个内容 part（空 step-start 段不产空 turn）。
 */
function applyPartToTurn(
  part: ParsedPart,
  acc: TurnAcc | null,
  turns: ReplayedTurn[],
  totals: TotalsAcc,
): TurnAcc | null {
  switch (part.type) {
    case "text":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.text = appendPartText(acc.text, part);
      return acc;
    case "reasoning":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.thinking = appendPartText(acc.thinking, part);
      return acc;
    case "tool":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.toolCalls.push(toolFromPart(part));
      return acc;
    case "step-finish": {
      const u = usageFromStepFinish(part);
      const cost = finiteOr(part.cost, 0);
      if (acc === null) acc = { text: "", thinking: "", toolCalls: [] };
      if (u !== undefined) acc.usageDelta = cost > 0 ? { ...u, cost } : u;
      closeTurn(acc, turns, totals);
      return null;
    }
    default:
      return acc;
  }
}

/** assistant 消息流 → turns（usage 累计进 totals）。 */
function collectTurns(messages: MessageRow[], grouped: Map<string, PartRow[]>, totals: TotalsAcc): ReplayedTurn[] {
  const turns: ReplayedTurn[] = [];
  for (const msg of messages) {
    const parsedMsg = parseJsonField(msg.data, "message") as ParsedMessage | undefined;
    // SessionView.turns 是 assistant 视角（pi Turn 同构）——user 消息（任务 prompt）不进 turns
    if (parsedMsg?.role !== "assistant") continue;
    let acc: TurnAcc | null = null;
    for (const partRow of grouped.get(msg.id) ?? []) {
      const part = parseJsonField(partRow.data, "part") as ParsedPart | undefined;
      if (part === undefined) continue;
      acc = applyPartToTurn(part, acc, turns, totals);
    }
    // 消息结束仍无 step-finish（被杀/截断）：已有内容则闭合
    closeTurn(acc, turns, totals);
  }
  return turns;
}

function buildView(db: SqliteDb, sessionId: string): SessionView {
  const messages = db
    .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence")
    .all(sessionId)
    .map(rowToMessageRow);

  const totals = new TotalsAcc();
  const turns = collectTurns(messages, loadGroupedParts(db, sessionId), totals);

  const usageTotal = totals.toTotal();
  return {
    engineId: ZCODE_ENGINE_ID,
    sessionId,
    ...(usageTotal !== undefined ? { usage: usageTotal } : {}),
    turns,
    source: "native",
  };
}

// ============================================================
// 主入口
// ============================================================

/**
 * 读取 zcode session 的引擎中立视图（read 第①级）。
 *
 * @param dbPath    db.sqlite 绝对路径（引擎 read() 由 handle 解析后传入）
 * @param sessionId 目标 session；缺省取池内最新（time_created DESC 首行）
 * @throws ZcodeReaderError db 缺失/表漂移/node:sqlite 不可用/session 不存在——
 *         结构化错误供调用方走降级链②③级
 */
export async function readZcodeSessionView(dbPath: string, sessionId?: string): Promise<SessionView> {
  if (!fs.existsSync(dbPath)) {
    throw new ZcodeReaderError(`db 文件不存在：${dbPath}`);
  }
  // [HISTORICAL] 动态 import 必须经变量间接：esbuild CJS 输出会把字面量
  // import("node:sqlite") 规约成裸名 import("sqlite")（external 化 node builtin 时的
  // 前缀剥离），而 Node 动态 import 裸名不走内置模块 fallback → ERR_MODULE_NOT_FOUND
  // → taiji runtime bundle（tsup CJS）下①级恒降级（2026-08-25 P5 实测）。非字面量
  // specifier esbuild 无法静态分析，保留原样输出，node: 前缀运行时正确解析。
  const sqliteModuleId = "node:sqlite";
  const sqliteMod = (await import(sqliteModuleId).catch(() => undefined)) as
    | { DatabaseSync?: unknown }
    | undefined;
  const DatabaseSyncCtor = sqliteMod?.DatabaseSync;
  if (typeof DatabaseSyncCtor !== "function") {
    throw new ZcodeReaderError(
      "当前 node 运行时不支持 node:sqlite（需 >=22.13）",
      "升级 node 或改用第②级（宿主 event journal）读取。",
    );
  }
  type DatabaseSyncLike = new (path: string, opts: { readOnly: boolean }) => SqliteDb & { close(): void };
  const open = DatabaseSyncCtor as DatabaseSyncLike;

  let db: InstanceType<DatabaseSyncLike> | undefined;
  try {
    db = new open(dbPath, { readOnly: true });
    return buildView(db, resolveSessionId(db, sessionId));
  } catch (err) {
    if (err instanceof ZcodeReaderError) throw err;
    throw new ZcodeReaderError(
      `sqlite 查询失败（${err instanceof Error ? err.message : String(err)}）`,
      "疑似表结构漂移（zcode schema_migration 升级）——调用方应降级到第②级；" +
        "并把新 schema 样本补录进 golden 库后更新 reader。",
    );
  } finally {
    try {
      db?.close();
    } catch (err) {
      // 只读连接 close 失败（WAL 并发读常见）不影响读取结果——吞掉继续；
      // reader 保持零依赖（双端复用约束），不留 void err 以外的语句
      void err;
    }
  }
}
