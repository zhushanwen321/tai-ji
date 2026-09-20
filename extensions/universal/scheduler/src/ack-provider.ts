import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import type {
  AckAvailability,
  SchedulerCurrentModel,
  SchedulerProviderOverride,
} from './types.js'

const logger = getLogger('scheduler')

// ── 合成流工厂（手写同步流）──
//
// 命令路径创建任务后跑一次「零 token 本地合成轮」，用真 assistant 消息打开 pi 的
// 会话落盘开关（设计 scheduler-command-path-persistence §3.3 D3/D4）。本模块只提供
// 纯工厂 + 可用性判据，注册/注销/编排（单窗口令牌 ackWindow）属 u-ack-turn。
//
// 为什么手写而不是复用 pi-ai 的 faux core：faux 恒填 provider:'faux' 且估算 usage，
// 违反两条不变量 —— 合成行字段必须等于会话真实模型（否则 pi 恢复时静默换模型）、
// usage 必须全 0（否则污染 taiji 的 context 统计）。

/** ack 合成流的构造输入。 */
export interface AckStreamDeps {
  /** 会话当前模型（provider/api/id 三字段直接落到合成消息上）。 */
  model: SchedulerCurrentModel
  /** 确认文案（由 u-ack-fallback 的 i18n 渲染后传入）。 */
  text: string
  /**
   * one-shot 自撤钩子（编排层传入；本单元只保证调用时机）。
   * 必须同步、恰好一次地生效。
   */
  onCalled?: () => void
}

/**
 * 全 0 usage（含 cost）——每次调用新建对象，不复用模块常量：
 * 合成消息会被 pi 的记账链路读取甚至就地累加，共享对象会让多次合成互相污染。
 */
function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * 构造注册到会话当前 provider 的 `streamSimple` 覆写：调用时立即产出确认文案并
 * 以 `stopReason:'aborted'` + `error` 事件终结（零网络、零 token）。
 *
 * `onCalled?.()` 在返回 stream **之前同步**调用（一次）：编排层要在真实模型请求发生前
 * 注销覆写（pi 一旦开始消费本流就不会回落到基座）。若把注销塞进 `queueMicrotask`，
 * 返回点与注销点之间会留下一个可被并发的 register/unregister 穿过的窗口，one-shot
 * 语义（窗口令牌 `registered` 标记）就不再是结构性的。
 *
 * 事件序（在 `queueMicrotask` 内推送，返回后不阻塞调用方）：
 *   start → text_start → text_delta → text_end → error(aborted) → end(final)
 *
 * 为什么终止事件必须是 `error` 而不是 `done`：pi-ai 的 `done.reason` 枚举只有
 * `stop | length | toolUse | deferred`（`pi-ai/dist/types.d.ts` 的
 * `AssistantMessageEvent` 联合），`aborted` 只出现在 `error.reason`（`'aborted' | 'error'`）里。
 * 用 `done` 表达 aborted 会落到非法联合成员上。
 */
export function buildAckStreamSimple(
  deps: AckStreamDeps,
): SchedulerProviderOverride['streamSimple'] {
  return () => {
    deps.onCalled?.()

    const base: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: deps.model.api,
      provider: deps.model.provider,
      model: deps.model.id,
      usage: zeroUsage(),
      stopReason: 'aborted',
      timestamp: Date.now(),
    }
    const final: AssistantMessage = {
      ...base,
      content: [{ type: 'text', text: deps.text }],
    }

    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: base })
      stream.push({
        type: 'text_start',
        contentIndex: 0,
        partial: { ...base, content: [{ type: 'text', text: '' }] },
      })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: deps.text, partial: final })
      stream.push({ type: 'text_end', contentIndex: 0, content: deps.text, partial: final })
      stream.push({ type: 'error', reason: 'aborted', error: final })
      stream.end(final)
    })

    return stream
  }
}

// ── 可用性判据（预计算 + fail-closed）──
//
// 判据在临界区外算好并缓存（u-ack-turn 的武装点同步 registerProvider 不能 await），
// 任一环节失败一律 fail-closed（不覆写 + 如实降级文案），绝不让能力探测炸掉扩展加载。
//
// 为什么内置集合必须用 `builtinProviders()` 而不是 `getBuiltinProviders()`：
// 后者只返回 `Object.keys(MODELS)`（生成目录），而 pi runtime 的 `builtins` 走
// `builtinProviders()`，后者额外含纯动态 provider（如 radius）——用后者判据会把
// radius 误判为「无基座」而放弃覆写。

