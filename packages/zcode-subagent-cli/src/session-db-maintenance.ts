// src/session-db-maintenance.ts
//
// [U6 / §3.2.6 风险登记②] zcode 隔离会话库的 TTL 清理通道（引擎侧 sweep 选型）。
// 设计：docs/architecture/subagent-permanent-session-model.md §3.2.6「zcode 会话库资源
// 生命周期」——万物可续聊后隔离库（<engineDataDir>/engines/zcode/session-db/db.sqlite）
// 成为单调累积写入面，条目 TTL 必须与 pi transcript 同窗 30 天；通道未落地不得
// 发布「zcode 万物可续聊」。
//
// 选型裁决（设计待验证检查点 4）：**引擎侧 sweep** 而非宿主侧清库——
//   - 库的写者是 app-server 常驻进程，引擎包是它的生命周期持有者；sweep 在引擎
//     进程内与写者同处 WAL 模式并发面（busy_timeout 兜锁窗口），写并发语义单点；
//   - 宿主（subagent-core / runtime）直写 sqlite 需要跨进程锁协调，且宿主对 zcode
//     库的路径知识已经白名单化收紧（zcodeDbPathAllowlist），再开一条宿主写通道与
//     「会话库隔离」设计方向相悖。
//
// 判龄口径（与 zsw 仓 z-subagent-workflow doctor clean 的超龄判据同族）：
//   last-activity = session.time_updated（续聊会刷新）?? time_created（创建时间）；
//   非数值（null / schema 漂移）保守保留——「删错锚」的代价（锚失效降级 reopen 丢
//   历史）高于「漏删」（磁盘多占），判据取保守侧。
//
// 删除序（FK 纪律，P1 实测：engine 声明 CASCADE 但 sqlite 默认 foreign_keys=0，
// 不显式开启则 DELETE session 留孤儿行）：先删 session_id 键的子表（表存在才删——
// schema 漂移容忍，缺表跳过不抛），session_task_link 双向（child 删 / parent 置
// NULL），workflow_run / workflow_activity 父键置 NULL，input_history 删，session
// 最后删。每库单事务，收尾 wal_checkpoint(PASSIVE)（不截断 -wal）。
//
// 失败语义（分级即错误处理契约）：sweep 是辅助资源面——任何失败（db 缺失 /
// node:sqlite 不可用 / 锁超时 / schema 漂移抛错）warn 留痕后返回 {swept:0}，绝不
// 拖垮 run 主链路。条目被清 = 锚失效 → 宿主侧自动走 reopen 降级（§3.2.6 ③），
// 无需人工恢复。

import * as fs from "node:fs";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("subagents");

/** TTL 窗口（ms）：30 天（2_592_000_000），对齐 pi 侧 transcript 保留期（§3.2.6 风险登记②）。 */
export const ZCODE_SESSION_TTL_MS = 2_592_000_000;

/** lazy sweep 的进程级节流窗（ms）：24 小时（86_400_000），同一 db 路径窗内不重扫。 */
export const ZCODE_SESSION_SWEEP_INTERVAL_MS = 86_400_000;

/** sweep 写锁等待（ms）：app-server 写者持锁时的并发兜底。 */
const SWEEP_BUSY_TIMEOUT_MS = 5_000;

/**
 * session_id 外键Cascade 子表清单（2026-09 实测 schema；缺表自动跳过——zcode 升级
 * 增删表不使 sweep 崩溃）。part 经 message 级联，不在显式清单。
 */
const SESSION_CHILD_TABLES: readonly string[] = [
  "message",
  "todo",
  "session_entry",
  "session_input",
  "session_target",
  "model_usage",
  "turn_usage",
  "tool_usage",
];

/** node:sqlite DatabaseSync 的最小消费面（同步 API——sweep 是同步维护动作）。 */
interface SweepSqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  close: () => void;
}

/** sweep 结果（观测面：日志与单测断言）。 */
export interface ZcodeSessionSweepResult {
  /** 本轮删除的 session 条数。 */
  swept: number;
  /** 命中 TTL 但被活跃豁免（keepSessionIds）保留的条数。 */
  keptActive: number;
}

/**
 * 同步加载 node:sqlite 的 DatabaseSync（进程内多实例复用）。
 * [HISTORICAL] 动态 import 必须经变量间接（esbuild CJS 前缀剥离陷阱，见 reader.ts
 * 同款注释）——本函数用 process.getBuiltinModule（Node ≥22.3 同步取 builtin，无
 * 异步面，适合同步 sweep；不可用时返回 undefined 走跳过分支）。
 */
