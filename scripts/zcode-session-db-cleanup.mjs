#!/usr/bin/env node
// zcode 引擎存量宿主行清理工具（设计 D7 / impl-plan §2.5 W5a）。
//
// 用途：以自身 record 存储（type='custom' && customType='subagent-record' entry 的
// engineHandle.sessionRef.sessionId）为白名单，清理改造前写进宿主库
// ~/.zcode/cli/db/db.sqlite 的存量会话行 + GUI 索引库 ~/.zcode/v2/tasks-index.sqlite
// 的对应行。破坏性操作：必须先 --plan 确认备份与停机窗口，再交互确认或
// --confirm-count <删除集总数> 受控旁路。
//
// 实现纪律（设计 §3.2 D7 四不变量）：
// - 白名单只来自结构化 entry 解析（JSON.parse 逐行），禁止文本/正则提取；
// - I2 时间戳跨源交叉验证（唯一常量 I2_TOLERANCE_MS）；
// - 删除面：宿主库 PRAGMA foreign_keys=ON + FK 依赖序（session 行删除，级联清理引用表），
//   input_history 无 FK 显式删；索引库零 FK → 四冲突源只读预检（命中两侧同时剔除）；
// - 跨库顺序恒「先宿主后索引」，索引侧失败落残留清单 w5-residue-<ts>.json，
//   --replay-residue 补删（含 R9-4 防篡改前置断言）。
//
// 本文件 referenceDeletionSetImpl 是 I1 参照断言的权威文本（原 probe 文档 counts.sql
// W5 参照 SQL 的同义实装，该文档已删除、git 可追溯）。

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── 常量（全局唯一） ────────────────────────────────────────────────────────

/** I2 时间戳容差（ms）。权威值：impl-plan §2.5 I2；counts.sql ④⑤ 的 10000 字面量指向此处。 */
export const I2_TOLERANCE_MS = 10_000;

/** record entry 的 customType（与 subagent-core record-entry.ts SUBAGENT_RECORD_CUSTOM_TYPE 同值）。 */
export const SUBAGENT_RECORD_CUSTOM_TYPE = "subagent-record";

/**
 * sessionId 形状校验（识别基准双过滤第一道）：字母数字开头，允许 ._- ，长度 4–128。
 * 形状过滤只挡明显脏数据（截断/换行注入），存在性过滤才是主判据。
 */
export const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;

// 以下后缀与 @zhushanwen/subagent-engine-sdk src/zcode-db-paths.ts（路径段常量 SSOT，
// zcode-cli db-path.ts 与 runtime sqlite-access.ts 同源 import）同值。脚本为 ESM 无法
// import TS 源（scripts/ 无构建链），按 db-path.ts 等价 JS 实现复用其语义；一致性由
// packages/runtime/test/host-db-suffix-parity.test.ts 的脚本投影文本比对守卫。
const HOST_DB_SUFFIX = [".zcode", "cli", "db", "db.sqlite"];
const INDEX_DB_SUFFIX = [".zcode", "v2", "tasks-index.sqlite"];

/** 隔离库路径（db-path.ts zcodeSessionDbPath 的等价 JS 实现；禁硬编码调用方）。 */
export function zcodeSessionDbPathJs(engineDataDir) {
  return path.join(engineDataDir, "engines", "zcode", "session-db", "db.sqlite");
}

/** 宿主库路径（db-path.ts hostZcodeDbPath 的等价 JS 实现）。 */
export function hostZcodeDbPathJs(homeDir = os.homedir()) {
  return path.join(homeDir, ...HOST_DB_SUFFIX);
}

/** GUI 索引库路径。 */
export function indexDbPathJs(homeDir = os.homedir()) {
  return path.join(homeDir, ...INDEX_DB_SUFFIX);
}

// ── 白名单解析（识别基准） ─────────────────────────────────────────────────

/**
 * 解析 record 存储 JSONL → 白名单行 [{sessionId, startedAt}]。
 * 只解析 type='custom' && customType='subagent-record' 的结构化 entry（data.v !== 1 的
 * 未知 schema 版本按 record-entry 契约跳过不猜）；同 id 多 entry 取 last-writer-wins
 * （running 态追加更新，startedAt 恒定）。pi 引擎 record 无 engineHandle.sessionRef，
 * 自然被过滤。不做任何文本/正则提取。
 */
