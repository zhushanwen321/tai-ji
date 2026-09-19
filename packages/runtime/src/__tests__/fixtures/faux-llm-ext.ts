/**
 * faux LLM 轨的测试专用 pi extension（pi 子进程内经 jiti 加载，勿 import 本文件——
 * 它只作为 `--extension` 参数被 spawnPiFixture 注入）。
 *
 * 职责：把 pi-ai 的 fauxProvider 注册为 pi 的 native provider（pi.registerProvider 的
 * native Provider 重载，0.84.4 实装），响应脚本从 env TAIJI_FAUX_SCRIPT 指定的 JSON
 * 文件读取（声明式、可序列化）。这是「真 pi 进程 + 真 extension 加载 + 假 LLM」注入
 * 路径的唯一 provider 挂载点——pi CLI bundle 无 faux，extension 注册是唯一通道。
 *
 * 跨进程契约：ScriptedStep 的 SSOT 是 ../equivalence/pi-fixture.ts（fixture 写 JSON，
 * 本文件读同构形态翻译）；两边类型靠序列化边界耦合，改动须两侧同步。
 *
 * 模型清单（四演员，语义由 pi-ai dist/models.js getSupportedThinkingLevels 锁定）：
 * - faux-1（reasoning:false）：spawnPiFixture faux 通道的默认 --model；档位恒 ['off']，
 *   是 thinking-level 钳制用例的确定性演员。
 * - faux-1-reasoning（reasoning:true，无 thinkingLevelMap）：档位
 *   ['off','minimal','low','medium','high']，是 thinking-level 正常档位用例的确定性
 *   演员——两演员让 thinking-level-effective-e2e 摆脱宿主 models.json 内容依赖。
 * - faux-1-b / faux-1-c（reasoning:false）：纯槽位演员，供「同一次装配内多个子进程需
 *   各自独立响应队列」的场景区分个体——subagent 探针（已随 collect 退役删除，git 可追溯；
 *   L2.5 faux 通道）的主 pi 与 N 个 subagent 子进程共享同一 TAIJI_FAUX_SCRIPT，靠
 *   model-keyed 脚本（见 loadScript）+ 各自 --model 选队：主 = faux-1-reasoning，
 *   子按派发时的 model 覆盖落到 b/c 槽位。行为差异全部由脚本步骤定义，模型本身无语义。
 * auth 恒 `{auth:{}}` 无需凭据（faux 实装），cost 恒 0，零网络——凭证无关/CI 可跑的机制基础。
 *
 * 双注册（e2e real 轨需求，2026-09-15）：同一 createFauxCore 实例同时挂两处——
 * ① pi.registerProvider（pi 主 loop 的 provider registry）；② pi-ai compat 的
 * apiProviderRegistry（registerApiProvider）。② 是给 extension 内经 llm-shared
 * callLLM → completeSimple 的调用方（rename-session 标题生成等）——compat 按
 * model.api 查 registry，不注册则抛 "No API provider registered for api: faux"。
 * 双注册共享同一响应队列：主 loop turn 与 extension 内 LLM 调用按全局到达序 shift
 * 消费同一脚本（探针实证 completeSimple 与 streamSimple 均吃到 setResponses 的步骤）。
 * vitest 侧既有消费者（pi-fixture / equivalence / idle-pi-reclaim）不走 compat 通道，
 * 行为不变；fauxProvider() 换 createFauxCore + createProvider 等价组合（fauxProvider
 * 内部即此组合，见 pi-ai dist/providers/faux.js）。
 *
 * reload 防重播种（进程级 once，见 factory 内 setResponses 守卫）：pi reload 重跑 factory 时
 * 跳过播种——响应队列跨 reload 不回卷，reload 后的后续 turn 命中 faux 耗尽 error 是预期形态。
 * 依赖「reload 后队列重置」的消费者不存在（2026-09-19 排查：全部消费者中仅 skill-reload 三
 * spec 触发 reload，其余 e2e/runtime 单测均为单次加载，once 守卫对其零行为差异）。
 */
