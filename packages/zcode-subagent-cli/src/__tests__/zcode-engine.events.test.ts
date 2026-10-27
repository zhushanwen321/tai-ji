// zcode-engine.events.test.ts —— zcode 引擎接线主套件：事件流/回调时点/能力声明/连接复用。
//
// 拆分自 zcode-engine.test.ts（单文件 61 例是整包墙钟的临界路径）；用例体与
// describe 名逐字保留，共享夹具见 zcode-engine-harness.ts。
//
// 覆盖：事件时序前移（text_delta 流式 + 终态 message_end/turn_end + resolve 严格晚于
// 末事件——不变量 2）/ usage 映射（与 parser.mapZcodeUsage 同源）/ 工具执行期 activity
// 透出 / onHandleReady 回调时点（create 应答后）/ per-session model 透传 / 共享宿主
// HOME（HOME 正向透传、argv=app-server --cwd engineDataDir、无池 config/lockfile/pidfile）/
// thinkingLevel 透传与提示 / schema 仿真（合法 JSON → parsedOutput、失败重试一轮）/
// 错误规格表（-32603 / -32004 / -32602）/ capabilities 断言（eventGranularity 翻转无
// 下游破坏的生产零消费方检查）/ 跨任务连接复用（boot 1）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 2026-10-27 测试范围收缩：本文件每例经 makeEngine 真实 spawn fake appserver 子进程做协议往返（真进程，
// e2e-map E2E-INTEG-63），整文件迁入集成门控 TAIJI_TEST_INTEGRATION——门控关闭时 skip（名字带 ｜skip：后缀），
// CI 或按改动范围触发时真跑。门控 import 走包内副本 integration-gate.local.ts（SSOT = test-guard/integration-gate.ts）。
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "./integration-gate.local.ts";
import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@zhushanwen/subagent-engine-sdk";
import { getLogger } from "@zhushanwen/subagent-engine-sdk";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import {
  GOLDEN_FULL_TEXT,
  GOLDEN_SESSION_ID,
  PROVIDER,
  bootCount,
  dataDirPath,
  makeCtx,
  makeEngine,
  makeTask,
  readState,
  registerZcodeEngineHarness,
  sentFrames,
} from "./zcode-engine-harness.ts";

registerZcodeEngineHarness();

/** 隔离会话 db 期望值的独立展开（①级读取钥匙）——刻意不 import 实现的
 * zcodeSessionDbPath（自指断言：实现改错时断言仍绿），路径知识独立于实现复述。 */
function expectedSessionDbPath(): string {
  return path.join(dataDirPath(), "engines", "zcode", "session-db", "db.sqlite");
}

/** 与 zcode-engine.ts 同一 facade 单例引用（spy 它的方法即拦截引擎的 warn 出声）。 */
const subagentsLogger = getLogger("subagents");

function bootEnv(stateFile: string): Record<string, unknown> {
  const env = readState(stateFile).find((e) => e.ev === "env");
  return typeof env === "object" && env !== null && !Array.isArray(env) ? env : {};
}

