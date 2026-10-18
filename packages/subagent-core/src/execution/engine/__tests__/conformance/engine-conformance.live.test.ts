// engine-conformance.live.test.ts —— conformance run 层真机门（基线三层③，W10
// 协议化改写）。手动门（设计 §3.3.8 / §4：run 层需已装引擎 + 有效凭据，不进默认 CI）：
//
//   cd packages/subagent-core
//   ENGINE_CONFORMANCE_LIVE=1 [PI_LIVE_MODEL=... ZCODE_E2E_MODEL=...] \
//     pnpm vitest run src/execution/engine/__tests__/conformance/engine-conformance.live.test.ts
//
// W10 改写：断言对象从内建 inproc 引擎（W11 删除）改为**协议客户端 × 引擎包 CLI**
// （EngineClient spawn pi-subagent-cli 进程入口 + RemoteEngine 适配）——即 A2 真机
// 形态本身。断言口径 = 不变量与关键终态（C2 outcome / C3 stream 事件不变量），
// 不做逐字段 diff（设计 §4 基线三层③）。zcode 部分与 zcode-subagent-cli 的
// zcode-engine.live.test.ts 互补（后者覆盖 schema 全链，此处只跑 conformance 最小子集）。
//
// 措辞口径（R9-1）：「子进程零残留」= 一代子进程 + 组内后代；引擎自身 detached
// 后代不判 fail（设计 §3.9 已接受代价）。POSIX 组探测（childSpawned pid 非组长）
// 由 reverse-router 运行时告警承载，真机验证挂 A3 手动门；Windows 无外部判据显式登记。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ZcodeEngine } from "@zhushanwen/zcode-subagent-cli";

import { EngineClient } from "../../client/engine-client.ts";
import { RemoteEngine } from "../../client/remote-engine.ts";
import type { RunContext } from "../../port.ts";
import type { AgentEvent, EngineCapabilities } from "../../types.ts";
import { SET_MODEL_NOT_ACTIVE_CODE } from "@zhushanwen/subagent-engine-sdk";
import { assertAgentEventInvariants } from "./agent-event-invariants.ts";

const LIVE = process.env["ENGINE_CONFORMANCE_LIVE"] === "1";

// 锚点：本文件在 packages/subagent-core/src/execution/engine/__tests__/conformance/
// 下，6 层 `..` 到 packages/，再进 pi-subagent-cli 的 bin 入口（manifest bin 目标，
// 与发现器可执行检查同源）。曾错写 7 层落到仓库根 → MODULE_NOT_FOUND（Gate B F1.1）。
const PI_CLI_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../pi-subagent-cli/bin/pi-subagent-cli.mjs",
);

/** pi 引擎 capabilities（manifest 同源形态——真机门内 RemoteEngine 同步成员源）。 */
const PI_LIVE_CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "native",
  steer: "native",
  conversation: "native",
  personaInjection: "file",
  eventGranularity: "stream",
  sandbox: "none",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "ignored",
  maxTurns: true,
  setModel: "native",
};

