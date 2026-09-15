// src/__tests__/primitives.test.ts
//
// 7 原语 + ui-types 行为冒烟（迁移等价性抽查——核心断言：迁移后的行为与 core 版
// 语义逐字对齐；core 侧既有测试族继续覆盖 core 版，双侧行为由 W2/W5/W7 消费验证）。
// data-dir 的三态判定（env 优先 / 注入回退 warn-once / 双缺报错）是 impl-plan §2.9
// 数据根注入矩阵的 SDK 侧实现断言。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NESTED_SPAWN_ENV,
  buildNestedSpawnEnv,
  assertNotNestedSpawn,
  ExecutionNestingContext,
  NestedSpawnRejectedError,
} from "../nesting-guard.ts";
import {
  TAIJI_DATA_DIR_ENV,
  resolveEngineDataDir,
  resetDataDirWarnForTests,
} from "../data-dir.ts";
import {
  sanitizeSeg,
  resolveEnginesRoot,
  resolveEngineDir,
  resolvePoolDir,
  resolveJournalPath,
} from "../paths.ts";
import { createReplayRecord, updateFromEvent, eventsToSessionView } from "../journal-replay.ts";
import {
  configureLoggerSink,
  getLogger,
  resetLoggerSinkForTests,
  type LoggerSink,
} from "../logger.ts";
import { synthesizeTimeoutOutcome, HOST_TIMEOUT_ABORT_REASON } from "../kill-chain.ts";
import {
  SCHEMA_EMULATION_TAIL_CHARS,
  buildSchemaEmulationSegment,
  extractAndValidateStructuredOutput,
} from "../schema-emulation.ts";
import type { AgentEvent, Turn } from "../protocol/contract-types.ts";

describe("nesting-guard（D8 双层防护）", () => {
  it("buildNestedSpawnEnv：注入统一标记 + 剥离引擎原生标记，不改入参", () => {
    const base: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      ZSW_NESTED: "1",
      PI_SUBAGENT_ROOT_SESSION_ID: "root",
      KEEP: "yes",
    };
    const env = buildNestedSpawnEnv(base);
    expect(env[NESTED_SPAWN_ENV]).toBe("1");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.ZSW_NESTED).toBeUndefined();
    expect(env.PI_SUBAGENT_ROOT_SESSION_ID).toBeUndefined();
    expect(env.KEEP).toBe("yes");
    // 入参不被修改（spawn env 组装链多层 spread 安全）
    expect(base[NESTED_SPAWN_ENV]).toBeUndefined();
    expect(base.CLAUDECODE).toBe("1");
  });

  it("assertNotNestedSpawn：已嵌套抛 nested_spawn_rejected（含可操作恢复指引）", () => {
    expect(() => assertNotNestedSpawn({ [NESTED_SPAWN_ENV]: "1" })).toThrowError(
      NestedSpawnRejectedError,
    );
    try {
      assertNotNestedSpawn({ [NESTED_SPAWN_ENV]: "1" });
    } catch (err) {
      expect((err as NestedSpawnRejectedError).code).toBe("nested_spawn_rejected");
      expect((err as NestedSpawnRejectedError).recovery).toMatch(/directly inside the current task/);
    }
    expect(() => assertNotNestedSpawn({})).not.toThrow();
  });

  it("ExecutionNestingContext：ALS 链传递 + 基线兜底（ALS 断裂修复语义）", () => {
    const ctx = new ExecutionNestingContext();
    expect(ctx.current()).toBeNull();
    ctx.setBaseline({ recordId: "proc-self", depth: 0 });
    // 无 ALS store → 基线兜底
    expect(ctx.current()).toEqual({ recordId: "proc-self", depth: 0 });
    // baseline() 不看 ALS store
    ctx.run({ recordId: "b", depth: 1 }, () => {
      expect(ctx.current()).toEqual({ recordId: "b", depth: 1 });
      expect(ctx.baseline()).toEqual({ recordId: "proc-self", depth: 0 });
    });
    expect(ctx.current()).toEqual({ recordId: "proc-self", depth: 0 });
  });
});