import { readFileSync } from 'node:fs'
import {
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxThinking,
  type Provider,
  type AssistantMessage,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { registerApiProvider } from '@earendil-works/pi-ai/compat'

/**
 * pi ExtensionAPI 的最小消费面。本文件被 pi 子进程 jiti 加载，且 runtime 不依赖
 * pi-coding-agent 包（无法 import 完整 ExtensionAPI 类型）——结构化最小类型 +
 * 运行时收窄（asPiApi），不使用 any。
 */
interface MinimalPiExtensionApi {
  registerProvider(provider: Provider): unknown
}

/** 声明式响应步骤（同构副本，SSOT 见文件头；字段语义见 pi-fixture.ts ScriptedStep 注释） */
interface ScriptedStep {
  thinking?: string
  text?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  /** 缺省推导：error → 'error'；toolCalls 非空 → 'toolUse'；否则 'stop' */
  stopReason?: 'stop' | 'toolUse' | 'error' | 'aborted'
  error?: string
}

/** 运行时收窄 pi extension 入参（jiti 加载下无类型保障，缺 registerProvider 即 fail-fast）。 */
function asPiApi(pi: unknown): MinimalPiExtensionApi {
  if (typeof pi !== 'object' || pi === null) {
    throw new Error(`faux-ext: pi extension api 非对象（${typeof pi}）`)
  }
  if (typeof (pi as Record<string, unknown>)['registerProvider'] !== 'function') {
    throw new Error('faux-ext: pi extension api 缺 registerProvider 方法（pi 版本漂移？核对 0.84.x ExtensionAPI）')
  }
  return pi as MinimalPiExtensionApi
}

/** 读取并校验响应脚本 JSON。两种形态：
 *  - 数组：统一队列（spawnPiFixture faux 通道唯一形态——所有 turn 按序消费同一队列）；
 *  - 对象（model-keyed，subagent 探针通道）：{ "provider/id" | "id": ScriptedStep[] }，
 *    按本进程 argv 的 --model 值选队（subagent 树内主/子进程共享同一脚本文件与 env，
 *    以模型身份区分队列；key 匹配先全形后裸 id，:level 后缀剥除后比对）。 */
function loadScript(scriptPath: string): ScriptedStep[] {
  const parsed: unknown = JSON.parse(readFileSync(scriptPath, 'utf-8'))
  if (Array.isArray(parsed)) return parsed as ScriptedStep[]
  if (typeof parsed === 'object' && parsed !== null) {
    const ref = selfModelRef()
    if (ref === undefined) {
      throw new Error(`faux-ext: 脚本为 model-keyed 对象但本进程 argv 无 --model（${scriptPath}）——统一队列请用数组形态`)
    }
    const map = parsed as Record<string, unknown>
    const bareId = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref
    const chosen = map[ref] ?? map[bareId]
    if (!Array.isArray(chosen)) {
      throw new Error(`faux-ext: model-keyed 脚本缺本进程模型 "${ref}" 的步骤数组（keys: ${Object.keys(map).join(', ')}；${scriptPath}）`)
    }
    return chosen as ScriptedStep[]
  }
  throw new Error(`faux-ext: TAIJI_FAUX_SCRIPT 内容必须是步骤数组或 model-keyed 对象，实际 ${typeof parsed}（${scriptPath}）`)
}

/** 本进程的 --model 词形（剥 :level 后缀）。无 --model 返回 undefined。 */
function selfModelRef(): string | undefined {
  const argv = process.argv
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--model') {
      const raw = argv[i + 1] ?? ''
      return raw.split(':')[0] ?? raw
    }
  }
  return undefined
}

