/**
 * ModelCapability — 模型能力注册表（pi-boundary-reliability design §3.3 D2 / §5 U5）。
 *
 * ── 格局声明（本仓首次反转，登记于此）────────────────────────────────
 * pi 系包此前刻意保持「仓库根 package.json 声明、runtime 包不可 import」格局
 * （见 infra/pi/__tests__/pi-paths-config-dir-contract.test.ts 头注：根声明仅供
 * 测试静态读 dist）。本模块是该格局的**首次反转**：runtime 由此出现 pi 系包的
 * 运行时 import（@earendil-works/pi-ai）。反转正当性 = 注册表核心承诺——
 * 「这个模型支持什么档位」只有 pi 一个实现副本（pi-ai 自身），taiji 侧零影子
 * 推断（问题类判据 1 的结构性消除）。配套纪律：runtime package.json 的 pi-ai
 * 精确 pin 与根 pin 的双副本一致性不能靠 pnpm（多版本共存合法、frozen-lockfile
 * 不报错），由 D6 版本门禁（check-pi-semantics 四包一致性校验）机器保证；
 * pi-ai 已登记 runtime/tsup.config.ts noExternal（架构规则 #12 ②）。
 *
 * ── 职责（D2 CR-hybrid：离线同源计算 + 在线 RPC 对账）────────────────
 * ① 离线计算：对配置聚合清单逐模型调 pi 同源 getSupportedThinkingLevels 算支持
 *    档位（reasoning 缺失/false → ['off']，与 pi 两级门控逐字节一致），以
 *    view-ready 字段 supportedLevels 随 ProviderInfo.models 下发，renderer 零推导。
 * ② 在线对账：session 附着后经 RpcClient.getAvailableModels 取 pi 合并清单，
 *    与配置聚合比对（配置有而 pi 无 / reasoning 不一致 / 大小写孪生），drift 项
 *    记 runtime 日志 + 事件上报出口。对账结果不缓存不落盘——每次现查现比
 *    （D2：每附着一次对一次）。
 *
 * ── 缓存键（D2 三维度）──────────────────────────────────────────────
 * 缓存键 = pi 版本 + models.json mtime + builtin-providers.json mtime：pi 升级 /
 * 用户改配置 / 内置目录再生成，任一变化即整表作废（防陈旧 + 防膨胀）。键承担
 * 「批量作废」职责；逐模型缓存条目键含 capability 字段签名（reasoning +
 * thinkingLevelMap 排序序列化），正确性不依赖 mtime 新鲜度——值不可能陈旧。
 * builtin-providers.json 是 import inline 打进 bundle 的（provider-config-helper
 * WC1）：vitest / 打包 CJS 下 __dirname 有效可取源文件 mtime；tsx ESM（无
 * __dirname）或 bundle 内无该文件时 stat 失败 → 该组分退化为 'na'（逐模型签名
 * 仍保证正确性，仅失去该维度的批量作废）。
 */
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderInfo } from '@taiji/shared'
import { getModelsPath } from '../infra/pi/pi-paths.js'
import type { AvailableModelSnapshot } from '../infra/pi/rpc-client.js'
import { logger } from '../infra/logger.js'
import { toErrorMessage } from '../utils/errors.js'

/**
 * 能力计算的最小模型形状（ProviderInfo.models 元素 / pi-ai Model 的共同子集）。
 */
export interface ModelCapabilityInput {
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null> | null
}

/**
 * getSupportedThinkingLevels 入参的声明形状（pi-ai Model<TApi>），经函数签名派生——
 * 不在 services 引入 Pi 前缀命名的类型（check_pi_type_leak：此类命名只许 infra/pi 内部）。
 */
type ThinkingLevelModelParam = Parameters<typeof getSupportedThinkingLevels>[0]

/**
 * 离线计算模型支持的思考档位——pi 同源函数的唯一 taiji 侧入口。
 *
 * pi-ai 的 Model<TApi> 声明了 api/provider/cost 等必填字段，但 getSupportedThinkingLevels
 * 实装（0.84.1 dist/models.js）只读 reasoning + thinkingLevelMap（两级门控：!reasoning →
 * ['off']；再按 thinkingLevelMap 过滤 EXTENDED_THINKING_LEVELS）。传最小形状经
 * unknown 收窄与 scripts/diff-probe-thinking.mjs 直调同款；语义锚点由 U7 探针族
 * （pi-semantics）+ diff-probe 接线（改比对对象为本计算路径）持续守卫。
 */
export function computeSupportedLevels(model: ModelCapabilityInput): string[] {
  return getSupportedThinkingLevels(model as unknown as ThinkingLevelModelParam)
}

// ── 缓存键（D2 三维度）──────────────────────────────────────────────