export function parseRecordWhitelist(recordsDir, fsMod = fs) {
  const byId = new Map();
  const files = fsMod
    .readdirSync(recordsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const f of files) {
    const text = fsMod.readFileSync(path.join(recordsDir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.type !== "custom" || e?.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) continue;
      const d = e.data;
      if (d?.v !== 1) continue;
      const sid = d?.engineHandle?.sessionRef?.sessionId;
      if (typeof sid === "string" && sid.length > 0) {
        byId.set(sid, {
          sessionId: sid,
          startedAt: typeof d.startedAt === "number" ? d.startedAt : null,
        });
      }
    }
  }
  return [...byId.values()];
}

// ── 分析（I1/I2/I3/I3b + 索引预检 + 参照 SQL 断言） ─────────────────────────

/** 分析中止（I2/I3/I3b/参照断言失败）：携带面向操作者的报告文本。 */
export class CleanupAbortError extends Error {
  constructor(report) {
    super(report);
    this.name = "CleanupAbortError";
    this.report = report;
  }
}

function tableExists(db, name) {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined
  );
}

/**
 * 索引库四冲突源只读预检（counts.sql W5 ② 同义；索引库零 FK，删除面不含这四源）。
 * 返回命中的 id 集合——命中 id 两侧同时剔除（宿主行也不删）。
 */
export function indexPrecheckHits(indexDb, ids) {
  const hits = new Set();
  if (ids.length === 0) return hits;
  const placeholders = ids.map(() => "?").join(",");
  const sources = [
    "SELECT DISTINCT task_id FROM task_group_members WHERE task_id IN (" + placeholders + ")",
    "SELECT target_task_id AS id FROM automations WHERE target_task_id IN (" + placeholders + ")",
    "SELECT session_id AS id FROM off_peak_tasks WHERE session_id IN (" + placeholders + ")",
    "SELECT task_id AS id FROM tasks WHERE off_peak_task_id IS NOT NULL AND task_id IN (" + placeholders + ")",
  ];
  for (const sql of sources) {
    for (const row of indexDb.prepare(sql).all(...ids)) {
      const v = row.id ?? row.task_id;
      if (typeof v === "string") hits.add(v);
    }
  }
  return hits;
}

/**
 * 只读挂接文件库（URI mode=ro；主连接为 :memory: 承载 wl 白名单表）。
 * 参照 SQL 路径只 SELECT，但仍用 ro 挂接把「只读」变成机器保证而非纪律。
 */
function attachReadOnly(db, alias, filePath) {
  const uri = "file:" + filePath.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23");
  db.exec(`ATTACH DATABASE '${uri.replace(/'/g, "''")}?mode=ro' AS ${alias}`);
}

/** 参照 SQL 侧的删除集计算（counts.sql W5 ①②③ 逐字同义——仅表名加 host./idx. 限定；独立于工具主路径自算）。 */
function referenceDeletionSetImpl(hostDbPath, indexDbPath, whitelistRows) {
  const mem = new DatabaseSync(":memory:");
  try {
    mem.exec("ATTACH DATABASE ':memory:' AS wl");
    mem.exec("CREATE TABLE wl.wl(sessionId TEXT PRIMARY KEY, startedAt INTEGER)");
    const ins = mem.prepare("INSERT OR REPLACE INTO wl.wl(sessionId, startedAt) VALUES (?, ?)");
    for (const r of whitelistRows) ins.run(r.sessionId, r.startedAt);
    attachReadOnly(mem, "host", hostDbPath);
    attachReadOnly(mem, "idx", indexDbPath);
    // counts.sql W5 ①：直接删除集
    const direct = new Set(
      mem
        .prepare("SELECT s.id FROM host.session s JOIN wl.wl w ON w.sessionId = s.id")
        .all()
        .map((r) => r.id),
    );
    // counts.sql W5 ③：派生删除集
    const derived = new Set(
      mem
        .prepare(
          "SELECT id FROM host.session WHERE parent_id IN (SELECT s.id FROM host.session s JOIN wl.wl w ON w.sessionId = s.id) AND task_type='subagent_child'",
        )
        .all()
        .map((r) => r.id),
    );
    // counts.sql W5 ②：索引预检（同一会话内 wl 已 ATTACH）
    const precheck = new Set(
      mem
        .prepare(
          "SELECT DISTINCT task_id AS id FROM idx.task_group_members WHERE task_id IN (SELECT sessionId FROM wl.wl) " +
            "UNION SELECT target_task_id AS id FROM idx.automations WHERE target_task_id IN (SELECT sessionId FROM wl.wl) " +
            "UNION SELECT session_id AS id FROM idx.off_peak_tasks WHERE session_id IN (SELECT sessionId FROM wl.wl) " +
            "UNION SELECT task_id AS id FROM idx.tasks WHERE off_peak_task_id IS NOT NULL AND task_id IN (SELECT sessionId FROM wl.wl)",
        )
        .all()
        .map((r) => r.id),
    );
    const drop = (s) => {
      for (const h of precheck) s.delete(h);
      return s;
    };
    return { direct: drop(direct), derived: drop(derived), precheck };
  } finally {
    mem.close();
  }
}