// ============================================================
// 事件时序前移 + usage 映射 + 句柄回调时点（不变量 2/3）
// ============================================================

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `事件流与回调时点（缺省 appserver 路径）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
  it("text_delta 逐个实时流出 + 终态 message_end(usage)/turn_end + resolve 严格晚于末事件", async () => {
    const { engine, workspace } = makeEngine();
    const order: string[] = [];
    const events: AgentEvent[] = [];
    const { handle, outcome } = await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({
        onEvent: (e) => {
          events.push(e);
          order.push(e.type);
        },
      }),
    );
    order.push("resolve");
    expect(order).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "message_end",
      "turn_end",
      "resolve",
    ]);
    // text_delta 逐字（golden pushStream 的三条 session/event delta）
    expect(events[0]).toEqual({ type: "text_delta", delta: "你好" });
    expect(events[1]).toEqual({ type: "text_delta", delta: "，" });
    expect(events[2]).toEqual({ type: "text_delta", delta: "任务完成" });
    // message_end.usage：收尾帧 usage 经 parser.mapZcodeUsage 同源映射
    expect(events[3]).toEqual({
      type: "message_end",
      usage: { input: 12599, output: 17, cacheRead: 0, cacheWrite: 0 },
    });
    expect(events[4]).toEqual({ type: "turn_end" });

    // outcome：content == 全文；usage（orchestration 版，mapZcodeOutcomeUsage 同源）
    expect(outcome.error).toBeUndefined();
    expect(outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    expect(outcome.usage).toEqual({ input: 12599, output: 17, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
    expect(outcome.exitCode).toBe(0);

    // handle 锚定：sessionRef.dbPath = 隔离会话库绝对路径
    // （期望值独立展开，见 expectedSessionDbPath 注释——不调实现函数）
    expect(handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: expectedSessionDbPath() });
    expect(String(handle.data.sessionRef["dbPath"]).startsWith("/")).toBe(true);
  }, 15_000);

  it("[PR3] 工具执行期活性接线：turn 中途 tool.updated progress 帧 → ctx.onEvent 收到 {type:'activity'}（零载荷严格相等）", async () => {
    // 真机探针实证（/tmp/zcode-activity-probe.log，2026-09-10）：工具执行期
    // session/event 每隔 ~1.0s 推 {type:"tool.updated", payload:{kind:"progress",…}}
    // ——既非 final-frame 也非 delta。宿主刷新逻辑只有 delta 事件，该帧族必须经
    // activity 变体透出，否则「仅工具执行、零正文」形态下宿主 30min 中段无进展
    // 守护饿死误杀。引擎接线 = channel onActivity → ctx.onEvent({type:"activity"})。
    const toolUpdatedProgress = JSON.stringify({
      method: "session/event",
      params: {
        sessionId: GOLDEN_SESSION_ID,
        type: "tool.updated",
        payload: {
          toolCallId: "call_e914fc9643b7459da05127a6",
          toolName: "Bash",
          elapsedMs: 2134,
          pid: 2824,
          stdoutBytes: 11,
          stdoutTail: "progress-1\n",
          kind: "progress",
        },
      },
    });
    const { engine, workspace } = makeEngine({
      replaceSendPushes: [
        ...ZCODE_APPSERVER_GOLDEN.pushStream,
        toolUpdatedProgress,
        ZCODE_APPSERVER_GOLDEN.terminal[0],
        ZCODE_APPSERVER_GOLDEN.terminal[1],
      ],
    });
    const events: AgentEvent[] = [];
    const { outcome } = await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({ onEvent: (e) => events.push(e) }),
    );
    expect(outcome.error).toBeUndefined();
    // activity 事件恰一次（一帧一事件）、零载荷字段侧严格相等（无多余键）
    const activities = events.filter((e) => e.type === "activity");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toStrictEqual({ type: "activity" });
    // 事件序：activity 夹在 delta 流与终态合成事件之间（turn 中途到达）
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "activity",
      "message_end",
      "turn_end",
    ]);
  }, 15_000);

  it("回调时点：onHandleReady（create 应答后）先于首事件（[池抽象降级] onPoolResolved 已退役）", async () => {
    const { engine, workspace } = makeEngine();
    const order: string[] = [];
    await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({
        onHandleReady: (partial) => order.push(`handle:${partial.sessionRef["sessionId"]}`),
        onEvent: (e) => {
          if (e.type === "text_delta" && order[order.length - 1] !== "event") order.push("event");
        },
      }),
    );
    expect(order[0]).toBe(`handle:${GOLDEN_SESSION_ID}`);
    expect(order[1]).toBe("event");
  }, 15_000);

  it("共享宿主 HOME：HOME 正向透传、遥测关、argv=app-server --cwd engineDataDir、无池 config/lockfile/pidfile、onChildSpawned 零调用", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    const onChildSpawned = vi.fn();
    const { handle } = await engine.run(makeTask({ cwd: workspace }), makeCtx({ onChildSpawned }));
    // fake 侧 boot env：base env 携带的宿主 HOME 值原样透传（buildAppServerEnv 不覆写
    // HOME 键——launcher 同进程 import() 也不改 env）、遥测 false、统一嵌套标记
    const env = bootEnv(stateFile);
    expect(env["home"]).toBe("/fake-host-home");
    expect(env["telemetry"]).toBe("false");
    expect(env["unifiedNested"]).toBe("1");
    const boot = readState(stateFile).find((e) => e.ev === "boot");
    expect(boot?.["argv"]).toEqual(["app-server", "--cwd", dataDirPath()]);
    // D6：app-server 常驻进程是引擎自管资源（dispose 收割），不进宿主终止链——
    // run 全程 onChildSpawned 不被调用（宿主 killAll 不误杀共享进程）
    expect(onChildSpawned).not.toHaveBeenCalled();
    // 池化时代的产物全部不存在：engines/zcode/ 只含 fs 拦截 launcher 与 session-db/
    // 会话库目录（session-db/ 为 2026-09 会话库隔离新增，W1），无池
    // config/lockfile/pidfile/journal 目录。两侧排序后比较，防 readdir 顺序不稳定
    const engineDir = fs.readdirSync(path.join(dataDirPath(), "engines", "zcode"));
    expect([...engineDir].sort()).toEqual(["appserver-launcher.cjs", "session-db"].sort());
  }, 15_000);

  it("maxTurns（pi 专属）→ 引擎内不再拒绝（[D3-④] 能力拒绝上提宿主 capability-gate，防双轨拦截复活）", async () => {
    // [D3-④ 合并注] capability 拒绝唯一实现 = common/capability-gate（两调用点 = chat 域
    // executeViaEngine 同步段 + SAR run 前，拒绝语义 engine_capability_unsupported 由
    // capability-gate.test.ts 承载）。引擎域 run() 不做 shape 检查——本用例反转回归测试：
    // maxTurns 直传引擎不得再被拒（曾因引擎内残留拦截与 gate 形成双轨）。
    const { engine, stateFile, workspace } = makeEngine();
    const r = await engine.run(makeTask({ cwd: workspace, maxTurns: 10 }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    // 正常走 app-server 流程（create×1——maxTurns 对 zcode 无通道，静默不透传）
    expect(sentFrames(stateFile, "session/create")).toHaveLength(1);
  }, 10_000);

  it("per-session model：create 帧 model={providerId,modelId}（task.model 拆分）+ toolDenylist 透传", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace, denyTools: ["bash", ""] }), makeCtx());
    const create = sentFrames(stateFile, "session/create")[0];
    expect(create.params["model"]).toEqual({ providerId: PROVIDER, modelId: "m1" });
    expect(create.params["toolDenylist"]).toEqual(["bash"]); // 空串过滤
    expect(create.params["workspace"]).toMatchObject({ workspacePath: workspace });
    expect(create.params["mode"]).toBe("yolo");
  }, 15_000);

  // [U4/R4-G3] 缺席模型：create 帧不含 model 键——zcode 走自身缺省解析（用户
  // defaultModelSelection 优先），且缺席跳过 preparer 凭据预校验（D3：正确行为非
  // 放松——本用例 v2 config 仅含 m1 条目，若缺席仍走 fallback 解析链会在无
  // builtin:bigmodel-coding-plan 条目时抛 engine_credential_missing）。
  it.each([undefined, "   "] as const)(
    "task.model 缺席/空白 → create 帧无 model 键（U4：缺席交 zcode 自身缺省解析，跳过凭据预校验）",
    async (model) => {
      const { engine, stateFile, workspace } = makeEngine();
      const { outcome } = await engine.run(makeTask({ cwd: workspace, model }), makeCtx());
      expect(outcome.error).toBeUndefined();
      const create = sentFrames(stateFile, "session/create")[0];
      expect("model" in create.params).toBe(false);
      // 其余键集不受影响（strict 对象仍带 workspacePath/mode）
      expect(create.params["workspace"]).toMatchObject({ workspacePath: workspace });
      expect(create.params["mode"]).toBe("yolo");
    },
    15_000,
  );

  it("thinkingLevel → create 帧 thoughtLevel 透传（F15a：task 声明映射协议通道）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace, thinkingLevel: "high" }), makeCtx());
    const create = sentFrames(stateFile, "session/create")[0];
    expect(create.params["thoughtLevel"]).toBe("high");
  }, 15_000);

  it("thinkingLevel 未传/空白 → create 帧无 thoughtLevel 键（A.2 ① strict 对象不设空键，防 -32602）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace, thinkingLevel: "  " }), makeCtx());
    const create = sentFrames(stateFile, "session/create")[0];
    expect("thoughtLevel" in create.params).toBe(false);
  }, 15_000);

  it("thinkingLevel=medium（非常见档位）→ warn 一行提示且 thoughtLevel 键仍透传（RX2-F1：提示不拦截）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string) => {
      warns.push(msg);
    }) as typeof subagentsLogger.warn);
    try {
      await engine.run(makeTask({ cwd: workspace, thinkingLevel: "medium" }), makeCtx());
    } finally {
      warnSpy.mockRestore();
    }
    // 提示恰一行；措辞是「若不支持将被忽略/回落」的或然警告（core 不做权威值域断言）
    const hits = warns.filter((m) => m.includes("thoughtLevel"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("medium");
    expect(hits[0]).toContain("将被忽略/回落");
    expect(hits[0]).toContain("low/high/max");
    // 透传不拦截：create 帧仍带原值（off/minimal/medium/xhigh 全放行）
    const create = sentFrames(stateFile, "session/create")[0];
    expect(create.params["thoughtLevel"]).toBe("medium");
  }, 15_000);

  it("thinkingLevel=high（常见档位）→ 零 thoughtLevel 提示（RX2-F1：常见档位不出声）", async () => {
    const { engine, workspace } = makeEngine();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string) => {
      warns.push(msg);
    }) as typeof subagentsLogger.warn);
    try {
      await engine.run(makeTask({ cwd: workspace, thinkingLevel: "high" }), makeCtx());
    } finally {
      warnSpy.mockRestore();
    }
    expect(warns.filter((m) => m.includes("thoughtLevel"))).toHaveLength(0);
  }, 15_000);

  it("task.model 缺省 + ctx.ctxModel 存在 → 出声留痕（F16b：ctxModel 是 pi 链路兜底，zcode 不消费）", async () => {
    // [R4/G3] v2 config 无需再补 fallback provider 条目——缺席 model 不再解析
    // ZCODE_FALLBACK_DEFAULT_MODEL，create 不携带 model 键（zcode 自身缺省解析）。
    const { engine, stateFile, workspace } = makeEngine();
    const warns: Array<{ msg: string; data: unknown }> = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string, data: unknown) => {
      warns.push({ msg, data });
    }) as typeof subagentsLogger.warn);
    try {
      const { outcome } = await engine.run(
        makeTask({ cwd: workspace, model: undefined }),
        makeCtx({ ctxModel: { id: "main-model", name: "Main", provider: "p", reasoning: false } }),
      );
      expect(outcome.error).toBeUndefined(); // 信号不阻断任务
      const hit = warns.find((w) => w.msg.includes("ctxModel"));
      expect(hit).toBeDefined();
      expect(hit?.msg).toContain("main-model");
      // [R4/G3] 文案不再声称「实际使用引擎缺省模型 <fallback>」——缺席 = 不携带键
      expect(hit?.msg).toContain("不携带 model 键");
      expect(hit?.msg).toContain("defaultModelSelection");
      // U4：缺席 → create 帧不含 model 键（zcode 自身缺省解析）
      const create = sentFrames(stateFile, "session/create")[0];
      expect("model" in create.params).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("显式 task.model 或 ctx 无 ctxModel → 零 ctxModel 信号（F16b：只在「ctx 有模型但被忽略」时出声）", async () => {
    // 第二段 run（model 缺省）走 create 省略 model 键链（CLI 缺省解析）——无 plan 家族
    // 兜底 id 参与解析（2026-09-29 account 体系迁移后缺席即省略，不伪造）
    const { engine, workspace } = makeEngine();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string) => {
      warns.push(msg);
    }) as typeof subagentsLogger.warn);
    try {
      // 显式 task.model + ctxModel：走正常解析链，不出声
      await engine.run(makeTask({ cwd: workspace }), makeCtx({ ctxModel: { id: "main-model", name: "Main", provider: "p", reasoning: false } }));
      // model 缺省 + ctx 无 ctxModel：预期缺省链，不出声
      await engine.run(makeTask({ cwd: workspace, model: undefined }), makeCtx());
      expect(warns.filter((m) => m.includes("ctxModel"))).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("schema 任务：appserver 路径同接 schema 仿真（合法 JSON → parsedOutput）", async () => {
    const finalText = '{"verdict":"ok"}';
    const { engine, workspace } = makeEngine({
      replaceSendPushes: buildJsonPushes(finalText),
      // read 是全文权威来源——须与收尾帧一致（否则 read 兜底覆盖掉 JSON 全文）
      readResult: { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: finalText }] }] },
    });
    const { outcome } = await engine.run(
      makeTask({ cwd: workspace, schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } }),
      makeCtx(),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });
  }, 15_000);

  it("schema 失败重试一轮：两会话两 send（重试轮独立 create），usage 两轮累计", async () => {
    const { engine, stateFile, workspace } = makeEngine({
      replaceSendPushes: buildJsonPushes("I think everything is fine."),
    });
    // 重试轮仍返回非 JSON（scenario 固化）→ 两轮均失败 → schema_emulation_failed
    const { outcome } = await engine.run(
      makeTask({ cwd: workspace, schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } }),
      makeCtx(),
    );
    expect(outcome.error).toContain("schema_emulation_failed");
    expect(sentFrames(stateFile, "session/create")).toHaveLength(2);
    expect(sentFrames(stateFile, "session/send")).toHaveLength(2);
    // 重试 prompt 带强化指令
    const sends = sentFrames(stateFile, "session/send");
    expect(String(sends[1]?.params["content"])).toContain("Retry: Structured Output Failed");
  }, 15_000);

  it("-32603 'Model config is missing' → engine_credential_missing 归类（outcome 不 reject）", async () => {
    const { engine, workspace } = makeEngine({
      createError: { code: -32603, message: "Model config is missing" },
    });
    const { outcome } = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(outcome.error).toContain("engine_credential_missing");
    expect(outcome.error).toContain("Model config is missing");
  }, 15_000);

  it("create 漂移错误（-32602）→ run-failed outcome 透传 code（R5 降级链地基）", async () => {
    const { engine, workspace } = makeEngine({
      createError: { code: -32602, message: "Invalid params", data: [{ path: ["model"] }] },
    });
    const { outcome } = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(outcome.error).toContain("engine_run_failed");
    expect(outcome.error).toContain("-32602");
  }, 15_000);

  it("-32004 运行中失败 → outcome/handle/错误文案携带会话 id（错误规格表：按任务失败上报含会话 id）", async () => {
    // create 成功（golden 会话）后 send 阶段失败——会话已建立，失败上报必须留痕 id
    const { engine, workspace } = makeEngine({
      sendError: { code: -32004, message: "Session is not active" },
    });
    const { handle, outcome } = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(outcome.error).toContain("engine_run_failed");
    expect(outcome.error).toContain("-32004");
    expect(outcome.error).toContain(GOLDEN_SESSION_ID);
    expect(outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    expect(handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: expectedSessionDbPath() });
  }, 15_000);
});

// ============================================================
// 连接复用（共享宿主 HOME：无凭据刷新机制——登录态轮换后常驻连接用旧凭据，
// 引擎进程重启才生效；跨任务连接复用本身仍是 D1 不变量）
// ============================================================

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `连接复用${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
  it("第二任务复用常驻连接（boot 1），两会话独立 create", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(bootCount(stateFile)).toBe(1);
    expect(sentFrames(stateFile, "session/create")).toHaveLength(2);
  }, 20_000);
});

