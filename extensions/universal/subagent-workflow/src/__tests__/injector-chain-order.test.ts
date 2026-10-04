// injector-chain-order.test.ts —— system-prompt 注入链注册顺序守卫（D7）单点。
//
// index.ts 的注入链序只由 setup*Injector 调用的先后表达（subagent 清单 → workflow
// 清单 → provider models → engine-awareness），无任何运行时检查。D7 硬约束
// （injectors/engine-awareness.ts「生产装配」节注释）：engine-awareness 恒链尾
// 注册——其段落内容变化只断 system prompt 尾部 cache 前缀。新增注入器若插到
// engine-awareness 之后 = 静默断 KV-cache 前缀（无运行时红灯），本守卫把该
// 违例变成测试红灯。
//
// 双层覆盖（本文件是链序源码锚点与链模拟的唯一所在地）：
// 1. 源码锚点：读 src/index.ts / src/injectors/engine-awareness.ts 源文本，
//    锚定「零直接 pi.on 注册 + 四 setup 全序 + engine handler 唯一注册点 +
//    渲染调用偏移 + 链模拟复刻保真串」。源码级断言的脆弱性权衡（刻意为之）：
//    engine handler 的生产实现装配依赖 ModelConfigService 单例与 sessionState
//    存取器（getModelConfigService() 在测试环境恒 null，导入后 handler 直接早退），
//    链模拟仍以复刻形态锚定拼装保真；而 before_agent_start 多 handler 的段序由
//    注册序唯一决定，「注册序」这一事实只存在于 index.ts 源码中——源码结构断言
//    是唯一能锚定它的方式。重构挪动注册位置导致本断言失败属预期行为（提醒同步
//    更新链模拟与守护锚点），不是误报。
// 2. handler 链模拟：真实导入 setupModelListInjector + 复刻 engine handler
//    （engine-awareness.ts 的 setupEngineAwarenessInjector）的渲染拼装（检测编排
//    部分归 engine-awareness.test.ts），模拟 pi 的 before_agent_start 链式叠加
//    语义，断言段序行为面（含判别力对照用例）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  buildEngineModelsPromptAppend,
  buildSubagentEngineSection,
  formatModelList,
  type EnginePort,
  type ModelEntry,
} from "@zhushanwen/subagent-core";
import { clearEngines, registerEngine } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { MODEL_LIST_GUIDE, setupModelListInjector } from "../injectors/model-list-injector.ts";

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

/** 守卫失败信息（可操作闭环）：约束依据 + 违例 injector 名与双方行号 + 恢复动作。 */
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

// ── 链模拟 fixture（engine-awareness.ts 复刻保真由下方源码锚点守卫）────────

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

// ── 源码锚点守卫 ────────────────────────────────────────

describe("injector 链序源码锚点守卫（D7）", () => {
  const src = readSrc(INDEX_TS);
  const calls = findInjectorCalls(src);

  it("守卫前提：index.ts 恰好注册一次 engine-awareness injector", () => {
    expect(
      calls.filter((c) => c.name === CHAIN_TAIL_INJECTOR),
      `守卫前提失效：${INDEX_TS} 中 ${CHAIN_TAIL_INJECTOR} 调用数应为 1。` +
        `若注册点已迁走，请把本守卫与 D7 约束一并迁到新装配点。`,
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

  it("守卫不退化为空集：index.ts 还有其他 setup*Injector 调用被覆盖", () => {
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

// ── handler 链模拟（段序行为面）──────────────────────────

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
