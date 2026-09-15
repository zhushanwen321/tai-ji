/**
 * settings-lifecycle —— settings 域订阅生命周期编排（core 域迁移版）。
 *
 * [迁移] strangler 迁移自 packages/renderer/src/composables/features/useSettings.ts（182 行）。
 * 保持模块级单例形态（unsubs 数组 + initialized 布尔守卫）：AppShell 应用级调用一次
 * init() 即挂载全部常驻订阅，其余消费方只读 store，不重复挂载。
 *
 * 职责（G2 语义保留）：
 * - 常驻订阅句柄（config.onProviders / model.onModels / config.onSkills / config.onAgents /
 *   config.onSkillDirs / config.onAgentDirs / config.onExtensionDirs / config.onDefaults /
 *   config.onSystemPrompt / config.onTerminalConfig / extension.onExtensions），
 *   经 IF1 SettingsTransport 注册，handler 写 settings store。
 * - system 初始化经 IF3 system-storage.getSystem(getPlatform().storage) → store.setSystem
 *   （setSystem 内部经 IF3 updateSystem 持久化，幂等）。
 * - refreshProviders：打开 modal 时刷新 providers 快照；失败不阻塞（订阅兜底）。
 *
 * 不持有：不持状态本身（状态在 settings store）；不做 DOM/i18n 副作用。
 *
 * [W4 交接] matchMedia（prefers-color-scheme）监听 + watch(store.system.theme) 挂/卸
 * 逻辑不迁 core（DOM 审计下沉壳）——W4 壳侧 watch getSettingsStore().system.theme
 * 挂/卸 matchMedia 监听（原 renderer useSettings.ts updateSystemThemeListener 语义）。
 *
 * 依赖方向：IF1 transport（订阅/请求）+ IF3 system-storage（system 初始化）+
 * settings-store（状态写入）。零 DOM、零 window/document、零 @/import。
 */
import { getPlatform } from '../../platform/port'
import { getSystem } from './system-storage'
import { getSettingsStore } from './settings-store'
import { getSettingsTransport } from './transport'

/**
 * 订阅句柄 + 幂等守卫（模块级，跨 init() 调用共享）。
 */
const unsubs: Array<() => void> = []
let initialized = false

/**
 * 幂等初始化：挂载常驻订阅 + 同步 system 偏好到 store。
 *
 * 由 AppShell（应用级，常驻）调用一次即可；多次调用安全（initialized 去重）。
 * 订阅常驻不随 modal 关闭断开，保证 settings 数据全局可消费。
 *
 * 通道（行为不变约束，与 renderer 原实现一一对应）：
 * 1. transport.onProviders → providers
 * 2. transport.onModels → models（与 providers 同源，故常驻）
 * 3. transport.onSkills → skills
 * 4. transport.onAgents → agents
 * 5. transport.onSkillDirs → skillDirs
 * 6. transport.onAgentDirs → agentDirs
 * 7. transport.onExtensionDirs → extensionDirs（Phase 4）
 * 8. transport.onDefaults → defaultModel
 * 9. transport.onSystemPrompt → systemPromptConfig
 * 10. transport.onTerminalConfig → terminalConfig（Phase 6）
 * 11. transport.onExtensions → extensions
 */
