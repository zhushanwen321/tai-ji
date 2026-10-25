/**
 * content-slots.ts —— ContentSlotRegistry 渲染端消费单点（容器扩展点统一 §6.1 / U8）。
 *
 * 职责：core 模块级单例（content-slot-registry.ts 的 contentSlotRegistry，§6.1「一份注册表」
 * 的实体承载）在本壳的访问入口 + 侧栏/设置页内置项登记 + 响应式派生。四个容器（抽屉/浮层/
 * 侧栏/设置页）的派生视图同源于该唯一实例（多实例 = 双权威：同一插件声明在一个容器的派生
 * 视图出现、另一个容器的实例缺失），声明灌入/清理走桥内单一写路径，无成对写。
 *
 * 内置项登记（§6.1「内置三项为注册表初始项」；core 无侧栏/设置页静态表，消费单元以
 * 声明形态登记进 core 单例）：侧栏 3 项（placement='sidebar.tab'）+ 设置页 17 项
 *（placement='settings.section'，group 决定归属）。内置文案走 labelKey（§6.16④），
 * 插件项文案走声明 label 原文。
 *
 * 响应式范式（§7.2）：注册表变更方法内刷新 snapshot（shallowRef 整表替换）；派生
 * computed 先读 snapshot.value 建立依赖再调 derive*——derive* 直读非响应 Map，不读
 * snapshot 的 computed 不会重算（永久 stale）。
 *
 * 分区键（nav key）：内置项 = id 去 'ui.' 前缀（保持既有 testid/深链/内容分支键不变，
 * 零行为变化）；插件项 = 声明 id 全值。设置页 activeMenu/深链/键盘导航均消费分区键。
 *
 * 图标解析：设置页内置项 icon 登记为 lucide 官方 kebab 名，经 §6.13 单一解析函数
 *（contributionIconComponent：resolveContributionIcon + 共享组件表）解析，本模块零本地映射表。
 */
import { computed, type ComputedRef } from 'vue'
import type { LucideIcon } from '@lucide/vue'
import {
  BUILTIN_NAMESPACE,
  contentSlotRegistry,
  HOST_PLUGIN_ID,
  type ContentSlotDeclaration,
  type ContentSlotRegistry,
  type ContentSlotView,
  type SettingsContentMaxWidth,
  type SettingsSectionGroupView,
} from '@taiji/core'
import { contributionIconComponent } from '@taiji/ui'

// ── 内置声明（注册表初始项）──────────────────────────────────────────

/** 内置侧栏 tab 声明（内置三项 = 注册表初始项，§6.1 侧栏行）。renderer.component 登记实际
 * 承载组件名（Sidebar.vue 内容分支的现状承载）；侧栏内容分派键 = tab id，component 供
 * 宿主渲染项登记语义完整（内置项不经白名单校验——白名单约束的是插件声明）。 */
const SIDEBAR_BUILTIN_SLOTS: ContentSlotDeclaration[] = [
  {
    id: `${BUILTIN_NAMESPACE}.sessions`,
    placement: 'sidebar.tab',
    label: 'sessions',
    scope: 'session',
    pluginId: HOST_PLUGIN_ID,
    renderer: { kind: 'host', component: 'SessionList' },
    openableWithoutData: true,
    labelKey: 'sidebar.segmentedTab.session',
  },
  {
    id: `${BUILTIN_NAMESPACE}.files`,
    placement: 'sidebar.tab',
    label: 'files',
    scope: 'session',
    pluginId: HOST_PLUGIN_ID,
    renderer: { kind: 'host', component: 'FileView' },
    openableWithoutData: true,
    labelKey: 'sidebar.segmentedTab.file',
  },
  {
    id: `${BUILTIN_NAMESPACE}.plugins`,
    placement: 'sidebar.tab',
    label: 'plugins',
    scope: 'session',
    pluginId: HOST_PLUGIN_ID,
    renderer: { kind: 'host', component: 'PluginViewContainer' },
    openableWithoutData: true,
    labelKey: 'sidebar.segmentedTab.plugin',
  },
]