describe.skipIf(!LIVE)("conformance run 层（协议客户端 × 引擎包 CLI，手动门）", () => {
  it("pi：简单任务全链（C2：outcome 无 error、content 非空、engineId=pi；C3 stream 不变量）", async (testCtx) => {
    const model = process.env["PI_LIVE_MODEL"];
    if (model === undefined || model === "") {
      testCtx.skip("PI_LIVE_MODEL 未设置（需真实 provider/model 凭据）——pi live run 面跳过");
      return;
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w10-live-pi-"));
    // 测试侧宿主扩展隔离（Gate B F1.2 裁决）：pi spawn 会加载宿主 ~/.pi/agent/npm
    // 全局扩展，本机版本破碎（subagent-workflow 8.7.0 × subagent-core 0.2.0 exports
    // 失配）时 pi 启动即退出 code 1——真机门要验的是引擎链路不是宿主扩展环境。
    // 隔离由引擎 CLI 的恒定基座保证：buildSpawnArgs 无条件给 pi 子进程注入
    // --no-extensions（pi -ne 语义：settings 清单 discovery 禁用、显式 --extension
    // 白名单仍生效），宿主 settings 发现的扩展不进子进程；CLI 入口自身不解析
    // 扩展 flag，下行 args 的 --no-extensions 无引擎侧消费者。
    const client = new EngineClient({
      engineId: "pi",
      command: process.execPath,
      args: [PI_CLI_ENTRY, "--no-extensions"],
      hostKind: "test",
      hostVersion: "w10-live",
      dataDir,
      envPrefixes: [],
    });
    const engine = new RemoteEngine({
      engineId: "pi",
      client,
      manifest: { capabilities: PI_LIVE_CAPABILITIES },
      dataDir,
      hostKind: "test",
    });
    try {
      const events: AgentEvent[] = [];
      const task = { prompt: "Reply with the single word: ok", description: "live-c2", model, cwd: os.tmpdir() };
      const ctx: RunContext = { taskId: "sa-live-pi-c2", onEvent: (e) => events.push(e) };
      const { outcome } = await engine.run(task, ctx);
      expect(outcome.error).toBeUndefined();
      expect(outcome.content.trim().length).toBeGreaterThan(0);
      expect(outcome.engineId).toBe("pi");
      assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });
    } finally {
      await engine.dispose();
    }
  }, 120_000);

  it("pi：setModel 控制范围最小子集（capabilities 位声明核对 + 已退出 run 的结构化 not-active 错误帧）", async (testCtx) => {
    const model = process.env["PI_LIVE_MODEL"];
    if (model === undefined || model === "") {
      testCtx.skip("PI_LIVE_MODEL 未设置（需真实 provider/model 凭据）——setModel conformance 面跳过");
      return;
    }
    const [provider, modelId] = model.split("/");
    if (provider === undefined || provider === "" || modelId === undefined || modelId === "") {
      testCtx.skip(`PI_LIVE_MODEL 非 provider/modelId 复合形态（${model}）——setModel conformance 面跳过`);
      return;
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w10-live-setmodel-"));
    const client = new EngineClient({
      engineId: "pi",
      command: process.execPath,
      args: [PI_CLI_ENTRY, "--no-extensions"],
      hostKind: "test",
      hostVersion: "w10-live-setmodel",
      dataDir,
      envPrefixes: [],
    });
    const engine = new RemoteEngine({
      engineId: "pi",
      client,
      manifest: { capabilities: PI_LIVE_CAPABILITIES },
      dataDir,
      hostKind: "test",
    });
    try {
      // ① capability 位声明核对（fixture 与 pi 引擎实装 manifest 同源——
      //    pi-engine.ts capabilities 声明 setModel: "native"；RemoteEngine 按该位
      //    门控 setModel 成员）。
      expect(engine.capabilities().setModel).toBe("native");
      expect(typeof engine.setModel).toBe("function");
      // ② 短任务跑完 → pi 孙进程退出（per-run 生命周期）→ setModel 对已退出 run
      //    经协议 error 帧应答结构化 not-active 错误码（§7.4「定位不到」承接态；
      //    热切成功路径的结构化应答侧由 pi-subagent-cli model-switch-control 单测
      //    承担，此处钉住协议 wire 面的请求-错误帧闭环）。
      const task = { prompt: "Reply with the single word: ok", description: "live-setmodel", model, cwd: os.tmpdir() };
      const ctx: RunContext = { taskId: "sa-live-pi-setmodel", onEvent: () => {} };
      const { outcome } = await engine.run(task, ctx);
      expect(outcome.error).toBeUndefined();
      await expect(
        engine.setModel({ runId: ctx.taskId, model: { provider, modelId } }),
      ).rejects.toMatchObject({ code: SET_MODEL_NOT_ACTIVE_CODE });
    } finally {
      await engine.dispose();
    }
  }, 180_000);

  it("zcode：probe 真机（C1 live 面：三项 check 全过）", async () => {
    const engine = new ZcodeEngine({ engineDataDir: () => "/tmp/zcode-conformance-live" });
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toMatch(/^0\.\d+\.\d+$/);
  }, 60_000);

  it("zcode：app-server 常驻通道 run 全链（C2 outcome 无 error + C3 stream 事件不变量）", async (testCtx) => {
    const model = process.env["ZCODE_E2E_MODEL"];
    if (model === undefined || model === "") {
      testCtx.skip("ZCODE_E2E_MODEL 未设置（需真实 provider/model 凭据）——appserver live run 面跳过");
      return;
    }
    const engine = new ZcodeEngine({
      engineDataDir: () => "/tmp/zcode-conformance-live-appserver",
    });
    const events: AgentEvent[] = [];
    const { outcome } = await engine.run(
      { prompt: "Reply with the single word: ok", description: "live-appserver-c2", model, cwd: "/tmp" },
      { taskId: "sa-live-zcode-appserver", onEvent: (e) => events.push(e) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.content.trim().length).toBeGreaterThan(0);
    expect(outcome.sessionId).toMatch(/^sess_/);
    assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });
    await engine.dispose().catch(() => undefined);
  }, 180_000);
});
