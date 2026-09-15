/**
 * Settings store —— 应用级配置的「纯状态容器」（core 域迁移版）。
 *
 * [迁移] strangler 迁移自 packages/renderer/src/stores/settings.ts（pinia setup store）
 * 原样迁移为纯 factory。迁移约束（IF1）：不依赖 pinia；状态/操作函数语义逐条等价；
 * 消费方自行 .value（无 pinia unwrap）。renderer 旧 store 保留，待消费方迁移（W4）后删除。
 *
 * 职责边界（2026-07-02 架构返工 G2 语义保留）：
 * - 本 store 只持 state + 纯写入方法，订阅生命周期编排在 settings-lifecycle（W2）。
 * - setSystem 无 DOM 副作用（applySystemToDom 下沉 ui 包/壳，TC2）；只做状态合并 +
 *   IF3 持久化（getPlatform().storage）+ 乐观更新失败回滚。
 * - setSkillDirs/setAgentDirs/setExtensionDirs 只发请求持久化，靠后端广播推回权威值
 *   （订阅在 settings-lifecycle.init 注册）。
 * - 四个 toggle action（provider/model/extension enabled + extension autoUpgrade）
 *   是纯本地乐观更新（返回旧值供回滚），区别于「靠广播推回」。
 *
 * 依赖方向：types（状态类型）+ system-storage（IF3 持久化）+ transport（IF1，路径配置
 * 请求）+ platform/port（KVStorage 注入）。零 DOM、零 @/import。
 */
import { ref } from 'vue'
import type {
  ProviderInfo,
  ModelInfo,
  SkillInfo,
  AgentInfo,
  SkillDirConfig,
  SystemPromptConfig,
  TerminalConfig,
} from '@taiji/shared'
import { getPlatform } from '../../platform/port'
import { updateSystem } from './system-storage'
import { getSettingsTransport } from './transport'
import { DEFAULT_SYSTEM, type SystemSettings, type ExtensionItem } from './types'

/** createSettingsStore() 返回的 store 实例形状（消费方类型标注用）。 */
export type SettingsStoreInstance = ReturnType<typeof createSettingsStore>

/**
 * 创建 settings store（纯 factory，无 pinia 依赖）。
 *
 * 返回形状与原 pinia setup store 一致（ref 原样返回）：消费方迁移时
 * storeToRefs 语义由显式 .value 取代。
 */