/** 设置页内置分组 id（声明 group 字段值；组头文案经 settingsGroupHeadLabel 映射 labelKey）。 */
export const SETTINGS_GROUP_RESOURCES = 'resources'
export const SETTINGS_GROUP_INPUT_APPEARANCE = 'input-appearance'
export const SETTINGS_GROUP_ENV_SYSTEM = 'env-system'

/** 设置页分区声明形状收敛：id/labelKey/icon/group/contentMaxWidth 五元 + 固定内置侧值。 */
interface SettingsSectionSlotSpec { // oe-exempt:20261025:framework:内置分区规格表数据形状（类型契约先行，非抽象接口单实现）
  id: string
  labelKey: string
  icon: string
  group: string
  contentMaxWidth?: SettingsContentMaxWidth
}

/** 内置分区规格表（id 裸键即分区键——深链 initialSection/testid/内容分支的既有值）；
 * contentMaxWidth 按现行三档事实登记：usage 宽档、mcp/system-prompt/rename-session
 * 中档（860px），其余缺省档（§7.5 判据从分区 id 硬编码迁移到声明字段）。 */
const SETTINGS_SECTION_SPECS: SettingsSectionSlotSpec[] = [
  { id: 'provider', labelKey: 'settings.menu.provider', icon: 'settings', group: SETTINGS_GROUP_RESOURCES },
  { id: 'skill', labelKey: 'settings.menu.skill', icon: 'sparkles', group: SETTINGS_GROUP_RESOURCES },
  { id: 'agent', labelKey: 'settings.menu.agent', icon: 'bot', group: SETTINGS_GROUP_RESOURCES },
  { id: 'extension', labelKey: 'settings.menu.extension', icon: 'blocks', group: SETTINGS_GROUP_RESOURCES },
  { id: 'mcp', labelKey: 'settings.menu.mcp', icon: 'server', group: SETTINGS_GROUP_RESOURCES, contentMaxWidth: 'medium' },
  { id: 'preset', labelKey: 'settings.menu.preset', icon: 'clipboard-list', group: SETTINGS_GROUP_RESOURCES },
  { id: 'appearance', labelKey: 'settings.menu.appearance', icon: 'palette', group: SETTINGS_GROUP_INPUT_APPEARANCE },
  { id: 'system-prompt', labelKey: 'settings.menu.systemPrompt', icon: 'scroll-text', group: SETTINGS_GROUP_INPUT_APPEARANCE, contentMaxWidth: 'medium' },
  { id: 'rename-session', labelKey: 'settings.menu.sessionRename', icon: 'tag', group: SETTINGS_GROUP_INPUT_APPEARANCE, contentMaxWidth: 'medium' },
  { id: 'tts', labelKey: 'settings.menu.tts', icon: 'volume-2', group: SETTINGS_GROUP_INPUT_APPEARANCE },
  { id: 'terminal', labelKey: 'settings.menu.terminal', icon: 'terminal-square', group: SETTINGS_GROUP_INPUT_APPEARANCE },
  { id: 'worktree', labelKey: 'settings.menu.worktree', icon: 'git-branch', group: SETTINGS_GROUP_ENV_SYSTEM },
  { id: 'update', labelKey: 'settings.menu.update', icon: 'download', group: SETTINGS_GROUP_ENV_SYSTEM },
  { id: 'remote-access', labelKey: 'settings.menu.remoteAccess', icon: 'wifi', group: SETTINGS_GROUP_ENV_SYSTEM },
  { id: 'network-proxy', labelKey: 'settings.menu.networkProxy', icon: 'waypoints', group: SETTINGS_GROUP_ENV_SYSTEM },
  { id: 'system', labelKey: 'settings.menu.system', icon: 'sliders-horizontal', group: SETTINGS_GROUP_ENV_SYSTEM },
  { id: 'usage', labelKey: 'settings.menu.usage', icon: 'chart-column', group: SETTINGS_GROUP_ENV_SYSTEM, contentMaxWidth: 'wide' },
]

