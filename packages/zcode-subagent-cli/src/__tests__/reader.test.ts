// reader.test.ts —— sqlite 只读 SessionView（验收 4 的 mock 半边：真实 node:sqlite 建库
// → turns/usage/toolCalls 派生；db 缺失/表漂移 → 结构化错误供降级）。真机半边（实录池
// 内 db）在 zcode-engine.live.test.ts。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readZcodeSessionView, ZcodeReaderError } from "../reader.ts";

let tmpDir: string;
let dbPath: string;

// 建出与 zcode 0.16.5 同形的三表最小 schema（列裁剪到 reader 消费面）
async function createDb(file: string): Promise<void> {
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => unknown };
  type Db = {
    exec: (s: string) => void;
    prepare: (s: string) => { run: (...a: unknown[]) => void };
    close: () => void;
  };
  const db = new DatabaseSync(file) as unknown as Db;
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);" +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);" +
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);",
  );
  const insertMessage = db.prepare("INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)");

  // session 1（目标）：user prompt + assistant 两轮（text/reasoning/tool/step-finish×2）
  db.prepare("INSERT INTO session (id, time_created) VALUES (?, ?)").run("sess_target", 2000);
  insertMessage.run("msg_user", "sess_target", 0, JSON.stringify({ role: "user" }));
  insertPart.run("part_user_text", "msg_user", "sess_target", 0, JSON.stringify({ type: "text", text: "the task" }));

  insertMessage.run("msg_asst", "sess_target", 1, JSON.stringify({ role: "assistant" }));
  insertPart.run("p0", "msg_asst", "sess_target", 0, JSON.stringify({ type: "step-start" }));
  insertPart.run("p1", "msg_asst", "sess_target", 1, JSON.stringify({ type: "reasoning", text: "thinking hard" }));
  insertPart.run(
    "p2",
    "msg_asst",
    "sess_target",
    2,
    JSON.stringify({
      type: "tool",
      tool: "Bash",
      state: JSON.stringify({ status: "completed", input: { command: "ls" }, output: "file-a\nfile-b" }),
    }),
  );
  insertPart.run(
    "p3",
    "msg_asst",
    "sess_target",
    3,
    JSON.stringify({
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { total: 110, input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 0 } },
    }),
  );
  // 第二轮（同 assistant message 内第二个 step 段）
  insertPart.run("p4", "msg_asst", "sess_target", 4, JSON.stringify({ type: "text", text: "final answer" }));
  insertPart.run(
    "p5",
    "msg_asst",
    "sess_target",
    5,
    JSON.stringify({
      type: "step-finish",
      reason: "stop",
      cost: 0.5,
      tokens: { total: 60, input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );

  // session 2（更早）：验证「缺省取最新」与定向读取互不干扰
  db.prepare("INSERT INTO session (id, time_created) VALUES (?, ?)").run("sess_older", 1000);
  insertMessage.run("msg_old", "sess_older", 0, JSON.stringify({ role: "assistant" }));
  insertPart.run("part_old", "msg_old", "sess_older", 0, JSON.stringify({ type: "text", text: "old turn" }));
  insertPart.run(
    "part_old2",
    "msg_old",
    "sess_older",
    1,
    JSON.stringify({ type: "step-finish", tokens: { input: 1, output: 1, cache: {} } }),
  );
  db.close();
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-reader-"));
  dbPath = path.join(tmpDir, "db.sqlite");
  await createDb(dbPath);
});

describe("readZcodeSessionView：native 读取", () => {
  it("turns 派生：两轮闭合、text/thinking/toolCalls/usage 齐备（验收 4）", async () => {
    const view = await readZcodeSessionView(dbPath, "sess_target");
    expect(view.engineId).toBe("zcode");
    expect(view.source).toBe("native");
    expect(view.sessionId).toBe("sess_target");
    expect(view.turns).toHaveLength(2);

    const [t1, t2] = view.turns!;
    expect(t1!.text).toBe("");
    expect(t1!.thinking).toBe("thinking hard");
    expect(t1!.toolCalls).toHaveLength(1);
    expect(t1!.toolCalls[0]!.toolName).toBe("Bash");
    expect(t1!.toolCalls[0]!.args).toEqual({ command: "ls" });
    expect(t1!.toolCalls[0]!.result).toEqual({ content: ["file-a\nfile-b"] });
    expect(t1!.toolCalls[0]!.isError).toBeUndefined(); // status completed
    expect(t1!.closed).toBe(true);

    expect(t2!.text).toBe("final answer");
    expect(t2!.closed).toBe(true);

    // usage 聚合 = 两轮 usageDelta 之和（cost 累计第二段的 0.5）
    expect(view.usage).toEqual({ input: 150, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.5, total: 175 });
  });

  it("缺省 sessionId 取池内最新 session（time_created DESC）", async () => {
    const view = await readZcodeSessionView(dbPath);
    expect(view.sessionId).toBe("sess_target");
  });

  it("tool 状态非 completed 标 isError", async () => {
    // 单独建一个带失败工具调用的 session，避免污染上面的聚合断言
    const failDb = path.join(tmpDir, "fail.sqlite");
    await createDb(failDb);
    const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => unknown };
    type Db = { prepare: (s: string) => { run: (...a: unknown[]) => void }; close: () => void };
    const db = new DatabaseSync(failDb) as unknown as Db;
    db.prepare("INSERT INTO session (id, time_created) VALUES (?, ?)").run("sess_fail", 3000);
    db
      .prepare("INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)")
      .run("msg_f", "sess_fail", 0, JSON.stringify({ role: "assistant" }));
    db
      .prepare("INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)")
      .run(
        "pf",
        "msg_f",
        "sess_fail",
        0,
        JSON.stringify({
          type: "tool",
          tool: "Edit",
          state: JSON.stringify({ status: "error", input: { file: "a" }, output: "conflict" }),
        }),
      );
    db.close();
    const view = await readZcodeSessionView(failDb, "sess_fail");
    expect(view.turns[0]!.toolCalls[0]!.isError).toBe(true);
  });
});