describe("data-dir（impl-plan §2.9 数据根注入矩阵的 SDK 侧三态）", () => {
  beforeEach(() => {
    resetDataDirWarnForTests();
  });

  it("态 1：env 优先（权威通道）", () => {
    expect(resolveEngineDataDir({ [TAIJI_DATA_DIR_ENV]: "/data/root" })).toBe("/data/root");
  });

  it("态 2：缺 env + 显式注入 → 用注入值 + warn 一次（warn-once 语义）", () => {
    const warns: string[] = [];
    const warn = (msg: string) => warns.push(msg);
    const first = resolveEngineDataDir({}, { fallbackDataRoot: "/injected/root", warn });
    const second = resolveEngineDataDir({}, { fallbackDataRoot: "/injected/root", warn });
    expect(first).toBe("/injected/root");
    expect(second).toBe("/injected/root");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(TAIJI_DATA_DIR_ENV);
  });

  it("态 3：缺 env 且无注入 → 显式报错（附 env 名 + 恢复动作，不静默漂目录）", () => {
    expect(() => resolveEngineDataDir({})).toThrowError(/TAIJI_AGENT_DATA_DIR is not set/);
    expect(() => resolveEngineDataDir({})).toThrowError(/Recovery:/);
    // 空串/空白 env 视同缺失
    expect(() => resolveEngineDataDir({ [TAIJI_DATA_DIR_ENV]: "   " })).toThrowError();
  });
});