/**
 * builtin-providers.json 源文件路径。vitest（CJS transform）/ tsup CJS bundle 下
 * __dirname 是 Node 注入的模块变量（正常）；tsx ESM 下 undefined → mtime 组分退化为
 * 'na'（架构规则 #12 ① 的既定降级模式，同 cli/resolver.ts）。
 */
const builtinProvidersJsonPath = typeof __dirname !== 'undefined'
  ? join(__dirname, '..', 'generated', 'builtin-providers.json')
  : undefined

function fileMtimeMs(path: string | undefined): number | null {
  if (!path) return null
  try {
    return statSync(path).mtimeMs
  } catch {
    // mtime 不可得（文件不存在 / 不可读 / tsx ESM 下无 __dirname）是既定降级路径：
    // 键组分退化为 'na'，正确性由逐模型签名兜底（见文件头缓存键说明）
    return null
  }
}

/** 组装缓存键：pi 版本 + models.json mtime + builtin-providers.json mtime（含义见文件头）。 */
export function buildCapabilityCacheKey(
  piVersion: string,
  modelsJsonMtimeMs: number | null,
  builtinProvidersMtimeMs: number | null,
): string {
  return `pi:${piVersion}|models.json:${modelsJsonMtimeMs ?? 'na'}|builtin-providers.json:${builtinProvidersMtimeMs ?? 'na'}`
}

/** thinkingLevelMap 稳定签名：key 排序后序列化——同内容不同插入序得同签名。 */
function thinkingLevelMapSignature(map: Record<string, string | null> | null | undefined): string {
  if (!map) return '{}'
  return JSON.stringify(Object.keys(map).sort().map(k => [k, map[k] ?? null]))
}

/**
 * 离线计算缓存 + ProviderInfo.models 标注器（挂入 ModelService，U5 服务面）。
 * compute 可注入——单测断言缓存命中 / 键变更作废行为（计数断言），默认 pi 同源实现。
 */
export class ModelCapabilityRegistry {
  // @data-owner #20（data-source-registry.md）：supportedLevels 派生缓存唯一写方 =
  // levelsFor 签名键 miss 时的 compute（值不可能陈旧）；批量作废键见 currentCacheKey。
  private cacheKey: string | null = null
  private readonly levelsBySignature = new Map<string, string[]>()

  constructor(
    private readonly compute: (m: ModelCapabilityInput) => string[] = computeSupportedLevels,
  ) {}

  /**
   * 当前缓存键（实时读两个 mtime）。piVersion 由调用方传入——消息层 appInfo.piVersion
   * 与 pi 实装同源；缺省 'unknown'（缓存正确性不依赖该组分，见文件头）。
   */
  currentCacheKey(piVersion: string): string {
    return buildCapabilityCacheKey(
      piVersion,
      fileMtimeMs(getModelsPath()),
      fileMtimeMs(builtinProvidersJsonPath),
    )
  }

  /**
   * 给 ProviderInfo.models 逐模型标注 supportedLevels（view-ready，renderer 零推导）。
   * 返回浅拷贝的新数组/新对象，不改入参（广播 payload 原引用复用）。
   */
  attachSupportedLevels(providers: ProviderInfo[], piVersion = 'unknown'): ProviderInfo[] {
    const key = this.currentCacheKey(piVersion)
    if (key !== this.cacheKey) {
      this.cacheKey = key
      this.levelsBySignature.clear()
    }
    return providers.map(p => ({
      ...p,
      models: p.models.map(m => ({ ...m, supportedLevels: this.levelsFor(key, m) })),
    }))
  }

  private levelsFor(cacheKey: string, m: ModelCapabilityInput): string[] {
    const signature = `${cacheKey}|${m.reasoning === true}|${thinkingLevelMapSignature(m.thinkingLevelMap)}`
    let levels = this.levelsBySignature.get(signature)
    if (levels === undefined) {
      levels = this.compute(m)
      this.levelsBySignature.set(signature, levels)
    }
    return levels
  }
}

// ── 在线对账（drift 检测 + 编排）─────────────────────────────────────

/** 对账漂移项（三类，D2 ②；kind 字符串进 runtime 日志供排查检索）。 */
export type CapabilityDrift =
  | { kind: 'config_only'; providerId: string; modelId: string }
  | { kind: 'reasoning_mismatch'; providerId: string; modelId: string; configReasoning: boolean | undefined; piReasoning: boolean }
  | { kind: 'case_twin'; providerId: string; modelId: string; piModelId: string }