/** 可用性判据的输入。 */
export interface AckAvailabilityDeps {
  /** 覆写目标 provider id（会话当前 provider）。 */
  providerId: string
  /** 显式禁用开关（如 `TAIJI_SCHED_ACK_DISABLE`）的读取器。 */
  isToggleDisabled: () => boolean
  /** 内置 provider id 集合加载器（可注入，测试用）。 */
  loadBuiltinProviderIds?: () => Promise<Set<string>>
  /** models.json provider id 集合加载器（可注入，测试用）。 */
  loadModelsJsonProviderIds?: () => Promise<Set<string>>
}

/**
 * 默认内置集合加载器。**动态 `import()` 必须留在函数内**：`@earendil-works/pi-ai/providers/all`
 * 是子路径导出，pi 升级若移除/改名它，静态顶层导入会让整个 scheduler 扩展加载失败；
 * 放在函数里则只让本次判据走 fail-closed。
 */
async function loadBuiltinProviderIds(): Promise<Set<string>> {
  const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all')
  return new Set(builtinProviders().map(provider => provider.id))
}

/**
 * 默认 models.json provider id 集合加载器。
 *
 * 读 `<getAgentDir()>/models.json` 的 `providers` 键集合（用户自定义 provider）。
 * 文件不存在 ⇒ 空集合（未配置自定义 provider 的正常形态）；JSON 非法/不可读 ⇒ 抛错，
 * 由 `computeAckAvailability` 收敛为 `check-failed`。
 *
 * `modelsJsonPath` 可选覆盖**仅为可测性**（默认实现内部依赖 `getAgentDir()`，测试无法注入
 * 模块导入；从真实数据目录之外的临时文件验证解析行为）；生产调用不传该参数。
 *
 * 日志纪律：只允许记录 provider id 与错误类型（error name/code）——models.json 的
 * provider 条目含 apiKey，任何形态都不进日志或错误消息。
 */
export async function loadModelsJsonProviderIds(modelsJsonPath?: string): Promise<Set<string>> {
  const path = modelsJsonPath ?? join(await resolveAgentDir(), 'models.json')

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    // 文件不存在 = 正常形态（无自定义 provider），不是失败。
    if (isErrnoException(err) && err.code === 'ENOENT') return new Set()
    throw err
  }

  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return new Set()
  return new Set(Object.keys(parsed.providers))
}

/** `getAgentDir()` 的动态导入（同上：子路径一旦漂移只影响本判据，不影响扩展加载）。 */
async function resolveAgentDir(): Promise<string> {
  const { getAgentDir } = await import('@earendil-works/pi-coding-agent')
  return getAgentDir()
}

/**
 * 预计算 ack 可用性（供编排层缓存，供武装点同步消费）：
 *   ① `isToggleDisabled()` ⇒ `toggle-disabled`
 *   ② providerId ∈ 内置集合（`builtinProviders()`，含 radius）⇒ `available`
 *   ③ providerId ∈ models.json 的 providers ⇒ `available`
 *   ④ 皆否 ⇒ `no-base`
 *   任一环节抛错 ⇒ `check-failed`（永不抛出，保证扩展加载与会话启动不被能力探测拖垮）。
 */
export async function computeAckAvailability(deps: AckAvailabilityDeps): Promise<AckAvailability> {
  try {
    if (deps.isToggleDisabled()) return { available: false, reason: 'toggle-disabled' }

    const builtinIds = await (deps.loadBuiltinProviderIds ?? loadBuiltinProviderIds)()
    if (builtinIds.has(deps.providerId)) return { available: true }

    const modelsJsonIds = await (deps.loadModelsJsonProviderIds ?? loadModelsJsonProviderIds)()
    if (modelsJsonIds.has(deps.providerId)) return { available: true }

    return { available: false, reason: 'no-base' }
  } catch (err) {
    // fail-closed 的诊断通道走 logger.debug（仅文件日志，不进 appendEntry、不进 LLM
    // 上下文）——warn/error 会写 custom entry 到会话 JSONL，而本函数本身就在判断
    // 「会话落盘是否可用」，用会落盘的通道记录判据失败会自造副作用。
    logger.debug('ack availability check failed', {
      provider: deps.providerId,
      error: describeError(err),
    })
    return { available: false, reason: 'check-failed' }
  }
}

// ── 小守卫（禁 any / 免断言）──

/** 是否为带 `code` 的 Node errno 异常（ENOENT 判别用）。 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err
}

/** 是否为普通对象（JSON 形状判别用）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 错误类型最小投影（name + 可选 code）——只取可安全入日志的字段。 */
function describeError(err: unknown): { name: string; code?: string } {
  if (err instanceof Error) {
    const code = isErrnoException(err) ? err.code : undefined
    return code === undefined ? { name: err.name } : { name: err.name, code }
  }
  return { name: typeof err }
}