/** 白名单形状过滤（识别基准双过滤第一道）：不过形状的 id 记入 shapeInvalid + anomalies。 */
function partitionWhitelistByShape(whitelistRows, anomalies) {
  const shapeInvalid = [];
  const shaped = [];
  for (const r of whitelistRows) {
    if (!SESSION_ID_SHAPE.test(r.sessionId)) {
      shapeInvalid.push(r.sessionId);
      anomalies.push(`形状校验不过（剔除）：${r.sessionId}`);
    } else {
      shaped.push(r);
    }
  }
  return { shaped, shapeInvalid };
}

/** 宿主库删除面行查询（直接集行 / 派生集行 / 直接集的非 subagent_child 子行）。 */
function queryHostDeletionRows(hostDbPath, shaped) {
  const host = new DatabaseSync(hostDbPath, { readOnly: true });
  let hostRows;
  let derivedRows;
  let nonChildChildren;
  try {
    const placeholders = shaped.map(() => "?").join(",");
    hostRows =
      shaped.length === 0
        ? []
        : host
            .prepare(
              `SELECT id, task_type, title_source, time_created, parent_id FROM session WHERE id IN (${placeholders})`,
            )
            .all(...shaped.map((r) => r.sessionId));
    const directIds = hostRows.map((r) => r.id);
    const ph2 = directIds.map(() => "?").join(",");
    // I3b 作用域基表：直接集的全部子行（不限 task_type），供不变量校验与 SET NULL 报告
    nonChildChildren =
      directIds.length === 0
        ? []
        : host
            .prepare(
              `SELECT id, task_type FROM session WHERE parent_id IN (${ph2}) AND task_type != 'subagent_child'`,
            )
            .all(...directIds);
    derivedRows =
      directIds.length === 0
        ? []
        : host
            .prepare(
              `SELECT id, parent_id, task_type FROM session WHERE parent_id IN (${ph2}) AND task_type='subagent_child'`,
            )
            .all(...directIds);
  } finally {
    host.close();
  }
  return { hostRows, derivedRows, nonChildChildren };
}

/** I2：时间戳交叉验证（作用域 = 直接删除集；超容差/取不到 → 硬中止）。 */
function checkI2Timestamps(hostRows, startedById) {
  const i2Violations = [];
  for (const row of hostRows) {
    const startedAt = startedById.get(row.id);
    const tc = row.time_created;
    if (startedAt === null || startedAt === undefined) {
      i2Violations.push(`${row.id}(startedAt 缺失)`);
    } else if (tc === null || tc === undefined || typeof tc !== "number") {
      i2Violations.push(`${row.id}(宿主 time_created 缺失)`);
    } else if (Math.abs(startedAt - tc) > I2_TOLERANCE_MS) {
      i2Violations.push(`${row.id}(Δ=${Math.abs(startedAt - tc)}ms > ${I2_TOLERANCE_MS}ms)`);
    }
  }
  if (i2Violations.length > 0) {
    throw new CleanupAbortError(
      `I2 时间戳交叉验证失败（容差 ${I2_TOLERANCE_MS}ms），中止：\n  ${i2Violations.join("\n  ")}`,
    );
  }
}

/** I3：形态硬中止（作用域 = 直接删除集）。 */
function checkI3Shape(hostRows) {
  const i3Violations = hostRows
    .filter((r) => r.task_type !== "interactive" || r.title_source === "custom")
    .map((r) => `${r.id}(task_type=${r.task_type}, title_source=${r.title_source})`);
  if (i3Violations.length > 0) {
    throw new CleanupAbortError(`I3 形态校验失败，中止：\n  ${i3Violations.join("\n  ")}`);
  }
}

/** 索引预检（只读挂接）：候选删除集命中四冲突源的 id 集合。 */
function runIndexPrecheck(indexDbPath, directSet, derivedRows) {
  const idx = new DatabaseSync(indexDbPath, { readOnly: true });
  try {
    const deletionCandidateIds = [...new Set([...directSet, ...derivedRows.map((r) => r.id)])];
    return indexPrecheckHits(idx, deletionCandidateIds);
  } finally {
    idx.close();
  }
}