/**
 * 纯比对：配置聚合（已启用 provider）vs pi 合并清单。
 * - config_only：配置有而 pi 无全等命中（provider+id），且无大小写孪生；
 * - case_twin：pi 无全等 id 但存在同 provider 下仅大小写不同的 id——models-store
 *   远端目录刷新引入大小写家族条目后 pi pattern 引擎静默换模的事故 A 形态；
 * - reasoning_mismatch：全等命中但归一值不一致（undefined 视为 false，与 pi 两级
 *   门控同款归一）——离线标注与 pi 运行态的档位结论相反。
 * disabled provider（enabled === false）跳过：pi enabledModels 白名单本就不加载它，
 * 比对只会制造噪音。pi 有而配置无的条目不报（清单来源差异是常态，非漂移）。
 */
export function detectCapabilityDrift(
  configProviders: ProviderInfo[],
  piModels: AvailableModelSnapshot[],
): CapabilityDrift[] {
  const exact = new Map<string, AvailableModelSnapshot>()
  const idsByLower = new Map<string, string[]>()
  for (const pm of piModels) {
    const key = `${pm.provider}/${pm.id}`
    exact.set(key, pm)
    const lower = key.toLowerCase()
    const bucket = idsByLower.get(lower)
    if (bucket) bucket.push(pm.id)
    else idsByLower.set(lower, [pm.id])
  }

  const drifts: CapabilityDrift[] = []
  for (const p of configProviders) {
    if (p.enabled === false) continue
    for (const m of p.models) {
      const key = `${p.id}/${m.id}`
      const hit = exact.get(key)
      if (!hit) {
        const twins = (idsByLower.get(key.toLowerCase()) ?? []).filter(id => id !== m.id)
        drifts.push(twins.length > 0
          ? { kind: 'case_twin', providerId: p.id, modelId: m.id, piModelId: twins[0] }
          : { kind: 'config_only', providerId: p.id, modelId: m.id })
        continue
      }
      if ((m.reasoning === true) !== (hit.reasoning === true)) {
        drifts.push({
          kind: 'reasoning_mismatch',
          providerId: p.id,
          modelId: m.id,
          configReasoning: m.reasoning,
          piReasoning: hit.reasoning === true,
        })
      }
    }
  }
  return drifts
}

/**
 * 引擎能力探测：IPiEngine port 尚未声明 getAvailableModels（port 扩面归后续单元），
 * 运行时结构探测——旧引擎 / mock 不带该方法时对账降级跳过而非崩溃。
 */
type ModelsSource = { getAvailableModels(): Promise<AvailableModelSnapshot[]> }

function asModelsSource(engine: unknown): ModelsSource | undefined {
  if (typeof engine !== 'object' || engine === null) return undefined
  const candidate = engine as Partial<ModelsSource>
  return typeof candidate.getAvailableModels === 'function' ? candidate as ModelsSource : undefined
}

export interface CapabilityReconcileDeps {
  sessionId: string
  /** 取该 session 的 pi 引擎（SessionService.getRpcClient → RpcClient 实装）。 */
  getEngine: () => unknown
  /** 配置聚合清单（configService.listProviders；provider 级过滤在 detectCapabilityDrift 内）。 */
  getConfigProviders: () => ProviderInfo[]
  /** 事件上报出口：drift 非空时调用一次。WS 协议消息类型属后续单元，先暴露出口供宿主接线。 */
  onDrift?: (drifts: CapabilityDrift[]) => void
}

/**
 * 在线对账编排：getAvailableModels → detectCapabilityDrift → runtime 日志 + 事件上报。
 * 纯旁路诊断：引擎不可用 / RPC 失败一律降级返回 []，绝不反噬 session 附着主链路；
 * 对账结果不缓存不落盘（每调用一次对一次）。
 */
export async function runCapabilityReconcile(deps: CapabilityReconcileDeps): Promise<CapabilityDrift[]> {
  const source = asModelsSource(deps.getEngine())
  if (!source) {
    logger.info('[model-capability] 对账跳过：pi 引擎不可用或不支持 getAvailableModels', { sessionId: deps.sessionId })
    return []
  }
  let piModels: AvailableModelSnapshot[]
  try {
    piModels = await source.getAvailableModels()
  } catch (e) {
    logger.warn('[model-capability] 对账失败：getAvailableModels RPC 异常', {
      sessionId: deps.sessionId,
      error: toErrorMessage(e),
    })
    return []
  }
  const configProviders = deps.getConfigProviders()
  const drifts = detectCapabilityDrift(configProviders, piModels)
  if (drifts.length === 0) {
    logger.info('[model-capability] 对账通过：配置聚合与 pi 合并清单一致', {
      sessionId: deps.sessionId,
      configProviderCount: configProviders.length,
      piModelCount: piModels.length,
    })
    return []
  }
  logger.warn('[model-capability] 对账发现漂移：配置聚合 ↔ pi 合并清单', {
    sessionId: deps.sessionId,
    drifts,
  })
  deps.onDrift?.(drifts)
  return drifts
}
