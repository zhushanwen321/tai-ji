// src/execution/__tests__/session-pending.test.ts
//
// readActivePendingFromSessionFile：读 session 文件算活跃后代（pending 差集）。
// 覆盖：差集、快速路径过滤、文件不存在/坏行/未回填 sessionFile。
// u-5c 迁自壳套件 src/__tests__/session-pending.test.ts（被测 module 是 core 件，
// 唯一测试覆盖原落壳——设计 §2.2 C6 / §1 目标 6）。
//
// 迁移改写：原壳版注入真实 @zhushanwen/pi-pending-notifications 计数器锚定差集
// 语义；core 依赖闭包禁 pi 系包（u-5c 验收「零跨包 specifier」），改为下方
// countActiveFromEntries 等价转写（逐字对照 extensions/universal/
// pending-notifications/src/state.ts 同名实现的两遍差集算法：先收 unregister id
// 集，再计 register 差集按 id 去重）——pi 侧算法自身由该包自有测试守卫。
//
// 合并终态（feat 容器 + dev [LC-6/T6②] 增量游标有界化增量）：
//   - 差集已由 per-file 游标内联（activeRegisters Map，见 session-pending.ts
//     PendingReadCursor）——countActiveFromEntries 端口收到的 = 活跃差集（非全量
//     行），等价转写在差集输入上幂等（unregister 行已被游标抵消，转写第一遍空
//     扫不改变结果），feat 族结果断言全部保持。
//   - 追加 [LC-6] 差集计数语义等值 + 游标剪枝两族（差集清单 listActivePending
//     FromSessionFile / prunePendingCursor 原语 / 文件删除惰性剪枝 / 端口收差集
//     口径断言）——真实 fs（临时目录）执行 offset/差集语义。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureNotifyDomain, resetNotifyDomainForTests } from "../../core/notify-ports.ts";

// [D5 消亡] listActivePendingFromSessionFile（后代补杀清单口径）随 inproc pi 引擎目录
// 删除消亡（消费方全在待删 session-runner；止损语义由 W4 监督器该放弃承接）——
// 本文件覆盖收敛为 count 口径 + 游标剪枝原语。
import {
  clearPendingCursors,
  prunePendingCursor,
  readActivePendingFromSessionFile,
} from "../assembly/session-pending.ts";

/** pi pending entries 的最小可识别形状（与 pi state.ts EntryLike 同构，运行时守卫）。 */
interface PendingEntryLike {
  customType?: unknown;
  data?: { id?: unknown } | null;
}

/**
 * countActiveFromEntries 等价转写（u-5c：core 闭包禁 pi 包 import）。
 * 算法逐字对照 @zhushanwen/pi-pending-notifications src/state.ts：
 * 两遍扫描——第一遍收 pending:unregister 的 id 集，第二遍计 pending:register
 * 中未被注销且未见过的 id（按 id 去重）。返回 { count }（端口契约拆 .count
 * 的上游形态）。
 */
function countActiveFromEntries(entries: unknown[]): { count: number } {
  const unregistered = new Set<string>();
  for (const raw of entries) {
    // S-10：entries 元素可能是 null/undefined（坏数据），断言前先守卫
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as PendingEntryLike;
    if (entry.customType !== "pending:unregister") continue;
    const data = (entry.data ?? {}) as { id?: unknown };
    if (typeof data.id === "string") unregistered.add(data.id);
  }

  const seen = new Set<string>();
  let count = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as PendingEntryLike;
    if (entry.customType !== "pending:register") continue;
    const data = (entry.data ?? {}) as { id?: unknown };
    if (typeof data.id !== "string" || unregistered.has(data.id) || seen.has(data.id)) continue;
    seen.add(data.id);
    count += 1;
  }
  return { count };
}

// 计数器经通知域窄端口注入（session-pending 不再直接 import pi-pending-notifications）
// ——注入差集计数等价实现保住差集语义回归面（真函数返回 CountActiveResult，端口
// 契约是 number（拆 .count，与 pi 壳 createPiNotifyDomainPorts 适配同构）；
// afterEach 重置防注入态泄漏。dev [LC-6] 族用 stubCountingPort 按用例覆盖
// （configureNotifyDomain 覆盖式写入，内层后执行生效）。
let sessionDir = "";

beforeEach(() => {
  configureNotifyDomain({
    countActiveFromEntries: (entries) => countActiveFromEntries(entries).count,
  });
  clearPendingCursors();
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-pending-"));
});

