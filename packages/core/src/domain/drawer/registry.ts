/**
 * 容器声明式注册表 —— display-containers §7.2（条目 = 内容类型 + 图标标识字符串 + 标签/空态文案 i18n key；
 * 每个容器声明承接的内容类型列表 + 元信息）。
 *
 * 落位 core、纯数据形态（core headless 约定：零 DOM lib / 零 Vue 组件依赖——图标是 Vue 组件进不了 core；
 * shared 同为平台中立层同理）。ui 层建「图标标识 → @lucide/vue 组件」映射表解析渲染：
 * icon 字段 = 现行 DrawerPanel 图标（@lucide/vue）的 kebab-case 组件名，W0 同图标零变化。
 *
 * text 字段 = 设计 §7.2「条目文本」块的逐字锚（迁移类判据要求附全量），单测逐字对账；
 * §7.7 双形态契约：注册表条目即唯一权威，ui 壳组件与 core 协调函数都读它，禁止各自文字化。
 *
 * [HISTORICAL] W0 行为不变锚（u-foundation）：数据源切换当刻条目数与显示序与旧硬编码一致（旧 10 条）。
 * 终态容器归属 = CONTAINER_REGISTRY（右 8/底 1/浮 2，§7.2）。
 *
 * 状态：纯数据注册表，无行为实装（类型契约不实装行为）。终态容器归属 = CONTAINER_REGISTRY
 * （右 8/底 1/浮 2，§7.2）；右抽屉数组以 ContainerRegistryEntry<RightDrawerTab> 实例化——
 * 编译层锁终态 8 员（terminal/browser 混入右抽屉声明即 tsc 红），DrawerPanel 直接读
 * RIGHT_DRAWER_REGISTRY（CONTAINER_REGISTRY['right-drawer'] 同对象）
 */
import type { RightDrawerTab } from './types'

/** 三容器内容类型全集（display-containers §7.2）：右抽屉 8 员（RightDrawerTab）+ 底抽屉 terminal + 浮层 browser；
 * workflow 双承接（右抽屉回落载体 + 浮层主形态，§7.6）。仅注册表层使用——右抽屉控制态/tab 位一律用 RightDrawerTab。 */
export type ContainerContentType = RightDrawerTab | 'terminal' | 'browser'

/** 容器标识（§7.2 三个容器） */
export type ContainerId = 'right-drawer' | 'bottom-drawer' | 'overlay'

/** 容器注册表条目（§7.2：内容类型 + 图标标识字符串 + 标签/空态文案的 i18n key）。
 * 泛型按容器实例化：RIGHT_DRAWER_REGISTRY = <RightDrawerTab>（编译层锁终态 8 员）；
 * 底抽屉/浮层条目持全集类型（各容器条目数 1/2 由单测锚定，§7.2 声明即终态）。 */
export interface ContainerRegistryEntry<C extends ContainerContentType = ContainerContentType> { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  /** 内容类型（tab/内容标识；泛型参数 C 精确到容器承接的内容类型） */
  content: C
  /** §7.2 条目文本逐字锚（含内容类型前缀，如 'git（变更集）'）——与设计文档逐字对账，禁止改写 */
  text: string
  /** 图标标识字符串（kebab-case lucide 组件名，ui 层映射 @lucide/vue 组件渲染） */
  icon: string
  /** 标签文案 i18n key */
  labelKey: string
  /** 空态文案 i18n key */
  emptyTextKey: string
  /** 空态提示 i18n key */
  emptyHintKey: string
}

// ── 内容条目（单一定义：容器声明与 W0 载入序列引用同一对象，文本/键零重复定义）──
// i18n key 复用各内容域既有 key（panel.sideDrawer.* / plan.drawer.* / btw.drawer.*）——W0 零新增
// i18n key、换数据源后渲染等价；容器专属文案 key 若 W1/W2 壳组件单元增补，须同 commit 回改本注册表。

const TERMINAL_ENTRY: ContainerRegistryEntry = {
  content: 'terminal',
  text: 'terminal（终端）',
  icon: 'terminal',
  labelKey: 'panel.sideDrawer.tabTerminal',
  emptyTextKey: 'panel.sideDrawer.noTerminal',
  emptyHintKey: 'panel.sideDrawer.terminalHint',
}

const BROWSER_ENTRY: ContainerRegistryEntry = {
  content: 'browser',
  text: 'browser（网页）',
  icon: 'globe',
  labelKey: 'panel.sideDrawer.tabBrowser',
  emptyTextKey: 'panel.sideDrawer.noBrowser',
  emptyHintKey: 'panel.sideDrawer.browserHint',
}