/** 规格 → 内置声明（placement='settings.section'；文案走 labelKey，icon 为 lucide kebab 名）。 */
function settingsSectionDeclaration(spec: SettingsSectionSlotSpec): ContentSlotDeclaration {
  return {
    id: `${BUILTIN_NAMESPACE}.${spec.id}`,
    placement: 'settings.section',
    label: spec.id,
    icon: spec.icon,
    group: spec.group,
    contentMaxWidth: spec.contentMaxWidth,
    scope: 'global',
    pluginId: HOST_PLUGIN_ID,
    // 设置页分区内容由 SettingsModal 内容分支承载（分派键 = 分区 id），component 登记
    // 该承载组件名（内置项不经白名单校验——白名单约束的是插件声明）
    renderer: { kind: 'host', component: 'SettingsModal' },
    openableWithoutData: true,
    labelKey: spec.labelKey,
  }
}

const SETTINGS_BUILTIN_SLOTS: ContentSlotDeclaration[] = SETTINGS_SECTION_SPECS.map(settingsSectionDeclaration)

// ── 单例装配（core 单一实例 + 本壳内置项惰性登记）────────────────────

/** 侧栏/设置页内置项是否已登记进 core 单例（registerBuiltin 同 id 覆盖幂等，标记防热路径
 * 重复刷新快照——getContentSlotRegistry 在派生 computed getter 内高频取用）。 */
let builtinsRegistered = false

/**
 * 容器位注册表（core 模块级单例，四容器派生视图唯一事实源）。首次访问登记侧栏/设置页
 * 内置项；插件声明注入（loadExternal）/ 清理（clearForPlugin）经实例方法操作，派生视图
 * 自动跟随。生产代码与测试共用本入口。
 */
export function getContentSlotRegistry(): ContentSlotRegistry {
  if (!builtinsRegistered) {
    contentSlotRegistry.registerBuiltin([...SIDEBAR_BUILTIN_SLOTS, ...SETTINGS_BUILTIN_SLOTS])
    builtinsRegistered = true
  }
  return contentSlotRegistry
}

/**
 * 测试隔离：清空 core 单例全部插件声明分区并复位内置项登记标记（下次 getContentSlotRegistry
 * 重新登记内置项）。core 单例不可丢弃重建（模块 const 导出），重定向为「清插件分区 +
 * 重登内置项」——终态与旧「丢弃重建」语义等价（回到仅有内置项的初始态）。仅测试消费。
 */
export function __resetContentSlotsForTesting(): void {
  builtinsRegistered = false
  const pluginIds = new Set(getContentSlotRegistry().listEntries().map((e) => e.declaration.pluginId))
  for (const id of pluginIds) contentSlotRegistry.clearForPlugin(id) // clearForPlugin 对 taiji-host 幂等跳过（内置项保留）
  getContentSlotRegistry()
}

// ── 响应式派生（先读 snapshot 建依赖，再 derive——见模块头注释）────────────

// 派生 computed 的 getter 内经 getContentSlotRegistry 取注册表（不在外层捕获实例引用）：
// 注册表实例方法内部刷新 snapshot（shallowRef 整表替换）驱动重算；测试重置
//（__resetContentSlotsForTesting）清插件分区后，getter 下次求值即读到干净快照。

/** 侧栏标签数组（内置 3 项 ∪ 插件声明项，§6.16 排序后）。 */
export function useSidebarTabs(): ComputedRef<ContentSlotView[]> {
  return computed(() => {
    const registry = getContentSlotRegistry()
    void registry.snapshot.value
    return registry.deriveSidebarTabs()
  })
}

