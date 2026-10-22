/**
 * runId 形态白名单（recordPathFor 路径穿越防线）行为锚。
 *
 * 背景：runId 是 LLM 工具参数面的自由字符串（workflow_control status/resume 直传），
 * 会被拼进 record 流路径（recordPathFor/stateFilePath）——无形态校验时，含路径分隔符
 * 或 `..` 的入参在 join 后逃逸出 runs 目录（读任意文件 + 借 status「settled-evicted
 * vs not found」两文案分叉做文件存在性探测）。
 *
 * 锁定的语义：
 * 1. **isWorkflowRunId 判据**：生产 runId 唯一来源 = core generateRunId
 *    （`wf-<毫秒>-<base36>`）及其同字符集变体放行；路径分隔符 / `..` / 空串 /
 *    首尾非字母数字拒绝（与 session 域 isPiSessionId 同族惯例：首尾字母数字锚定）；
 * 2. **stateFilePath tripwire**：非法 runId fail-fast throw（path traversal
 *    blocked），磁盘零副作用、永不产出 runs 目录外的路径；
 * 3. **settledRecordOf 降级**：非法 runId → miss（undefined）+ warn 留证——通知链
 *    降级语义不崩（生产调用方只传 run.runId，本用例锁定的是防御面的行为形状）；
 * 4. **合法 runId 回归锚**：白名单不改变合法 id 的路径推导（runsDir 内 join + 后缀在位）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { isWorkflowRunId, JsonlRunStore } from "../jsonl-run-store.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runid-whitelist-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

describe("isWorkflowRunId 形态白名单（布尔判定）", () => {
  it.each([
    "wf-1719500000000-a1b2c3", // generateRunId 实际产出形态（wf-<毫秒>-<base36>）
    "rfl-e2e-1760000000000-123456", // e2e driver 变体（同字符集）
    "wf_1", // 下划线在白名单字符集内
    "w", // 单字符（首尾锚定的可满足最短形态）
  ])("放行：%j", (runId) => {
    expect(isWorkflowRunId(runId)).toBe(true);
  });

  it.each([
    "", // 空串
    "..", // 纯 dots
    "../evil", // 路径分隔符 + ..
    "a/b", // posix 分隔符
    "a\\b", // windows 分隔符
    "a..b", // 内嵌 dots（字符集不含 '.'，自然拒绝）
    "-abc", // 首字符非字母数字
    "abc-", // 尾字符非字母数字
    "wf 1", // 空格
    "wf:1", // 冒号（isPiSessionId 同族禁用字符）
  ])("拒绝：%j", (runId) => {
    expect(isWorkflowRunId(runId)).toBe(false);
  });
});

describe("recordPathFor 路径穿越防线（fail-fast tripwire）", () => {
  it("stateFilePath 非法 runId → throw（path traversal blocked），磁盘零副作用", () => {
    const store = new JsonlRunStore({ runsDir: tmpDir });
    expect(() => store.stateFilePath("../evil")).toThrow(/path traversal blocked/);
    // runsDir 内不因拒绝而产生任何文件（拒绝发生在路径构造前）
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("settledRecordOf 非法 runId → miss（undefined，通知链降级语义不崩）+ warn 留证", () => {
    const store = new JsonlRunStore({ runsDir: tmpDir });
    expect(store.settledRecordOf("../evil")).toBeUndefined();
    // 诊断留证可归因（非静默——对齐该 catch 面对非 ENOENT 错误的既有语义）
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(String(loggerMock.warn.mock.calls[0]?.[0])).toContain("record stream read failed");
  });

  it("合法 runId 路径推导不变（回归锚：runsDir 内 join + .record.jsonl 后缀在位）", () => {
    const store = new JsonlRunStore({ runsDir: tmpDir });
    expect(store.stateFilePath("wf-1719500000000-a1b2c3")).toBe(
      path.join(tmpDir, "wf-1719500000000-a1b2c3.record.jsonl"),
    );
  });
});