const GIT_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'git',
  text: 'git（变更集）',
  icon: 'git-branch',
  labelKey: 'panel.sideDrawer.tabGit',
  emptyTextKey: 'panel.sideDrawer.noGit',
  emptyHintKey: 'panel.sideDrawer.gitHint',
}

const DOC_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'doc',
  text: 'doc（命令文档）',
  icon: 'book-open',
  labelKey: 'panel.sideDrawer.tabDoc',
  emptyTextKey: 'panel.sideDrawer.noDoc',
  emptyHintKey: 'panel.sideDrawer.docHint',
}

const DETAIL_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'detail',
  text: 'detail（文件详情）',
  icon: 'file-text',
  labelKey: 'panel.sideDrawer.tabDetail',
  emptyTextKey: 'panel.sideDrawer.noFileSelected',
  emptyHintKey: 'panel.sideDrawer.detailHint',
}

const SUBAGENT_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'subagent',
  text: 'subagent（子代理）',
  icon: 'bot',
  labelKey: 'panel.sideDrawer.tabSubagent',
  emptyTextKey: 'panel.sideDrawer.noSubagent',
  emptyHintKey: 'panel.sideDrawer.subagentHint',
}

const BASHTASK_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'bashTask',
  text: 'bashTask（后台命令）',
  icon: 'square-terminal',
  labelKey: 'panel.sideDrawer.tabBashTask',
  emptyTextKey: 'panel.sideDrawer.noBashTask',
  emptyHintKey: 'panel.sideDrawer.bashTaskHint',
}

const PLAN_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'plan',
  text: 'plan（计划文档）',
  icon: 'square-check-big',
  labelKey: 'plan.drawer.tabPlan',
  emptyTextKey: 'plan.drawer.noPlan',
  emptyHintKey: 'plan.drawer.planHint',
}

const BTW_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'btw',
  text: 'btw（旁路线）',
  icon: 'messages-square',
  labelKey: 'btw.drawer.tabBtw',
  emptyTextKey: 'btw.drawer.noThread',
  emptyHintKey: 'btw.drawer.threadHint',
}

/** 右抽屉 workflow 条目（§7.2：workflow（回落载体，L1 常驻，主入口浮层）） */
const WORKFLOW_DRAWER_ENTRY: ContainerRegistryEntry<RightDrawerTab> = {
  content: 'workflow',
  text: 'workflow（回落载体，L1 常驻，主入口浮层）',
  icon: 'workflow',
  labelKey: 'panel.sideDrawer.tabWorkflow',
  emptyTextKey: 'panel.sideDrawer.noWorkflow',
  emptyHintKey: 'panel.sideDrawer.workflowHint',
}

/** 浮层 workflow 条目（§7.2：workflow（工作流图）——同一内容类型在浮层的条目文本不同，故条目按 (容器, 内容) 成对） */
const WORKFLOW_OVERLAY_ENTRY: ContainerRegistryEntry = {
  content: 'workflow',
  text: 'workflow（工作流图）',
  icon: 'workflow',
  labelKey: 'panel.sideDrawer.tabWorkflow',
  emptyTextKey: 'panel.sideDrawer.noWorkflow',
  emptyHintKey: 'panel.sideDrawer.workflowHint',
}

// ── 终态容器声明（§7.2 逐字序：右 8 / 底 1 / 浮 2）──

/** 右抽屉（right-drawer）承接的内容类型列表（8 条，§7.2 声明序；<RightDrawerTab> = 编译层锁终态） */
export const RIGHT_DRAWER_REGISTRY: readonly ContainerRegistryEntry<RightDrawerTab>[] = [
  GIT_ENTRY,
  DOC_ENTRY,
  DETAIL_ENTRY,
  SUBAGENT_ENTRY,
  BASHTASK_ENTRY,
  PLAN_ENTRY,
  BTW_ENTRY,
  WORKFLOW_DRAWER_ENTRY,
]

/** 底抽屉（bottom-drawer）承接的内容类型列表（1 条——本期只有 terminal 一种内容，不预设 tab 枚举，§7.1 YAGNI） */
export const BOTTOM_DRAWER_REGISTRY: readonly ContainerRegistryEntry[] = [TERMINAL_ENTRY]

/** 浮层（overlay）承接的内容类型列表（2 条——单例换内容） */
export const OVERLAY_REGISTRY: readonly ContainerRegistryEntry[] = [BROWSER_ENTRY, WORKFLOW_OVERLAY_ENTRY]

/** 容器声明式注册表（§7.2：每个容器声明承接的内容类型列表 + 元信息） */
export const CONTAINER_REGISTRY: Readonly<Record<ContainerId, readonly ContainerRegistryEntry[]>> = {
  'right-drawer': RIGHT_DRAWER_REGISTRY,
  'bottom-drawer': BOTTOM_DRAWER_REGISTRY,
  overlay: OVERLAY_REGISTRY,
}