afterEach(() => {
  resetNotifyDomainForTests();
  clearPendingCursors();
  fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeTmpSessionFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-pending-test-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const mkRegister = (id: string, type: "subagent" | "workflow" = "subagent") =>
  JSON.stringify({ type: "custom", customType: "pending:register", data: { id, type, name: id } });

const mkUnregister = (id: string, reason = "completed", ts = "2026-08-06T08:00:00.000Z") =>
  JSON.stringify({ type: "custom", customType: "pending:unregister", data: { id, reason }, timestamp: ts });

const mkMessage = (role: string, text: string) =>
  JSON.stringify({ type: "message", id: `m-${Date.now()}-${Math.random()}`, message: { role, content: [{ type: "text", text }] } });

// ─── dev [LC-6] 族 helpers（真实 fs + entryLine 形态） ─────

function entryLine(customType: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: "custom",
    customType,
    data,
    timestamp: "2026-09-01T00:00:00.000Z",
    id: `e-${Math.random().toString(36).slice(2)}`,
  })}\n`;
}

function registerData(id: string, sessionId: string): Record<string, unknown> {
  return { id, type: "session", name: `desc-${id}`, status: "active", registeredAt: 1, expiresAt: undefined, sessionId };
}

/** 注入直数端口：返回收到的 entry 数（观察 count 口径的消费面）。 */
function stubCountingPort(): ReturnType<typeof vi.fn<(entries: unknown[]) => number>> {
  const counter = vi.fn((entries: unknown[]) => entries.length) as ReturnType<typeof vi.fn<(entries: unknown[]) => number>>;
  configureNotifyDomain({ countActiveFromEntries: counter });
  return counter;
}

describe("readActivePendingFromSessionFile", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // 清理失败不影响断言
      }
    }
  });

  it("无 pending entries → count 0", () => {
    const file = makeTmpSessionFile([mkMessage("user", "hi"), mkMessage("assistant", "hello")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: false });
  });

  it("纯 register → count = 活跃后代数", () => {
    const file = makeTmpSessionFile([mkRegister("bg-1"), mkRegister("bg-2", "workflow")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 2, recentUnregister: false });
  });

  it("register + unregister 同 id → 差集抵消", () => {
    const file = makeTmpSessionFile([mkRegister("bg-1"), mkUnregister("bg-1")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: false });
  });

  it("混合：部分注销 → 只统计仍活跃的（真实 e2e 场景：P 的 agent_end 时 explorer 未注销）", () => {
    const file = makeTmpSessionFile([
      mkRegister("bg-1"),
      mkUnregister("bg-1", "completed"),
      mkRegister("explorer-1"),
      mkMessage("assistant", "waiting for explorer..."),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });

  it("fork 继承的主 session register 已被 expired unregister 抵消 → 不干扰", () => {
    // 模拟 P fork 主 session：继承 register 且文件里已有对应 unregister 抵消行
    // （历史 session 档 U4 产物）。翻 process 档后 U4 不再补写抵消行，fork 残留的
    // 现行收口 = 读侧过滤②（见文末 [F1] describe）——本用例锁「文件内抵消行仍生效」
    // 的差集语义本身，不锁清理机制。
    const file = makeTmpSessionFile([
      mkRegister("parent-bg"),
      mkUnregister("parent-bg", "expired"),
      mkRegister("my-bg"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });

  it("坏行（截断 JSON）跳过，不影响其余判定", () => {
    const file = makeTmpSessionFile([
      '{"type":"custom","customType":"pending:register","data":{"id":"bg-1"',
      mkRegister("bg-2"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });

  it("sessionFile 未回填（undefined）→ error（调用方保守不 kill）", () => {
    const res = readActivePendingFromSessionFile(undefined);
    expect(res.count).toBe(0);
    expect(res.error).toBeDefined();
  });

  it("文件不存在 → error（调用方保守不 kill）", () => {
    const res = readActivePendingFromSessionFile("/nonexistent/path/session.jsonl");
    expect(res.count).toBe(0);
    expect(res.error).toBeDefined();
  });

  it("最近 60s 内有 unregister → recentUnregister=true（后代刚完成，唤醒在路上——竞态窗口不 kill）", () => {
    const file = makeTmpSessionFile([
      mkRegister("bg-live"),
      mkUnregister("bg-live", "completed", new Date().toISOString()),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: true });
  });

  it("unregister 在 60s 窗口外 → recentUnregister=false（正常 kill 路径）", () => {
    const file = makeTmpSessionFile([
      mkRegister("bg-live"),
      mkUnregister("bg-live", "completed", "2020-01-01T00:00:00.000Z"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: false });
  });

  // [S-4] fast-path 按值匹配而非序列化格式。旧行 `line.includes('"customType":"pending:')`
  // 耦合 pi 的 JSON 序列化空格习惯（冒号后无空格）。若 pi 改序列化（单行内冒号后加空格），
  // 旧实现全过滤 → count=0 → keep-alive 静默失效 → recursive tree 被杀、steer 丢失。
  // 本用例构造冒号后带空格的单行 JSON，验证值匹配仍命中 + 解析正确。
  it("S-4: 序列化冒号后带空格 → 仍正确解析（防 fast-path 格式耦合导致 keep-alive 静默失效）", () => {
    const file = makeTmpSessionFile([
      `{ "type": "message", "message": { "role": "user", "content": [] } }`,
      `{ "type": "custom", "customType": "pending:register", "data": { "id": "bg-1", "type": "subagent", "name": "bg-1" } }`,
      `{ "type": "custom", "customType": "pending:unregister", "data": { "id": "bg-1", "reason": "completed" }, "timestamp": "2020-01-01T00:00:00.000Z" }`,
      `{ "type": "custom", "customType": "pending:register", "data": { "id": "bg-2", "type": "subagent", "name": "bg-2" } }`,
    ]);
    tmpFiles.push(file);
    // bg-1 register+unregister 抵消，bg-2 仍活跃 → count=1。
    // 旧 fast-path（`"customType":"pending:` 冒号无空格）会跳过所有行 → count=0（静默失效）。
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });
});