// ============================================================
// capabilities（D5）+ eventGranularity 生产零消费方检查
// ============================================================

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `capabilities（D5：仅 eventGranularity 变）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
  it("单一 app-server 形态声明 eventGranularity='stream'，其余能力位与设计声明一致", () => {
    const { engine } = makeEngine();
    expect(engine.capabilities()).toEqual({
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "cold",
      personaInjection: "prompt",
      eventGranularity: "stream",
      // [W2/R2] sandbox 位升 emulated（cwd 传导已通，worktree 隔离由公共层承担——
      // W3 交接翻转：带 worktree 任务不再被 capability gate 拒绝）
      sandbox: "emulated",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: false,
      // [subagent-model-switch] zcode 引擎不在模型切换设计范围——unsupported 如实声明
      // （zcode-engine.ts capabilities 快照同源跟随）
      setModel: "unsupported",
    });
  });

  it("eventGranularity 生产零消费方检查：src 内（测试除外）无任何能力位读取访问（翻转无下游破坏）", () => {
    // 扫描根 = 本包 src（设计意图「src 内零消费」）。勿改成 5 级上跳——本文件
    // 在 src/__tests__（比 renderer i18n 用例浅 2 层），5 级会落到 workspace 父目录
    // 扫进所有兄弟 worktree（曾致本用例 3.1s 且耗时随兄弟 worktree 文件量漂移）。
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const consumerAccess = /\.(capabilities\(\)|caps|capabilities)\.eventGranularity\b/g;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          consumerAccess.lastIndex = 0;
          if (consumerAccess.test(text)) offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

/** 造一组「delta 流 + 收尾帧 + read 应答」的 JSON 输出推送（schema 仿真用例）。 */
function buildJsonPushes(finalText: string): string[] {
  return [
    ZCODE_APPSERVER_GOLDEN.pushStream[0],
    ZCODE_APPSERVER_GOLDEN.pushStream[1],
    ZCODE_APPSERVER_GOLDEN.pushStream[2],
    JSON.stringify({
      method: "v4/telemetry/event",
      params: { kind: "turn.terminal", status: "success" },
    }),
    JSON.stringify({
      method: "session/event",
      params: { sessionId: GOLDEN_SESSION_ID, payload: { response: finalText } },
    }),
  ];
}
