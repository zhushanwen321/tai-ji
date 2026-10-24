/**
 * PluginProviderSource —— Provider 插件来源数据源（provider-plugin-access 设计 U6）。
 *
 * 职责（D1/D5/D9 消费侧）：
 *  - 拉清单：plugin.listAvailable（家族卡数据源 + 本地安装状态 + 更新可用标记）；
 *  - 凭据状态：条目展开 / 页进入经 plugin.invoke 的 getStatus 拉已知状态（拉为主，
 *    ADR-0097/D5），plugin:event 的凭据状态上报作增量提示（推补充——丢失由下一次
 *    展开拉取收敛，不建推送补偿）；宿主只做展示映射，不推断状态（D5）。
 *
 * 状态形态判定（对齐 useWool 先例）：插件来源是**设置域全局状态**（无 sessionId 归属），
 * 非 per-session 状态——模块级单例 + refCount 物理订阅（ADR-0049 例外清单形态，
 * 判定见本注释）。多组件共享单条 plugin:event 订阅与同一快照。
 *
 * 通道约定（与插件侧的共同契约，首个使用方 = wool 系插件包）：
 *  - 状态上报 channel = 'provider.credentialStatus'，payload = CredentialStatusPayload
 *    （含归属 providerId）；
 *  - 业务方法名 = 'getStatus'，params = { providerId }，返回 CredentialStatusPayload
 *    或 null（插件明确「未上报/无状态」）。
 * 插件未上报时 statusOf 返回 undefined，宿主不显示任何失效标记（D5/S5——不猜测）。
 */
import { onScopeDispose, ref, type Ref } from 'vue'
import type { PluginListAvailableReply } from '@taiji/shared'
import type { UiEventSender } from '@taiji/ui/rendering-protocol'
// [C3] settings 域的 WS 读写一律经 SettingsTransport seam（禁直连 @/api 门面 /
// 禁深 import transport 域）；插件来源的四条通道 + 可选安装成员由 seam 承载
import { getSettingsTransport } from '@taiji/core'
import type { PluginInstallResult, PluginInstallPreview } from '@taiji/core'

/** 凭据状态上报 channel（插件自命 channel 的消费约定，见文件头）。 */
export const CREDENTIAL_STATUS_CHANNEL = 'provider.credentialStatus'

/** getStatus 业务方法名（插件经 commands-executor 注册的 method 路由键）。 */
export const GET_STATUS_METHOD = 'getStatus'

/** 凭据状态载荷（宿主展示映射的最小契约：状态 + 可选一行文案）。 */
export interface CredentialStatusPayload { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  /** 凭据状态两值：valid = 插件判定可用；invalid = 插件判定失效（S17 展示驱动） */
  state: 'valid' | 'invalid'
  /** 一行文案（如「登录态已过期」；缺省用宿主默认文案） */
  message?: string
}

/** unknown → CredentialStatusPayload 的运行时窄化（上报载荷形态，providerId 必带）。 */
export function parseCredentialStatus(raw: unknown): CredentialStatusPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  if (candidate.state !== 'valid' && candidate.state !== 'invalid') return null
  if (candidate.message !== undefined && typeof candidate.message !== 'string') return null
  if (typeof candidate.providerId !== 'string' || candidate.providerId === '') return null
  return {
    state: candidate.state,
    ...(candidate.message !== undefined ? { message: candidate.message } : {}),
  }
}

/** getStatus 返回值窄化：状态字段形态（providerId 已在 params，返回值不带归属）。 */
function parseStatusFields(raw: unknown): CredentialStatusPayload | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  if (candidate.state !== 'valid' && candidate.state !== 'invalid') return null
  if (candidate.message !== undefined && typeof candidate.message !== 'string') return null
  return {
    state: candidate.state,
    ...(candidate.message !== undefined ? { message: candidate.message } : {}),
  }
}

/** 清单条目（附安装状态比对结果，PluginListAvailableReply.plugins 元素别名）。 */
export type PluginCatalogItem = PluginListAvailableReply['plugins'][number]

/** providerId → 插件命名空间的前缀判定（D4：providerId === ns || startsWith(ns + '-')）。 */
export function providerMatchesNamespace(providerId: string, namespace: string): boolean {
  return providerId === namespace || providerId.startsWith(`${namespace}-`)
}