describe("readZcodeSessionView：结构化错误（供降级②③级，验收 4 负例）", () => {
  beforeEach(() => {
    // 无共享状态需重置；保留钩子位置说明负例组意图
  });

  it("db 文件缺失 → engine_session_read_failed（detail 含路径）", async () => {
    const missing = path.join(tmpDir, "nope.sqlite");
    try {
      await readZcodeSessionView(missing, "sess_x");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZcodeReaderError);
      const e = err as ZcodeReaderError;
      expect(e.code).toBe("engine_session_read_failed");
      expect(e.detail).toContain(missing);
      expect(e.message).toContain("降级");
    }
  });

  it("表结构漂移（缺 part 表）→ 结构化错误含漂移提示", async () => {
    const drifted = path.join(tmpDir, "drifted.sqlite");
    const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => unknown };
    type Db = { exec: (s: string) => void; close: () => void };
    const db = new DatabaseSync(drifted) as unknown as Db;
    // 只建 session/message（zcode 升级把 part 改名的形态）；塞一行 session 让定位
    // 通过、失败必然发生在 part 查询（表缺失）
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);" +
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);" +
        "INSERT INTO session (id, time_created) VALUES ('sess_d', 1);",
    );
    db.close();
    try {
      await readZcodeSessionView(drifted);
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodeReaderError;
      expect(e.code).toBe("engine_session_read_failed");
      expect(e.message).toContain("漂移");
      expect(e.message).toContain("golden");
    }
  });

  it("session 不存在 → 结构化错误（不静默空视图）", async () => {
    try {
      await readZcodeSessionView(dbPath, "sess_ghost");
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodeReaderError).detail).toContain("sess_ghost");
    }
  });
});
