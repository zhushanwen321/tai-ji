// registry.test.ts —— subagent-workflow C08 簇合并产物（round5-G）。
// 共同被测业务模块：`core:@zhushanwen/subagent-core/execution/engine/registry.ts`。mock 相容：单侧 mock @zhushanwen/subagent-core/core/logger.ts——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/conversation-wiring.test.ts（2 用例，skip 0）
//   - src/__tests__/engines-declaration.test.ts（2 用例，skip 0）
//   - src/__tests__/injector-chain-order.test.ts（11 用例，skip 0）
//   - src/__tests__/transparent-resume.test.ts（8 用例，skip 0）
//   - src/injectors/__tests__/engine-awareness.test.ts（20 用例，skip 0）

import { readFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { dirname, join } from 'node:path'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerFakePiEngine, type FakePiEnginePort } from '@zhushanwen/subagent-core/testing/execution/__tests__/helpers/fake-engine-port.ts'
import { clearEngines, registerEngine } from '@zhushanwen/subagent-core/execution/engine/registry.ts'
import { ModelConfigService, RecordStore, SubagentService, buildEngineModelsPromptAppend, buildSubagentEngineSection, formatModelList, type EnginePort, type ModelEntry, closeHandler, forkFromHandler, messageHandler, type GlobalConfigReadResult } from '@zhushanwen/subagent-core'
import { type ModelInfo, type ModelRegistryLike } from '@zhushanwen/subagent-core/execution/assembly/model-resolver.ts'
import { resetCoreForTests } from '@zhushanwen/subagent-core/core/host-services.ts'
import { type EnginePort as EnginePortDeep } from '@zhushanwen/subagent-core/execution/engine/port.ts'
import { getEnginesFilePath, syncEnginesFile } from '@zhushanwen/subagent-core/execution/engine/engine-discovery.ts'
import { fileURLToPath } from 'node:url'
import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { MODEL_LIST_GUIDE, setupModelListInjector } from '../injectors/model-list-injector.ts'
import { seedTerminalRecordForSessionFile } from '@zhushanwen/subagent-core/testing/execution/__tests__/helpers/seed-terminal-record.ts'
import { getSubagentSessionDir, getSubagentRecordsDir } from '@zhushanwen/subagent-core/execution/assembly/path-encoding.ts'
import { buildEngineChangeNotice, ENGINE_CHANGE_CUSTOM_TYPE, runEngineAwarenessTurn, type EngineAwarenessDeps, type EngineAwarenessOutcome } from '../injectors/engine-awareness'

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