/** 预检后异常信号入列：索引冲突命中 + 直接集非 subagent_child 子行（SET NULL 报告面）。 */
function appendPrecheckAnomalies(anomalies, indexHits, nonChildChildren) {
  for (const h of indexHits) {
    anomalies.push(`索引冲突源命中（两侧剔除）：${h}`);
  }
  for (const r of nonChildChildren) {
    anomalies.push(`直接集存在非 subagent_child 子行（不纳入删除，parent_id 将被 SET NULL）：${r.id}(task_type=${r.task_type})`);
  }
}

/** I1 参照断言：工具自算删除集 == 参照 SQL（referenceDeletionSetImpl）结果。 */
function assertReferenceParity({ hostDbPath, indexDbPath, shaped, direct, derived }) {
  const ref = referenceDeletionSetImpl(hostDbPath, indexDbPath, shaped);
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  if (!sameSet(direct, [...ref.direct]) || !sameSet(derived, [...ref.derived])) {
    throw new CleanupAbortError(
      `I1 参照断言失败：工具自算直接集/派生集与参照 SQL 权威文本（docs/architecture/zcode-session-db-isolation.md §3.2 D7）不一致。\n` +
        `  自算 direct=[${direct.join(",")}] derived=[${derived.join(",")}]\n` +
        `  参照 direct=[${[...ref.direct].join(",")}] derived=[${[...ref.derived].join(",")}]`,
    );
  }
}

/**
 * 主分析路径：白名单 → 四数分列 + I2/I3/I3b 校验 + 索引预检 + I1 参照断言。
 * 任一硬校验失败抛 CleanupAbortError（报告含违规 id 列表）。
 */
export function analyze({ whitelistRows, hostDbPath, indexDbPath }) {
  const anomalies = [];
  const { shaped, shapeInvalid } = partitionWhitelistByShape(whitelistRows, anomalies);
  const whitelistTotal = whitelistRows.length;

  const { hostRows, derivedRows, nonChildChildren } = queryHostDeletionRows(hostDbPath, shaped);

  // I2：时间戳交叉验证（作用域 = 直接删除集；超容差/取不到 → 硬中止）
  const startedById = new Map(shaped.map((r) => [r.sessionId, r.startedAt]));
  checkI2Timestamps(hostRows, startedById);

  // I3：形态硬中止（作用域 = 直接删除集）
  checkI3Shape(hostRows);

  // I3b：派生集不变量（每行 parent_id ∈ 直接删除集 且 task_type='subagent_child'）
  const directSet = new Set(hostRows.map((r) => r.id));
  assertDerivedInvariant(directSet, derivedRows);

  // 索引预检：命中 → 两侧同时剔除
  const indexHits = runIndexPrecheck(indexDbPath, directSet, derivedRows);
  const direct = [...directSet].filter((id) => !indexHits.has(id));
  const derived = derivedRows.map((r) => r.id).filter((id) => !indexHits.has(id));
  appendPrecheckAnomalies(anomalies, indexHits, nonChildChildren);

  // I1 参照断言：工具自算删除集 == 参照 SQL（referenceDeletionSetImpl）结果
  assertReferenceParity({ hostDbPath, indexDbPath, shaped, direct, derived });

  return {
    whitelistTotal,
    directCount: direct.length,
    derivedCount: derived.length,
    deletionTotal: direct.length + derived.length,
    direct,
    derived,
    indexConflictHits: [...indexHits],
    shapeInvalid,
    anomalies,
  };
}

/** I3b 派生集不变量（独立导出供 fixture 级校验）。 */
export function assertDerivedInvariant(directSet, derivedRows) {
  const violations = derivedRows
    .filter((r) => !directSet.has(r.parent_id) || r.task_type !== "subagent_child")
    .map((r) => `${r.id}(parent_id=${r.parent_id}, task_type=${r.task_type})`);
  if (violations.length > 0) {
    throw new CleanupAbortError(`I3b 派生集不变量失败，中止：\n  ${violations.join("\n  ")}`);
  }
}

// ── 执行（删除 + 残留清单 + 凭证） ─────────────────────────────────────────

/** SET NULL 越行修改的 Prospective 计数列（报告用；表可能缺——fixture 最小 schema）。 */
const SET_NULL_REPORT_COLUMNS = [
  ["session_task_link", "parent_session_id"],
  ["workflow_run", "parent_session_id"],
  ["workflow_activity", "child_session_id"],
];

/**
 * 执行删除（跨库顺序：每 id 先宿主后索引）。索引侧失败不回滚宿主侧（中间态只可能是
 * 「宿主已删、索引残留」的可恢复方向）——失败 id 落残留清单，可 --replay-residue 补删。
 * 确认与凭证由调用方（runCli）负责，本函数假定已确认。
 */
