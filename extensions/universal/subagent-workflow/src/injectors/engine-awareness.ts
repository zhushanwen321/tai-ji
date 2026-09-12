// src/injectors/engine-awareness.ts
//
// [engine-awareness U3] 引擎感知检测编排。设计权威源：
// docs/design/subagent-engine-awareness-injection.md（已删除，git 可追溯）§2.3 物理数据流 /
// §3.3 D1（per-turn poll）、D1b（lastEngine 初始化与静默基线化）、D2（reload 先行）、
// D3（通知通道）、D5（三态读取语义）。
//
// 职责：per-turn（before_agent_start）三态 poll 全局 config → 与 per-session
// lastEngine diff → 变更时按硬约束顺序编排：提交读取结果到路由缓存（D2，先于一切——
// 只改注入不改路由会出现「prompt 说引擎 B、实际派发跑引擎 A」，权威信息源说谎）
// → sendMessage 对话流通知（D3/D4，短文案不含任何模型清单）→ 更新 lastEngine。
//
// 本模块的编排核心（runEngineAwarenessTurn）是无状态纯编排（依赖注入式，可测）；
// 生产装配在下方 setupEngineAwarenessInjector（D7-④：接线从 index.ts 内联第 4 处
// 收编至此，与另三个 injector 的 setup* 同形）——lastEngine 的 per-session 存取经
// 参数注入（index.ts sessionState 装配），其余宿主能力（readConfig / applyRead /
// sendMessage）在装配函数内组装。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { readGlobalConfig, type GlobalConfigReadResult } from "@zhushanwen/subagent-core";
import { DEFAULT_ENGINE_ID, normalizeEngineId } from "@zhushanwen/subagent-core";
import { buildEngineModelsPromptAppend, buildSubagentEngineSection } from "@zhushanwen/subagent-core";
import { getModelConfigService } from "@zhushanwen/subagent-core";

const logger = getLogger("subagents");

/** 引擎变更通知 customType（D3；renderer/测试按此识别引擎变更消息）。 */
export const ENGINE_CHANGE_CUSTOM_TYPE = "subagent-engine-changed";

/**
 * 引擎变更通知文案（设计 §3.1 英文基准，三行结构逐字骨架；D4：不含任何模型清单，
 * 清单只活在 system prompt 现值一份）。指路段按目标引擎参数化，与
 * <current_subagent_engine> 恒在段的分界语义一致：目标 pi → 指向核心段
 * <available_provider_models>；非 pi → 指向该引擎清单段 <available_<engine>_models>。
 */
export function buildEngineChangeNotice(from: string, to: string): string {
  const modelsLine =
    to === DEFAULT_ENGINE_ID
      ? "Use pi-registry ids from <available_provider_models> for explicit models;"
      : `Use ids from <available_${to}_models> for explicit models;`;
  return [
    `Subagent default engine changed: ${from} → ${to} (effective this turn).`,
    modelsLine,
    "omit `model` to inherit. The <current_subagent_engine> section reflects the current state.",
  ].join("\n");
}

/** 检测编排依赖（注入式）。生产装配在 index.ts engine handler；测试用 stub。 */
export interface EngineAwarenessDeps {
  /** 三态读取全局 config（D5；生产 = () => readGlobalConfig(getAgentDir())）。 */
  readConfig(): GlobalConfigReadResult;
  /**
   * D2：将本 turn 三态读取结果提交路由缓存（生产 = ModelConfigService.applyGlobalConfig，
   * 纯赋值幂等；failed 已由编排层早退，到达此调用的必为 ok/absent）。
   */
  applyRead(read: GlobalConfigReadResult): void;
  /** 对话流通知投递（D3；生产 = pi.sendMessage(message, {})，不设 triggerTurn）。 */
  sendMessage(message: {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }): void;
  /** per-session lastEngine 读取（undefined = 未基线化，D1b）。 */
  getLastEngine(): string | undefined;
  /** per-session lastEngine 写入（仅合法引擎 id，不写 undefined）。 */
  setLastEngine(engine: string): void;
}

/** 单次 per-turn 检测的编排结果（测试断言面 + 诊断留痕消费）。 */
export type EngineAwarenessOutcome =
  | { outcome: "changed"; from: string; to: string }
  | { outcome: "unchanged"; engine: string }
  | { outcome: "baseline"; engine: string }
  | { outcome: "read-failed"; reason: string };

/**
 * 单个 session 的 per-turn 引擎检测编排（§2.3 数据流 ①② 步；③ 渲染归 index.ts）。
 *
 * 分派（D5 三态 × D1b 基线）：
 *   - read failed → 保持 lastEngine 不动、不提交缓存、不通知（防 torn write 瞬间伪通知）；
 *     read-failure warn 日志由 readGlobalConfig 内部落，此处只返回结果。
 *   - lastEngine === undefined（session_start 初始化读失败的兜底形态）→ 静默基线化为
 *     当前目标值：不算变更、不发通知（防「changed: undefined → zcode」首 turn 伪通知）。
 *   - last === target（absent 归一后同值也在内）→ 无事。
 *   - last ≠ target（含 ENOENT=合法缺省）→ 提交缓存先行 → 通知 → 记账，三步同 turn。
 *
 * 抛错面：不主动 try-catch——readGlobalConfig 三态返回不抛，applyRead/sendMessage 的
 * 生产实现各自吞错；handler 顶层 catch 兜底（fail-safe 不阻塞 agent loop）。
 */