// [perf] 增量游标行为：同文件重复判定（层主被多个后代唤醒 N 次 → N 次 agent_end）
// 只读上次 offset 之后的新增行，累计差集语义与全量读一致。
describe("readActivePendingFromSessionFile — 增量游标 [perf]", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-pending-incr-"));
    file = path.join(dir, "session.jsonl");
    clearPendingCursors();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("首次全量 + append 后增量：unregister 只抵消对应 id（与全量读一致）", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n" + mkRegister("d2") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(2);

    fs.appendFileSync(file, mkUnregister("d1", "completed") + "\n");
    const r = readActivePendingFromSessionFile(file);
    expect(r.error).toBeUndefined();
    expect(r.count).toBe(1);
  });

  it("EOF 半行（append 竞态）不入账，补全换行后入账", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(1);

    // 半行：无尾换行 → offset 不推进该行
    const full = mkUnregister("d1", "completed", new Date().toISOString());
    fs.appendFileSync(file, full.slice(0, full.length - 4));
    expect(readActivePendingFromSessionFile(file).count).toBe(1);

    // 补全（剩余字符 + 换行）→ 消费
    fs.appendFileSync(file, full.slice(-4) + "\n");
    const r = readActivePendingFromSessionFile(file);
    expect(r.count).toBe(0);
    expect(r.recentUnregister).toBe(true);
  });

  it("文件 truncate/重建（size 回退）→ 重置游标从头全读", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n" + mkRegister("d2") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(2);

    fs.writeFileSync(file, mkRegister("d3") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(1);
  });

  it("clearPendingCursors 后重新全量（累计 entries 不残留旧账）", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(1);
    clearPendingCursors();
    fs.appendFileSync(file, mkRegister("d2") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(2);
  });
});

// ─── [LC-6/T6②] 差集计数语义等值 + 游标剪枝（dev 增量） ────

describe("[LC-6] 差集计数语义等值", () => {
  it("register−unregister 差集：unregister 后 count/list 归零", () => {
    const counter = stubCountingPort();
    const f = path.join(sessionDir, "a.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        entryLine("pending:register", registerData("bg-2", "sess-2")) +
        entryLine("pending:unregister", { id: "bg-1" }),
    );

    const r = readActivePendingFromSessionFile(f);
    expect(r.error).toBeUndefined();
    expect(r.count).toBe(1); // 2 register − 1 unregister
    expect(counter.mock.calls[0]?.[0]).toHaveLength(1); // 端口收到差集（非全量 3 行）
    expect((counter.mock.calls[0]?.[0] as unknown[])[0]).toMatchObject({ customType: "pending:register" });
  });

  it("同 id 重 register（未 unregister）覆盖 → 仍 1 个活跃", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "b.jsonl");
    fs.writeFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1")));
    fs.appendFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1-moved")));

    expect(readActivePendingFromSessionFile(f).count).toBe(1);
  });

  it("unregister 后同 id 再 register → 恢复活跃", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "c.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        entryLine("pending:unregister", { id: "bg-1" }) +
        entryLine("pending:register", registerData("bg-1", "sess-2")),
    );

    expect(readActivePendingFromSessionFile(f).count).toBe(1);
  });

  it("latestUnregister 60s 唤醒窗口判据不受差集化影响", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "d.jsonl");
    const nowIso = new Date().toISOString();
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        JSON.stringify({
          type: "custom",
          customType: "pending:unregister",
          data: { id: "bg-1" },
          timestamp: nowIso,
          id: "e-unreg",
        }) +
        "\n",
    );

    const r = readActivePendingFromSessionFile(f);
    expect(r.count).toBe(0); // 差集归零
    expect(r.recentUnregister).toBe(true); // unregister 时刻仍被游标记录（唤醒窗口语义保持）
  });

  it("缺 data.id 的畸形 pending 行丢弃，不影响其余差集", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "e.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", {}) + // 畸形：无 id
        entryLine("pending:register", registerData("bg-2", "sess-2")),
    );

    expect(readActivePendingFromSessionFile(f).count).toBe(1); // 畸形行丢弃，好行入差集
  });
});

