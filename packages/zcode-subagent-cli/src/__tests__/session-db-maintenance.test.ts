// session-db-maintenance.test.ts —— [U6 / §3.2.6 风险登记②] zcode 隔离会话库 TTL
// 清理通道单测：真实 node:sqlite 建 tmp 库（mkdtempSync 自建自删，零接触真实数据
// 目录），断言三要素——超窗条目被清（含子表级联行）/ 窗内条目保留 / 活跃 sessionId
// 豁免；非数值时间戳保守保留；节流窗（fake timers 推进系统时间）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ZCODE_SESSION_SWEEP_INTERVAL_MS,
  ZCODE_SESSION_TTL_MS,
  _resetSweepThrottleForTest,
  maybeSweepExpiredZcodeSessions,
  sweepExpiredZcodeSessions,
} from "../session-db-maintenance.ts";

let tmpDir: string;
let dbPath: string;

interface Db {
  exec: (s: string) => void;
  prepare: (s: string) => {
    run: (...a: unknown[]) => void;
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
  close: () => void;
}

async function openDb(file: string): Promise<Db> {
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => unknown };
  return new DatabaseSync(file) as unknown as Db;
}

/**
 * 建出 sweep 消费面的最小 schema（session + 两张 session_id 子表 + input_history
 * + 三族 FK 孤儿防线表）。三族表不声明 FK 约束——复现生产实测形态（engine 声明
 * CASCADE/SET NULL 但 foreign_keys=0 不生效，孤儿行只有 sweep 显式 SQL 能清），
 * 断言针对显式清理 SQL 的效果而非连接级级联。
 */
async function createDb(file: string): Promise<Db> {
  const db = await openDb(file);
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER);" +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);" +
      "CREATE TABLE todo (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);" +
      "CREATE TABLE input_history (session_id TEXT PRIMARY KEY, payload TEXT);" +
      "CREATE TABLE session_task_link (id TEXT PRIMARY KEY, parent_session_id TEXT, child_session_id TEXT);" +
      "CREATE TABLE workflow_run (id TEXT PRIMARY KEY, parent_session_id TEXT, status TEXT);" +
      "CREATE TABLE workflow_activity (id TEXT PRIMARY KEY, child_session_id TEXT, kind TEXT);",
  );
  return db;
}

function insertSession(db: Db, id: string, timeCreated: number | null, timeUpdated?: number | null): void {
  db.prepare("INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)").run(
    id,
    timeCreated,
    timeUpdated ?? null,
  );
}

function insertChildRows(db: Db, sessionId: string): void {
  db.prepare("INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, 0, '{}')").run(`m-${sessionId}`, sessionId);
  db.prepare("INSERT INTO todo (id, session_id, content) VALUES (?, ?, 't')").run(`td-${sessionId}`, sessionId);
  db.prepare("INSERT INTO input_history (session_id, payload) VALUES (?, '{}')").run(sessionId);
}

async function countRows(db: Db, table: string, where: string, arg: unknown): Promise<number> {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(arg) as { n?: unknown };
  return typeof row?.n === "number" ? row.n : -1;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-ttl-"));
  dbPath = path.join(tmpDir, "db.sqlite");
});

