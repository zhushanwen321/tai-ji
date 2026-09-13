// journal-wiring.test.ts —— [D3-③ journal 接线合一] host helper 单测（两域共用的
// 唯一实现：writer 创建 + journaling onEvent + handle 回填 + close）。
// 设计权威源：docs/design/dual-track（已删 git 可追溯）§3.3 D3-③ + 双轨清单 #6。
//
// [池抽象降级 2026-09-13] 原「占位池 key + onPoolResolved retarget」覆盖面已删——
// journal 落盘路径构造即终值（固定分组 key 'shared'，磁盘布局字节不变）。
//
// 覆盖：①固定分组 key 路径定稿（getter 恒构造值）；②先落盘再转发（forwardEvents）；
// ③handle 回填写终态路径；④close 幂等不抛。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wireEventJournal } from "../../common/journal-wiring.ts";
import { resolveJournalPath } from "../../paths.ts";
import type { AgentEvent } from "../../types.ts";
import type { EngineHandle } from "../../types.ts";

let dataRoot: string;
const PREV_DATA_DIR = process.env["XYZ_AGENT_DATA_DIR"];

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "journal-wiring-"));
  process.env["XYZ_AGENT_DATA_DIR"] = dataRoot;
});

afterEach(() => {
  if (PREV_DATA_DIR === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
  else process.env["XYZ_AGENT_DATA_DIR"] = PREV_DATA_DIR;
  fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeHandle(): EngineHandle {
  return { data: { v: 1, engineId: "zcode", sessionRef: {}, adapterVersion: "t" } };
}

describe("wireEventJournal（D3-③ host helper 唯一实现）", () => {
  it("路径构造即终值：固定分组 key 'shared'（engines/zcode/shared/，[池抽象降级] 无 retarget）", () => {
    const wiring = wireEventJournal({ engineId: "zcode", taskId: "sa-1" });
    expect(wiring.path).toBe(resolveJournalPath(dataRoot, "zcode", "shared", "sa-1"));
  });

  it("journaling onEvent：先落盘再转发（forwardEvents 收到同一事件）", async () => {
    const forwarded: AgentEvent[] = [];
    const wiring = wireEventJournal({ engineId: "zcode", taskId: "sa-2", forwardEvents: (e) => forwarded.push(e) });
    wiring.onEvent({ type: "turn_end" });
    wiring.onEvent({ type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
    await wiring.close();
    expect(forwarded.map((e) => e.type)).toEqual(["turn_end", "message_end"]);
    // 落盘真实发生（close flush 后文件存在且行数吻合——先落盘语义由文件内容见证）
    const lines = fs.readFileSync(wiring.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).taskId).toBe("sa-2");
    expect(JSON.parse(lines[0]).engineId).toBe("zcode");
  });

  it("chat 域形态（无 forwardEvents）：事件只进 journal，不抛", async () => {
    const wiring = wireEventJournal({ engineId: "zcode", taskId: "sa-3" });
    wiring.onEvent({ type: "turn_end" });
    await wiring.close();
    expect(fs.existsSync(wiring.path)).toBe(true);
  });

  it("activity 豁免 journal.append：journal 文件无对应行，forwardEvents 仍收到（纯活性信号不进持久面）", async () => {
    const forwarded: AgentEvent[] = [];
    const wiring = wireEventJournal({ engineId: "zcode", taskId: "sa-6", forwardEvents: (e) => forwarded.push(e) });
    wiring.onEvent({ type: "activity" });
    wiring.onEvent({ type: "turn_end" });
    wiring.onEvent({ type: "activity" });
    await wiring.close();
    // forwardEvents 照发（workflow liveRecord reducer no-op / 守护刷新面上游）
    expect(forwarded.map((e) => e.type)).toEqual(["activity", "turn_end", "activity"]);
    // journal 只落 turn_end 一行（activity 过滤在 append 前，无 seq 空洞）
    const lines = fs.readFileSync(wiring.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event.type).toBe("turn_end");
  });

  it("handle 回填：backfillHandle 写终态路径（read ②级自描述定位符）", async () => {
    const wiring = wireEventJournal({ engineId: "zcode", taskId: "sa-4" });
    wiring.onEvent({ type: "turn_end" });
    const handle = makeHandle();
    wiring.backfillHandle(handle);
    expect(handle.data.journalPath).toBe(resolveJournalPath(dataRoot, "zcode", "shared", "sa-4"));
    await wiring.close();
    expect(fs.existsSync(handle.data.journalPath!)).toBe(true);
  });

  it("close 幂等（重复调用不抛）；无事件任务不产生空 journal 文件", async () => {
    const wiring = wireEventJournal({ engineId: "zcode", taskId: "sa-5" });
    await wiring.close();
    await expect(wiring.close()).resolves.toBeUndefined();
    expect(fs.existsSync(wiring.path)).toBe(false);
  });
});