// ======== 来源：conversation-wiring.test.ts ========
describe("conversation-wiring", () => {
  const STUB_MODEL: ModelInfo = { id: "test-model", name: "Test", provider: "test", reasoning: false };

  /** 最小合法 registry（initModel fail-fast 需要；resolveModel 第三层直接透传 ctxModel）。 */
  function makeEmptyRegistry(): ModelRegistryLike {
    return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
  }

  /** initSession 注入的最小 pi duck-type（同 subagent-service PiLike 形状，结构匹配即可）。 */
  interface PiStub { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    appendEntry(customType: string, data?: unknown): void;
    events: { emit(channel: string, data: unknown): void };
    sendMessage(
      message: { customType: string; content: string; display: boolean; details?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): void;
  }

  function makePi(): PiStub {
    return {
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
      sendMessage: vi.fn(),
    };
  }

  /** 暴露私有 store 的接口（测试专用 cast）。 */
  interface ServiceInternals { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    store: RecordStore;
  }

  // ============================================================
  // 1. 接线层：execute({idleTimeoutMs}) → record 字段 + 派发链
  // ============================================================

  describe("[modeless] idleTimeoutMs 接线：execute → createRecordForMode", () => {
    let agentDir: string;
    let service: SubagentService;
    let store: RecordStore;
    let fake: FakePiEnginePort;

    beforeEach(() => {
      agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-wiring-"));
      const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
      modelService.initModel({
        modelRegistry: makeEmptyRegistry(),
        sessionId: "root-session",
        ctxModel: STUB_MODEL,
      });
      service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "root-session" });
      store = (service as unknown as ServiceInternals).store;
      // 协议替身引擎：run 永不 settle（FakeRun promise 挂起），record 停在 running。
      fake = registerFakePiEngine();
    });

    afterEach(() => {
      service.dispose();
      // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
      clearEngines();
      fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    it("idleTimeoutMs:12345 → 落 record、无 chatMode 键、仍可续聊", async () => {
      const handle = await service.execute({
        task: "keep chatting with me",
        slug: "conv-test",
        idleTimeoutMs: 12345,
      });

      const record = store.getMutable(handle.subagentId);
      expect(record).toBeDefined();
      // idleTimeoutMs 归属 record（全 record 生效的 idle GC 节奏；优先级 参数 > env > 默认）
      expect(record!.idleTimeoutMs).toBe(12345);
      // [modeless] 模式标志消亡：record 级 chatMode 落值不得复活
      expect(Object.keys(record!)).not.toContain("chatMode");
      expect(record!.status).toBe("running");
      // idle 续聊资格 = 引擎能力轴（messageHandler 唯一门槛），与参数/record 形态无关
      expect(service.engineSupportsConversation(record!)).toBe(true);
      // execute 走到首轮派发（engine.run 已派发）——完整接线而非 early return
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      // 会话形态由 resume 锚点承载（协议 run 的 ctx.resume.recordId——[modeless 波2]
      // task.conversation 协议键已删，本轮起「每轮 = 新 run + resume 锚点」唯一形态）
      expect(fake.runs[0].ctx.resume?.recordId).toBe(handle.subagentId);
    });

    it("idleTimeoutMs 缺省 → undefined（不误置）+ 无 chatMode 键 + 仍可续聊（万物可续不依赖参数）", async () => {
      const handle = await service.execute({
        task: "one shot task",
        slug: "oneshot-test",
      });

      const record = store.getMutable(handle.subagentId);
      expect(record).toBeDefined();
      expect(record!.idleTimeoutMs).toBeUndefined();
      expect(Object.keys(record!)).not.toContain("chatMode");
      // 缺省派发同权可续——「一次性 record 不可续」的记录级形态已消亡（原
      // chatMode === false 断言的等价承接）
      expect(service.engineSupportsConversation(record!)).toBe(true);
    });
  });
});

// ======== 来源：engines-declaration.test.ts ========
describe("engines-declaration", () => {
  const ENGINE_ROOTS_ENV = "TAIJI_AGENT_ENGINE_ROOTS";

  const BIN_CONTENT = "#!/bin/sh\nexit 0\n";

  // fixture 引擎包（fake「foo-subagent-cli」：只装包 + manifest，A4 最小形态）
  function makeEnginePkg(rootDir: string, id: string): void {
    const pkgDir = path.join(rootDir, `${id}-subagent-cli`);
    fs.mkdirSync(pkgDir, { recursive: true });
    const binRel = "./dist/cli.mjs";
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: `@test/${id}-subagent-cli`,
        bin: { [`${id}-subagent-cli`]: binRel },
        "taiji": {
          subagentEngine: {
            id,
            bin: `${id}-subagent-cli`,
            protocol: 1,
            capabilities: {
              schemaEnforcement: "emulated",
              steer: "unsupported",
              conversation: "unsupported",
              personaInjection: "prompt",
              eventGranularity: "coarse",
              sandbox: "none",
              sessionRead: "outcome-only",
              resume: "unsupported",
              interrupt: "kill-only",
              permissionMode: "ignored",
              maxTurns: false,
            },
          },
        },
      }),
    );
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, binRel), BIN_CONTENT);
    fs.chmodSync(path.join(pkgDir, binRel), 0o755);
  }

  function stubEngine(id: string): EnginePortDeep {
    return {
      id,
      capabilities: () => ({
        schemaEnforcement: "emulated",
        steer: "unsupported",
        conversation: "unsupported",
        personaInjection: "prompt",
        eventGranularity: "coarse",
        sandbox: "none",
        sessionRead: "outcome-only",
        resume: "unsupported",
        interrupt: "kill-only",
        permissionMode: "ignored",
        maxTurns: false,
      }),
      probe: async () => ({ ok: true, engineVersion: "test", checks: [] }),
      run: async () => {
        throw new Error("unused");
      },
      read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
    };
  }

  let tmpRoot: string;

  let agentDir: string;

  let prevEnvRoots: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "engines-decl-"));
    agentDir = path.join(tmpRoot, "agent");
    prevEnvRoots = process.env[ENGINE_ROOTS_ENV];
    process.env[ENGINE_ROOTS_ENV] = path.join(tmpRoot, "engine-roots");
    clearEngines();
  });

  afterEach(() => {
    if (prevEnvRoots === undefined) delete process.env[ENGINE_ROOTS_ENV];
    else process.env[ENGINE_ROOTS_ENV] = prevEnvRoots;
    resetCoreForTests();
    clearEngines();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  describe("引擎清单派生视图合流（W4：发现器装载 ∪ 组合根注册 → engines.json）", () => {
    it("组合根注册引擎 + 发现的引擎包合流入派生视图（契约 {v:1, engines} 不变）", async () => {
      // 组合根注册点（registerPiEngine/registerZcodeEngine 的 inproc 形态；工厂体同款
      // registerEngine 调用——不 import 引擎内部，用 stub 等价注册点）
      registerEngine("pi", () => stubEngine("pi"));
      registerEngine("zcode", () => stubEngine("zcode"));
      // L1 env 根下的第三方引擎包（A4 最小形态：只装包 + manifest）
      makeEnginePkg(path.join(tmpRoot, "engine-roots"), "foo");

      syncEnginesFile(agentDir);
      const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
      expect(file.v).toBe(1);
      expect(file.engines.sort()).toEqual(["foo", "pi", "zcode"]);
    });

    it("派生视图幂等零写；引擎包卸载 → 下次扫描自动从清单消失（清理通道）", async () => {
      registerEngine("pi", () => stubEngine("pi"));
      makeEnginePkg(path.join(tmpRoot, "engine-roots"), "gone-later");

      syncEnginesFile(agentDir);
      const filePath = getEnginesFilePath(agentDir);
      const statAfterFirst = fs.statSync(filePath);
      syncEnginesFile(agentDir);
      expect(fs.statSync(filePath).mtimeMs).toBe(statAfterFirst.mtimeMs);

      // 包目录移除（引擎卸载）→ 清单收缩，零改 core
      fs.rmSync(path.join(tmpRoot, "engine-roots", "gone-later-subagent-cli"), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
      syncEnginesFile(agentDir);
      const file = JSON.parse(fs.readFileSync(filePath, "utf8")) as SubagentEnginesFile;
      expect(file.engines).toEqual(["pi"]);
    });
  });
});

// ======== 来源：injector-chain-order.test.ts ========
describe("injector-chain-order", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const PKG_ROOT = join(__dirname, "..", "..");

  function readSrc(relPath: string): string {
    return readFileSync(join(PKG_ROOT, relPath), "utf-8");
  }

  const INDEX_TS = join("src", "index.ts");

  const ENGINE_AWARENESS_TS = join("src", "injectors", "engine-awareness.ts");

  /** D7 约束主体：必须恒为注入链尾的 injector setup 函数名。 */
  const CHAIN_TAIL_INJECTOR = "setupEngineAwarenessInjector";

  /** index.ts 注入链全序（注册序 = 段序的唯一表达面，D7）。 */
  const EXPECTED_CHAIN_ORDER = [
    "setupSubagentListInjector",
    "setupWorkflowListInjector",
    "setupModelListInjector",
    "setupEngineAwarenessInjector",
  ];

  interface InjectorCall { // oe-exempt:20260929:framework:测试 fixture 契约类型（mock 桩/断言视图）——dev-0.10.5 已验收代码 merge 带入
    name: string;
    /** 1-based 行号（人可直接跳转 index.ts 定位）。 */
    line: number;
  }

  /**
 * 匹配 `setup…Injector(` 调用点（大小写敏感）。import 语句不含 `(` 不命中；
 * 注释里带调用括号的提及会误命中——index.ts 现状无此形态，未来注释提及请写成
 * 不带括号的 `setupXxxInjector`。
 */
  function findInjectorCalls(src: string): InjectorCall[] {
    const calls: InjectorCall[] = [];
    const pattern = /\b(setup[A-Za-z]*Injector)\s*\(/g;
    for (let m = pattern.exec(src); m !== null; m = pattern.exec(src)) {
      calls.push({ name: m[1]!, line: src.slice(0, m.index).split("\n").length });
    }
    return calls;
  }

  /** 检查失败信息（可操作闭环）：约束依据 + 违例 injector 名与双方行号 + 恢复动作。 */
  function buildChainTailViolationMessage(
    engine: InjectorCall,
    violators: InjectorCall[],
  ): string {
    const violatorList = violators.map((v) => `${v.name} (index.ts L${v.line})`).join(", ");
    return (
      `${CHAIN_TAIL_INJECTOR} 必须恒为 system-prompt 注入链尾（D7 约束：engine-awareness ` +
      `段内容变化只断 system prompt 尾部 cache 前缀——非链尾注册会静默断 KV-cache 前缀）。` +
      `违例：${violatorList} 注册在 ${CHAIN_TAIL_INJECTOR} (index.ts L${engine.line}) 之后。` +
      `恢复：把违例 injector 的 setup 调用移到 ${CHAIN_TAIL_INJECTOR} 之前。`
    );
  }

  // ── 链模拟 fixture（engine-awareness.ts 复刻保真由下方源码锚点检查）────────

  /** pi registry 风格条目（provider models 段数据源；同时充当 ctx.modelRegistry 快照）。 */
  const PROVIDER_ENTRIES: ModelEntry[] = [
    { provider: "zai-coding-cn", id: "glm-5.3", name: "GLM 5.3", reasoning: true, input: ["text"], contextWindow: 200_000 },
    { provider: "minimax-cn", id: "MiniMax-M3", name: "MiniMax M3", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000 },
  ];

  /** zcode 引擎清单（v2 registry 风格 id）。 */
  const ZCODE_MODELS: Array<{ id: string; name?: string }> = [
    { id: "builtin:bigmodel-coding-plan/GLM-5.3", name: "GLM-5.3" },
    { id: "builtin:bigmodel-coding-plan/GLM-5.3-Flash" },
  ];

  /** 模拟 pi 核心 system prompt（engine 追加段之外的全部内容）。 */
  const BASE = "You are a coding agent.\n\n# System\nCore prompt body.";

  /** index.ts 尾部追加模板的分隔符（`${event.systemPrompt}\n\n${append}`）。 */
  const APPEND_SEPARATOR = "\n\n";

  /**
 * engine handler 的追加段拼装（与 engine-awareness.ts setupEngineAwarenessInjector
 * 内 handler 同款：状态段 + 清单段、空段剔除、\n\n 连接）。
 */
  function composeEngineAppend(defaultEngine: string | undefined): string {
    return [buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]
      .filter((part) => part !== "")
      .join("\n\n");
  }

  /** 最小 fake 引擎（引擎清单段渲染只需 listModels）。 */
  function fakeEngine(id: string, models: Array<{ id: string; name?: string }>): EnginePort {
    return {
      id,
      capabilities: () => ({ conversation: "unsupported", steer: "unsupported", sandbox: "none" }),
      probe: async () => ({ ok: true, engineVersion: "test" }),
      run: async () => {
        throw new Error("not used in this test");
      },
      read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
      listModels: () => models.map((m) => ({ ...m })),
    };
  }

  /** 链模拟用 handler 形态（参数收窄到运行时实际消费的字段）。 */
  type ChainHandler = (event: { systemPrompt: string }, ctx: unknown) => unknown;

  /** fake ExtensionAPI：捕获 pi.on 注册的 handler（保持注册序）。 */
  function capturePi(): { handlers: ChainHandler[]; api: ExtensionAPI } {
    const handlers: ChainHandler[] = [];
    const api = {
      on: (_event: string, handler: (...args: unknown[]) => unknown) => {
        // on 的 mock 签名参数为 unknown[]，收窄到两参形态（pi 调用约定恒两参）
        handlers.push(((event: unknown, ctx: unknown) => handler(event, ctx)) as ChainHandler);
      },
    } as unknown as ExtensionAPI;
    return { handlers, api };
  }

  /** 模拟 pi 的 before_agent_start 串联语义：按注册序执行，前序返回的 systemPrompt 作为后序输入。 */
  async function runHandlerChain(handlers: ChainHandler[], initialPrompt: string): Promise<string> {
    let prompt = initialPrompt;
    const ctx = { modelRegistry: { getAvailable: () => PROVIDER_ENTRIES } };
    for (const handler of handlers) {
      const result: unknown = await handler({ systemPrompt: prompt }, ctx);
      // 运行时收窄：handler 返回 { systemPrompt: string } 时替换链上 prompt，否则保持
      if (typeof result === "object" && result !== null && "systemPrompt" in result) {
        const sp: unknown = (result as { systemPrompt: unknown }).systemPrompt;
        if (typeof sp === "string") prompt = sp;
      }
    }
    return prompt;
  }

  // ── 源码锚点检查 ────────────────────────────────────────

  describe("injector 链序源码锚点检查（D7）", () => {
    const src = readSrc(INDEX_TS);
    const calls = findInjectorCalls(src);

    it("检查前提：index.ts 恰好注册一次 engine-awareness injector", () => {
      expect(
        calls.filter((c) => c.name === CHAIN_TAIL_INJECTOR),
        `检查前提失效：${INDEX_TS} 中 ${CHAIN_TAIL_INJECTOR} 调用数应为 1。` +
          `若注册点已迁走，请把本检查与 D7 约束一并迁到新装配点。`,
      ).toHaveLength(1);
    });

    it("index.ts 零直接 pi.on(\"before_agent_start\") 注册——四段注入全部经 setup* 函数（链尾语义精确成立的前提）", () => {
      // D7-④：index.ts 不再有直接 pi.on("before_agent_start") 注册。本断言让
      // 「链尾」语义精确成立；未来若新增直接注册需人工复核段序。
      expect(src.split('pi.on("before_agent_start"')).toHaveLength(1);
    });

    it("注册序恒为 subagents → workflows → models → engine 全序（新增/挪动 injector 需人工复核段序）", () => {
      expect(calls.map((c) => c.name)).toEqual(EXPECTED_CHAIN_ORDER);
    });

    it("engine-awareness 的调用位置在所有其他 setup*Injector 调用之后（逐个比较，新增 injector 自动纳入）", () => {
      const engineCalls = calls.filter((c) => c.name === CHAIN_TAIL_INJECTOR);
      expect(engineCalls.length).toBeGreaterThan(0);
      const engine = engineCalls[0]!;
      // 逐位置比较而非硬编码清单：任何插到 engine-awareness 之后的 injector（含未来
      // 新增）都进 violators → 红。engine-awareness 自身已排除。
      const violators = calls.filter(
        (c) => c.name !== CHAIN_TAIL_INJECTOR && c.line > engine.line,
      );
      expect(violators, buildChainTailViolationMessage(engine, violators)).toEqual([]);
    });

    it("检查不退化为空集：index.ts 还有其他 setup*Injector 调用被覆盖", () => {
      expect(calls.filter((c) => c.name !== CHAIN_TAIL_INJECTOR).length).toBeGreaterThanOrEqual(1);
    });

    it("失败信息可操作：含约束依据（D7/链尾）、违例 injector 名、双方行号与恢复动作", () => {
      // 固定 fixture 锁消息模板——主用例违例时 expect 第二参输出的就是这条消息
      const msg = buildChainTailViolationMessage(
        { name: CHAIN_TAIL_INJECTOR, line: 200 },
        [{ name: "setupNewListInjector", line: 210 }],
      );
      expect(msg).toContain(CHAIN_TAIL_INJECTOR);
      expect(msg).toContain("D7");
      expect(msg).toContain("链尾");
      expect(msg).toContain("setupNewListInjector (index.ts L210)");
      expect(msg).toContain("L200");
      expect(msg).toContain("恢复");
    });

    it("engine handler 唯一注册点在 engine-awareness.ts（恰一处 pi.on(\"before_agent_start\")）", () => {
      const eaSrc = readSrc(ENGINE_AWARENESS_TS);
      // split 长度 2 = 恰一处出现：engine 段 handler 的注册不散落第二处
      expect(eaSrc.split('pi.on("before_agent_start"')).toHaveLength(2);
    });

    it("engine-awareness.ts 渲染调用偏移：状态段/清单段调用在 pi.on 注册之后且状态段先于清单段", () => {
      const eaSrc = readSrc(ENGINE_AWARENESS_TS);
      // engine handler 内渲染调用序：状态段在清单段之前（append 内段序：状态段 → 清单段）。
      // 两个调用在 engine-awareness.ts 中位于同一行（数组字面量），行号无法区分先后——
      // 用字符偏移断言
      const offsetStatusCall = eaSrc.indexOf("buildSubagentEngineSection(defaultEngine)");
      const offsetModelsCall = eaSrc.indexOf("buildEngineModelsPromptAppend(defaultEngine)");
      if (offsetStatusCall < 0 || offsetModelsCall < 0) {
        throw new Error("engine-awareness.ts 中未找到 engine 段渲染调用锚点");
      }
      expect(offsetStatusCall).toBeGreaterThan(eaSrc.indexOf('pi.on("before_agent_start"'));
      expect(offsetStatusCall).toBeLessThan(offsetModelsCall);
    });

    it("链模拟复刻保真锚点：append 拼装形态与生产逐字一致（空段剔除 + \\n\\n 连接 + 尾部追加模板）", () => {
      const eaSrc = readSrc(ENGINE_AWARENESS_TS);
      // 这些锚点保证本文件的 composeEngineAppend / 尾部追加模板与生产拼装
      // （engine-awareness.ts）的一致性——生产形态变化会先在这里红，提醒同步更新链模拟复刻点
      expect(eaSrc).toContain('[buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]');
      expect(eaSrc).toContain('.filter((part) => part !== "")');
      expect(eaSrc).toContain('.join("\\n\\n")');
      expect(eaSrc).toContain("${event.systemPrompt}\\n\\n${append}");
    });
  });

  // ── handler 链模拟（段序行为范围）──────────────────────────

  describe("段序守护：engine 段恒链尾（D7，链模拟）", () => {
    beforeEach(() => {
      clearEngines();
      registerEngine("zcode", () => fakeEngine("zcode", ZCODE_MODELS));
    });

    afterEach(() => {
      clearEngines();
    });

    it("handler 链模拟：按 index.ts 注册序执行后，engine 段位于 provider models 段之后且居尾", async () => {
      const { handlers, api } = capturePi();
      // 真实导入 model list injector（provider models 段的生产渲染路径）
      setupModelListInjector(api);
      // 复刻 engine handler（engine-awareness.ts setupEngineAwarenessInjector）的渲染
      // 拼装部分（检测编排部分归 engine-awareness.test.ts）
      const defaultEngine = "zcode";
      handlers.push((event) => {
        const append = composeEngineAppend(defaultEngine);
        return { systemPrompt: `${event.systemPrompt}${APPEND_SEPARATOR}${append}` };
      });

      const prompt = await runHandlerChain(handlers, BASE);

      const providerIdx = prompt.indexOf("<available_provider_models>");
      const statusIdx = prompt.indexOf("<current_subagent_engine>");
      const zcodeListIdx = prompt.indexOf("<available_zcode_models>");
      expect(providerIdx).toBeGreaterThanOrEqual(0);
      // 段序硬约束：engine 状态段与引擎清单段都在 provider models 段之后
      expect(statusIdx).toBeGreaterThan(providerIdx);
      expect(zcodeListIdx).toBeGreaterThan(providerIdx);
      // 恒链尾：engine 追加段是 prompt 的最后内容
      expect(prompt.endsWith(`${APPEND_SEPARATOR}${composeEngineAppend(defaultEngine)}`)).toBe(true);
      // model list handler 注入形态锚定（BASE + injection 无分隔，生产 handler 同款）
      expect(prompt.startsWith(BASE + formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE }))).toBe(true);
    });

    it("对照：注册序颠倒（engine 先、model list 后）时段序断言必失败——守护有判别力", async () => {
      const { handlers, api } = capturePi();
      const defaultEngine = "zcode";
      handlers.push((event) => {
        const append = composeEngineAppend(defaultEngine);
        return { systemPrompt: `${event.systemPrompt}${APPEND_SEPARATOR}${append}` };
      });
      setupModelListInjector(api);

      const prompt = await runHandlerChain(handlers, BASE);

      // 颠倒后 engine 段跑到 provider models 段之前——证明上一条 it 的断言非平凡
      const providerIdx = prompt.indexOf("<available_provider_models>");
      const statusIdx = prompt.indexOf("<current_subagent_engine>");
      expect(statusIdx).toBeGreaterThanOrEqual(0);
      expect(statusIdx).toBeLessThan(providerIdx);
    });
  });
});

