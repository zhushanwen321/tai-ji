// zcode-engine.live.test.ts —— 端到端真机门（单一 app-server 形态，2026-09 起无
// spawn 段）：真实 zcode CLI + 真实凭据 + 真实 LLM 调用。手动门（设计 §3.3.8
// conformance run 层同构）：默认 skip，跑法：
//
//   ENGINE_CONFORMANCE_LIVE=1 ZCODE_E2E_MODEL='<provider/model>' pnpm vitest run src/execution/engine/engines/zcode/__tests__/zcode-engine.live.test.ts
//
// ZCODE_E2E_MODEL 缺省值是采集 golden 样本的本机 provider（v2 config 实测带 apiKey、
// 公网可达）；换机器跑时用 env 覆盖为本机可用模型。共享宿主 HOME + 隔离会话库形态
// （2026-09 会话库隔离）：HOME 仍为真实宿主值（凭据/插件/MCP 继承不变），会话写入
// <engineDataDir>/engines/zcode/session-db/db.sqlite（xyz-agent 独占，不进 ZCode GUI
// 侧边栏）；journal/引擎数据落 /tmp（跑完由本文件 afterAll 清理）。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentEvent } from "@zhushanwen/subagent-engine-sdk";
import { ZcodeEngine } from "../zcode-engine.ts";
import { assertAgentEventInvariants } from "./agent-event-invariants.ts";

const LIVE = process.env["ENGINE_CONFORMANCE_LIVE"] === "1";
const E2E_MODEL = process.env["ZCODE_E2E_MODEL"] ?? "e512d53e-0bfc-4915-9081-860d4aa13cd0/mimo-v2.5-pro";
const AS_DATA_ROOT = path.join(fs.realpathSync(os.tmpdir()), "zcode-appserver-e2e-data");
const AS_WORK_CWD = path.join(fs.realpathSync(os.tmpdir()), "zcode-appserver-e2e-cwd");

describe.skipIf(!LIVE)("ZcodeEngine 端到端真机（app-server 常驻，共享宿主 HOME）", () => {
  let engine: ZcodeEngine;

  beforeAll(() => {
    fs.mkdirSync(AS_WORK_CWD, { recursive: true });
    engine = new ZcodeEngine({
      engineDataDir: () => AS_DATA_ROOT,
    });
  });

  afterAll(async () => {
    // dispose 是常驻进程的唯一收割入口（D6）——先 dispose 再清目录
    await engine.dispose().catch(() => undefined);
    for (const dir of [AS_DATA_ROOT, AS_WORK_CWD]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // 尽力清理
      }
    }
  });

  it("probe：二进制/版本两项全过", async () => {
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toMatch(/^0\.\d+\.\d+$/);
  }, 60_000);

  it("run：常驻通道全链（stream 事件流出 + read①级 native + poolKey 锚定 'shared' + 会话落隔离会话库）", async () => {
    const events: AgentEvent[] = [];
    const { handle, outcome } = await engine.run(
      {
        prompt: 'Verify this arithmetic check: 2 + 2 = 4. If it is correct the verdict must be "ok", otherwise "bad".',
        description: "e2e-appserver",
        model: E2E_MODEL,
        cwd: AS_WORK_CWD,
        schema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["ok", "bad"] } },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
      { taskId: "sa-live-appserver", onEvent: (e) => events.push(e) },
    );

    // C2：outcome 正确
    expect(outcome.error).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.sessionId).toMatch(/^sess_/);
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });
    expect(outcome.usage?.input).toBeGreaterThan(0);

    // C3 stream 口径：text_delta 实时流出（非终态一次性）+ 不变量五条
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });

    // handle 锚定：poolKey 恒 'shared'，dbPath = 隔离会话库绝对路径（①级读取钥匙）。
    // 期望值独立展开（不调实现函数——实现改错时断言须红），非 zcodeSessionDbPath 同源
    const dbPath = handle.data.sessionRef["dbPath"];
    expect(dbPath).toBe(path.resolve(AS_DATA_ROOT, "engines", "zcode", "session-db", "db.sqlite"));
    expect(dbPath.startsWith("/")).toBe(true);

    // read 第①级：SQLite 完整重建（非降级）——读的是隔离会话库（xyz-agent 独占）
    const view = await engine.read(handle);
    expect(view.source).toBe("native");
    expect(view.turns.length).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("abort：长任务中途取消 → stop 链合成终态 exitCode=null + 常驻进程不残留 + 后续任务可用", async () => {
    const controller = new AbortController();
    const runPromise = engine.run(
      {
        prompt:
          "Write an extremely detailed 5000-word technical essay about distributed systems consistency models. Do not stop early.",
        description: "e2e-appserver-abort",
        model: E2E_MODEL,
        cwd: AS_WORK_CWD,
      },
      { taskId: "sa-live-appserver-abort", signal: controller.signal },
    );
    // 等 send 已发（会话在途），再中途 abort——覆盖 stop 链而非 pre-abort 短路
    await new Promise((r) => setTimeout(r, 4_000));
    controller.abort();
    const { outcome } = await runPromise;

    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("session/stop");

    // 无残留：引擎数据目录锚定的 app-server 进程在 dispose 前应 ≤1（abort 不误杀
    // 共享进程；与其他 zcode 实例区分靠 --cwd 引擎数据目录路径）
    const leftovers = listZcodeProcessesForCwd(AS_DATA_ROOT);
    expect(leftovers.length).toBeLessThanOrEqual(1);

    // 崩溃/中止后下一任务自动重建或复用（不变量 4 同路径）——abort 不污染常驻进程
    const second = await engine.run(
      { prompt: "Reply with the single word: ok", description: "e2e-appserver-after-abort", model: E2E_MODEL, cwd: AS_WORK_CWD },
      { taskId: "sa-live-appserver-after-abort" },
    );
    expect(second.outcome.error).toBeUndefined();
    expect(second.outcome.content.trim().length).toBeGreaterThan(0);
  }, 300_000);
});

/** 扫系统进程表：--cwd 锚定到指定目录的 app-server 常驻进程（僵尸检测）。spawn 形态
 * 是 `node .../engines/zcode/appserver-launcher.cjs app-server --cwd <dir>`——zcode.cjs
 * 经 launcher 的 import() 动态加载，不出现在 cmdline。 */
function listZcodeProcessesForCwd(cwd: string): string[] {
  try {
    const out = execFileSync("ps", ["-eo", "command"], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((line) => line.includes("appserver-launcher.cjs") && line.includes(`--cwd ${cwd}`));
  } catch {
    return [];
  }
}