function loadDatabaseSyncCtor(): (new (path: string, opts?: { readOnly?: boolean }) => SweepSqliteDb) | undefined {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== "function") return undefined;
  const mod = getBuiltin("node:sqlite") as { DatabaseSync?: unknown } | undefined;
  return typeof mod?.DatabaseSync === "function"
    ? (mod.DatabaseSync as new (path: string, opts?: { readOnly?: boolean }) => SweepSqliteDb)
    : undefined;
}

/** session 行的 last-activity（time_updated 优先回落 time_created；非数值 → null 保守保留）。 */
function sessionLastActivity(row: { time_updated?: unknown; time_created?: unknown }): number | null {
  for (const v of [row.time_updated, row.time_created]) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** 过期条目收集结果：expired = 待删 id 清单；keptActive = 活跃豁免计数。 */
interface ExpiredScan {
  expired: string[];
  keptActive: number;
}

/**
 * [行为保持] 从 session 表收集超窗条目（原 sweepExpiredZcodeSessions 内联循环
 * 提取，判定序逐条保持）：形状防御（无 id 行不可删也不可豁免）→ 保守保留
 * （非数值时间戳 / 窗内条目）→ 活跃豁免（keepSessionIds 命中计数保条目）。
 */
function collectExpiredSessions(
  db: SweepSqliteDb,
  cutoff: number,
  keep: ReadonlySet<string>,
): ExpiredScan {
  const rows = db
    .prepare("SELECT id, time_updated, time_created FROM session")
    .all() as Array<{ id?: unknown; time_updated?: unknown; time_created?: unknown }>;
  const expired: string[] = [];
  let keptActive = 0;
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id === "") continue; // 形状防御：无 id 行不可删也不可豁免
    const last = sessionLastActivity(row);
    if (last === null || last >= cutoff) continue; // 保守保留：非数值时间戳 / 窗内条目
    if (keep.has(row.id)) {
      keptActive++;
      continue;
    }
    expired.push(row.id);
  }
  return { expired, keptActive };
}

/**
 * [行为保持] 同连接显式开启并校验 FK PRAGMA（原内联段提取）。P1 实测：engine
 * 声明 CASCADE 但默认 foreign_keys=0——未生效即抛错中止删除（防孤儿行）。
 */
function ensureForeignKeysOn(db: SweepSqliteDb): void {
  db.exec("PRAGMA foreign_keys = ON");
  const fkOn = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown } | undefined;
  if (fkOn?.foreign_keys !== 1) {
    throw new Error("PRAGMA foreign_keys=ON 未生效——中止删除（防孤儿行），本轮 sweep 放弃");
  }
}

/** [行为保持] 现存表名集合（schema 漂移容忍探测，原内联段提取）。 */
function listPresentTables(db: SweepSqliteDb): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>)
      .map((r) => (typeof r.name === "string" ? r.name : "")),
  );
}

/**
 * 单条 IN 子句的占位符参数上限：SQLite 变量上限默认 32766（SQLITE_MAX_VARIABLE_NUMBER），
 * 超大 session 库单批全量 IN 会越限报错。500 留足量级裕度；分批共享同一事务，原子性与
 * 原单批形态不变。
 */
const DELETE_BATCH_SIZE = 500;

/** 把 ids 切成 ≤size 的批（最后一批可短）。 */
function chunkIds(ids: readonly string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

/**
 * [行为保持] 单事务删除序（FK 纪律，原函数 try 段提取，删除顺序与 SQL 逐字保持）：
 * session_id 键子表 → session_task_link 双向（child 删 / parent 置 NULL）→
 * workflow 父键置 NULL → input_history 删 → session 最后删。expired 超过
 * DELETE_BATCH_SIZE 时按批拆分 IN 子句（全部批次共享同一事务——任一批失败整体
 * ROLLBACK，原子性与原单批形态一致）。失败 ROLLBACK 后原样上抛（已断连等
 * ROLLBACK 失败时保留原错误）。返回实际删除条数。
 */
function deleteExpiredSessionsInTx(
  db: SweepSqliteDb,
  expired: readonly string[],
  present: ReadonlySet<string>,
): number {
  db.exec("BEGIN");
  try {
    let swept = 0;
    for (const batch of chunkIds(expired, DELETE_BATCH_SIZE)) {
      const ph = batch.map(() => "?").join(", ");
      for (const table of SESSION_CHILD_TABLES) {
        if (present.has(table)) db.prepare(`DELETE FROM ${table} WHERE session_id IN (${ph})`).run(...batch);
      }
      if (present.has("session_task_link")) {
        db.prepare(`DELETE FROM session_task_link WHERE child_session_id IN (${ph})`).run(...batch);
        db.prepare(`UPDATE session_task_link SET parent_session_id = NULL WHERE parent_session_id IN (${ph})`).run(...batch);
      }
      if (present.has("workflow_run")) {
        db.prepare(`UPDATE workflow_run SET parent_session_id = NULL WHERE parent_session_id IN (${ph})`).run(...batch);
      }
      if (present.has("workflow_activity")) {
        db.prepare(`UPDATE workflow_activity SET child_session_id = NULL WHERE child_session_id IN (${ph})`).run(...batch);
      }
      if (present.has("input_history")) {
        db.prepare(`DELETE FROM input_history WHERE session_id IN (${ph})`).run(...batch);
      }
      const res = db.prepare(`DELETE FROM session WHERE id IN (${ph})`).run(...batch);
      swept += res.changes ?? batch.length;
    }
    db.exec("COMMIT");
    return swept;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErr) {
      void rollbackErr; // 已断连等：保留原错误
    }
    throw err;
  }
}