describe("[LC-6] 游标剪枝", () => {
  it("文件删除后 cursor 自动剪枝：重建同名文件从头全量读（不残留旧 offset）", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "reborn.jsonl");
    // 第一代：15 字节/行 × 10 行 filler → cursor offset = 150
    const gen1 = Array.from({ length: 10 }, (_, i) => `filler-line-${String(i).padStart(2, "0")}\n`).join("");
    fs.writeFileSync(f, gen1);
    expect(readActivePendingFromSessionFile(f).count).toBe(0);

    // 删除后的一次判定触发剪枝（stat ENOENT → cursors.delete，惰性剪枝语义）。
    fs.unlinkSync(f);
    const duringAbsent = readActivePendingFromSessionFile(f);
    expect(duringAbsent.error).toBeDefined();

    // 重建同名文件：新内容 size > 旧 offset（150），bg-x 的 register 行落在旧 offset
    // 之内——cursor 未剪枝时会从 byte 150 续读漏掉它。
    const gen2 =
      entryLine("pending:register", registerData("bg-x", "sess-x")) +
      "filler".padEnd(200, ".") +
      "\n";
    expect(Buffer.byteLength(gen2, "utf-8")).toBeGreaterThan(150);
    fs.writeFileSync(f, gen2);

    expect(readActivePendingFromSessionFile(f).count).toBe(1); // 剪枝生效：从头全量读
  });

  it("prunePendingCursor：回收后重新判定等值（全量重读差集不变）", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "pruned.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        entryLine("pending:register", registerData("bg-2", "sess-2")),
    );
    expect(readActivePendingFromSessionFile(f).count).toBe(2);

    prunePendingCursor(f); // 进程 close 侧回收

    fs.appendFileSync(f, entryLine("pending:unregister", { id: "bg-1" }));
    const r = readActivePendingFromSessionFile(f);
    expect(r.count).toBe(1); // 重建后差集正确（无重复无丢失）
  });

  it("prunePendingCursor：prune 后覆写文件（size ≥ 旧 offset）→ 新内容完整可见", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "overwritten.jsonl");
    const gen1 = Array.from({ length: 10 }, (_, i) => `filler-line-${String(i).padStart(2, "0")}\n`).join("");
    fs.writeFileSync(f, gen1);
    readActivePendingFromSessionFile(f); // offset = 160

    const gen2 =
      entryLine("pending:register", registerData("bg-y", "sess-y")) +
      "filler".padEnd(200, ".") +
      "\n";
    fs.writeFileSync(f, gen2); // 覆写（模拟文件替换），size > 旧 offset
    prunePendingCursor(f);

    expect(readActivePendingFromSessionFile(f).count).toBe(1);
  });

  it("prunePendingCursor 不存在的条目为 no-op（不抛错）", () => {
    expect(() => prunePendingCursor(path.join(sessionDir, "never-seen.jsonl"))).not.toThrow();
  });

  it("读失败（文件不存在）→ error 面返回且 cursor 已剪（后续可全量重建）", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "vanish.jsonl");
    fs.writeFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1")));
    expect(readActivePendingFromSessionFile(f).count).toBe(1);

    fs.unlinkSync(f);
    const r = readActivePendingFromSessionFile(f); // 剪枝触发点（stat ENOENT）
    expect(r.error).toBeDefined();
    expect(r.count).toBe(0);

    // 重建后从文件头判定（无 offset 残留），条目完整恢复
    fs.writeFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1")));
    expect(readActivePendingFromSessionFile(f).count).toBe(1);
  });
});