export function executeDeletion({
  analysis,
  hostDbPath,
  indexDbPath,
  residueDir,
  operator,
  authorizationSource,
  now = Date.now(),
}) {
  const ids = [...analysis.direct, ...analysis.derived];
  const residue = [];
  const fkFailures = [];
  let inputHistoryDeleted = 0;
  const setNullProspective = {};

  const host = new DatabaseSync(hostDbPath);
  try {
    host.exec("PRAGMA foreign_keys = ON");
    for (const [table, col] of SET_NULL_REPORT_COLUMNS) {
      if (tableExists(host, table) && ids.length > 0) {
        const ph = ids.map(() => "?").join(",");
        setNullProspective[`${table}.${col}`] =
          host.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IN (${ph})`).get(...ids).n;
      }
    }
    for (const id of ids) {
      try {
        host.exec("BEGIN");
        if (tableExists(host, "input_history")) {
          // input_history 无 FK 也无间接级联路径 → 显式删（保留 zsw countInputHistoryHits 同款计数）
          inputHistoryDeleted += host
            .prepare("DELETE FROM input_history WHERE session_id = ?")
            .run(id).changes;
        }
        host.prepare("DELETE FROM session WHERE id = ?").run(id);
        host.exec("COMMIT");
      } catch (err) {
        host.exec("ROLLBACK");
        fkFailures.push(`${id}: ${err.message}`);
        continue; // FK 失败即中止该 id（不删索引侧），报告后继续下一 id
      }
      // 索引侧（先宿主后索引；失败 → 残留）
      try {
        deleteIndexRows(indexDbPath, id);
      } catch {
        residue.push(id);
      }
    }
  } finally {
    host.close();
  }

  const ts = new Date(now).toISOString().replace(/[:.]/g, "-");
  let residueFile = null;
  if (residue.length > 0 && residueDir) {
    residueFile = path.join(residueDir, `w5-residue-${ts}.json`);
    fs.writeFileSync(
      residueFile,
      JSON.stringify({ schema: "w5-residue-v1", generatedAt: new Date(now).toISOString(), residueIds: residue, deletionTotal: analysis.deletionTotal }, null, 2),
    );
  }

  const credential = {
    schema: "w5-cleanup-credential-v1",
    phrase: `DELETE ${analysis.deletionTotal}`,
    operator: operator ?? os.userInfo().username,
    timestamp: new Date(now).toISOString(),
    authorizationSource,
    deletionTotal: analysis.deletionTotal,
    directCount: analysis.directCount,
    derivedCount: analysis.derivedCount,
  };
  let credentialFile = null;
  if (residueDir) {
    credentialFile = path.join(residueDir, `w5-cleanup-credential-${ts}.json`);
    fs.writeFileSync(credentialFile, JSON.stringify(credential, null, 2));
  }

  // FK 失败的 id 视作未完成删除（宿主侧仍在库）——不计入 deleted，也不并入 residue：
  // replay 只补删索引侧（其前置断言 = 宿主侧主路径已删），FK 失败 id 进 residue 会让
  // replay 删掉「宿主仍在库」会话的索引行，制造新的中间态。FK 失败经 fkFailures 单独
  // 报告（含错误消息），由操作者解依赖后重跑清理。
  const fkFailureIds = new Set(fkFailures.map((entry) => entry.split(":", 1)[0]));

  return {
    deleted: ids.filter((id) => !residue.includes(id) && !fkFailureIds.has(id)),
    residue,
    residueFile,
    credentialFile,
    credential,
    inputHistoryDeleted,
    setNullProspective,
    fkFailures,
  };
}

/** 索引侧单 id 删除（删除面 = tasks + automation_runs.session_id + tasks.forked_from_task_id）。 */
function deleteIndexRows(indexDbPath, id) {
  const idx = new DatabaseSync(indexDbPath);
  try {
    idx.exec("BEGIN");
    if (tableExists(idx, "automation_runs")) {
      idx.prepare("DELETE FROM automation_runs WHERE session_id = ?").run(id);
    }
    if (tableExists(idx, "tasks")) {
      idx.prepare("UPDATE tasks SET forked_from_task_id = NULL WHERE forked_from_task_id = ?").run(id);
      idx.prepare("DELETE FROM tasks WHERE task_id = ?").run(id);
    }
    idx.exec("COMMIT");
  } catch (err) {
    idx.exec("ROLLBACK");
    throw err;
  } finally {
    idx.close();
  }
}

// ── replay（--replay-residue；R9-4 防篡改前置断言） ────────────────────────

/**
 * 补删残留清单（只删索引侧——宿主侧在主路径已删）。前置断言：
 * ① 逐 id 形状校验（违规 → 整体拒删）；
 * ② replay 前逐 id 断言宿主行确不存在（存在 → 拒绝并提示先对齐两库备份状态，
 *    防制造「索引已删、宿主残留」反向中间态——篡改清单混入真实用户 id 在此被拦截）；
 * ③ 索引 tasks 存在性：不存在 → 过期 id，no-op 报告；
 * ④ 复用索引预检四冲突源：命中 → 跳过并报告（不删）。
 */
export function replayResidue({ residueFile, hostDbPath, indexDbPath }) {
  const parsed = JSON.parse(fs.readFileSync(residueFile, "utf8"));
  if (parsed?.schema !== "w5-residue-v1" || !Array.isArray(parsed.residueIds)) {
    return { status: "refused", reason: `残留清单 schema 不识别：${residueFile}`, deleted: [], skipped: [], noop: [] };
  }
  const ids = parsed.residueIds;

  const invalid = ids.filter((id) => typeof id !== "string" || !SESSION_ID_SHAPE.test(id));
  if (invalid.length > 0) {
    return { status: "refused", reason: `清单含形状非法 id（拒删）：${invalid.join(", ")}`, deleted: [], skipped: [], noop: invalid };
  }

  const host = new DatabaseSync(hostDbPath, { readOnly: true });
  let presentInHost;
  try {
    presentInHost = ids
      .filter((id) =>
        host.prepare("SELECT 1 FROM session WHERE id = ?").get(id) !== undefined,
      );
  } finally {
    host.close();
  }
  if (presentInHost.length > 0) {
    return {
      status: "refused",
      reason:
        `清单 id 在宿主库仍存在（拒绝，防「索引已删、宿主残留」反向中间态；请先对齐两库备份状态）：${presentInHost.join(", ")}`,
      deleted: [],
      skipped: [],
      noop: [],
    };
  }

  const idx = new DatabaseSync(indexDbPath, { readOnly: true });
  let hits;
  let stale;
  try {
    hits = indexPrecheckHits(idx, ids);
    stale = ids.filter(
      (id) => !hits.has(id) && idx.prepare("SELECT 1 FROM tasks WHERE task_id = ?").get(id) === undefined,
    );
  } finally {
    idx.close();
  }

  const deleted = [];
  for (const id of ids) {
    if (hits.has(id) || stale.includes(id)) continue;
    deleteIndexRows(indexDbPath, id);
    deleted.push(id);
  }
  return { status: "ok", deleted, skipped: [...hits], noop: stale, expectedCount: ids.length };
}

// ── 执行形态与 CLI ─────────────────────────────────────────────────────────

/** 参数解析（--plan / --confirm-count N / --replay-residue F / 路径覆盖）。 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") out.plan = true;
    else if (a === "--confirm-count") out.confirmCount = Number(argv[++i]);
    else if (a === "--replay-residue") out.replayResidue = argv[++i];
    else if (a === "--records-dir") out.recordsDir = argv[++i];
    else if (a === "--host-db") out.hostDb = argv[++i];
    else if (a === "--index-db") out.indexDb = argv[++i];
    else if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a === "--home-dir") out.homeDir = argv[++i];
    else out._.push(a);
  }
  return out;
}

/**
 * 执行形态裁决：--confirm-count 精确匹配为受控旁路；无确认参数且非 TTY → 拒绝（refuse）；
 * TTY → 交互确认（stdin 输入删除集总数）。返回值供测试注入 isTTY / stdin 断言。
 */
export function resolveExecutionMode({ confirmCount, isTTY }) {
  const destructive = true;
  if (confirmCount !== undefined) return { mode: "confirm-count", destructive };
  if (!isTTY) return { mode: "refuse", reason: "非 TTY 且无 --confirm-count：拒绝执行删除（受控旁路 = --confirm-count <删除集总数 / 清单条数>）" };
  return { mode: "interactive", destructive };
}

/**
 * 备份与停机窗口编排（R9-5/R9-6）。①③ 硬停（确定性可验证动作）；②④ 尽力检查
 * （只能证明检查时点无匹配进程）。② 的 pgrep 覆盖 zsw CLI 与其在途 app-server 子进程。
 */
export function buildPlanText({ homeDir = os.homedir(), dataDir }) {
  const host = path.join(homeDir, ...HOST_DB_SUFFIX);
  const index = path.join(homeDir, ...INDEX_DB_SUFFIX);
  const isolated = dataDir ? zcodeSessionDbPathJs(dataDir) : "<dataDir>/engines/zcode/session-db/db.sqlite（--data-dir 未提供）";
  return [
    "== 备份清单（整库快照；回滚粒度 = 整库还原，无单行回滚）==",
    `  - 宿主库三件套：${host}（+ -wal/-shm）`,
    `  - 索引库：${index}（+ -wal/-shm）`,
    `  - 隔离库：${isolated}（+ -wal/-shm；回滚面完整而纳入）`,
    "  前置：可用空间 ≥ 峰值 ≈ 9GB（备份 3GB + VACUUM ≈2×）；删行不回收磁盘，VACUUM 为可选独立步骤。",
    "== 停机窗口写者清单 ==",
    "  ① [硬停] 本仓 pi/runtime 宿主：退出 taiji 应用（Electron 主进程退出，runtime 子进程随之终止）",
    '  ② [尽力检查] zsw 在途任务：pgrep -flE "zsw|zcode.*app-server" 必须空输出；非空 → 中止窗口启动并列出全部命中进程（等其终态或由操作者按进程级精确定位处理后重跑检查）',
    "  ③ [硬停] ZCode GUI：完全退出应用",
    "  ④ [尽力检查] 用户手动终端 zcode CLI：人工确认窗口内无在途 zcode 终端会话",
    "  ②④ 只能证明检查时点无匹配进程；①③ 为确定性可验证动作。",
  ].join("\n");
}

function printAnalysis(analysis) {
  const lines = [];
  if (analysis.anomalies.length > 0) {
    lines.push("== 异常信号汇总（置顶）==");
    for (const a of analysis.anomalies) lines.push(`  ! ${a}`);
  }
  lines.push("== 四数分列（I1）==");
  lines.push(`  白名单总数：${analysis.whitelistTotal}`);
  lines.push(`  直接删除集（白名单 ∩ 宿主库，预检剔除后）：${analysis.directCount}`);
  lines.push(`  派生删除集（parent_id ∈ 直接集 且 subagent_child）：${analysis.derivedCount}`);
  lines.push(`  删除集总数：${analysis.deletionTotal}`);
  if (analysis.indexConflictHits.length > 0) {
    lines.push(`  索引冲突源命中（两侧剔除）：${analysis.indexConflictHits.join(", ")}`);
  }
  return lines.join("\n");
}

/** CLI 路径解析（显式参数 > env > 默认推导）。 */
function resolveCliPaths(args) {
  const homeDir = args.homeDir ?? os.homedir();
  const dataDir = args.dataDir ?? process.env.TAIJI_AGENT_DATA_DIR ?? path.join(homeDir, ".taiji");
  const hostDbPath = args.hostDb ?? hostZcodeDbPathJs(homeDir);
  const indexDbPath = args.indexDb ?? indexDbPathJs(homeDir);
  const recordsDir = args.recordsDir ?? path.join(dataDir, "pi", "sessions");
  return { homeDir, dataDir, hostDbPath, indexDbPath, recordsDir };
}

/**
 * replay 子命令（--replay-residue）。--confirm-count 必须提供且精确等于清单条数
 * （同主路径纪律，防陈旧/篡改清单）。
 */
function runReplayCommand(args, { hostDbPath, indexDbPath }) {
  if (args.confirmCount === undefined) {
    return { exitCode: 2, report: "replay 必须带 --confirm-count <清单条数>（同主路径纪律，防陈旧清单）" };
  }
  const parsed = JSON.parse(fs.readFileSync(args.replayResidue, "utf8"));
  const count = Array.isArray(parsed?.residueIds) ? parsed.residueIds.length : -1;
  if (args.confirmCount !== count) {
    return { exitCode: 2, report: `--confirm-count ${args.confirmCount} != 清单条数 ${count}：拒绝（防陈旧/被篡改清单）` };
  }
  const r = replayResidue({ residueFile: args.replayResidue, hostDbPath, indexDbPath });
  const code = r.status === "refused" ? 1 : 0;
  const report = [
    `replay ${args.replayResidue}`,
    `  状态：${r.status}${r.reason ? " — " + r.reason : ""}`,
    `  补删：${r.deleted.length}（${r.deleted.join(", ")}）`,
    `  冲突源命中跳过：${r.skipped.join(", ") || "无"}`,
    `  过期 no-op：${r.noop.join(", ") || "无"}`,
    `  残留清单剩余：${r.status === "ok" ? "空" : "未执行"}`,
  ].join("\n");
  return { exitCode: code, report };
}

/**
 * 删除前确认环节（interactive stdin / --confirm-count 受控旁路）。
 * 返回 { confirmed, report }：confirmed=false 时 report 为拒绝报告。
 */
async function confirmDeletion({ mode, args, analysis, stdin }) {
  if (mode.mode === "interactive") {
    const line = await readLine(stdin);
    if (line !== String(analysis.deletionTotal)) {
      return {
        confirmed: false,
        report: `${printAnalysis(analysis)}\n交互确认失败：输入与删除集总数（${analysis.deletionTotal}）不匹配，未删除任何行。`,
      };
    }
    return { confirmed: true, report: null };
  }
  if (args.confirmCount !== analysis.deletionTotal) {
    return {
      confirmed: false,
      report: `${printAnalysis(analysis)}\n--confirm-count ${args.confirmCount} != 删除集总数 ${analysis.deletionTotal}：拒绝执行。`,
    };
  }
  return { confirmed: true, report: null };
}

/** 删除后报告组装（FK 失败置顶 + 四数分列 + 删除计数 + 凭证）。 */
function formatDeletionReport(analysis, result) {
  return [
    result.fkFailures.length > 0 ? `== 异常信号汇总（置顶）==\n  FK 失败：\n  ${result.fkFailures.join("\n  ")}` : "",
    printAnalysis(analysis),
    `已删除：${result.deleted.length}；索引残留：${result.residue.length}${result.residue.length ? "（清单 " + result.residueFile + "，可 --replay-residue 补删）" : "（残留清单归空）"}`,
    `input_history 显式删除：${result.inputHistoryDeleted}`,
    `SET NULL 越行修改（Prospective）：${JSON.stringify(result.setNullProspective)}`,
    `确认凭证：${result.credentialFile}（${result.credential.phrase} / ${result.credential.operator} / ${result.credential.authorizationSource}）`,
  ].filter(Boolean).join("\n");
}

/**
 * 主路径：分析 → 确认 → 删除。分析硬校验失败（CleanupAbortError）与确认拒绝
 * 均不触达删除面。
 */
async function runDeletionFlow({ args, paths, isTTY, stdin, outDir, now }) {
  const mode = resolveExecutionMode({ confirmCount: args.confirmCount, isTTY });

  const whitelistRows = parseRecordWhitelist(paths.recordsDir);
  let analysis;
  try {
    analysis = analyze({ whitelistRows, hostDbPath: paths.hostDbPath, indexDbPath: paths.indexDbPath });
  } catch (err) {
    if (err instanceof CleanupAbortError) return { exitCode: 1, report: `== 异常信号汇总（置顶）==\n  ! ${err.report}` };
    throw err;
  }

  if (mode.mode === "refuse") {
    return { exitCode: 2, report: `${printAnalysis(analysis)}\n${mode.reason}` };
  }

  const confirmation = await confirmDeletion({ mode, args, analysis, stdin });
  if (!confirmation.confirmed) {
    return { exitCode: 2, report: confirmation.report };
  }

  const result = executeDeletion({
    analysis,
    hostDbPath: paths.hostDbPath,
    indexDbPath: paths.indexDbPath,
    residueDir: outDir,
    authorizationSource: mode.mode === "interactive" ? "interactive-stdin-confirm" : "--confirm-count",
    now,
  });
  return {
    exitCode: result.residue.length > 0 || result.fkFailures.length > 0 ? 3 : 0,
    report: formatDeletionReport(analysis, result),
  };
}

/**
 * CLI 主体（可注入 stdin/isTTY/now 供测试）。返回 {exitCode, report}，不直接 process.exit。
 */
export async function runCli({ argv = process.argv.slice(2), isTTY = process.stdin.isTTY, stdin = process.stdin, outDir = process.cwd(), now = Date.now() } = {}) {
  const args = parseArgs(argv);
  const paths = resolveCliPaths(args);

  if (args.plan) {
    return { exitCode: 0, report: buildPlanText({ homeDir: paths.homeDir, dataDir: paths.dataDir }) };
  }

  if (args.replayResidue) {
    return runReplayCommand(args, paths);
  }

  return runDeletionFlow({ args, paths, isTTY, stdin, outDir, now });
}

async function readLine(stdin) {
  const rl = stdin;
  return new Promise((resolve) => {
    let buf = "";
    rl.on("data", (c) => {
      buf += c;
      if (buf.includes("\n")) {
        rl.removeAllListeners("data");
        resolve(buf.split("\n")[0].trim());
      }
    });
    rl.once("end", () => resolve(buf.trim()));
    rl.once("close", () => resolve(buf.trim()));
  });
}

// 入口（直接执行时）
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  runCli().then(
    (r) => {
      console.log(r.report);
      process.exit(r.exitCode);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