// ======== 来源：transparent-resume.test.ts ========
describe("transparent-resume", () => {
  const IDENTITY_ENV_KEYS = [
    "PI_SUBAGENT_ROOT_SESSION_ID",
    "PI_SUBAGENT_SELF_RECORD_ID",
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_ROOT_CWD",
    "PI_SUBAGENT_FORK_DEPTH",
  ] as const;

  function makePi() {
    return {
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
      sendMessage: vi.fn(),
    };
  }

  /** 写一个最小合法 subagent session.jsonl。identity 前置 model_change/thinking_level_change——
 *  light 重建只从头两处 change entry 读 model/thinkingLevel（parseIdentityFromText 找到
 *  identity 即停），respawn 时经 record identity 复原进 SpawnResumeOpts（防漂移）。 */
  function writeSessionJsonl(
    sessionsDir: string,
    identity: {
      id: string;
      rootSessionId: string;
      parentRecordId?: string;
      depth?: number;
      worktree?: boolean;
    },
  ): string {
    const file = path.join(sessionsDir, `${identity.id}.jsonl`);
    const startedAt = 1_700_000_000_000;
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess-uuid",
        timestamp: new Date(startedAt).toISOString(),
        cwd: "/tmp",
      }),
      JSON.stringify({ type: "model_change", provider: "p", modelId: "m-1" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
      JSON.stringify({
        type: "custom",
        id: "id-1",
        parentId: null,
        timestamp: new Date(startedAt).toISOString(),
        customType: "subagent-identity",
        data: {
          id: identity.id,
          agent: "general-purpose",
          mode: "background",
          task: "disconnected predecessor task",
          slug: identity.id.replace(/^sa-/, ""),
          startedAt,
          rootSessionId: identity.rootSessionId,
          ...(identity.parentRecordId !== undefined ? { parentRecordId: identity.parentRecordId } : {}),
          ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
          ...(identity.worktree !== undefined ? { worktree: identity.worktree } : {}),
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: "id-1",
        timestamp: new Date(startedAt + 1000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "predecessor progress" }],
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
          stopReason: "stop",
          timestamp: startedAt + 1000,
        },
      }),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
    return file;
  }

  /** 存量 .cancelled sidecar 残留 fixture。收条 sidecar 读侧已退场（③）：本文件在场
 *  不参与任何判定（惰性残留），仅用于验证带此残留的 record 照常被识别与放行。 */
  function writeTombstone(sessionFile: string, id: string): void {
    fs.writeFileSync(
      `${sessionFile}.cancelled`,
      `${JSON.stringify({ id, status: "cancelled", agent: "general-purpose", startedAt: 1, endedAt: 2 })}\n`,
      "utf-8",
    );
  }

  /** [W1 / D3] 读 record 事件文件的帧序列（type；round-started 帧附 `:round`）。
 *  [W1 / D1] 停写 v1 快照后运行态事实源 = 事件文件——轮次/收尾的写入 journal 记录断言改锚
 *  帧序列；路径推导与 SubagentService 装配同源（getSubagentRecordsDir）。 */
  function readRecordEventFrames(id: string): string[] {
    const eventsPath = path.join(getSubagentRecordsDir(ROOT_SID), `${id}.events`);
    const raw = fs.readFileSync(eventsPath, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const frame = JSON.parse(l) as { type: string; round?: number };
        return frame.round !== undefined ? `${frame.type}:${frame.round}` : frame.type;
      });
  }

  /** service 的根会话 id（store 目录分区键——sessions/records 同树同键）。 */
  const ROOT_SID = "root-session-cur";

  describe("透明重生 + fork-from 恢复通道（壳侧真链路）", () => {
    let agentDir: string;
    let sessionsDir: string;
    let service: SubagentService;
    let pi: ReturnType<typeof makePi>;
    let fake: FakePiEnginePort;

    beforeEach(() => {
      for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
      agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-transparent-resume-"));
      // [session-store-layout-inversion D2/D3] 数据根经 env 注入（生产链同形态）；
      // sessions/records 两目录由分区键 ROOT_SID 派生（不再有 agentDir/enc 段）。
      vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
      sessionsDir = getSubagentSessionDir(ROOT_SID);
      fs.mkdirSync(sessionsDir, { recursive: true });

      const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
      // [U4] fork-from 放行后真正走到 service.execute 全链——resolveIdentity 需要
      // modelRegistry stub（modelRefFromVerified 调 source.getAvailable()）。
      modelService.initModel({
        sessionId: "root-session-cur",
        ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
        modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
      });
      service = new SubagentService({ cwd: agentDir, modelService });
      pi = makePi();
      service.initSession({ pi, sessionId: ROOT_SID });

      // 协议替身引擎（续聊/fork 恒派发新 run + resume 锚点）。
      fake = registerFakePiEngine();
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      service.dispose();
      // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
      clearEngines();
      await new Promise((r) => setTimeout(r, 0)); // fire-and-forget 收尾链排空
      fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    });

    // ============================================================
    // happy path 帧面：在途中断遗留 → 同 id 重生续写原文件
    // ============================================================

    describe("happy path 帧面", () => {
      it("遗留中断记录（事件流无收条帧）message → 内部状态翻 running + resume 触达 + 原 sessionFile 作为续写目标", async () => {
        // 事件流缺席 = 在途中断形态（重建兜底 idle + interrupted-by-restart）——
        // 万物可续候选，message 同 id 透明重生、续写原文件。
        const file = writeSessionJsonl(sessionsDir, { id: "sa-d-happy", rootSessionId: "root-session-cur" });
        expect(service.queries.findRecord("sa-d-happy")).toBeUndefined(); // 前置：内存无

        const result = await messageHandler(service, { subagentId: "sa-d-happy", text: "continue the work" });
        expect(result.response.delivered).toBe(true);
        // 不开新 JSONL：sessions 目录仍只有原文件一个
        expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))).toEqual([
          "sa-d-happy.jsonl",
        ]);

        // 内部状态翻 running（resurrect 回边生效）
        await vi.waitFor(() => {
          const snap = service.queries.findRecord("sa-d-happy");
          expect(snap?.status).toBe("running");
          expect(snap?.sessionFile).toBe(file); // 身份字段复原：原 session 文件
        });
        const snap = service.queries.findRecord("sa-d-happy");
        // [modeless 波5] chatMode 字段消亡：模式不是 record 状态，message 直接续聊
        expect(snap?.chatMode).toBeUndefined();

        // resume 触达（协议 engine.run 捕获）：原 sessionFile 作为续写锚点传递；
        // model 从 record identity 复原（fixture 的 model_change entry → ctxModel 解析兜底）。
        await vi.waitFor(() => expect(fake.runs.length).toBe(1));
        expect(fake.runs[0].ctx.taskId).toBe("sa-d-happy");
        expect(fake.runs[0].task.prompt).toBe("continue the work");
        expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
        expect(fake.runs[0].ctx.ctxModel).toMatchObject({ provider: "p", id: "m-1" });

        // subagent-record v2 注册条目落盘（[W1 / D1] 停写 v1 快照后 entry 面 = 注册/
        // 终态两条小条目；「状态翻 running」的事实写入 journal 记录 = record-round-started 帧；
        // 事件流缺席的遗留记录重生时补账 created 帧 + 注册条目）。
        const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
        expect(entries.length).toBeGreaterThan(0);
        const lastEntry = entries[entries.length - 1][1] as { v?: number; kind?: string; id?: string };
        expect(lastEntry).toMatchObject({ v: 2, kind: "registered", id: "sa-d-happy" });
        const frames = readRecordEventFrames("sa-d-happy");
        expect(frames).toContain("record-created");
        expect(frames).toContain("record-round-started:0");

        // 重生后的死因语义位已清（无 closed 态残留）
        expect(snap?.closedReason).toBeUndefined();
        expect(snap?.endedAt).toBeUndefined();
      });

      it("完成后轮次收尾并写入 journal 记录（round 从 0 重建推进 → 第二轮 key=id:1 的基数成立），不与终态通知互吞", async () => {
        // 结构性验证：notifier dedup key = `${id}:${round}`；重生记录 round 重建为 undefined →
        // 首轮应答 settle 时 round=(0)+1=1 —— 与旧实例在另一进程的通知互不可见。
        // [W1 / D1·D3] v1 快照 entry 停写后 round 快照位消亡：轮次推进的事实源 = 事件
        // 文件（record-round-started → record-round-idle 帧序）+ 记录态收尾翻边（idle）。
        const file = writeSessionJsonl(sessionsDir, { id: "sa-d-notify", rootSessionId: "root-session-cur" });

        await messageHandler(service, { subagentId: "sa-d-notify", text: "go" });
        // 收链：本轮 detached 协议 run 在用例内 settle（防跨用例竞态）
        await vi.waitFor(() => expect(fake.runs.length).toBe(1));
        fake.runs[0].settle({ content: "revived round" });

        const entries = await vi.waitFor(() => {
          const all = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
          expect(all.length).toBeGreaterThan(0);
          // 轮次推进的事实写入 journal 记录：round-started(round 0) 在前、轮终收条 round-idle 在后
          // ——第二轮 dedup key 的 round 基数（=1）由该记录态派生。
          const frames = readRecordEventFrames("sa-d-notify");
          expect(frames).toContain("record-round-started:0");
          // 轮终收条帧自带累计轮数（[② 读侧换源] round 进帧）：轮终帧 = record-round-idle:1
          // ——第二轮 dedup key 的 round 基数（=1）直接在帧载荷可见。
          expect(frames).toContain("record-round-idle:1");
          expect(frames.indexOf("record-round-idle:1")).toBeGreaterThan(frames.indexOf("record-round-started:0"));
          // 收尾翻边：轮终后记录态 idle（第二轮起 key 正常递增的记录态前提）
          expect(service.queries.findRecord("sa-d-notify")?.status).toBe("idle");
          return all;
        });
        // v2 注册条目在盘（entry 面唯一形态——无 v1 快照、无 round 快照位）
        const last = entries[entries.length - 1][1] as { v?: number; kind?: string };
        expect(last).toMatchObject({ v: 2, kind: "registered" });
      });
    });

    // ============================================================
    // 终态 sidecar 残留惰性（③ 退场后读侧不消费任何收条 sidecar 文件）
    // ============================================================

    describe("终态 sidecar 残留惰性", () => {
      it("旧名空 .finalized 与损坏 .state 残留在场 → 读侧无视（不产出误导死因），记录仍可发现且 message 透明重生", async () => {
        // 两类残留形态并存：旧格式空文件（旧版本写入）+ 现名垃圾内容（外部损坏/手写）。
        // 读侧已整体退场（不读内容、不进缓存戳）：记录按 jsonl identity 正常重建，
        // 死因展示走事件流（缺席 = interrupted-by-restart），不再产出 disconnected/gc。
        const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-legacy", rootSessionId: "root-session-cur" });
        fs.writeFileSync(`${file}.finalized`, "", "utf-8");
        fs.writeFileSync(`${file}.state`, "some random junk", "utf-8");

        const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-legacy");
        expect(rec?.status).toBe("idle");
        expect(rec?.closedReason).toBeUndefined();

        // message 透明重生不受残留影响，续写原文件
        const res = await messageHandler(service, { subagentId: "sa-a2-legacy", text: "hi" });
        expect(res.response.delivered).toBe(true);
        await vi.waitFor(() => expect(fake.runs.length).toBe(1));
        expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
      });
    });

    // ============================================================
    // fork-from 贯通（新 id + prompt 注入 + task.forkSource 协议透传）
    // ============================================================

    describe("fork-from 贯通", () => {
      it("正常接续：done 记录 → 新 id + prompt 注入引导语（含源文件指引面）", async () => {
        const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src", rootSessionId: ROOT_SID });
        // done 形态播种（现行载体）：事件流 record-settled 帧（stopReason=completed）
        seedTerminalRecordForSessionFile(sourceFile, getSubagentRecordsDir(ROOT_SID), {
          stopReason: "completed",
        });

        const result = await forkFromHandler(service, {
          sourceSubagentId: "sa-src",
          prompt: "verify test results first",
        });

        // 返回形状：{ newSubagentId, sourceSessionFile }
        expect(result.response.newSubagentId).toBeTruthy();
        expect(result.response.newSubagentId).not.toBe("sa-src");
        expect(result.response.sourceSessionFile).toBe(sourceFile);
        expect(result.subagentId).toBe(result.response.newSubagentId);

        // prompt 注入：task = 用户指令在前 + 接续框架在后（--fork 上下文重建要求）。
        await vi.waitFor(() => expect(fake.runs.length).toBe(1));
        expect(fake.runs[0].task.prompt).toContain("verify test results first");
        expect(fake.runs[0].task.prompt).toMatch(/inherited conversation via --fork/);
        // fork 源 sessionFile 透传到协议 run 帧 task.forkSource（载体 = SDK AgentCallOpts.
        // forkSource，pi 引擎侧 buildSpawnArgs --fork 已有专项直测，两层合成覆盖全链）。
        expect(fake.runs[0].task.forkSource).toBe(sourceFile);

        expect((service.queries.findRecord(result.response.newSubagentId))?.status).toBe("running");
        expect((service.queries.findRecord(result.response.newSubagentId))?.slug).toBe("src-resumed");
      });

      it("无 prompt → 注入默认接管框架（reconstruct state 引导语）", async () => {
        const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src2", rootSessionId: ROOT_SID });
        // done 形态播种（载体同上）
        seedTerminalRecordForSessionFile(sourceFile, getSubagentRecordsDir(ROOT_SID), {
          stopReason: "completed",
        });

        await forkFromHandler(service, { sourceSubagentId: "sa-src2" });

        await vi.waitFor(() => expect(fake.runs.length).toBe(1));
        expect(fake.runs[0].task.prompt).toMatch(/taking over work/i);
        expect(fake.runs[0].task.prompt).toMatch(/already done|left unfinished/);
        // 默认 prompt 形态同样携带 fork 源（载体同上）。
        expect(fake.runs[0].task.forkSource).toBe(path.join(sessionsDir, "sa-src2.jsonl"));
      });

      // fork cancelled 放行壳内留一（同契约另一份在 core subagent-actions-core 检查 4
      // 删除条参数化覆盖；此处保留真链路断言更全的一份）。
      it("[U4 守卫 4 删除] cancelled 残留源 → 放行分叉（主动告别不再是 fork 例外）", async () => {
        const file = writeSessionJsonl(sessionsDir, { id: "sa-canxx", rootSessionId: ROOT_SID });
        writeTombstone(file, "sa-canxx");

        const r = await forkFromHandler(service, { sourceSubagentId: "sa-canxx" });
        expect(r.response.newSubagentId).not.toBe("sa-canxx");
        expect(r.response.sourceSessionFile).toBe(file);
        await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      });
    });

    // ============================================================
    // 回归边界：严格语义保持
    // ============================================================

    describe("回归边界", () => {
      it("[U4] close action 对遗留中断 record → 放行（idle 全候选：对已收尾 record 操作 = 幂等收尾/归档）", async () => {
        const file = writeSessionJsonl(sessionsDir, { id: "sa-d-closestrict", rootSessionId: "root-session-cur" });

        // [U4 万物可续] getRecordForAction 冷查不再按 allowReconnect 把门——close 的
        // 归属校验放行（冷查重建注册），closeSubagent 幂等收尾。不触发续聊执行链。
        const r = await closeHandler(service, { subagentId: "sa-d-closestrict" });
        expect(r.response.closed).toBe(true);
        expect(fake.runs.length).toBe(0);
      });

      it("找不到的 id → 原样透传 not found 文案（id 打错场景不受影响，含 id 回显）", async () => {
        await expect(messageHandler(service, { subagentId: "sa-nonexistent", text: "hi" })).rejects.toThrow(
          /not found or not owned by this session: sa-nonexistent/,
        );
      });
    });
  });
});