export function createSettingsStore() {
  // ── State ──
  const providers = ref<ProviderInfo[]>([])
  /**
   * 聚合模型列表（runtime aggregateModels 产出，config.providers 解析后的扁平模型）。
   * 与 providers 同源（sendInitialState 同 step 推、broadcastProviderList 同步广播），
   * 故同样走常驻订阅（settings-lifecycle.init 注册，应用生命周期不断开）。
   *
   * 【契约】scoped 过滤后列表，仅供 Composer 模型切换器（ModelSelectPopover）消费——
   * scopedModels 白名单非空时此处仅含白名单内模型（runtime aggregateModelsWithScoped）。
   * 其他「需要选模型」的场景（如 extension 模型配置，extension 解析走 pi 全量
   * modelRegistry 与 scoped 无关）应从 providers 派生全量候选，禁止借用本列表
   * （useAuthedModelGroups 即为此范式，守卫测试见其 __tests__）。
   */
  const models = ref<ModelInfo[]>([])
  const skills = ref<SkillInfo[]>([])
  const agents = ref<AgentInfo[]>([])
  const extensions = ref<ExtensionItem[]>([])
  const system = ref<SystemSettings>({ ...DEFAULT_SYSTEM })
  // ADR-0021 §1 加载路径配置（层 A 勾选/拖动用）：预设候选 + enabled 状态
  const skillDirs = ref<SkillDirConfig[]>([])
  const agentDirs = ref<SkillDirConfig[]>([])
  // ADR-0021 §1 extension 加载路径配置（Phase 4）：与 skill/agent 同构，靠前 = 先加载。
  // extension 的「优先级」语义因资源类型而异（tool 靠前生效、hook 全部执行），故 UI 措辞用「加载顺序」。
  const extensionDirs = ref<SkillDirConfig[]>([])
  // 默认模型（"provider/modelId" 复合串，与 SessionSummary.modelId 同格式）。
  // runtime 在连接 / model.switch / provider 增删时经 config.defaults 推送；
  // landing 态（无 active session）的 composer 模型选择器取它作 fallback。
  const defaultModel = ref('')
  /** 系统提示词配置（FR-4，config.systemPrompt 广播同步）。null=尚未加载。 */
  const systemPromptConfig = ref<{ config: SystemPromptConfig; corrupted: boolean } | null>(null)
  /** 终端配置（Phase 6，config.terminalConfig 广播同步）。null=尚未加载。 */
  const terminalConfig = ref<{ config: TerminalConfig; corrupted: boolean } | null>(null)
  /**
   * Scoped models 白名单（provider/modelId 复合串数组，序=显示序）。
   * 非空时模型选择器只显示其中模型；空数组/缺失=未启用（显示全部）。
   * 数据来自 config.providers 广播 / config.getProviders reply 的 scopedModels 字段。
   */
  const scopedModels = ref<string[]>([])

  // ── Actions（纯写入；订阅生命周期在 settings-lifecycle）──

  /**
   * 更新 system 偏好：合并本地态 → 持久化（IF3 updateSystem）。
   * 原 renderer 实现中「同步 DOM + i18n」部分（applySystemToDom）下沉 ui 包/壳（TC2），
   * core 侧无 DOM 副作用。
   *
   * 乐观更新 + 失败回滚（D9 修复语义保留）：
   *   原实现先乐观改 system.value，再 await updateSystem，失败时 system.value 已是新值不回滚
   *   → store 说新主题 DOM 是旧主题，状态脱节。现顺序：存快照 → 改 state → await 持久化
   *   → 失败 catch 还原 state → throw（让调用方 toast 反馈）。
   */
  async function setSystem(patch: Partial<SystemSettings>): Promise<void> {
    const snapshot = { ...system.value }
    system.value = { ...system.value, ...patch }
    try {
      await updateSystem(getPlatform().storage, patch)
    } catch (e) {
      // 持久化失败：回滚 state，保持 state/storage 一致
      system.value = snapshot
      throw e
    }
  }

  /**
   * 覆盖 skill 加载路径（ADR-0021 §1 目录级管道，v2 scope 穿越路 A）。
   * dirs 是含 scope 的目录配置有序数组（带 enabled 态与 project/global 归属，靠前覆盖靠后）。
   * 整体透传 SkillDirConfig[]（不降维为 string[]），让用户显式标记的 scope 真正决定加载归属与优先级。
   * 只负责发请求持久化 + 让后端广播推回权威值（buildDirConfigs 补全预设候选）。
   * 拖拽的即时性由 LoadPaths 的本地状态保证，store 不做乐观更新（避免两套本地状态打架）。
   */
  async function setSkillDirs(dirs: SkillDirConfig[]): Promise<void> {
    await getSettingsTransport().setSkillDirs(dirs)
  }

  /** 覆盖 agent 加载路径（ADR-0021 §1 目录级管道，v2 scope 穿越路 A），语义同 setSkillDirs。 */
  async function setAgentDirs(dirs: SkillDirConfig[]): Promise<void> {
    await getSettingsTransport().setAgentDirs(dirs)
  }

  /** 覆盖 extension 加载路径（Phase 4 目录级管道，v2 scope 穿越路 A），语义同 setSkillDirs/setAgentDirs。
   *  dirs 是含 scope 的目录配置有序数组（带 enabled 态与 project/global 归属，靠前先加载）。
   *  整体透传 SkillDirConfig[]（不降维为 string[]）。只发请求持久化，靠后端广播推回权威值。
   *  extension 不需要重启提示——新 session 生效（与 agent 的「重开会话」提示不同）。 */
  async function setExtensionDirs(dirs: SkillDirConfig[]): Promise<void> {
    await getSettingsTransport().setExtensionDirs(dirs)
  }

  // ── 乐观更新（toggle 级，区别于 setSkillDirs 的「靠广播推回」）──
  // Switch 受控于 store state，点 toggle 到 UI 动效需经历一次 WS 往返（几十~数百 ms），
  // 纯广播模式期间开关卡在原位 → 用户以为没反应。这些 action 立即改本地 state，
  // 组件「先调 action 再调 API、失败回滚」，广播回来时权威值自然覆盖（幂等调和）。

  /**
   * 乐观切换 provider enabled。
   * 立即改本地 providers 对应项的 enabled，组件负责随后调 API 持久化、失败时回滚。
   * @returns 旧值（供回滚用）
   */
  function setProviderEnabled(id: string, enabled: boolean): boolean {
    const idx = providers.value.findIndex((p) => p.id === id)
    if (idx === -1) return false
    const old = providers.value[idx].enabled ?? true
    providers.value[idx] = { ...providers.value[idx], enabled }
    return old
  }

  /**
   * 写入 providers 权威快照（广播 / getProviders reply 推回）。
   * scoped 守卫（reply + 广播双通道同一语义）：undefined = 通道未携带（旧 runtime），
   * 不覆盖已有值，由 config.providers 广播兜底推回。
   */
  function setProviders(next: ProviderInfo[], scoped?: string[]): void {
    providers.value = next
    if (scoped !== undefined) scopedModels.value = scoped
  }

  /**
   * 乐观切换 model 级 enabled（D6）。
   * 立即改本地 providers 中目标 provider 下目标 model 的 enabled，组件随后调 API 持久化、失败回滚。
   * @returns 旧值（供回滚用），找不到时返回 true（默认启用）
   */
  function setModelEnabled(providerId: string, modelId: string, enabled: boolean): boolean {
    const pIdx = providers.value.findIndex((p) => p.id === providerId)
    if (pIdx === -1) return true
    const provider = providers.value[pIdx]
    const mIdx = provider.models.findIndex((m) => m.id === modelId)
    if (mIdx === -1) return true
    const old = provider.models[mIdx].enabled ?? true
    const nextModels = provider.models.map((m, i) => i === mIdx ? { ...m, enabled } : m)
    providers.value[pIdx] = { ...provider, models: nextModels }
    return old
  }

  /**
   * 乐观切换 extension enabled。
   * @returns 旧值（供回滚用）
   */
  function setExtensionEnabled(name: string, enabled: boolean): boolean {
    const idx = extensions.value.findIndex((e) => e.name === name)
    if (idx === -1) return false
    const old = extensions.value[idx].enabled ?? true
    extensions.value[idx] = { ...extensions.value[idx], enabled }
    return old
  }

  /**
   * 乐观切换 extension autoUpgrade。
   * @returns 旧值（供回滚用）
   */
  function setExtensionAutoUpgrade(name: string, autoUpgrade: boolean): boolean {
    const idx = extensions.value.findIndex((e) => e.name === name)
    if (idx === -1) return false
    const old = extensions.value[idx].autoUpgrade ?? false
    extensions.value[idx] = { ...extensions.value[idx], autoUpgrade }
    return old
  }

  return {
    // state
    providers,
    models,
    skills,
    agents,
    extensions,
    system,
    skillDirs,
    agentDirs,
    extensionDirs,
    defaultModel,
    systemPromptConfig,
    terminalConfig,
    scopedModels,
    // actions（纯写入）
    setSystem,
    setSkillDirs,
    setAgentDirs,
    setExtensionDirs,
    setProviders,
    setProviderEnabled,
    setModelEnabled,
    setExtensionEnabled,
    setExtensionAutoUpgrade,
  }
}

// ── 模块级惰性单例（域内消费方共用；壳/测试可 createSettingsStore() 新建独立实例）──

let storeSingleton: SettingsStoreInstance | null = null

/**
 * 获取 settings store 模块级单例（首次调用惰性创建）。
 * settings-lifecycle / use-provider-edit 等域内模块共用同一实例。
 */
export function getSettingsStore(): SettingsStoreInstance {
  if (!storeSingleton) storeSingleton = createSettingsStore()
  return storeSingleton
}

/** 仅测试用：清空单例缓存（跨用例隔离，避免 state 泄漏）。 */
export function __resetSettingsStoreForTesting(): void {
  storeSingleton = null
}