// ─── [F1 读侧过滤②] 跨 session 残留基准 = 被读文件所属 session ───
//
// fork 继承的父级 register 残留（翻 process 档后 U4 补注销不再中性化，永久留存）
// 由读侧过滤收口：本文件读侧以「被读文件所属 session id」（pi session 文件首行
// SessionHeader.id）为基准经端口第二参传入，端口实现按 entry sessionId ≠ 基准
// 跳过——后代判定差集不含跨 session 残留，层主不被残留误判「尚有活跃后代」。

describe("[F1 读侧过滤②] 后代判定差集的跨 session 残留基准", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // 清理失败不影响断言
      }
    }
  });

  /** pi session 文件首行 SessionHeader（session-manager.js newSession 形态）。 */
  const mkSessionHeader = (sessionId: string) =>
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp" });

  /** 带 sessionId 的 register（pending-notifications listener 落盘形态）。 */
  const mkRegisterIn = (id: string, sessionId: string) =>
    JSON.stringify({ type: "custom", customType: "pending:register", data: { id, type: "subagent", name: id, registeredAt: 1, sessionId } });

  /** 端口等价实现（消费基准）：按 currentSessionId 过滤后直数——pending-notifications
   *  filterActiveRegisters 的最小转写（缺 sessionId 的旧形态条目视为本 session，不过滤）。 */
  function filteredCountingPort(): ReturnType<typeof vi.fn<(entries: unknown[], opts?: { currentSessionId?: string }) => number>> {
    const counter = vi.fn((entries: unknown[], opts?: { currentSessionId?: string }) => {
      const seen = new Set<string>();
      let count = 0;
      for (const raw of entries) {
        if (!raw || typeof raw !== "object") continue;
        const data = (raw as { data?: { id?: unknown; sessionId?: unknown } }).data ?? {};
        if (typeof data.id !== "string" || seen.has(data.id)) continue;
        seen.add(data.id);
        if (
          opts?.currentSessionId !== undefined &&
          typeof data.sessionId === "string" &&
          data.sessionId !== opts.currentSessionId
        ) {
          continue;
        }
        count += 1;
      }
      return count;
    }) as ReturnType<typeof vi.fn<(entries: unknown[], opts?: { currentSessionId?: string }) => number>>;
    configureNotifyDomain({ countActiveFromEntries: counter });
    return counter;
  }

  it("带 session header 的文件 → 端口收到的基准 = header.id（被读文件所属 session）", () => {
    const counter = filteredCountingPort();
    const file = makeTmpSessionFile([
      mkSessionHeader("sess-child"),
      mkRegisterIn("bg-own", "sess-child"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file).count).toBe(1);
    const call = counter.mock.calls[0] as unknown[];
    expect(call[1]).toEqual({ currentSessionId: "sess-child" });
  });

  it("端到端：fork 继承的父级 register 残留（sessionId = 父 session）不进后代判定差集", () => {
    filteredCountingPort();
    // 子 session 文件 = header(sess-child) + fork 继承的父级注册残留 + 子进程自己的注册
    const file = makeTmpSessionFile([
      mkSessionHeader("sess-child"),
      mkRegisterIn("bg-parent", "sess-parent"),
      mkRegisterIn("wf-parent", "sess-parent"),
      mkRegisterIn("bg-own", "sess-child"),
    ]);
    tmpFiles.push(file);
    // 无读侧过滤时差集为 3（层主误判「尚有活跃后代」空等）；过滤后只数本 session = 1
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });

  it("无 session header（旧 fixture 形态）→ 基准 undefined = 不过滤（向后兼容）", () => {
    const counter = filteredCountingPort();
    const file = makeTmpSessionFile([
      mkRegisterIn("bg-parent", "sess-parent"),
      mkRegisterIn("bg-own", "sess-child"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file).count).toBe(2);
    const call = counter.mock.calls[0] as unknown[];
    expect(call[1]).toBeUndefined();
  });

  it("增量读（cursor 已热）时基准仍从 cursor 缓存透传（不依赖重读首行）", () => {
    const counter = filteredCountingPort();
    const file = makeTmpSessionFile([
      mkSessionHeader("sess-child"),
      mkRegisterIn("bg-own", "sess-child"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file).count).toBe(1); // 首读建 cursor
    // 追加新 register 后增量读——offset > 0 不重读首行，基准取 cursor 缓存
    fs.appendFileSync(file, mkRegisterIn("bg-own-2", "sess-child") + "\n", "utf-8");
    expect(readActivePendingFromSessionFile(file).count).toBe(2);
    const lastCall = counter.mock.calls[counter.mock.calls.length - 1] as unknown[];
    expect(lastCall[1]).toEqual({ currentSessionId: "sess-child" });
  });
});
