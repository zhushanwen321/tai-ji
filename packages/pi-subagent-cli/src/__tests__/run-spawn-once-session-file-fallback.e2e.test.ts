// src/__tests__/run-spawn-once-session-file-fallback.e2e.test.ts
//
// close 时 sessionFile 仍缺的响亮 warn 生产接线端到端回归（pump close finalizer 见
// spawn-run-pump.ts 的 warnSessionFileUnobtainable）。
//
// 被测链路 = 真实 runSpawnOnce → 真实 pump/close finalizer，仅 pi 对端用 fake 脚本
// 替代（同 run-spawn-once.integration.test.ts 手法）。fake pi 形态 =「get_state 全程
// 不应答」（握手 3 轮 + agent_end 补查全 miss 的原事故现实形态）+ 正常跑完、不落任何
// session 文件（sessionId 未知 → LC-4 后缀反查无从发起）→ 四路全 miss。
//
// 用户裁定（prompt 头键兜底采纳机制已移除）：全 miss 本身是应响亮报错的异常信号，
// 不做启发式自动认领——正确形态 = warn 留痕（含 recordId + 全路 miss 归因 + 人工
// 排查指引）+ run 正常终态（resolveExit 必达、outcome 正常，不因缺锚点挂死/误报失败）。
//
// fixture 落 mkdtempSync 自建目录（tmpdir 白名单，不触碰真实数据目录）。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureLoggerSink, resetLoggerSinkForTests, type LogLevel } from "@zhushanwen/subagent-engine-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  killAllActiveChildren,
  runSpawnOnce,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";

/**
 * fake pi：rpc 形态子进程。
 * - `get_state` **全程不应答**（原事故形态；spawn 期握手与 agent_end 回补同样收不到应答）；
 * - 收到 prompt 后正常收尾：message_end → agent_end（→ 引擎 M2 回补 1s 超时后 kill，
 *   触发 close）；不落任何 session 文件（sessionId 恒未知 → LC-4 无从反查）。
 */
const FAKE_PI_SCRIPT = `
import readline from "node:readline";

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\\n"); };

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "extension_ui_response") return;
  // 握手 / agent_end 回补的 get_state 一律不应答（不写 response 行）
  if (msg.type === "get_state") return;
  if (msg.type !== "prompt") return;

  send({ type: "message_end", message: { stopReason: "stop" } });
  send({ type: "agent_end", willRetry: false, reason: "end_turn" });
});
`;

let rootDir: string;
let sessionDir: string;
let scriptPath: string;
let argv1Saved: string | undefined;
let logs: Array<{ level: LogLevel; component: string; message: string }>;

interface Harness {
  handleReady: Array<{ sessionRef: Record<string, string>; poolKey: string }>;
}

function makeHarness(): Harness {
  rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-sfwarn-"));
  sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  scriptPath = join(rootDir, "fake-pi.mjs");
  fs.writeFileSync(scriptPath, FAKE_PI_SCRIPT);
  argv1Saved = process.argv[1];
  process.argv[1] = scriptPath; // getPiInvocation 分支 1：node <script> <args>
  logs = [];
  configureLoggerSink({
    log: (level, component, message) => {
      logs.push({ level, component, message });
    },
  });
  return { handleReady: [] };
}

function callbacksOf(h: Harness): SpawnRunCallbacks {
  return {
    onEvent: () => {},
    onHandleReady: (p) => h.handleReady.push(p),
    onChildStateChanged: () => {},
  };
}

function baseParams(): SpawnRunParams {
  return {
    recordId: "rec-warn-e2e",
    task: "session file 全 miss 形态的任务 prompt",
    agentName: "warn-agent",
    model: "prov/model-1",
    sessionDir,
    cwd: rootDir,
  };
}

afterEach(() => {
  resetLoggerSinkForTests();
  killAllActiveChildren();
  resetAllEpipeFailures();
  process.argv[1] = argv1Saved ?? "";
  if (rootDir !== undefined && fs.existsSync(rootDir)) {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("close 时 sessionFile 缺失的响亮 warn（runSpawnOnce + fake pi 全程不应答）", () => {
  it("四路全 miss → warn 留痕（recordId + unobtainable + 排查指引）且 run 正常终态", async () => {
    const h = makeHarness();

    const result: SpawnRunResult = await runSpawnOnce(baseParams(), callbacksOf(h));

    // run 正常终态：resolveExit 必达（await 不挂死）+ agent_end 主动终结的 exit 0 口径
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // 全 miss 形态：身份面无锚点（不自动认领）
    expect(result.sessionFile).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(h.handleReady).toHaveLength(0);

    // 响亮 warn：含 recordId + unobtainable + 全路 miss 归因 + 人工排查指引
    const warns = logs
      .filter((l) => l.level === "warn" && l.message.includes("[sessionfile]"))
      .map((l) => l.message);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("unobtainable for rec-warn-e2e");
    expect(warns[0]).toContain("all acquisition paths missed: spawn handshake, late response, agent_end backfill, LC-4 suffix lookup");
    expect(warns[0]).toContain("record finalized without transcript anchor");
    expect(warns[0]).toContain("Recovery:");
  }, 15_000);
});