/**
 * 扫并删除隔离库中超 TTL 窗的 session 条目（同步——维护动作，调用方负责不阻塞
 * 主链路时点，见 maybeSweep 的 defer 接线）。
 *
 * @param dbPath       隔离库绝对路径（zcodeSessionDbPath 产物）
 * @param opts.nowMs   时间基准（缺省 Date.now()——单测注入 fake clock 语义）
 * @param opts.ttlMs   TTL 窗口（缺省 ZCODE_SESSION_TTL_MS）
 * @param opts.keepSessionIds 活跃豁免集（在途会话——engine.activeSessions 快照）
 */
export function sweepExpiredZcodeSessions(
  dbPath: string,
  opts: { nowMs?: number; ttlMs?: number; keepSessionIds?: ReadonlySet<string> } = {},
): ZcodeSessionSweepResult {
  const noOp: ZcodeSessionSweepResult = { swept: 0, keptActive: 0 };
  if (!fs.existsSync(dbPath)) return noOp;
  const Ctor = loadDatabaseSyncCtor();
  if (Ctor === undefined) {
    logger.warn("[zcode-ttl] node:sqlite 不可用（需 Node ≥22.3 的 process.getBuiltinModule）——本轮 sweep 跳过");
    return noOp;
  }
  const now = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? ZCODE_SESSION_TTL_MS;
  const cutoff = now - ttl;
  const keep = opts.keepSessionIds ?? new Set<string>();
  let db: SweepSqliteDb | undefined;
  try {
    db = new Ctor(dbPath);
    db.exec(`PRAGMA busy_timeout = ${SWEEP_BUSY_TIMEOUT_MS}`);
    const { expired, keptActive } = collectExpiredSessions(db, cutoff, keep);
    if (expired.length === 0) {
      db.close();
      return { swept: 0, keptActive };
    }
    ensureForeignKeysOn(db);
    const present = listPresentTables(db);
    const swept = deleteExpiredSessionsInTx(db, expired, present);
    logger.debug(`[zcode-ttl] 隔离库超窗条目已清：${swept} 条（TTL ${ttl}ms，豁免活跃 ${keptActive}）`, { dbPath });
    try {
      db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    } catch (err) {
      void err; // checkpoint 失败只影响 WAL 回收节奏，删除已提交
    }
    return { swept, keptActive };
  } catch (err) {
    logger.warn(
      `[zcode-ttl] sweep 失败（辅助资源面，不影响 run 主链路；下个节流窗重试）: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { dbPath },
    );
    return noOp;
  } finally {
    try {
      db?.close();
    } catch (err) {
      void err;
    }
  }
}

/** 节流账本（dbPath → 上次 sweep 完成时刻；模块级 = 进程级节流）。 */
const sweepThrottle = new Map<string, number>();

/**
 * 节流版 sweep 入口（生产接线点：ensureAppServerRuntime defer 调用）。同一 dbPath
 * 在 ZCODE_SESSION_SWEEP_INTERVAL_MS 内只扫一次；`force` 仅供测试穿透节流。
 * 时间基准走 Date.now()——fake timers 单测经 vi.setSystemTime 推进节流窗。
 */
export function maybeSweepExpiredZcodeSessions(
  dbPath: string,
  opts: { keepSessionIds?: ReadonlySet<string>; force?: boolean } = {},
): ZcodeSessionSweepResult {
  const now = Date.now();
  const last = sweepThrottle.get(dbPath);
  if (!opts.force && last !== undefined && now - last < ZCODE_SESSION_SWEEP_INTERVAL_MS) {
    return { swept: 0, keptActive: 0 };
  }
  const result = sweepExpiredZcodeSessions(dbPath, {
    ...(opts.keepSessionIds !== undefined ? { keepSessionIds: opts.keepSessionIds } : {}),
  });
  // 失败（warn 路径）同样推进节流戳：失败重试按下个窗口走，不逐 run 放大
  sweepThrottle.set(dbPath, now);
  return result;
}

/** 测试隔离用：清空节流账本（不进生产路径）。 */
export function _resetSweepThrottleForTest(): void {
  sweepThrottle.clear();
}