describe("paths（数据目录布局 SSOT，纯函数）", () => {
  it("布局：<dataDir>/engines/<engineId>/<poolKey>/journal-<taskId>.jsonl", () => {
    const dataDir = "/tmp/taiji";
    expect(resolveEnginesRoot(dataDir)).toBe(join(dataDir, "engines"));
    expect(resolveEngineDir(dataDir, "zcode")).toBe(join(dataDir, "engines", "zcode"));
    expect(resolvePoolDir(dataDir, "zcode", "shared")).toBe(
      join(dataDir, "engines", "zcode", "shared"),
    );
    expect(resolveJournalPath(dataDir, "zcode", "shared", "task-1")).toBe(
      join(dataDir, "engines", "zcode", "shared", "journal-task-1.jsonl"),
    );
  });

  it("sanitizeSeg：路径穿越/分隔符/空白归一 + 超长截断 + 空值回落 default", () => {
    // "../../etc/passwd" → 非法段替换为 '-' 后首尾 '-' 剥除
    expect(sanitizeSeg("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeSeg("a b/c")).toBe("a-b-c");
    expect(sanitizeSeg("")).toBe("default");
    expect(sanitizeSeg("x".repeat(120))).toHaveLength(80);
  });
});

describe("journal-replay（纯投影 + reducer，重放等价性语义）", () => {
  /** 事件序列驱动 reducer 累积后返回 turns（对齐 core journal-replay 消费链）。 */
  function replay(events: AgentEvent[]): Turn[] {
    const record = createReplayRecord();
    for (const ev of events) updateFromEvent(record, ev);
    return record.turns;
  }

  it("reducer：text/thinking 累积、tool 配对、turn 闭合、usage 聚合", () => {
    const record = createReplayRecord();
    const events: AgentEvent[] = [
      { type: "text_delta", delta: "Hello, " },
      { type: "text_delta", delta: "world" },
      { type: "thinking_delta", delta: "hmm" },
      { type: "tool_start", toolName: "bash", args: { cmd: "ls" } },
      { type: "tool_end", toolName: "bash", result: { content: [] }, isError: false },
      { type: "message_end", usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.5 } },
      { type: "turn_end" },
      { type: "text_delta", delta: "next turn" },
      { type: "turn_end" },
      // error 事件在 turn_end 之后到达：applyTurnEnd 清 lastError（瞬态 error 恢复后
      // 不误判失败），error 处理器随后写回——顺序即语义
      { type: "error", message: "transient" },
    ];
    for (const ev of events) updateFromEvent(record, ev);
    // 2 turns（首个预置空 turn 被首个 text 消费）
    expect(record.turnCount).toBe(2);
    expect(record.turns).toHaveLength(2);
    expect(record.turns[0]).toMatchObject({ text: "Hello, world", thinking: "hmm", closed: true });
    expect(record.turns[0].toolCalls).toHaveLength(1);
    expect(record.turns[0].toolCalls[0]).toMatchObject({
      toolName: "bash",
      _status: "done",
      isError: false,
    });
    expect(record.turns[0].usageDelta).toEqual({
      input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.5,
    });
    // totalTokens = 四项之和（10+5+1+2）
    expect(record.totalTokens).toBe(18);
    // turn_end 清 lastError；滞后 error 事件写回
    expect(record.lastError).toBe("transient");
  });

  it("滞后 tool_end 兜底：跨 turn 倒序找 running 同名 toolCall，未命中则补已完成项", () => {
    const turns = replay([
      { type: "tool_start", toolName: "bash" },
      { type: "turn_end" },
      { type: "tool_end", toolName: "bash", result: { content: [] } },
    ]);
    const closed = turns[0]!;
    expect(closed.toolCalls[0]?._status).toBe("done");
    // 无 tool_start 的孤儿 tool_end → push 已完成项（不丢数据）
    const orphanTurn = turns[turns.length - 1]!;
    expect(orphanTurn.toolCalls).toHaveLength(1);
    expect(orphanTurn.toolCalls[0]?._status).toBe("done");
  });

  it("eventsToSessionView：source 恒 journal + sessionId 提取 + usage 聚合（投影出口）", () => {
    const events: AgentEvent[] = [
      { type: "text_delta", delta: "answer" },
      { type: "message_end", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
      { type: "turn_end" },
    ];
    const view = eventsToSessionView(events, "zcode", "sess-1");
    expect(view.engineId).toBe("zcode");
    expect(view.sessionId).toBe("sess-1");
    expect(view.source).toBe("journal");
    expect(view.turns).toHaveLength(1);
    // ReplayedTurn：内部态剥离（无 _status/startedTs）、closed 恒 true
    expect(view.turns[0]).toEqual({
      text: "answer",
      thinking: "",
      toolCalls: [],
      closed: true,
    });
    expect(view.usage).toEqual({
      input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0, total: 10,
    });
  });
});

describe("logger facade（时序契约：先缓存后配置透明切换）", () => {
  afterEach(() => {
    resetLoggerSinkForTests();
  });

  it("facade 动态解析：先 getLogger 后 configureLoggerSink，已缓存实例切到新 sink", () => {
    const seen: Array<{ level: string; msg: string }> = [];
    const sink: LoggerSink = {
      log(level, _component, message) {
        seen.push({ level, msg: message });
      },
    };
    const logger = getLogger("sdk-test");
    logger.warn("before-config");
    configureLoggerSink(sink);
    logger.warn("after-config");
    expect(seen).toEqual([{ level: "warn", msg: "after-config" }]);
    // 同 component 同引用（core getLogger singleton 惯例）
    expect(getLogger("sdk-test")).toBe(logger);
  });
});

describe("kill-chain（超时终态合成；杀链执行路径由引擎包集成测试覆盖）", () => {
  it("synthesizeTimeoutOutcome：engineId 参数注入 + exitCode=null + slug 进错误信息", () => {
    const outcome = synthesizeTimeoutOutcome(
      { prompt: "p", description: "my-task-slug" },
      "stdout tail content",
      "zcode",
    );
    expect(outcome.engineId).toBe("zcode");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.content).toBe("");
    expect(outcome.error).toContain("engine_timeout:");
    expect(outcome.error).toContain("slug=my-task-slug");
    expect(outcome.error).toContain("stdout tail content");
  });

  it("HOST_TIMEOUT_ABORT_REASON 标记（超时 vs 用户 cancel 判别锚点）", () => {
    expect(HOST_TIMEOUT_ABORT_REASON).toBe("agent-call-timeout");
  });
});

describe("schema-emulation（D4 硬分流：emulated 引擎专用）", () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };

  it("prompt 注入段：含 schema JSON 与输出约定", () => {
    const segment = buildSchemaEmulationSegment(schema);
    expect(segment).toContain("## Structured Output Requirement");
    expect(segment).toContain(JSON.stringify(schema));
    expect(segment).toContain("Output ONLY the JSON value");
  });

  it("三级提取：直接 parse / code fence / 括号扫描 + ajv 校验", () => {
    const direct = extractAndValidateStructuredOutput('{"answer":"a"}', schema);
    expect(direct).toEqual({ ok: true, parsed: { answer: "a" } });

    const fenced = extractAndValidateStructuredOutput('```json\n{"answer":"b"}\n```', schema);
    expect(fenced).toEqual({ ok: true, parsed: { answer: "b" } });

    const scanned = extractAndValidateStructuredOutput('Here: {"answer":"c"} hope it helps', schema);
    expect(scanned).toEqual({ ok: true, parsed: { answer: "c" } });
  });

  it("校验失败/提取失败返回 ok:false + tail 截断（不 throw，重试由调用方决策）", () => {
    const invalid = extractAndValidateStructuredOutput('{"answer":42}', schema);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain("Schema validation failed");
      expect(invalid.tail).toBe('{"answer":42}');
    }
    const noJson = extractAndValidateStructuredOutput("no json at all", schema);
    expect(noJson.ok).toBe(false);
    if (!noJson.ok) {
      expect(noJson.error).toContain("3-stage fallback");
    }
    // tail 上限 500 字符
    expect(SCHEMA_EMULATION_TAIL_CHARS).toBe(500);
  });
});