export function runEngineAwarenessTurn(deps: EngineAwarenessDeps): EngineAwarenessOutcome {
  const read = deps.readConfig();
  if (read.status === "failed") {
    return { outcome: "read-failed", reason: read.reason };
  }
  const target = normalizeEngineId(read.config.defaultEngine);
  const last = deps.getLastEngine();
  if (last === undefined) {
    // D1b（修订）：基线化前把本 turn 读取结果提交到单例缓存。baseline 形态可能来自
    // session_start 读取失败（lastEngine 未设置 + Service 缓存回落缺省）而文件此后被
    // 修好——若只记账不提交，缓存/路由/状态段永停旧值且永不通知（「改 config 不生效」
    // 以更隐蔽形态复活）。apply 纯赋值——检测值与缓存值构造性同源，重复提交无害。
    deps.applyRead(read);
    deps.setLastEngine(target);
    return { outcome: "baseline", engine: target };
  }
  if (last === target) {
    return { outcome: "unchanged", engine: target };
  }
  // D2 顺序硬约束：先提交读取结果到路由缓存（本 turn 路由 + 渲染同源生效）→ 再通知 → 再记账。
  deps.applyRead(read);
  deps.sendMessage({
    customType: ENGINE_CHANGE_CUSTOM_TYPE,
    content: buildEngineChangeNotice(last, target),
    display: true,
    details: { from: last, to: target },
  });
  deps.setLastEngine(target);
  logger.debug(
    `[engine-awareness] default engine changed: ${last} -> ${target} (route reloaded, notice sent)`,
  );
  return { outcome: "changed", from: last, to: target };
}

// ── 生产装配（D7-④：接线从 index.ts 内联收编为统一 setup 函数）─────────────
//
// 注册链尾 before_agent_start handler：per-turn 检测编排 + 恒在状态段/引擎清单段
// 渲染。原 index.ts 内联第 4 处接线（[engine-awareness U3] 标记区域）收编于此——
// index.ts 的注入链序由四个 setup 调用（subagents → workflows → provider models →
// engine）的先后表达，不再靠内联闭包 + 注释维护。
//
// 编排依据（自 index.ts 随迁的设计注释）：
// - sendMessage 不设 triggerTurn（D3）——切换是用户主动行为，无需唤醒 AI 立即行动；
//   P1 探针已证此形态消息进入本 turn LLM 上下文（证据：真机 pi rpc payload dump +
//   0.84.4 dist sendMessage→_appendCustomMessage→agent.state.messages.push→
//   createContextSnapshot 调用链）。
// - 段序：状态段在前（文案声明 "listed ... below"），清单段在后；provider models 段
//   由更早注册的 handler 注入、位于上方——本 handler 恒链尾注册（D7：段内容变化只断
//   system prompt 尾部 cache 前缀）。apply 后 getGlobalConfig() 即新值——通知、状态段、
//   路由三处同 turn 对齐（G2）。
// - fail-safe：任何异常不注入不阻塞 agent loop；service 未装配（null）或
//   systemPrompt 非 string 同样静默跳过。

/** per-session lastEngine 存取（生产装配由 index.ts sessionState 提供）。 */
export interface EngineAwarenessSessionAccessors {
  /** per-session lastEngine 读取（undefined = 未基线化，D1b）。 */
  getLastEngine(sessionId: string): string | undefined;
  /** per-session lastEngine 写入（仅合法引擎 id，不写 undefined）。 */
  setLastEngine(sessionId: string, engine: string): void;
}

/**
 * 注册引擎感知 before_agent_start handler（链尾）。
 *
 * 每 turn：① runEngineAwarenessTurn 检测编排（§2.3 数据流 ①② 步）；② 恒在状态段
 * <current_subagent_engine>（D6）+ 引擎清单段 <available_<engine>_models> 渲染追加
 * （③ 渲染归本函数）。渲染拼装 = 状态段 + 清单段、空段剔除、\n\n 连接、尾部追加
 * （engine-section-stability.test.ts 的链模拟复刻此形态，源码锚点断言保真）。
 */
export function setupEngineAwarenessInjector(
  pi: ExtensionAPI,
  session: EngineAwarenessSessionAccessors,
): void {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    try {
      const service = getModelConfigService();
      if (service === null || typeof event.systemPrompt !== "string") return undefined;
      const sid = ctx.sessionManager.getSessionId();
      runEngineAwarenessTurn({
        readConfig: () => readGlobalConfig(getAgentDir()),
        applyRead: (read) => service.applyGlobalConfig(read),
        sendMessage: (message) => {
          // D3：不设 triggerTurn——切换是用户主动行为，无需唤醒 AI 立即行动
          pi.sendMessage(message, {});
        },
        getLastEngine: () => session.getLastEngine(sid),
        setLastEngine: (engine) => session.setLastEngine(sid, engine),
      });
      const defaultEngine = service.getGlobalConfig().defaultEngine;
      const append = [buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]
        .filter((part) => part !== "")
        .join("\n\n");
      return { systemPrompt: `${event.systemPrompt}\n\n${append}` };
    } catch {
      return undefined;
    }
  });
}