afterEach(() => {
  _resetSweepThrottleForTest();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("sweepExpiredZcodeSessions（判龄三要素 + 级联删除）", () => {
  it("超窗条目被清（子表行同删）、窗内条目保留、活跃 sessionId 豁免、非数值时间戳保守保留", async () => {
    const db = await createDb(dbPath);
    const now = 1_000_000_000_000;
    const expiredAt = now - ZCODE_SESSION_TTL_MS - 1; // 严格超窗
    const freshAt = now - ZCODE_SESSION_TTL_MS + 60_000; // 窗内（TTL 内续聊过的会话）
    // expired-active：超窗但在途（活跃豁免）
    insertSession(db, "sess_expired", expiredAt);
    insertSession(db, "sess_expired_active", expiredAt);
    insertSession(db, "sess_fresh", freshAt, freshAt);
    insertSession(db, "sess_null_time", null);
    for (const id of ["sess_expired", "sess_expired_active", "sess_fresh"]) insertChildRows(db, id);
    db.close();

    const result = sweepExpiredZcodeSessions(dbPath, {
      nowMs: now,
      keepSessionIds: new Set(["sess_expired_active"]),
    });

    expect(result.swept).toBe(1);
    expect(result.keptActive).toBe(1);

    const verify = await openDb(dbPath);
    try {
      const sessionRows = (verify.prepare("SELECT id FROM session").all() as Array<{ id: string }>).map((r) => r.id).sort();
      expect(sessionRows).toEqual(["sess_expired_active", "sess_fresh", "sess_null_time"]);
      // 子表级联：expired 的 message/todo/input_history 行同删，fresh 的保留
      expect(await countRows(verify, "message", "session_id = ?", "sess_expired")).toBe(0);
      expect(await countRows(verify, "todo", "session_id = ?", "sess_expired")).toBe(0);
      expect(await countRows(verify, "input_history", "session_id = ?", "sess_expired")).toBe(0);
      expect(await countRows(verify, "message", "session_id = ?", "sess_fresh")).toBe(1);
      expect(await countRows(verify, "message", "session_id = ?", "sess_expired_active")).toBe(1);
    } finally {
      verify.close();
    }
  });

  it("判龄基准 = time_updated 优先（续聊刷新过的超龄会话不误删）", async () => {
    const db = await createDb(dbPath);
    const now = 2_000_000_000_000;
    insertSession(db, "sess_old_created_recent_update", now - ZCODE_SESSION_TTL_MS - 999_999, now - 1_000);
    insertChildRows(db, "sess_old_created_recent_update");
    db.close();

    const result = sweepExpiredZcodeSessions(dbPath, { nowMs: now });
    expect(result.swept).toBe(0);
    const verify = await openDb(dbPath);
    try {
      const rows = verify.prepare("SELECT id FROM session").all() as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual(["sess_old_created_recent_update"]);
    } finally {
      verify.close();
    }
  });

  it("db 缺失 / 无超窗条目 → no-op（不抛）", () => {
    expect(sweepExpiredZcodeSessions(path.join(tmpDir, "nope.sqlite"))).toEqual({ swept: 0, keptActive: 0 });
  });

  it("超窗条目超过单批 IN 参数上限（1200 > 500）→ 分批删除仍全清（子表级联全覆盖）", async () => {
    // IN 子句按批拆分（每批 ≤500 占位符，SQLite 变量上限 32766 兜底）；
    // 共享单事务——批间任一失败整体回滚，此处验证正常路径批间结果合并。
    const db = await createDb(dbPath);
    const now = 3_000_000_000_000;
    const expiredAt = now - ZCODE_SESSION_TTL_MS - 1;
    const total = 1200;
    // 4800 条 INSERT 包进单事务：逐条 autocommit 每条一次 fsync，实测 1.1s-5.6s 波动
    // 贴 vitest 5s 默认超时线（flaky）；事务化后一次性落盘，与被测 sweep 行为无关。
    db.exec("BEGIN");
    for (let i = 0; i < total; i++) {
      insertSession(db, `sess_${i}`, expiredAt);
      insertChildRows(db, `sess_${i}`);
    }
    db.exec("COMMIT");
    db.close();

    const result = sweepExpiredZcodeSessions(dbPath, { nowMs: now });
    expect(result.swept).toBe(total);

    const verify = await openDb(dbPath);
    try {
      expect((verify.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n).toBe(0);
      expect((verify.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n).toBe(0);
      expect((verify.prepare("SELECT COUNT(*) AS n FROM input_history").get() as { n: number }).n).toBe(0);
    } finally {
      verify.close();
    }
  });
});

describe("sweepExpiredZcodeSessions（三族 FK 孤儿防线：session_task_link 双向 / workflow 父键置 NULL）", () => {
  it("超窗会话：link child 方向整行删、parent 方向置 NULL 行留；workflow_run/workflow_activity 引用键置 NULL 行留；存活会话关联行不动", async () => {
    const db = await createDb(dbPath);
    const now = 4_000_000_000_000;
    const expiredAt = now - ZCODE_SESSION_TTL_MS - 1; // 严格超窗
    const freshAt = now - ZCODE_SESSION_TTL_MS + 60_000; // 窗内
    insertSession(db, "sess_expired", expiredAt);
    insertSession(db, "sess_expired_active", expiredAt);
    insertSession(db, "sess_fresh", freshAt, freshAt);

    // session_task_link 双向：child 指向被删会话 → 整行删；parent 指向被删会话 → 置 NULL 行留；两端存活 → 不动
    db.prepare("INSERT INTO session_task_link (id, parent_session_id, child_session_id) VALUES (?, ?, ?)").run("link_child_hit", "sess_fresh", "sess_expired");
    db.prepare("INSERT INTO session_task_link (id, parent_session_id, child_session_id) VALUES (?, ?, ?)").run("link_parent_hit", "sess_expired", "sess_fresh");
    db.prepare("INSERT INTO session_task_link (id, parent_session_id, child_session_id) VALUES (?, ?, ?)").run("link_untouched", "sess_fresh", "sess_expired_active");

    // workflow_run / workflow_activity：引用指向被删会话 → 键置 NULL 行留；指向存活会话 → 不动
    db.prepare("INSERT INTO workflow_run (id, parent_session_id, status) VALUES (?, ?, ?)").run("run_hit", "sess_expired", "done");
    db.prepare("INSERT INTO workflow_run (id, parent_session_id, status) VALUES (?, ?, ?)").run("run_keep", "sess_fresh", "done");
    db.prepare("INSERT INTO workflow_activity (id, child_session_id, kind) VALUES (?, ?, ?)").run("act_hit", "sess_expired", "step");
    db.prepare("INSERT INTO workflow_activity (id, child_session_id, kind) VALUES (?, ?, ?)").run("act_keep", "sess_fresh", "step");
    db.close();

    const result = sweepExpiredZcodeSessions(dbPath, {
      nowMs: now,
      keepSessionIds: new Set(["sess_expired_active"]),
    });
    expect(result.swept).toBe(1);

    const verify = await openDb(dbPath);
    try {
      const sessionRows = (verify.prepare("SELECT id FROM session").all() as Array<{ id: string }>).map((r) => r.id).sort();
      expect(sessionRows).toEqual(["sess_expired_active", "sess_fresh"]);

      // child 方向：child_session_id 指向被删会话 → 整行删除（不留孤儿）
      expect(await countRows(verify, "session_task_link", "id = ?", "link_child_hit")).toBe(0);
      // parent 方向：行保留，parent_session_id 置 NULL，child 引用原样
      const parentHit = verify.prepare("SELECT parent_session_id, child_session_id FROM session_task_link WHERE id = ?").get("link_parent_hit") as {
        parent_session_id: string | null;
        child_session_id: string;
      };
      expect(parentHit.parent_session_id).toBeNull();
      expect(parentHit.child_session_id).toBe("sess_fresh");
      // 两端均存活（含活跃豁免）→ 完全不动
      const untouched = verify.prepare("SELECT parent_session_id, child_session_id FROM session_task_link WHERE id = ?").get("link_untouched") as {
        parent_session_id: string;
        child_session_id: string;
      };
      expect(untouched.parent_session_id).toBe("sess_fresh");
      expect(untouched.child_session_id).toBe("sess_expired_active");

      // workflow_run：命中行保留 + parent_session_id 置 NULL；存活引用不动
      const runHit = verify.prepare("SELECT parent_session_id, status FROM workflow_run WHERE id = ?").get("run_hit") as {
        parent_session_id: string | null;
        status: string;
      };
      expect(runHit.parent_session_id).toBeNull();
      expect(runHit.status).toBe("done");
      const runKeep = verify.prepare("SELECT parent_session_id FROM workflow_run WHERE id = ?").get("run_keep") as { parent_session_id: string };
      expect(runKeep.parent_session_id).toBe("sess_fresh");

      // workflow_activity：命中行保留 + child_session_id 置 NULL；存活引用不动
      const actHit = verify.prepare("SELECT child_session_id, kind FROM workflow_activity WHERE id = ?").get("act_hit") as {
        child_session_id: string | null;
        kind: string;
      };
      expect(actHit.child_session_id).toBeNull();
      expect(actHit.kind).toBe("step");
      const actKeep = verify.prepare("SELECT child_session_id FROM workflow_activity WHERE id = ?").get("act_keep") as { child_session_id: string };
      expect(actKeep.child_session_id).toBe("sess_fresh");
    } finally {
      verify.close();
    }
  });
});

describe("maybeSweepExpiredZcodeSessions（进程级节流，fake timers）", () => {
  it("节流窗内第二次 no-op；推进系统时间超窗后重扫；force 穿透", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const db = await createDb(dbPath);
    db.close();
    _resetSweepThrottleForTest();

    // 第一次：空库扫过（swept 0，节流戳落位）
    expect(maybeSweepExpiredZcodeSessions(dbPath)).toEqual({ swept: 0, keptActive: 0 });
    // 窗内：不重扫（即便此刻库里已出现超窗条目）
    const seed = await openDb(dbPath);
    insertSession(seed, "sess_stale", 1);
    seed.close();
    expect(maybeSweepExpiredZcodeSessions(dbPath)).toEqual({ swept: 0, keptActive: 0 });
    // force 穿透节流
    expect(maybeSweepExpiredZcodeSessions(dbPath, { force: true }).swept).toBe(1);
    // 重新播种 + 推进系统时间超节流窗 → 重扫生效
    const reseed = await openDb(dbPath);
    insertSession(reseed, "sess_stale_2", 1);
    reseed.close();
    vi.setSystemTime(Date.now() + ZCODE_SESSION_SWEEP_INTERVAL_MS + 1);
    expect(maybeSweepExpiredZcodeSessions(dbPath).swept).toBe(1);

    const verify = await openDb(dbPath);
    try {
      const rows = verify.prepare("SELECT id FROM session").all() as Array<{ id: string }>;
      expect(rows).toEqual([]);
    } finally {
      verify.close();
    }
  });
});