/** 设置页分组二级结构（内置 17 项 ∪ 插件声明项，group 归属、无组归 undefined 组）。 */
export function useSettingsNavGroups(): ComputedRef<SettingsSectionGroupView[]> {
  return computed(() => {
    const registry = getContentSlotRegistry()
    void registry.snapshot.value
    return registry.deriveSettingsSections()
  })
}

/** 设置页分区平铺（显示顺序 = 分组桶序 × 组内排序；键盘 ↑↓ 导航与页查找用）。 */
export function useSettingsNavSections(): ComputedRef<ContentSlotView[]> {
  const groups = useSettingsNavGroups()
  return computed(() => groups.value.flatMap((g) => g.sections))
}

// ── 消费端映射（分区键 / 文案 / 分组头 / 限宽档 / 图标）──────────────────

const BUILTIN_ID_PREFIX = `${BUILTIN_NAMESPACE}.`

/** 视图条目 → 分区键：内置 = id 去 'ui.' 前缀（既有 testid/深链/内容分支键不变）；
 * 插件 = 声明 id 全值。 */
export function settingsNavKey(view: ContentSlotView): string {
  return view.source === 'builtin' && view.id.startsWith(BUILTIN_ID_PREFIX)
    ? view.id.slice(BUILTIN_ID_PREFIX.length)
    : view.id
}

/** 文案谓词（§6.16④）：内置项恒走 labelKey（内置 label 是 id 占位值，非渲染文案）；
 * 插件项走声明 label 原文，缺 label 回落 labelKey。t 由调用方注入（组件 i18n 实例）。 */
export function slotDisplayLabel(view: ContentSlotView, t: (key: string) => string): string {
  if (view.source === 'builtin' && view.labelKey !== undefined) return t(view.labelKey)
  if (view.label !== undefined && view.label.length > 0) return view.label
  if (view.labelKey !== undefined) return t(view.labelKey)
  return view.id
}

/** 内置分组 id → 组头 labelKey（内置组文案归 i18n）；其他值 = 插件自带分组名原文。 */
const BUILTIN_GROUP_LABEL_KEYS: Record<string, string> = {
  [SETTINGS_GROUP_RESOURCES]: 'settings.menu.groupResources',
  [SETTINGS_GROUP_INPUT_APPEARANCE]: 'settings.menu.groupInputAppearance',
  [SETTINGS_GROUP_ENV_SYSTEM]: 'settings.menu.groupEnvSystem',
}

/** 分组头文案：内置组走 labelKey；声明未带 group（undefined）归「其他」组；插件组原文。 */
export function settingsGroupHeadLabel(group: string | undefined, t: (key: string) => string): string {
  if (group === undefined) return t('settings.menu.groupOther')
  const key = BUILTIN_GROUP_LABEL_KEYS[group]
  return key !== undefined ? t(key) : group
}

/** 限宽档 → 内容列 max-width CSS 值（现行三档值迁移：宽 1064 / 中 860 / 默认 720 的
 * token 形态；档位语义见 SettingsContentMaxWidth）。 */
export function contentMaxWidthCss(width: SettingsContentMaxWidth | undefined): string {
  if (width === 'wide') return 'var(--content-max-w-wide)'
  if (width === 'medium') return '860px'
  return 'var(--content-max-w)'
}

/** 视图条目图标解析（§6.13 单一函数的设置页消费侧）：resolveContributionIcon 归一化/白名单/
 * 错名兜底 + 按去重键 warn 一次（内置项 pluginId = taiji-host，插件项 = 声明归属），组件
 * 换算在共享表（ui/lib/contribution-icons）——本模块零本地映射表。 */
export function settingsNavIcon(view: Pick<ContentSlotView, 'pluginId' | 'id' | 'icon'>): LucideIcon {
  return contributionIconComponent({ pluginId: view.pluginId, contributionId: view.id, icon: view.icon })
}