/** 条目进入接入流程的焦点（重新授权 / 更新插件——跳过家族选择直达目标段）。 */
export interface PluginFlowFocus { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  pluginId: string
  intent: 'authorize' | 'update'
}

/** 插件来源条目的下发信息（ProviderPage 按清单 family 前缀判定后下发行卡）。 */
export interface PluginEntryInfo { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  /** 提供该来源的插件 id（挂载位 scope 的插件维度 + 重新授权/更新的 invoke 对象） */
  pluginId: string
  /** 清单版本 > 已装版本（「更新插件」动作显示判据，S26） */
  updateAvailable?: boolean
}

/** 安装确认卡知情面（S27；权威定义 = core seam，与 runtime IPluginService 结构对齐）。 */
export type { PluginInstallPreview }

/** 两段式安装端口（seam 三可选成员收窄成可调用端口）。 */
export interface PluginInstallPort { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  preparePluginInstall(packageSpec: string): Promise<PluginInstallPreview>
  confirmPluginInstall(pluginId: string): Promise<PluginInstallResult>
  cancelPluginInstall(pluginId: string): Promise<void>
}

/**
 * 运行时 guard：seam 的两段式安装成员实装与否（安装 WS 帧 / domain 方法由 u-wool-host
 * 追加交付，主 agent 裁决 dwfq-27efec2b-1）。三成员齐备返回端口；缺失返回 null →
 * 调用点呈「通道未就绪」可见降级，不崩溃（落定后零改动生效）。
 */
export function resolvePluginInstallPort(): PluginInstallPort | null {
  const transport = getSettingsTransport()
  if (typeof transport.preparePluginInstall !== 'function') return null
  if (typeof transport.confirmPluginInstall !== 'function') return null
  if (typeof transport.cancelPluginInstall !== 'function') return null
  return {
    preparePluginInstall: (spec) => transport.preparePluginInstall!(spec),
    confirmPluginInstall: (pluginId) => transport.confirmPluginInstall!(pluginId),
    cancelPluginInstall: (pluginId) => transport.cancelPluginInstall!(pluginId),
  }
}

/**
 * 构造挂载位作用域的 uiEvent 出口（D8 值回传）：只有挂载位容器同时知道
 * (pluginId, viewId)，故 provide 由容器组件做（授权容器 / 条目扩展区），原语只报
 * (componentId, event, value)。pluginId 取 getter——家族卡切换后跟随当前选中项。
 */
export function createPluginUiEventSender(pluginId: () => string | null, viewId: string): UiEventSender {
  return {
    send(componentId, event, value) {
      const id = pluginId()
      if (id === null) return
      getSettingsTransport().sendPluginUiEvent({ pluginId: id, viewId, componentId, event, value }).catch((e: unknown) => {
        // 辅助通道降级：回传失败不阻断输入（插件侧持有次优值，下次输入覆盖），warn 可见
        console.warn(`[plugin-provider-source] uiEvent (${id}/${viewId}/${componentId}) failed:`, e)
      })
    },
  }
}

/** usePluginProviderSource 返回形态（类型别名：多行字面量签名触发 indent lint）。 */
export type PluginProviderSourceReturn = {
  /** 清单可安装视图（家族卡 + 安装/更新状态；未拉取/失败为空数组） */
  catalog: Ref<PluginCatalogItem[]>
  /** 清单是否已成功拉取至少一次（S15 两态提示判定：loaded && 空 = 缓存清单为空） */
  catalogLoaded: Ref<boolean>
  /** 拉取清单（fail-safe 链在 runtime，本层失败保持现状 + warn） */
  refreshCatalog: () => Promise<void>
  /** 已知凭据状态（undefined = 未上报/未拉取——宿主不显示任何标记，D5/S5） */
  statusOf: (providerId: string) => CredentialStatusPayload | undefined
  /**
   * 条目展开 / 页进入时拉取凭据状态（D5：getStatus 同步返回插件本地最近已知状态，
   * 上游校验由插件异步执行后经 plugin:event 增量上报）。插件侧失败降级 warn，
   * 不阻断条目展开。
   */
  pullStatus: (pluginId: string, providerId: string) => Promise<void>
  /**
   * providerId → 清单家族条目（命中 = 插件来源条目；含 pluginId / updateAvailable /
   * capabilities 等组件层消费字段）。清单未拉到或未命中返回 undefined。
   */
  entryOfProvider: (providerId: string) => PluginCatalogItem | undefined
}

