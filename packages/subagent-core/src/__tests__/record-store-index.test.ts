// src/__tests__/record-store-index.test.ts
//
// [perf L-1] sessions-index.json（RecordStore 冷扫描索引）的模块级 + 集成级行为测试。
//
// 覆盖（S1TC1-13）：
//   S1TC1  C1  索引命中零探测（chmod 000 后新实例首扫仍返回全部记录）
//   S1TC2  C2  戳不匹配单文件重探测（append 续聊 identity），其余零读取，条目更新
//   S1TC3  C3  索引损坏回退全扫 + 重写自愈（无 console.error）
//   S1TC4  C4  version:999（高于自身）整体忽略且不重写（内容与 mtime 均不变）
//   S1TC4B C4b version:0（低于自身）整体丢弃，本轮 dirty 重写为当前版本
//   S1TC5  C5  负条目命中——无 identity 的 junk 文件跨实例零重读（mtime 不变）
//   S1TC6  C6  索引落 dirname(sessionsDir) 且写后 L0 快路径不失效
//   S1TC7  C7  双实例顺序共享——A 落盘后 B 首次扫描零探测
//   S1TC8  C8  落盘无 .tmp. 残留且产物可被下次加载完整消费
//   S1TC9      节流：60s 最小间隔窗内不写、过窗后 dirty 才写
//   S1TC10     模块级 loadIndex/saveIndex roundtrip
//   S1TC11     模块级 loadIndex 三级校验链与版本分支
//   S1TC12     模块级单条目字段损坏仅丢弃该条目
//   S1TC13     dispose→revive 后重扫惰性重载索引命中
//   S1TC14     索引命中 + .cancelled sidecar 冷启动——命中分支读取 tombstone 置 closed
//
// 异步落盘等待约定：断言「写完成」用 vi.waitFor(existsSync/内容)（rename 原子性保证
// 文件出现即完整）；断言「未写」用 bounded settle（50ms 检测窗口——正确实现的写决策
// 在 collectRecords 同步段已被排除，窗口内不会有任何写发生）；禁止固定长 sleep 等
// 待写完成。例外：S1TC9 fake Date 模式下 vi.waitFor 会推进 fake 时钟破坏时间线，
// 改用手写轮询 settleUntil（真实 setTimeout，仅计数限界）。
//
// 清理约定：真实 jsonl fixture 的 afterEach rmSync 必带 maxRetries（fire-and-forget
// 索引写与清理的 ENOTEMPTY 竞态，见 get-record-for-action-restart.test.ts）。
//
// 环境守卫约定：chmod 000 零探测用例（S1TC1/2/7/13）用 chmodProbeIt——win32 的
// chmod 000 仅映射 read-only、root 无视 000，断言会静默退化为恒真，须跳过。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordStore } from "../execution/persistence/record-store";
import { INDEX_FILENAME, INDEX_VERSION, loadIndex, saveIndex } from "../execution/persistence/sessions-index";
import type { SessionsIndexEntry, SessionsIndexNegativeEntry } from "../execution/persistence/sessions-index";

/** chmod 000 零探测用例的环境守卫：win32 上 chmod 000 仅映射 read-only（读仍被允许）、
 *  root 无视 000——两种环境下「零内容读取」断言静默退化为恒真（实现退化回读也不失败），
 *  跳过防假绿。平台短路在前，getuid 仅 POSIX 存在。 */
const chmodProbeIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

/** bounded 轮询：真实 setTimeout（20ms/轮），rounds 上限防挂死。fake Date 模式专用
 *  （vi.waitFor 在 fake timers 下会 advanceTimersByTime 推进 fake Date，破坏节流时间线）。
 *  预算 10s：全量并行跑时机器高负载，fire-and-forget 落盘链（含 fsync）可能远慢于平时。 */
async function settleUntil(cond: () => boolean, rounds = 500): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!cond()) throw new Error("settleUntil: condition not met within bounded rounds");
}

// ============================================================
// 模块级（不经 RecordStore）
// ============================================================