// ======== 来源：engine-awareness.test.ts ========
describe("engine-awareness", () => {
  // ── 测试数据（engine-awareness 编排侧）──────────────────

  /** ok 态读取结果工厂（config 形状与 sanitize 输出一致）。 */
  function okRead(defaultEngine: string | undefined): GlobalConfigReadResult {
  	return {
  		status: "ok",
  		config: { version: 1, maxConcurrent: 6, ...(defaultEngine !== undefined ? { defaultEngine } : {}) },
  	};
  }

  /** 调用序记录 + 发送捕获的 deps 工厂。 */
  function makeDeps(overrides: Partial<EngineAwarenessDeps> = {}) {
  	const calls: string[] = [];
  	const sent: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
  	const applied: GlobalConfigReadResult[] = [];
  	let lastEngine: string | undefined;
  	const deps: EngineAwarenessDeps = {
  		readConfig: () => okRead(undefined),
  		applyRead: (read) => {
  			calls.push("apply");
  			applied.push(read);
  		},
  		sendMessage: (message) => {
  			calls.push("send");
  			sent.push(message);
  		},
  		getLastEngine: () => lastEngine,
  		setLastEngine: (engine) => {
  			calls.push(`set:${engine}`);
  			lastEngine = engine;
  		},
  		...overrides,
  	};
  	return { deps, calls, sent, applied, getLast: () => lastEngine };
  }

  // ── buildEngineChangeNotice（D4 不含模型清单）────────────

  describe("buildEngineChangeNotice", () => {
  	it("pi 目标：§3.1 文案骨架（zcode → pi），指向 <available_provider_models>", () => {
  		const content = buildEngineChangeNotice("zcode", "pi");
  		expect(content).toBe(
  			[
  				"Subagent default engine changed: zcode → pi (effective this turn).",
  				"Use pi-registry ids from <available_provider_models> for explicit models;",
  				"omit `model` to inherit. The <current_subagent_engine> section reflects the current state.",
  			].join("\n"),
  		);
  	});

  	it("非 pi 目标：指向该引擎清单段 <available_<engine>_models>", () => {
  		const content = buildEngineChangeNotice("pi", "zcode");
  		expect(content).toContain("Subagent default engine changed: pi → zcode (effective this turn).");
  		expect(content).toContain("<available_zcode_models>");
  		expect(content).not.toContain("<available_provider_models>");
  	});

  	it("不含任何模型清单（无 <model> 标签 / 无 provider id 形态，D4）", () => {
  		for (const to of ["pi", "zcode"]) {
  			const content = buildEngineChangeNotice("zcode", to);
  			expect(content).not.toContain("<model>");
  			// provider id 形态：zai-coding-cn/glm-5.3、builtin:bigmodel-coding-plan/... 等
  			expect(content).not.toMatch(/[a-z][\w-]*\/[\w.-]+/i);
  			expect(content).not.toContain("builtin:");
  		}
  	});
  });

  // ── runEngineAwarenessTurn：变更编排 ─────────────────────

  describe("runEngineAwarenessTurn", () => {
  	it("变更触发 apply + 通知 + 记账，顺序硬约束 apply → send → set（D2）", () => {
  		const read = okRead("pi");
  		const { deps, calls, sent, applied } = makeDeps({
  			readConfig: () => read,
  			getLastEngine: () => "zcode",
  		});
  		const result = runEngineAwarenessTurn(deps);
  		expect(result).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
  		expect(calls).toEqual(["apply", "send", "set:pi"]);
  		// 构造性同源：提交到路由缓存的就是本次读取返回的同一对象（非重读、非拷贝）
  		expect(applied[0]).toBe(read);
  		expect(sent).toHaveLength(1);
  		expect(sent[0].customType).toBe(ENGINE_CHANGE_CUSTOM_TYPE);
  		expect(sent[0].content).toContain("zcode → pi");
  	});

  	it("通知消息形态对齐 notifier 约定（display:true + details 携带 from/to，D3/D8）", () => {
  		const { deps, sent } = makeDeps({
  			readConfig: () => okRead("zcode"),
  			getLastEngine: () => "pi",
  		});
  		runEngineAwarenessTurn(deps);
  		expect(sent[0].display).toBe(true);
  		expect(sent[0].details).toEqual({ from: "pi", to: "zcode" });
  	});

  	it("无变更无事：零 apply 零通知零写入", () => {
  		const { deps, calls, sent } = makeDeps({
  			readConfig: () => okRead("zcode"),
  			getLastEngine: () => "zcode",
  		});
  		const result: EngineAwarenessOutcome = runEngineAwarenessTurn(deps);
  		expect(result).toEqual({ outcome: "unchanged", engine: "zcode" });
  		expect(calls).toEqual([]);
  		expect(sent).toHaveLength(0);
  	});

  	it("读失败保持 lastEngine 不动、不 apply 不通知（D5 态 3）", () => {
  		let lastEngine: string | undefined = "zcode";
  		const { deps, calls, sent } = makeDeps({
  			readConfig: () => ({ status: "failed", reason: "Unexpected token in JSON" }),
  			getLastEngine: () => lastEngine,
  			setLastEngine: (engine) => {
  				lastEngine = engine;
  			},
  		});
  		const result = runEngineAwarenessTurn(deps);
  		expect(result).toEqual({ outcome: "read-failed", reason: "Unexpected token in JSON" });
  		expect(calls).toEqual([]);
  		expect(sent).toHaveLength(0);
  		expect(lastEngine).toBe("zcode");
  	});

  	it("ENOENT（absent）= 合法缺省 pi：正常触发变更（D5 态 2）", () => {
  		const read: GlobalConfigReadResult = { status: "absent", config: { version: 1, maxConcurrent: 6 } };
  		const { deps, calls, sent, applied } = makeDeps({
  			readConfig: () => read,
  			getLastEngine: () => "zcode",
  		});
  		const result = runEngineAwarenessTurn(deps);
  		expect(result).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
  		expect(calls).toEqual(["apply", "send", "set:pi"]);
  		// absent 态同样构造性同源（删配置切回缺省也走同一次读取）
  		expect(applied[0]).toBe(read);
  		expect(sent[0].content).toContain("zcode → pi");
  	});

  	it("缺省 config（defaultEngine 字段缺失）diff 基准归一为 pi：zcode → 无字段 视为变更到 pi", () => {
  		const { deps, sent } = makeDeps({
  			readConfig: () => okRead(undefined),
  			getLastEngine: () => "zcode",
  		});
  		const result = runEngineAwarenessTurn(deps);
  		expect(result).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
  		expect(sent[0].content).toContain("zcode → pi");
  	});
  });

  // ── runEngineAwarenessTurn：D1b 基线化 ───────────────────

  describe("runEngineAwarenessTurn lastEngine 基线化（D1b）", () => {
  	it("首 turn lastEngine === undefined：静默基线化为当前值，无伪通知，但 apply 先行（D1b 修订）", () => {
  		const read = okRead("zcode");
  		const { deps, calls, sent, applied, getLast } = makeDeps({
  			readConfig: () => read,
  			// session_start 初始化读失败 → lastEngine 未设置（undefined）
  		});
  		const result = runEngineAwarenessTurn(deps);
  		expect(result).toEqual({ outcome: "baseline", engine: "zcode" });
  		// D1b 修订：基线分支必须先提交读取结果把 Service 缓存对齐到刚读到的现值——
  		// 否则「session_start 读失败缓存回落 + 文件此后被修好」形态下，
  		// 缓存/路由/状态段永停旧值且永不通知
  		expect(calls).toEqual(["apply", "set:zcode"]);
  		// 构造性同源：基线分支提交的也是本次读取的同一对象
  		expect(applied[0]).toBe(read);
  		expect(sent).toHaveLength(0);
  		expect(getLast()).toBe("zcode");
  	});

  	it("基线化后再 turn 读到同值 → unchanged（基线生效，且 unchanged 仍零调用）", () => {
  		let lastEngine: string | undefined;
  		const { deps, calls, sent } = makeDeps({
  			readConfig: () => okRead("zcode"),
  			getLastEngine: () => lastEngine,
  			setLastEngine: (engine) => {
  				lastEngine = engine;
  			},
  		});
  		expect(runEngineAwarenessTurn(deps)).toEqual({ outcome: "baseline", engine: "zcode" });
  		expect(runEngineAwarenessTurn(deps)).toEqual({ outcome: "unchanged", engine: "zcode" });
  		// setLastEngine 被本用例 override（写局部变量、不记录 calls），故 calls 仅剩
  		// baseline 分支的 apply；unchanged 分支零调用
  		expect(calls).toEqual(["apply"]);
  		expect(sent).toHaveLength(0);
  	});

  	it("lastEngine === undefined 且读失败：连基线都不做，不写入不通知", () => {
  		const { deps, calls, sent, getLast } = makeDeps({
  			readConfig: () => ({ status: "failed", reason: "EACCES" }),
  		});
  		const result = runEngineAwarenessTurn(deps);
  		expect(result).toEqual({ outcome: "read-failed", reason: "EACCES" });
  		expect(calls).toEqual([]);
  		expect(sent).toHaveLength(0);
  		expect(getLast()).toBeUndefined();
  	});
  });

  // ── 多 session 独立性 ──────────────────────────────────

  describe("runEngineAwarenessTurn 多 session 独立 lastEngine", () => {
  	/**
	 * 模拟 index.ts 装配形态：共享 per-session 状态 Map（sessionState），
	 * 每个 sid 一组 deps（getLastEngine/setLastEngine 绑定各自 sid）。
	 */
  	function makeMultiSessionState() {
  		const lastEngines = new Map<string, string | undefined>();
  		const notices: Array<{ sid: string; content: string }> = [];
  		function depsFor(sid: string, read: () => GlobalConfigReadResult): EngineAwarenessDeps {
  			return {
  				readConfig: read,
  				applyRead: () => {},
  				sendMessage: (message) => {
  					notices.push({ sid, content: message.content });
  				},
  				getLastEngine: () => lastEngines.get(sid),
  				setLastEngine: (engine) => {
  					lastEngines.set(sid, engine);
  				},
  			};
  		}
  		return { lastEngines, notices, depsFor };
  	}

  	it("session1 检测变更不污染 session2 的基线（各自独立边沿）", () => {
  		const { lastEngines, notices, depsFor } = makeMultiSessionState();
  		const readZcode = (): GlobalConfigReadResult => okRead("zcode");
  		const readPi = (): GlobalConfigReadResult => okRead("pi");

  		// 各自首 turn 基线化
  		const sid1 = depsFor("s1", readZcode);
  		const sid2 = depsFor("s2", readPi);
  		expect(runEngineAwarenessTurn(sid1)).toEqual({ outcome: "baseline", engine: "zcode" });
  		expect(runEngineAwarenessTurn(sid2)).toEqual({ outcome: "baseline", engine: "pi" });

  		// session1 的引擎切换（zcode → pi）：session1 收通知，session2 无感知
  		const sid1After = depsFor("s1", readPi);
  		expect(runEngineAwarenessTurn(sid1After)).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
  		// session2 再 turn：仍 unchanged，零通知
  		const sid2After = depsFor("s2", readPi);
  		expect(runEngineAwarenessTurn(sid2After)).toEqual({ outcome: "unchanged", engine: "pi" });

  		expect(notices).toHaveLength(1);
  		expect(notices[0].sid).toBe("s1");
  		expect(lastEngines.get("s1")).toBe("pi");
  		expect(lastEngines.get("s2")).toBe("pi");
  	});
  });

  // ──────────────────────────────────────────────────────────────
  // 引擎切换只变尾部（A8 前置）：复刻 index.ts 装配形态（BASE + provider models
  // 段 + engine 追加段），断言切换前后稳定头部逐字节不变、engine 段恒居尾。
  // 注册序事实由 injector-chain-order.test.ts 源码锚点检查，本处不重复。
  // ──────────────────────────────────────────────────────────────

  /** pi registry 风格条目（provider models 段数据源；同时充当 ctx.modelRegistry 快照）。 */
  const PROVIDER_ENTRIES: ModelEntry[] = [
  	{
  		provider: "zai-coding-cn",
  		id: "glm-5.3",
  		name: "GLM 5.3",
  		reasoning: true,
  		input: ["text"],
  		contextWindow: 200_000,
  	},
  	{
  		provider: "minimax-cn",
  		id: "MiniMax-M3",
  		name: "MiniMax M3",
  		reasoning: true,
  		input: ["text", "image"],
  		contextWindow: 1_000_000,
  	},
  ];

  /** zcode 引擎清单（v2 registry 风格 id）。 */
  const ZCODE_MODELS: Array<{ id: string; name?: string }> = [
  	{ id: "builtin:bigmodel-coding-plan/GLM-5.3", name: "GLM-5.3" },
  	{ id: "builtin:bigmodel-coding-plan/GLM-5.3-Flash" },
  ];

  /** 模拟 pi 核心 system prompt（engine 追加段之外的全部内容）。 */
  const BASE = "You are a coding agent.\n\n# System\nCore prompt body.";

  /** index.ts 尾部追加模板的分隔符（`${event.systemPrompt}\n\n${append}`）。 */
  const APPEND_SEPARATOR = "\n\n";

  /**
 * engine handler 的追加段拼装（与 engine-awareness.ts setupEngineAwarenessInjector
 * 内 handler 同款：状态段 + 清单段、空段剔除、\n\n 连接）。复刻保真由
 * injector-chain-order.test.ts 的源码锚点断言保证。
 */
  function composeEngineAppend(defaultEngine: string | undefined): string {
  	return [buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]
  		.filter((part) => part !== "")
  		.join("\n\n");
  }

  /** 合成一个 turn 的 system prompt 尾部：BASE + provider models 段 + engine 追加段。 */
  function composeTurn(defaultEngine: string | undefined): string {
  	const providerSection = formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE });
  	const afterProvider = providerSection === "" ? BASE : BASE + providerSection;
  	const append = composeEngineAppend(defaultEngine);
  	return append === "" ? afterProvider : `${afterProvider}${APPEND_SEPARATOR}${append}`;
  }

  /** 最大公共前缀长度（逐码元比较；用于「分叉点不早于稳定头部」断言）。 */
  function commonPrefixLength(a: string, b: string): number {
  	const n = Math.min(a.length, b.length);
  	let i = 0;
  	while (i < n && a[i] === b[i]) i++;
  	return i;
  }

  /** 最小 fake 引擎（engine 注入链只用 listModels；其余面走不到）。 */
  function fakeEngine(id: string, models: Array<{ id: string; name?: string }>): EnginePort {
  	return {
  		id,
  		capabilities: () => ({ conversation: "unsupported", steer: "unsupported", sandbox: "none" }),
  		probe: async () => ({ ok: true, engineVersion: "test" }),
  		run: async () => {
  			throw new Error("not used in this test");
  		},
  		read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
  		// 每次调用返回新数组实例（模拟 registry 每 turn 现值）——渲染必须与实例无关
  		listModels: () => models.map((m) => ({ ...m })),
  	};
  }

  /**
 * 断言「从 from 切到 to 时变化只发生在尾部 engine 段」：
 *   - provider models 段及其之前的头部逐字节不变（公共前缀 toBe 级断言）；
 *   - 剥离尾部 engine 追加段后两串余部逐字节相等且恰为稳定头部；
 *   - 分叉点不早于稳定头部末尾（差异绝不侵入 provider models 段）；
 *   - 切换后的引擎追加段恰居 prompt 尾部。
 */
  function expectOnlyTailDiffers(from: string | undefined, to: string | undefined): void {
  	const stableHead = BASE + formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE });
  	const before = composeTurn(from);
  	const after = composeTurn(to);
  	const beforeAppend = composeEngineAppend(from);
  	const afterAppend = composeEngineAppend(to);

  	expect(before).not.toBe(after);
  	expect(before.startsWith(stableHead)).toBe(true);
  	expect(after.startsWith(stableHead)).toBe(true);
  	expect(before.slice(0, before.length - beforeAppend.length - APPEND_SEPARATOR.length)).toBe(
  		stableHead,
  	);
  	expect(after.slice(0, after.length - afterAppend.length - APPEND_SEPARATOR.length)).toBe(
  		stableHead,
  	);
  	expect(commonPrefixLength(before, after)).toBeGreaterThanOrEqual(stableHead.length);
  	expect(after.endsWith(afterAppend)).toBe(true);
  }

  describe("引擎切换只变尾部（A8 前置：变化只断尾部 cache 前缀）", () => {
  	beforeEach(() => {
  		clearEngines();
  		registerEngine("zcode", () => fakeEngine("zcode", ZCODE_MODELS));
  	});

  	afterEach(() => {
  		clearEngines();
  	});

  	it("zcode → pi：provider models 段前缀不变，变化只发生在 engine 段（尾部）", () => {
  		expectOnlyTailDiffers("zcode", "pi");
  	});

  	it("pi → zcode（反向切换）：同款只变尾部", () => {
  		expectOnlyTailDiffers("pi", "zcode");
  	});

  	it("zcode → ghost（配置手误形态）：G4 降级段同样只替换尾部，不破坏前缀", () => {
  		expectOnlyTailDiffers("zcode", "ghost");
  	});
  });

  // ──────────────────────────────────────────────────────────────
  // setupModelListInjector handler：provider models 段的生产渲染路径。
  // model-list-injector 无模块级状态（每次 setup 注册新 handler），静态 import 直测。
  // ──────────────────────────────────────────────────────────────

  describe("setupModelListInjector", () => {
  	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

  	function setupWithRegistry(models: ModelEntry[], fail = false): Handler {
  		const handlers: Record<string, Handler> = {};
  		const pi = {
  			on: (name: string, fn: Handler) => {
  				handlers[name] = fn;
  			},
  		} as unknown as Parameters<typeof setupModelListInjector>[0];
  		setupModelListInjector(pi);
  		const registry = fail
  			? { getAvailable: vi.fn(() => { throw new Error("registry boom"); }) }
  			: { getAvailable: vi.fn(() => models) };
  		const handler = handlers["before_agent_start"];
  		if (!handler) throw new Error("before_agent_start handler not registered");
  		return (event: unknown) => handler(event, { modelRegistry: registry });
  	}

  	it("注册 before_agent_start handler，注入 append 到 systemPrompt 尾部", async () => {
  		const handler = setupWithRegistry([entry()]);
  		const result = (await handler({ systemPrompt: "BASE" }, {})) as {
  			systemPrompt: string;
  		};
  		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
  		expect(result.systemPrompt).toContain("<available_provider_models>");
  		expect(result.systemPrompt).toContain("zai-coding-cn/glm-5.2");
  	});

  	it("空模型列表返回 undefined（不返回 systemPrompt，不干预链）", async () => {
  		const handler = setupWithRegistry([]);
  		const result = await handler({ systemPrompt: "BASE" }, {});
  		expect(result).toBeUndefined();
  	});

  	it("registry 异常被吞掉（fail-safe，不阻断 agent turn）", async () => {
  		const handler = setupWithRegistry([], true);
  		const result = await handler({ systemPrompt: "BASE" }, {});
  		expect(result).toBeUndefined();
  	});
  });

  // ── formatModelList guide 全量快照（壳自有文案唯一字节锁）──

  function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  	return {
  		provider: "zai-coding-cn",
  		id: "glm-5.2",
  		name: "GLM 5.2",
  		reasoning: true,
  		input: ["text"],
  		contextWindow: 200_000,
  		...overrides,
  	};
  }

  describe("formatModelList guide 全量快照（MODEL_LIST_GUIDE 唯一字节锁）", () => {
  	it("guide 文案全量锚定：骨架 + 引导语 + 条目模板测试内硬编码快照（改写 MODEL_LIST_GUIDE 即红灯）", () => {
  		// 渲染算法契约（排序/caps/转义/空列表）由 core injection-render byte-exact
  		// parity 承载；本条锁壳侧 guide 文案本体（期望值不插值生产常量——文案两侧
  		// 同源插值时漂移无检查，故硬编码）
  		const out = formatModelList([
  			entry({ provider: "p", id: "m", name: "N" }),
  		], { guide: MODEL_LIST_GUIDE });
  		expect(out).toBe(
  			`\n\n<available_provider_models>\nThe following models are available (auth-configured). Use these ids when delegating via the subagent/workflow \`model\` param ("provider/modelId" format) to match the task (e.g. vision models for screenshots, strong reasoners for architecture). Do NOT switch the main conversation model mid-session — per-call model override on delegates only (switching the main model is cache-hostile); use the /model command only when the user explicitly asks to change it.\n  <model><id>p/m</id><name>N</name><caps>reasoning</caps><contextWindow>200000</contextWindow></model>\n</available_provider_models>`,
  		);
  	});
  });
});