// taste:allow-no-data-owner W24-EX-B（模块级单例，设置域全局态非 per-session——ADR-0049
// 例外清单形态，判定见文件头）：凭据状态 map（providerId → 插件上报的已知状态）。
const statusMap = ref(new Map<string, CredentialStatusPayload>())
// taste:allow-no-data-owner W24-EX-B（同上）：清单可安装视图缓存（家族卡 + 安装/更新状态）。
const catalog = ref<PluginCatalogItem[]>([])
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构）：清单首次拉取完成标记（空态判定）。
const catalogLoaded = ref(false)

let refCount = 0
let unsubscribeEvent: (() => void) | null = null

/** plugin:event 增量提示订阅（D5：推补充——丢失由下次 pullStatus 收敛，无补偿机制）。 */
function ensureSubscribed(): void {
  if (unsubscribeEvent !== null) return
  unsubscribeEvent = getSettingsTransport().onPluginEvent((event) => {
    if (event.channel !== CREDENTIAL_STATUS_CHANNEL) return
    // parseCredentialStatus 的契约含 providerId（归属必带）；仍显式提取并校验，
    // 防御「payload providerId 与窄化结果错位」的插件侧 bug 静默写错分区。
    const providerId = extractProviderId(event.payload)
    const status = providerId !== undefined ? parseCredentialStatus(event.payload) : null
    if (!status) return
    const next = new Map(statusMap.value)
    next.set(providerId!, { state: status.state, ...(status.message !== undefined ? { message: status.message } : {}) })
    statusMap.value = next
  })
}

/** 上报载荷里的归属 providerId（parseCredentialStatus 契约字段的前置提取）。 */
function extractProviderId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const providerId = (payload as Record<string, unknown>).providerId
  return typeof providerId === 'string' && providerId !== '' ? providerId : undefined
}

function releaseSubscription(): void {
  unsubscribeEvent?.()
  unsubscribeEvent = null
}

/**
 * 消费 Provider 插件来源域状态（设置页全局态单例 + refCount 订阅；消费点须在组件
 * setup 上下文内——onScopeDispose 挂当前 scope）。
 */
export function usePluginProviderSource(): PluginProviderSourceReturn {
  refCount++
  ensureSubscribed()
  onScopeDispose(() => {
    refCount--
    if (refCount <= 0) {
      refCount = 0
      releaseSubscription()
    }
  })
  return {
    catalog,
    catalogLoaded,
    refreshCatalog,
    statusOf: (providerId) => statusMap.value.get(providerId),
    pullStatus,
    entryOfProvider: (providerId) =>
      catalog.value.find((entry) => entry.family !== undefined && providerMatchesNamespace(providerId, entry.family.id)),
  }
}

/** 拉取清单（listAvailable；失败保持现状 + warn，UI 层按空态/重试呈现，S15）。 */
async function refreshCatalog(): Promise<void> {
  try {
    const reply = await getSettingsTransport().listAvailablePlugins()
    catalog.value = reply.plugins
    catalogLoaded.value = true
  } catch (e) {
    // 辅助域降级（对齐 useWool.pull 惯例）：失败保持现状（首拉失败 = 空清单空态），不向上抛。
    console.warn('[plugin-provider-source] listAvailable failed (kept current catalog):', e)
  }
}

/** 条目展开 / 页进入的凭据状态拉取（invoke getStatus；失败 warn 降级，D5）。 */
async function pullStatus(pluginId: string, providerId: string): Promise<void> {
  try {
    const raw = await getSettingsTransport().invokePlugin(pluginId, GET_STATUS_METHOD, { providerId })
    const status = parseStatusFields(raw)
    const next = new Map(statusMap.value)
    if (status) next.set(providerId, status)
    else next.delete(providerId) // 显式 null = 插件明确「未上报」→ 不显示标记
    statusMap.value = next
  } catch (e) {
    // 插件崩溃 / 方法未注册：辅助域降级 warn，保持现状（无标记——不猜测，S5）
    console.warn(`[plugin-provider-source] getStatus(${pluginId}, ${providerId}) failed:`, e)
  }
}

/** 测试钩子：复位模块级状态 + 强制退订（对齐 _resetXxxForTest 模式）。 */
export function _resetPluginProviderSourceForTest(): void {
  refCount = 0
  releaseSubscription()
  statusMap.value = new Map()
  catalog.value = []
  catalogLoaded.value = false
}