describe("sessions-index 模块（S1TC10-12）", () => {
  let encDir: string;
  let indexPath: string;

  beforeEach(() => {
    encDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-index-mod-"));
    indexPath = path.join(encDir, INDEX_FILENAME);
  });

  afterEach(() => {
    fs.rmSync(encDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 合法正条目模板（字段值任意但类型齐全）。 */
  function positiveEntry(over: Partial<SessionsIndexEntry> = {}): SessionsIndexEntry {
    return {
      mtimeMs: 111,
      size: 222,
      slug: "t",
      id: "sa-1",
      agent: "worker",
      mode: "background",
      task: "test task",
      startedAt: 1000,
      rootSessionId: "root-1",
      parentRecordId: undefined,
      depth: 0,
      model: "provider/model",
      thinkingLevel: undefined,
      ...over,
    };
  }

  it("S1TC10: loadIndex/saveIndex roundtrip——正/负条目与 model 空串完整往返、无 .tmp. 残留", async () => {
    const entries = new Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>([
      // model 空串：尾部探测（readIdentityTail）拿不到 model_change 的合法结果，不当损坏（DS4）
      ["a.jsonl", positiveEntry({ model: "" })],
      ["junk.jsonl", { negative: true, mtimeMs: 1, size: 2 }],
      // undefined 可选字段：JSON 序列化丢弃，往返保持 undefined
      ["b.jsonl", positiveEntry({ id: "sa-2", rootSessionId: undefined, thinkingLevel: undefined })],
    ]);
    await saveIndex(encDir, { entries });

    const loaded = loadIndex(encDir);
    expect(loaded.higherVersion).toBe(false);
    expect(loaded.entries.size).toBe(3);
    expect(loaded.entries.get("a.jsonl")).toEqual(entries.get("a.jsonl"));
    expect(loaded.entries.get("junk.jsonl")).toEqual({ negative: true, mtimeMs: 1, size: 2 });
    expect(loaded.entries.get("b.jsonl")).toEqual(entries.get("b.jsonl"));

    // 正常路径无 .tmp. 残留（rename 成功消费 tmp）
    expect(fs.readdirSync(encDir)).toEqual([INDEX_FILENAME]);
  });

  it("S1TC11: loadIndex 三级校验链与版本分支——永不抛，高版本整体忽略", () => {
    // ① 空 encDir（无文件）② 非法 JSON ③ 顶层结构不符（entries 数组 / version 缺失）
    // ⑤ version 低于自身 → 均为 {entries: 空, higherVersion: false}
    expect(loadIndex(encDir)).toEqual({ entries: new Map(), higherVersion: false }); // ①

    fs.writeFileSync(indexPath, "{{{"); // ②
    expect(loadIndex(encDir).entries.size).toBe(0);
    expect(loadIndex(encDir).higherVersion).toBe(false);

    fs.writeFileSync(indexPath, JSON.stringify({ version: 1, pid: 1, entries: [1, 2] })); // ③a 数组非 object
    expect(loadIndex(encDir).entries.size).toBe(0);
    expect(loadIndex(encDir).higherVersion).toBe(false);

    fs.writeFileSync(indexPath, JSON.stringify({ pid: 1, entries: {} })); // ③b version 缺失
    expect(loadIndex(encDir).entries.size).toBe(0);
    expect(loadIndex(encDir).higherVersion).toBe(false);

    // ④ version:999（高于自身）：空 Map + higherVersion:true——即使 entries 合法也不消费
    fs.writeFileSync(indexPath, JSON.stringify({ version: 999, pid: 1, entries: { "a.jsonl": positiveEntry() } }));
    const higher = loadIndex(encDir);
    expect(higher.entries.size).toBe(0);
    expect(higher.higherVersion).toBe(true);

    // ⑤ version:0（低于自身）：整体丢弃 → 空索引可写（下轮 dirty 重写自愈）
    fs.writeFileSync(indexPath, JSON.stringify({ version: 0, pid: 1, entries: { "a.jsonl": positiveEntry() } }));
    expect(loadIndex(encDir)).toEqual({ entries: new Map(), higherVersion: false });
  });

  it("S1TC12: 单条目字段损坏仅丢弃该条目，其余条目正常保留", () => {
    const good = positiveEntry();
    const raw: Record<string, unknown> = {
      good,
      badTask: { ...good, task: 123 }, // task 为 number
      badMode: { ...good, mode: "async" }, // mode 越界
      noStamp: { ...good, mtimeMs: undefined, size: undefined }, // 缺戳字段（JSON 化后缺失）
      badNeg: { negative: true, mtimeMs: 1 }, // 负条目缺 size
    };
    fs.writeFileSync(indexPath, JSON.stringify({ version: 1, pid: 1, entries: raw }));

    const loaded = loadIndex(encDir);
    expect(loaded.entries.size).toBe(1); // 单条目损坏不放大为整体失效
    expect(loaded.entries.get("good")).toEqual(good);
  });
});

// ============================================================
// 集成级（经 RecordStore）
// ============================================================

describe("RecordStore 索引接入 [perf L-1]（S1TC1-9/13）", () => {
  let rootDir: string;
  let sessionsDir: string;
  let encDir: string;
  let indexPath: string;

  beforeEach(() => {
    // 两层布局（对齐生产 <enc> 段结构）：索引落 dirname(sessionsDir)=rootDir
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-index-"));
    sessionsDir = path.join(rootDir, "sessions");
    fs.mkdirSync(sessionsDir);
    encDir = path.dirname(sessionsDir);
    indexPath = path.join(encDir, INDEX_FILENAME);
  });

  afterEach(() => {
    // 恢复权限以防 tmp 清理失败（chmod 000 用例会留下不可读文件/目录）
    try { fs.chmodSync(sessionsDir, 0o755); } catch { /* best-effort */ }
    for (const f of fs.readdirSync(sessionsDir)) {
      try { fs.chmodSync(path.join(sessionsDir, f), 0o644); } catch { /* best-effort */ }
    }
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 构造一个 session.jsonl（header + identity + N 条 assistant message）。复刻
   *  record-store-cache.test.ts 的 writeSession 形态。 */
  function writeSession(opts: {
    name: string;
    id: string;
    agent?: string;
    startedAt?: number;
    rootSessionId?: string;
    assistantTexts?: string[];
  }): string {
    const file = path.join(sessionsDir, opts.name);
    const lines: unknown[] = [
      { type: "session", id: "sess" },
      {
        type: "custom",
        customType: "subagent-identity",
        data: {
          id: opts.id,
          agent: opts.agent ?? "worker",
          mode: "background",
          task: "test task",
          startedAt: opts.startedAt ?? 1000,
          rootSessionId: opts.rootSessionId ?? "root-1",
          depth: 0,
        },
      },
    ];
    for (const text of opts.assistantTexts ?? []) {
      lines.push({
        type: "message",
        timestamp: "2026-08-14T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          usage: { input: 10, output: 5 },
          stopReason: "stop",
          timestamp: 2000,
        },
      });
    }
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  /** 续聊形态 session：头部 >64KB padding（identity 被推出头部窗口），identity 在尾部附近。
   *  复刻 record-store-cache.test.ts B5 用例的构造（readIdentityTail 主力命中形态）。 */
  function writeTailIdentitySession(name: string, id: string, task: string): string {
    const file = path.join(sessionsDir, name);
    const lines = [
      JSON.stringify({ type: "session", id: "sess" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(70000), timestamp: 1000 } }),
      JSON.stringify({
        type: "custom",
        customType: "subagent-identity",
        data: { id, agent: "worker", mode: "background", task, slug: "tail", startedAt: 1000, rootSessionId: "root-1", depth: 0 },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-14T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "out" }], usage: { input: 1, output: 1 }, stopReason: "stop", timestamp: 2000 },
      }),
    ];
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  /** 无 identity 的 junk 文件（仅 session header）。复刻 record-store-cache.test.ts 构造。 */
  function writeJunk(name: string): string {
    const file = path.join(sessionsDir, name);
    fs.writeFileSync(file, JSON.stringify({ type: "session", id: "sess2" }) + "\n");
    return file;
  }

  /** 等待索引文件落盘（rename 原子性保证出现即完整）。 */
  async function waitForIndex(): Promise<void> {
    await vi.waitFor(() => {
      if (!fs.existsSync(indexPath)) throw new Error("sessions-index not written yet");
    }, { timeout: 8_000 });
  }

  chmodProbeIt("S1TC1: 索引命中零探测——chmod 000 后新 RecordStore 首次 collectRecords 仍返回全部记录", { timeout: 15_000 }, async () => {
    const f1 = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });

    const storeA = new RecordStore(sessionsDir);
    storeA.collectRecords(100, "all", "root-1");
    await waitForIndex();

    // 去读权限：statSync 仍可用（戳 mtimeMs/size 不变 → 索引条目仍命中），readFileSync/
    // openSync 失败——若实现退化回读文件，readIdentityHeader 捕获异常返回 undefined → sa-1 消失。
    fs.chmodSync(f1, 0o000);
    const storeB = new RecordStore(sessionsDir);
    const records = storeB.collectRecords(100, "all", "root-1");
    expect(records.map((r) => r.id).sort()).toEqual(["sa-1", "sa-2"]);
    const sa1 = records.find((r) => r.id === "sa-1");
    expect(sa1?.agent).toBe("worker");
    expect(sa1?.task).toBe("test task");
    expect(sa1?.startedAt).toBe(1000);
    fs.chmodSync(f1, 0o644);
  });

  chmodProbeIt("S1TC2: 戳不匹配单文件重探测——append 后仅该文件重探测、其余零读取、索引条目更新", { timeout: 15_000 }, async () => {
    // a.jsonl 续聊形态（identity 在尾部）：append 新 identity 后 readIdentityTail 重探测
    // 取最后一条 → task 更新为 "resumed"（若从头部取第一条 identity 则拿到旧值，断言失败）。
    const fA = writeTailIdentitySession("a.jsonl", "sa-1", "initial");
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });

    const storeA = new RecordStore(sessionsDir);
    storeA.collectRecords(100, "all", "root-1");
    await waitForIndex();

    // append 新 subagent-identity entry（模拟续聊，size 必变 → 索引戳不匹配）
    fs.appendFileSync(
      fA,
      JSON.stringify({
        type: "custom",
        customType: "subagent-identity",
        data: { id: "sa-1", agent: "worker", mode: "background", task: "resumed", slug: "tail", startedAt: 1000, rootSessionId: "root-1", depth: 0 },
      }) + "\n",
    );
    // b.jsonl 戳未变 → 应索引命中零读取（退化回读则消失）
    fs.chmodSync(path.join(sessionsDir, "b.jsonl"), 0o000);

    const bBefore = loadIndex(encDir).entries.get("b.jsonl");
    const storeB = new RecordStore(sessionsDir);
    const records = storeB.collectRecords(100, "all", "root-1");
    expect(records.find((r) => r.id === "sa-1")?.task).toBe("resumed"); // a 重探测取尾部 identity
    expect(records.map((r) => r.id).sort()).toEqual(["sa-1", "sa-2"]); // b 索引命中仍在

    // 探测结果写回索引：a 条目戳对齐当前 stat 且 task="resumed"；b 条目未被触碰
    await vi.waitFor(() => {
      const e = loadIndex(encDir).entries.get("a.jsonl");
      if (e === undefined || e.negative === true || e.task !== "resumed") throw new Error("a entry not rewritten yet");
    }, { timeout: 8_000 });
    const aEntry = loadIndex(encDir).entries.get("a.jsonl");
    const aStat = fs.statSync(fA);
    expect(aEntry?.mtimeMs).toBe(aStat.mtimeMs);
    expect(aEntry?.size).toBe(aStat.size);
    expect(loadIndex(encDir).entries.get("b.jsonl")).toEqual(bBefore); // 单文件失效不波及邻居
  });

  it("S1TC3: 索引损坏回退全扫 + 重写自愈", { timeout: 15_000 }, async () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
    fs.writeFileSync(indexPath, "{not valid json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = new RecordStore(sessionsDir);
    const records = store.collectRecords(100, "all", "root-1");
    expect(records.map((r) => r.id).sort()).toEqual(["sa-1", "sa-2"]); // 空索引=今天的全量行为

    await vi.waitFor(() => {
      JSON.parse(fs.readFileSync(indexPath, "utf-8")); // 轮询索引变合法（损坏→空索引→全扫 dirty→重写自愈）
    }, { timeout: 8_000 });
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { version?: number; entries: Record<string, unknown> };
    expect(parsed.version).toBe(INDEX_VERSION);
    expect(Object.keys(parsed.entries).sort()).toEqual(["a.jsonl", "b.jsonl"]);
    expect(errSpy).not.toHaveBeenCalled(); // 损坏走 debug 日志（PI_EXT_DEBUG=1 可见），不 console.error
    errSpy.mockRestore();
  });

  it("S1TC4: version:999（高于自身）整体忽略且不重写——内容与 mtime 均不变", async () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
    fs.writeFileSync(indexPath, JSON.stringify({ version: 999, pid: 1, entries: {} }));
    const before = { content: fs.readFileSync(indexPath, "utf-8"), mtimeMs: fs.statSync(indexPath).mtimeMs };

    const store = new RecordStore(sessionsDir);
    const records = store.collectRecords(100, "all", "root-1");
    expect(records.map((r) => r.id).sort()).toEqual(["sa-1", "sa-2"]); // 空索引全量探测，结果正确

    await new Promise((r) => setTimeout(r, 50)); // bounded settle：正确实现从 collectRecords 返回起就永不发起写
    expect(fs.readFileSync(indexPath, "utf-8")).toBe(before.content); // 磁盘内容逐字节不动
    expect(fs.statSync(indexPath).mtimeMs).toBe(before.mtimeMs); // mtime 不动（高版本只忽略不重写）
  });

  it("S1TC4B: version:0（低于自身）整体丢弃，本轮 dirty 重写为 v1", { timeout: 15_000 }, async () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
    fs.writeFileSync(indexPath, JSON.stringify({ version: 0, pid: 1, entries: {} }));

    const store = new RecordStore(sessionsDir);
    const records = store.collectRecords(100, "all", "root-1");
    expect(records.map((r) => r.id).sort()).toEqual(["sa-1", "sa-2"]);

    await vi.waitFor(() => {
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { version?: number };
      if (parsed.version !== INDEX_VERSION) throw new Error("index not rewritten to current version yet");
    }, { timeout: 8_000 });
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(Object.keys(parsed.entries).sort()).toEqual(["a.jsonl", "b.jsonl"]); // 低版本丢弃→全扫 dirty→重写自愈
  });

  it("S1TC5: 负条目命中——无 identity 的 junk 文件跨实例零重读", { timeout: 15_000 }, async () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    writeJunk("junk.jsonl");

    const storeA = new RecordStore(sessionsDir);
    storeA.collectRecords(100, "all", "root-1");
    await waitForIndex();

    const negEntry = loadIndex(encDir).entries.get("junk.jsonl");
    expect(negEntry).toEqual({ negative: true, mtimeMs: expect.any(Number), size: expect.any(Number) }); // 负缓存持久化

    const before = fs.statSync(indexPath).mtimeMs;
    const storeB = new RecordStore(sessionsDir);
    const records = storeB.collectRecords(100, "all", "root-1");
    expect(records.map((r) => r.id)).toEqual(["sa-1"]); // junk 无 identity 本就不产记录；a 命中在

    await new Promise((r) => setTimeout(r, 50));
    expect(fs.statSync(indexPath).mtimeMs).toBe(before); // B 全命中零探测→不 dirty→不写（负条目命中失效则 junk 重探测→dirty→重写→mtime 变）
  });

  it("S1TC6: 索引落 dirname(sessionsDir) 且写后 L0 快路径不失效", { timeout: 15_000 }, async () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
    const store = new RecordStore(sessionsDir); // 不挂 manifestStore：排除 listAllSync 的 readdir 干扰

    const first = store.collectRecords(100, "all", "root-1");
    await waitForIndex();

    // 兄弟位置三佐证之 readdir 过滤：索引在 root（dirname(sessionsDir)）不在 sessionsDir 内部
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.readdirSync(sessionsDir)).not.toContain(INDEX_FILENAME);

    // L0 快路径观测：chmod 000 sessionsDir 目录——statSync 仍可用（目录 mtime 不变 → 快路径
    // 判定成立），readdirSync EACCES 失败（慢路径 return [] → 0 条）。二次 collectRecords 仍
    // 返回全部记录 = readdir 被跳过 = 索引写入未改 sessionsDir 目录 mtime。
    // （原设计 spyOn(fs,"readdirSync") 在 ESM 模块命名空间不可配置，改用等价行为观测。）
    fs.chmodSync(sessionsDir, 0o000);
    try {
      const second = store.collectRecords(100, "all", "root-1");
      expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
      expect(second).toHaveLength(2);
    } finally {
      fs.chmodSync(sessionsDir, 0o755);
    }
  });

  chmodProbeIt("S1TC7: 双实例顺序共享——A 落盘后 B 首次扫描零探测", { timeout: 15_000 }, async () => {
    const fa = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    const fb = writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
    const fj = writeJunk("junk.jsonl");

    const storeA = new RecordStore(sessionsDir);
    const recordsA = storeA.collectRecords(100, "all", "root-1");
    await waitForIndex();

    fs.chmodSync(fa, 0o000);
    fs.chmodSync(fb, 0o000);
    fs.chmodSync(fj, 0o000);
    const before = fs.statSync(indexPath).mtimeMs;

    const storeB = new RecordStore(sessionsDir);
    const recordsB = storeB.collectRecords(100, "all", "root-1");
    const project = (rs: typeof recordsA) =>
      rs.map((r) => `${r.id}|${r.agent}|${r.task}|${r.startedAt}|${r.rootSessionId}|${r.status}`).sort();
    expect(project(recordsB)).toEqual(project(recordsA)); // 正+负条目全命中零读取

    await new Promise((r) => setTimeout(r, 50));
    expect(fs.statSync(indexPath).mtimeMs).toBe(before); // B 零探测未发起写（顺序共享语义）
  });

  it("S1TC8: 落盘无 .tmp. 残留且产物可被下次加载完整消费", { timeout: 15_000 }, async () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
    writeJunk("junk.jsonl");

    const storeA = new RecordStore(sessionsDir);
    const recordsA = storeA.collectRecords(100, "all", "root-1");
    await waitForIndex();

    const files = fs.readdirSync(encDir);
    expect(files.some((f) => f.includes(".tmp."))).toBe(false); // 正常路径 rename 成功消费 tmp

    const loaded = loadIndex(encDir);
    expect(loaded.higherVersion).toBe(false);
    expect(loaded.entries.size).toBe(3); // 2 正 + 1 负，快照完整
    const aEntry = loaded.entries.get("a.jsonl");
    if (aEntry === undefined || aEntry.negative === true) throw new Error("a.jsonl should be a positive entry");
    expect(aEntry.id).toBe(recordsA.find((r) => r.id === "sa-1")?.id);
    expect(aEntry.task).toBe("test task");
    expect(aEntry.model).toBe(""); // 头部探测拿不到 model_change → 空串（DS4 合法）
  });

  it("S1TC9: 节流——60s 最小间隔窗内不写、过窗后 dirty 才写", { timeout: 30_000 }, async () => {
    // 仅 fake Date（setTimeout/轮询走真实时钟不冲突）；RecordStore 节流判定与
    // lastIndexWriteAt 全走 Date.now()（先例 worktree-pid-registration.integration.test.ts）。
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    vi.setSystemTime(T0);
    try {
      const store = new RecordStore(sessionsDir);

      // 第一段：首扫必写（lastIndexWriteAt=0 过节流窗），索引含 a
      writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
      store.collectRecords(100, "all", "root-1");
      // settle 必须等「节流打戳完成」而非仅「文件出现」：打戳在 saveIndex 成功 .then 里
      // 异步推进（rename → 目录 fsync 的 open/sync/close → resolve 之后），高负载下可能
      // 晚于文件出现。若先推进 fake 时钟，打戳读到推进后的 Date.now()（T0+30s）→ 节流
      // 基准被污染 → 第三段永判窗内 → settle 超时（全量并行偶发失败的根因）。打戳无
      // 公共 API 可观测，轮询软私有字段本身（Reflect.get + typeof guard，免类型断言）；
      // 比固定空转轮数（目录 fsync 的 IO 完成时间无上界）这是确定性等待。
      await settleUntil(() => {
        const stamped = Reflect.get(store, "lastIndexWriteAt");
        return fs.existsSync(indexPath) && typeof stamped === "number" && stamped > 0;
      });
      expect(loadIndex(encDir).entries.get("a.jsonl")).toBeDefined();

      // 第二段：T0+30s（距成功写 30s < 60s）新文件 b → 慢路径 → b 探测 dirty，但窗内不写
      writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
      vi.setSystemTime(T0 + 30_000);
      store.collectRecords(100, "all", "root-1");
      await settleUntil(() => loadIndex(encDir).entries.get("a.jsonl") !== undefined); // 稳定基线
      expect(loadIndex(encDir).entries.get("b.jsonl")).toBeUndefined(); // 节流窗内 dirty 扫描不落盘

      // 第三段：T0+61s（过窗）新文件 c → dirty → 写入全量快照（含 b 与 c）
      writeSession({ name: "c.jsonl", id: "sa-3", assistantTexts: ["r3"] });
      vi.setSystemTime(T0 + 61_000);
      store.collectRecords(100, "all", "root-1");
      await settleUntil(() => {
        const e = loadIndex(encDir).entries;
        return e.get("b.jsonl") !== undefined && e.get("c.jsonl") !== undefined;
      });
      expect(loadIndex(encDir).entries.get("a.jsonl")).toBeDefined(); // 全量快照含全部最新探测结果
    } finally {
      vi.useRealTimers();
    }
  });

  chmodProbeIt("S1TC13: dispose→revive 后重扫惰性重载索引命中（/resume /fork 高频路径）", { timeout: 15_000 }, async () => {
    const fa = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });
    const fb = writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });
    const store = new RecordStore(sessionsDir);
    store.collectRecords(100, "all", "root-1");
    await waitForIndex();

    store.dispose(); // 清 fileCache/dirStamp/索引字段重置为初始值
    store.revive(); // 不预载索引：revive 后 dirStamp===null 重扫时惰性加载

    fs.chmodSync(fa, 0o000);
    fs.chmodSync(fb, 0o000);
    const records = store.collectRecords(100, "all", "root-1");
    expect(records.map((r) => r.id).sort()).toEqual(["sa-1", "sa-2"]); // 重扫 → loadIndex 重载 → 正条目命中零内容读取
  });

  it("S1TC14: 索引命中 + .cancelled sidecar 冷启动——命中分支读取 tombstone 置 closed", { timeout: 15_000 }, async () => {
    const f1 = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] });

    const storeA = new RecordStore(sessionsDir);
    storeA.collectRecords(100, "all", "root-1");
    await waitForIndex();

    // jsonl 戳不变，仅在旁路放 .cancelled sidecar（cancel 后 jsonl 截断、状态只能靠
    // tombstone 重建；sidecar 形态复刻 record-store-cache.test.ts A3 用例）
    fs.writeFileSync(
      `${f1}.cancelled`,
      JSON.stringify({ id: "sa-1", status: "cancelled", agent: "worker", startedAt: 1000, endedAt: 3000 }) + "\n",
    );

    // 冷启动新实例：jsonl 戳命中索引条目 → 走命中分支，但 cancelled sidecar stat 变化
    // 必须被感知——命中分支读 tombstone override 状态（否则退回兜底 running）
    const storeB = new RecordStore(sessionsDir);
    const sa1 = storeB.collectRecords(100, "all", "root-1").find((r) => r.id === "sa-1");
    expect(sa1?.status).toBe("idle");
    expect(sa1?.closedReason).toBe("cancelled");
    expect(sa1?.error).toBe("cancelled by user");
    expect(sa1?.endedAt).toBe(3000); // tombstone 的精确结束时间，非 mtime 近似
  });
});