/** 声明式步骤 → faux AssistantMessage（队列元素形态，逐轮 shift 消费）。 */
function toAssistantMessage(step: ScriptedStep): AssistantMessage {
  const blocks: Array<ReturnType<typeof fauxThinking> | { type: 'text'; text: string } | ReturnType<typeof fauxToolCall>> = []
  if (step.thinking !== undefined) blocks.push(fauxThinking(step.thinking))
  if (step.text !== undefined) blocks.push({ type: 'text', text: step.text })
  for (const tc of step.toolCalls ?? []) {
    blocks.push(fauxToolCall(tc.name, tc.args as ToolCall['arguments']))
  }
  const stopReason =
    step.stopReason ?? (step.error !== undefined ? 'error' : step.toolCalls !== undefined && step.toolCalls.length > 0 ? 'toolUse' : 'stop')
  return fauxAssistantMessage(blocks, {
    stopReason: stopReason as AssistantMessage['stopReason'],
    errorMessage: step.error,
  })
}

/** 防重播种的进程级单例槽（Symbol.for 同 key 即同一 symbol，跨 jiti 模块实例共享——理由见 factory 内守卫注释） */
const SEEDED_KEY = Symbol.for('@taiji/faux-llm-ext.seeded')

export default function fauxLlmExtension(pi: unknown, _context: unknown): void {
  const scriptPath = process.env['TAIJI_FAUX_SCRIPT']
  if (scriptPath === undefined || scriptPath === '') {
    throw new Error('faux-ext: TAIJI_FAUX_SCRIPT env 未设置（响应脚本 JSON 路径）')
  }
  // 可选流控：tokensPerSecond > 0 才生效（token 级流式切块节奏），否则不限速
  const tpsRaw = Number(process.env['TAIJI_FAUX_TPS'] ?? '0')
  const tokensPerSecond = Number.isFinite(tpsRaw) && tpsRaw > 0 ? tpsRaw : undefined

  const core = createFauxCore({
    provider: 'faux',
    api: 'faux',
    tokensPerSecond,
    models: [
      {
        id: 'faux-1',
        name: 'Faux 1 (reasoning off)',
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: 'faux-1-reasoning',
        name: 'Faux 1 Reasoning (reasoning on)',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: 'faux-1-b',
        name: 'Faux 1 B (slot actor for per-child scripts)',
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: 'faux-1-c',
        name: 'Faux 1 C (slot actor for per-child scripts)',
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  })

  // 防重播种（进程级 once）：pi reload 会重跑本 factory——resource-loader reload() 先
  // clearExtensionCache（缓存清空 + generation++），loadExtensionsCached 未命中后经 jiti
  // （moduleCache:false）重新求值本模块文件，模块级 flag 随新模块实例重置而无效，必须用
  // Symbol.for 进程级单例槽跨 jiti 实例存活（pi-subagents workflow-domain-state 同族防线）。
  // 无守卫时 reload 把响应队列重置回队首 → 完成通知 triggerTurn 后主 agent 重放 toolCall 步 →
  // 幽灵 round-2 run（skill-reload e2e 托盘收口断言假红的根因）。跳过播种后新 core 队列为空，
  // reload 后的后续 turn 命中 faux 耗尽语义（pi-ai "No more faux responses queued" error），
  // 与真实 LLM「回文本、不重跑工具」在「不再派发工具」上等价。
  if (Reflect.get(globalThis, SEEDED_KEY) !== true) {
    core.setResponses(loadScript(scriptPath).map(toAssistantMessage))
    Reflect.set(globalThis, SEEDED_KEY, true)
  }
  // 与 fauxProvider() 等价的 provider 组装（auth 形态照抄 pi-ai dist/providers/faux.js）
  const provider: Provider = createProvider({
    id: core.provider,
    auth: { apiKey: { name: 'Faux', resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: core.stream,
      streamSimple: core.streamSimple,
      fetchDeferred: core.fetchDeferred,
      cancelDeferred: core.cancelDeferred,
    },
  })
  // 双注册的第二处（见文件头「双注册」注释）：compat apiProviderRegistry 共享同队列
  registerApiProvider(
    { api: core.api, stream: core.stream, streamSimple: core.streamSimple },
    'taiji-faux-llm-ext',
  )
  asPiApi(pi).registerProvider(provider)
}