async function init(): Promise<void> {
  if (initialized) return
  initialized = true

  const transport = getSettingsTransport()
  const store = getSettingsStore()

  unsubs.push(transport.onProviders((p, scopedModels) => {
    store.setProviders(p, scopedModels)
  }))
  // models 与 providers 同源（sendInitialState 同 step 推、provider 增删同广播），故常驻订阅
  unsubs.push(transport.onModels((m) => { store.models.value = m }))
  unsubs.push(transport.onSkills((s) => { store.skills.value = s }))
  unsubs.push(transport.onAgents((a) => { store.agents.value = a }))
  unsubs.push(transport.onSkillDirs((d) => { store.skillDirs.value = d }))
  unsubs.push(transport.onAgentDirs((d) => { store.agentDirs.value = d }))
  unsubs.push(transport.onExtensionDirs((d) => { store.extensionDirs.value = d }))
  unsubs.push(transport.onDefaults((m) => { store.defaultModel.value = m }))
  // 系统提示词配置（FR-4，systemPrompt 广播 → store.systemPromptConfig 常驻同步）
  unsubs.push(transport.onSystemPrompt((cfg, corrupted) => {
    store.systemPromptConfig.value = { config: cfg, corrupted }
  }))
  // 终端配置（Phase 6，terminalConfig 广播 → store.terminalConfig 常驻同步）
  unsubs.push(transport.onTerminalConfig((cfg, corrupted) => {
    store.terminalConfig.value = { config: cfg, corrupted }
  }))
  unsubs.push(transport.onExtensions((e) => { store.extensions.value = e }))

  // system 是纯前端偏好（storage），初始化时读并同步到 store
  // （setSystem 内部经 IF3 updateSystem 持久化，幂等写回）。
  // DOM 同步（applySystemToDom：theme→data-theme + themePreset→data-theme-preset +
  // locale→i18n）由壳侧（W4）承接，core 不做。
  const system = await getSystem(getPlatform().storage)
  await store.setSystem(system)

  // [W4 交接] 原 renderer 实现的 theme=system 时 watch(store.system.theme) + matchMedia
  // 监听（updateSystemThemeListener）不迁 core——壳侧 watch system.theme 挂/卸监听。
}

/**
 * 打开 modal 时刷新 providers（拿最新快照）；skills/agents 靠订阅，不主动拉。
 * 失败时不阻塞 UI：onProviders 订阅会兜底推回最新数据。
 */
async function refreshProviders(): Promise<void> {
  const store = getSettingsStore()
  try {
    const { providers, scopedModels } = await getSettingsTransport().listProviders()
    store.setProviders(providers, scopedModels)
  // eslint-disable-next-line taste/no-silent-catch -- 拉取失败不阻塞 UI：onProviders 订阅会兜底推回最新数据，无需打扰用户
  } catch (e) {
    console.warn('[settings] listProviders 失败，依赖订阅兜底', e)
  }
}

/**
 * 连接后主动拉取模型列表（对齐 refreshProviders 范式的兜底）。
 *
 * [HISTORICAL] 2026-08-05：onModels 订阅曾因「注册晚于 sendInitialState 首推」竞态丢首条 model.list，
 * 导致 settingsStore.models 永空（根因已由 bootstrapSettingsCore 上提订阅注册到 App.vue setup 修复）。
 * 本方法作为防御纵深：即使订阅时序未来被回归，连接后的显式拉取仍能填充 models。
 * 由 App.vue onConnected 首次连接后调一次（非 mock 模式）。失败不阻塞（onModels 订阅兜底）。
 */
async function refreshModels(): Promise<void> {
  const store = getSettingsStore()
  try {
    store.models.value = await getSettingsTransport().listModels()
  // eslint-disable-next-line taste/no-silent-catch -- 拉取失败不阻塞 UI：onModels 订阅会兜底推回最新数据，无需打扰用户
  } catch (e) {
    console.warn('[settings] listModels 失败，依赖订阅兜底', e)
  }
}

/** 销毁订阅（AppShell 卸载时调用，应用生命周期内通常不触发）。 */
function dispose(): void {
  unsubs.splice(0).forEach((u) => u())
  initialized = false
}

/**
 * 测试隔离：重置 init 守卫（与 settings store 重置配合，beforeEach 调）。
 * 让 settings-lifecycle 的「init 幂等 / dispose 清订阅」用例可重复运行。
 */
function resetSettingsInit(): void {
  dispose()
}

/**
 * settings 域编排（模块级单例形态，保持 renderer 原 useSettings 语义）。
 *
 * 返回订阅生命周期方法（init/refreshProviders/dispose/resetSettingsInit）。
 * 状态读取直接用 getSettingsStore()（各消费方按需 .value / 直读）。
 */
export function useSettings() {
  return {
    init,
    refreshProviders,
    refreshModels,
    dispose,
    resetSettingsInit,
  }
}

