/**
 * drawer 域容器位派生视图消费侧 —— 右抽屉标签条的单一数据源（容器扩展点统一 §6.1 / U6）。
 *
 * 职责（读侧派生，不持状态）：
 * - 内置项装配：RIGHT_DRAWER_REGISTRY（既有唯一权威，registry.ts）经 builtinDrawerSlots
 *   转换为内置声明，惰性登记进容器位注册表单例。转换器注入是 AC7 方向的正用——
 *   extension-host 不 import domain（content-slot-registry.ts 头注），domain 消费
 *   extension-host 的派生视图属上层向下依赖；
 * - 派生投影：deriveDrawerTabs()（内置 8 项 ∪ 插件声明项，§6.16 排序）投影为抽屉标签条
 *   条目。key 归一：内置项 = 去保留命名空间前缀的内容 id（'ui.git' → 'git'，与控制态 /
 *   coordination 既有 tab 位对齐）；插件项 = 声明 id（全局 id 空间，§6.12）；
 * - 失效回退（§5.4 卸载行 + §11.1-1 断言 3）：分区 activeTab 指向的 tab 不在派生视图中
 *  （插件被禁用/崩溃/卸载）→ 生效 tab 回退内置默认项（首个内置视图）。读侧派生不回写
 *   分区——回写会把「卸载」变成一次选中态写入，且声明重放后无法恢复原选中（分区值保留，
 *   同 id 声明回来时选中自然恢复；回退期间界面高亮/内容/空态文案经同一生效值一致回退）。
 *
 * 响应式（§7.2 载体）：读注册表快照（shallowRef 整表替换）在调用方 computed/render 内
 * 求值即建立依赖；registerBuiltin / loadExternal / clearForPlugin 变更后快照整表替换
 * 触发重算。drawerTabViews() 必须在响应式作用域内调用，裸调（非响应上下文）只做一次性投影。
 */
import {
  BUILTIN_NAMESPACE,
  builtinDrawerSlots,
  contentSlotRegistry,
  type ContentSlotRenderer,
} from '../../extension-host/content-slot-registry'
import { RIGHT_DRAWER_REGISTRY } from './registry'
import type { RightDrawerTab } from './types'

/** 抽屉标签条派生条目（ContentSlotView 的抽屉消费投影：key = 控制态 tab 位）。 */
export interface DrawerTabView { // oe-exempt:20261025:framework:抽屉派生条目数据契约（类型契约先行，非抽象接口单实现）
  /** 控制态 tab 位：内置 = 内容 id（'git'）；插件 = 声明 id（命名空间全名，§6.12） */
  key: RightDrawerTab
  source: 'builtin' | 'plugin'
  pluginId: string
  /** 插件文案原文（§6.16④：有 label 用原文；内置项无此字段） */
  label?: string
  /** 内置文案 i18n key（内置项恒走，§6.16④） */
  labelKey?: string
  /** 图标标识（kebab-case lucide 名，渲染端映射表解析） */
  icon?: string
  scope: 'session' | 'global'
  openableWithoutData: boolean
  /** 插件空态文案原文 */
  emptyState?: { text?: string; hint?: string }
  /** 内置空态文案 i18n key */
  emptyTextKey?: string
  emptyHintKey?: string
  renderer: ContentSlotRenderer
}

/** 内置项装配（惰性幂等：首个读访问登记，重复调用零操作——registerBuiltin 同 id 覆盖写）。 */
let builtinsAssembled = false
function ensureBuiltinsAssembled(): void {
  if (builtinsAssembled) return
  contentSlotRegistry.registerBuiltin(builtinDrawerSlots(RIGHT_DRAWER_REGISTRY))
  builtinsAssembled = true
}

/** 内置项 key 还原：声明 id 恒为 '<保留命名空间>.<内容 id>'（builtinDrawerSlots 生成式），去前缀即内容 id。 */
function builtinTabKey(declarationId: string): RightDrawerTab {
  const prefix = `${BUILTIN_NAMESPACE}.`
  return declarationId.startsWith(prefix) ? declarationId.slice(prefix.length) : declarationId
}

/**
 * 右抽屉标签条派生视图（单一数据源：内置 ∪ 插件声明，替代 RIGHT_DRAWER_REGISTRY 直读——
 * 直读是「core 派生 N 项、界面画 N−1 项」双权威的根源）。须在响应式作用域内调用。
 */
export function drawerTabViews(): DrawerTabView[] {
  ensureBuiltinsAssembled()
  return contentSlotRegistry.deriveDrawerTabs().map((view) => ({
    key: view.source === 'builtin' ? builtinTabKey(view.id) : view.id,
    source: view.source,
    pluginId: view.pluginId,
    label: view.label,
    labelKey: view.labelKey,
    icon: view.icon,
    scope: view.scope,
    openableWithoutData: view.openableWithoutData,
    emptyState: view.emptyState,
    emptyTextKey: view.emptyTextKey,
    emptyHintKey: view.emptyHintKey,
    renderer: view.renderer,
  }))
}

/** 按 tab 位查派生条目（内容分派与失效判定与渲染端共用同一投影形态）。 */
export function findDrawerTabView(tab: RightDrawerTab): DrawerTabView | undefined {
  return drawerTabViews().find((view) => view.key === tab)
}

/**
 * 内置默认项（§11.1-1 断言 1/3 的锚）：派生视图中的首个内置项（内置序 = 注册表声明序，
 * git 恒首位）。不是派生视图首项——插件声明 order 抢到首位时（§6.16 同值按 pluginId
 * 字典序，多数插件 id 排在 taiji-host 前），新会话默认仍必须是内置项。
 * 全部内置项缺失的退化场景回退 'git'（与 createDefaultControlState 默认值同源）。
 */
export function builtinDefaultDrawerTab(): RightDrawerTab {
  return drawerTabViews().find((view) => view.source === 'builtin')?.key ?? 'git'
}

/**
 * 生效 tab 位：分区值命中派生视图则原样；未命中（插件 tab 卸载/禁用/崩溃）→ 回退内置
 * 默认项。纯派生不回写分区（见文件头注「失效回退」）。
 */
export function effectiveDrawerTab(partitionTab: RightDrawerTab): RightDrawerTab {
  return findDrawerTabView(partitionTab) !== undefined ? partitionTab : builtinDefaultDrawerTab()
}
