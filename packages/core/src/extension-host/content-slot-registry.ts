/**
 * content-slot-registry.ts —— ContentSlotRegistry（容器扩展点统一 §6.1 容器位唯一事实源）。
 *
 * 插件/宿主对「容器能显示什么」的声明统一落本注册表；四个容器各有一份派生视图函数
 * （不做统一同构抽象——浮层没有全局标签条，一份抽象会强迫浮层假装有标签条，§6.1 不采用项）：
 * 右抽屉标签数组 / 浮层内容类型表 / 侧栏标签数组 / 设置页分组二级。
 *
 * 内置侧与声明侧的权威划分（单一事实源，禁双权威；AC7 信息流向 = 本模块不 import domain）：
 * - 内置项经 registerBuiltin 以声明形态登记（pluginId = 保留值 taiji-host）；抽屉内置的
 *   转换源 = RIGHT_DRAWER_REGISTRY（domain/drawer/registry.ts，既有唯一权威）——装配方经
 *   builtinDrawerSlots 转换器注入（结构类型入参，不产生模块依赖边）；侧栏/设置页内置项
 *   由消费单元以声明形态登记（core 无对应静态表）；
 * - 浮层内置项不经声明通道（开合/渲染由浮层壳显式分支承载，§6.8「切标签不改内容 kind」
 *   的不对称保留，U7 验收条款「runs 保留显式内置分支」同源）：builtinOverlayTypeViews
 *   转换器产出内置视图，经 deriveOverlayContentTypes 入参合并；workflow（runs）在视图上
 *   登记 §6.5 宿主渲染项（host + WorkflowVizDag——DAG/甘特原语不足保留宿主，U10 层 4）。
 * - 插件声明经 loadExternal 注入（placement 分派进对应派生视图）。
 *
 * 派生规则三条硬约束（§6.1）：
 * 1. renderer.kind === 'host' 必须有 component，缺则该声明不派生（不可用声明）；
 * 2. 宿主渲染项（kind='host'）的 pluginId 恒为 'taiji-host'（保留值），不被插件卸载清理误清；
 * 3. component 必须命中宿主组件白名单（插件声明只能命中不能创造），未命中按不可用声明处理。
 *
 * 声明输入校验（P12：外部插件声明是不可信输入）：
 * - id（§6.12）：`<命名空间>.<名称>`（命名空间 = deriveNamespace(pluginId)；'ui' 为内置保留），
 *   ≤128 字符、字符集 [a-z0-9._-]（小写归一化后校验）；违反判不可用声明；
 * - 文案（§6.9）：label / emptyState.text / emptyState.hint 各 ≤200 字符，超限截断 + 一行
 *   warning（截断比拒绝更不易误伤正常插件）；order 超 32 位整数范围按缺省（排内置项之后）。
 *
 * 不可用声明的降级口径（§5.4 判定表行 1-3）：单条声明无效不牵连插件其他贡献；
 * 不派生（不出现在任何派生视图）；原因记入声明条目（unavailable），供管理页标记与
 * 判定表消费。校验链的告警经 failure-degradation.ts 的统一出口 warnFailureOnce
 *（§6.14 去重键 = `pluginId::contributionId::失败种类`，进程级持存、插件重启不清空），
 * warning 文案内嵌的恢复动作对账同模块的 §5.4 判定表 FAILURE_JUDGEMENT_TABLE；
 * §6.13 图标解析单函数 resolveContributionIcon 亦在该模块（四容器与头部按钮共用）。
 * 先校验后动作在 ContainerNavigationExecutor（container-navigation.ts）。
 *
 * 响应式载体（§7.2）：注册表本体是 headless 非响应结构；snapshot（shallowRef 整表快照）
 * 供壳层组件 computed 追踪，registerBuiltin/loadExternal/clearForPlugin 变更方法内统一刷新
 *（构造性保证「变更后必刷新」，调用方无须记得显式刷新）。
 *
 * 排序（§6.16 序号契约，单点比较函数四处容器共用）：内置项 order = 数组下标派生
 *（起点 0 步长 10）；未声明 order 的插件项排内置项之后按抵达序；同值按 pluginId 字典序
 * 决胜；文案来源 = 声明有 label 用原文、无 label 查 labelKey（内置项恒走后者）。
 */
import { shallowRef, type ShallowRef } from 'vue'
import { deriveNamespace } from '@taiji/shared/plugin-namespace'
import type { OverlayContentKind } from '@taiji/shared'
import { FAILURE_JUDGEMENT_TABLE, warnFailureOnce } from './failure-degradation'

// ── 声明结构（§6.1 逐字形状）──────────────────────────────────────────

/** 容器位位置族：挂载点开放注册制下的开放字符串；已知族见 CONTENT_SLOT_PLACEMENTS。
 * 其中 'panel.header' / 'composer.toolbar' 由既有 headerAction/view 宿主通道消费（无派生视图）。 */
export type ContentSlotPlacement = string

/** 派生视图覆盖的四个容器位置族（§6.1 四容器表；§6.8：浮层族是 overlay.content 而非
 * overlay.tab——注册项表达「这是一种可显示的浮层内容」，不是「第几个标签页」）。 */
export const CONTENT_SLOT_PLACEMENTS = [
  'drawer.tab',
  'overlay.content',
  'sidebar.tab',
  'settings.section',
] as const

/** 宿主渲染项的保留归属值：pluginId 恒为该值，确保不被插件卸载清理误清（§6.1 硬约束 2）。 */
export const HOST_PLUGIN_ID = 'taiji-host'

/** 内置声明的保留命名空间（§6.12：内置项命名空间登记为 ui，如 ui.git、ui.scheduler）。 */
export const BUILTIN_NAMESPACE = 'ui'

/** renderer 分派（§6.1）：view = 插件推树（ViewHost 按 (sessionId, viewId) 消费）；
 * host = 宿主内置组件（component 必须命中白名单）。 */
export type ContentSlotRenderer =
  | { kind: 'view'; viewId: string }
  | { kind: 'host'; component: string }

/**
 * 设置页分区内容列限宽档（§7.5 待验证项落位：contentMaxWidth 三档判据从「分区 id 硬编码」
 * 改声明字段，字段形状由实施拍板）——仅 settings.section 声明消费；缺省 = 默认档。
 */
export type SettingsContentMaxWidth = 'wide' | 'medium' | 'default'

/** 容器位声明（§6.1 声明结构逐字形状 + 内置项 i18n key 直通三字段）。 */
export interface ContentSlotDeclaration { // oe-exempt:20261025:framework:wire 声明契约（类型契约先行，非抽象接口单实现）
  /** 容器位标识，必须带插件命名空间前缀（§6.12）；内置项用 'ui.' 前缀 */
  id: string
  placement: ContentSlotPlacement
  /** 显示名（插件自带；内置项文案走 labelKey，本字段对内置投影不参与渲染） */
  label: string
  /** 图标名（§6.13 统一解析，宿主按白名单解析，未命中落兜底图标） */
  icon?: string
  /** 排序（§6.16 序号契约：未声明排内置项之后、同值按 pluginId 字典序决胜） */
  order?: number
  /** 仅 settings.section 使用：归到哪个分组（无组时消费端归「其他」） */
  group?: string
  /** 仅 settings.section 使用：内容列限宽档（§7.5 声明化；缺省 = 默认档） */
  contentMaxWidth?: SettingsContentMaxWidth
  /** 会话归属（§6.9：缺省 'session'；'global' 内容不参与会话级联） */
  scope: 'session' | 'global'
  /** 归属；宿主渲染项用保留值 taiji-host（HOST_PLUGIN_ID） */
  pluginId: string
  renderer: ContentSlotRenderer
  emptyState?: { text?: string; hint?: string }
  /** §6.15：无数据时可进入（缺省 true，空态由 emptyState 承载） */
  openableWithoutData?: boolean
  // ── 内置项专用 i18n key 直通（builtinDrawerSlots 转换器填充；插件声明不填——
  // 插件文案自带原文 §6.16④，i18n 词表归宿主容器域，不给插件声明面暴露 key 通道）──
  /** 标签文案 i18n key（内置项恒走，§6.16④） */
  labelKey?: string
  /** 空态文案 i18n key（内置项） */
  emptyTextKey?: string
  /** 空态提示 i18n key（内置项） */
  emptyHintKey?: string
}

/** 不可用声明的原因（§5.4 判定表行的注册表内投影；管理页标记与判定表消费）。
 *  'unknown-placement' = §5.4 行 2（placement 不在容器位位置族词表——已注册挂载点
 *  族内不存在对应容器派生位，U13 落地）。 */
export type UnavailableSlotReason = 'invalid-id' | 'missing-component' | 'component-not-allowed' | 'unknown-placement'

/** 注册表全量条目（含不可用标记——不可用声明不派生但必须在册，供管理页/判定表消费）。 */
export interface ContentSlotEntry { // oe-exempt:20261025:framework:注册表条目数据契约（类型契约先行，非抽象接口单实现）
  declaration: ContentSlotDeclaration
  /** 校验失败原因；undefined = 可用 */
  unavailable?: UnavailableSlotReason
}

// ── 宿主组件白名单（§6.1 硬约束 3 / T2 审查残留项）─────────────────────

/**
 * 宿主内置组件白名单：壳持有的常量表。插件声明 renderer.kind='host' 时 component 只能
 * 命中本表（只能命中不能创造）——外部插件已可安装（EXTERNAL_PLUGIN_ENABLED=true），
 * component 是插件可控字符串，无白名单等价于「插件可指定宿主渲染任意组件」。
 *
 * 初始成员两类（§6.5 + 既有内置 tab）：
 * - 三类重可视化宿主组件（§6.5 明确不插件化，登记为宿主渲染器）：对话流 MessageStream /
 *   DAG 图 WorkflowVizDag / 甘特图 WorkflowVizGantt；
 * - 右抽屉既有内置 tab 内容组件（PanelContainer 现行 8 分支条件链的分支组件）。
 * 名值为 Vue 组件名（PascalCase）；渲染端内置组件表以本表为契约（U6 消费）。
 */
export const HOST_COMPONENT_WHITELIST = [
  // 三类重可视化（§6.5：坐标系 + 连线 + 手势需求，原语不足，明确保留宿主）
  'MessageStream',
  'WorkflowVizDag',
  'WorkflowVizGantt',
  // 右抽屉既有内置 tab 内容组件（git/doc/detail/subagent/bashTask/plan/btw/trace）
  'GitPanel',
  'CommandDocPanel',
  'DetailPane',
  'SubagentTab',
  'BackgroundTaskDetailPanel',
  'PlanDocsPanel',
  'BtwPanel',
  'TraceInspector',
] as const

export type HostComponentName = (typeof HOST_COMPONENT_WHITELIST)[number]

/** 右抽屉内置 tab → 宿主内容组件（PanelContainer 现行分支链的静态对账锚；内置项是
 * 白名单的「创造侧」，不经白名单校验——白名单约束的是插件声明）。 */
const BUILTIN_DRAWER_HOST_COMPONENTS: Record<string, HostComponentName> = {
  git: 'GitPanel',
  doc: 'CommandDocPanel',
  detail: 'DetailPane',
  subagent: 'SubagentTab',
  bashTask: 'BackgroundTaskDetailPanel',
  plan: 'PlanDocsPanel',
  btw: 'BtwPanel',
  trace: 'TraceInspector',
}

// ── 内置项转换器（结构类型入参，零 domain import——AC7 信息流向单向）────────

/** 抽屉静态注册表条目的结构像（domain ContainerRegistryEntry 的成员子集，鸭子类型兼容）。 */
export interface DrawerRegistryEntryLike { // oe-exempt:20261025:framework:转换器结构类型入参（零依赖解耦形态，非抽象接口单实现）
  content: string
  icon: string
  labelKey: string
  emptyTextKey: string
  emptyHintKey: string
}

/**
 * 抽屉内置项转换器：RIGHT_DRAWER_REGISTRY 条目 → 内置声明（装配方调 registerBuiltin 登记）。
 * id = 'ui.<content>'（§6.12 内置保留命名空间）；renderer = host + 白名单内内置组件
 *（BUILTIN_DRAWER_HOST_COMPONENTS）；文案走 labelKey（§6.16④ 内置项恒走 key），label 按
 * 声明结构必填报条目 text（渲染端 labelKey 优先，不参与内置项渲染）。
 */
export function builtinDrawerSlots(entries: readonly DrawerRegistryEntryLike[]): ContentSlotDeclaration[] {
  return entries.map((entry) => ({
    id: `${BUILTIN_NAMESPACE}.${entry.content}`,
    placement: 'drawer.tab',
    label: entry.content,
    icon: entry.icon,
    scope: 'session',
    pluginId: HOST_PLUGIN_ID,
    renderer: { kind: 'host', component: BUILTIN_DRAWER_HOST_COMPONENTS[entry.content] },
    openableWithoutData: true,
    labelKey: entry.labelKey,
    emptyTextKey: entry.emptyTextKey,
    emptyHintKey: entry.emptyHintKey,
  }))
}

/** 浮层静态注册表条目的结构像（domain ContainerRegistryEntry 的成员子集，鸭子类型兼容）。 */
export interface OverlayRegistryEntryLike { // oe-exempt:20261025:framework:转换器结构类型入参（零依赖解耦形态，非抽象接口单实现）
  content: string
  icon: string
  labelKey: string
  emptyTextKey: string
  emptyHintKey: string
}

/**
 * 浮层内置项转换器：OVERLAY_REGISTRY 条目 → 内置内容类型视图（经 deriveOverlayContentTypes
 * 入参合并，不进注册表——内置浮层内容的开合/渲染由浮层壳显式分支承载，§6.8）。
 * kind = 条目 content（词表成员序与 OverlayContentKind 判别联合一致，registry 单测对账）；
 * openableWithoutData 按 §6.15：workflow（runs）显式 false，其余 true。
 *
 * [容器扩展点统一 §6.5/U10 层 4] runs（workflow kind）登记为宿主渲染项：
 * renderer = host + WorkflowVizDag——DAG 与甘特是坐标系 + 连线 + 手势需求、11 个原语
 * 全为流式布局语义无法表达（§6.5 不采用项），宿主实现是设计内取舍不是待迁遗留；在
 * 内容类型表上显式携带 host renderer 登记，使「runs = 宿主渲染项」成为派生数据事实
 *（与插件推树条目同构、区别只是内容来源——消费方可据此分派，无须复刻壳内分支知识）。
 * 其余三个内置 kind 不携带 renderer：browser 是独立壳无内容类型语义，scheduler 由
 * 插件推树（ViewHost 路径）、canvas 的宿主组件（CanvasPane）不在 §6.5 三类重可视化
 * 登记范围（白名单外，不冒登）。
 */
export function builtinOverlayTypeViews(entries: readonly OverlayRegistryEntryLike[]): OverlayContentTypeView[] {
  return entries.map((entry) => ({
    kind: entry.content as OverlayContentKind,
    source: 'builtin',
    pluginId: HOST_PLUGIN_ID,
    labelKey: entry.labelKey,
    icon: entry.icon,
    scope: 'session',
    openableWithoutData: entry.content !== 'workflow',
    emptyTextKey: entry.emptyTextKey,
    emptyHintKey: entry.emptyHintKey,
    // §6.5 宿主渲染项登记：仅 workflow（runs）——DAG/甘特保留宿主（原语不足，§6.5）
    ...(entry.content === 'workflow'
      ? ({ renderer: { kind: 'host', component: 'WorkflowVizDag' } } as const)
      : {}),
  }))
}

// ── 输入校验（P12 / §6.9 / §6.12）────────────────────────────────────

/** 文案字段长度上限（§6.9：超限截断 + 一行 warning，不拒绝整条声明） */
const TEXT_MAX_LENGTH = 200
/** id 长度上限（§6.12） */
const ID_MAX_LENGTH = 128
/** id 字符集（§6.12：小写归一化后校验） */
const ID_PATTERN = /^[a-z0-9._-]+$/
/** 32 位有符号整数范围（§6.9：order 超范围按缺省处理） */
const ORDER_MIN = -2147483648
const ORDER_MAX = 2147483647

/**
 * 声明 id 校验（§6.12）：`<命名空间>.<名称>`、≤128 字符、字符集 [a-z0-9._-]（小写归一化
 * 后校验）、命名空间 = deriveNamespace(pluginId)。内置声明（builtin=true）命名空间必须是
 * 保留值 'ui'；插件声明的 'ui' 命名空间被拒（保留命名空间，防插件冒充内置项）。
 *
 * @returns null = 合法；否则返回失败原因短语（warning 文案）
 */
export function validateContentSlotId(id: string, pluginId: string, builtin = false): string | null {
  const normalized = id.trim().toLowerCase()
  if (normalized.length === 0) return 'id 为空'
  if (normalized.length > ID_MAX_LENGTH) return `id 超 ${ID_MAX_LENGTH} 字符上限`
  if (!ID_PATTERN.test(normalized)) return 'id 含 [a-z0-9._-] 之外字符'
  const dot = normalized.indexOf('.')
  if (dot <= 0 || dot === normalized.length - 1) return 'id 缺命名空间前缀（须为 <命名空间>.<名称> 形态）'
  const namespace = normalized.slice(0, dot)
  if (builtin) {
    if (namespace !== BUILTIN_NAMESPACE) return `内置声明命名空间须为保留值 '${BUILTIN_NAMESPACE}'`
    return null
  }
  if (namespace === BUILTIN_NAMESPACE) return `命名空间 '${BUILTIN_NAMESPACE}' 为内置保留`
  const expected = deriveNamespace(pluginId).toLowerCase()
  if (expected.length === 0) return '插件命名空间推导为空（pluginId 形态异常）'
  if (namespace !== expected) return `id 命名空间 '${namespace}' 与插件命名空间 '${expected}' 不一致`
  return null
}

/** 文案截断（§6.9：≤200 字符，超限截断 + warn 一次；返回截断后文本） */
function clampText(text: string, field: string, pluginId: string, id: string): string {
  if (text.length <= TEXT_MAX_LENGTH) return text
  warnFailureOnce(pluginId, id, 'text-truncated', `文案截断：${field} 超 ${TEXT_MAX_LENGTH} 字符已截断（${pluginId}/${id}）——按 §6.9 上限约束，插件侧缩短文案`)
  return text.slice(0, TEXT_MAX_LENGTH)
}

/** order 有效性（§6.9：超 32 位整数范围按缺省——null 表示按缺省处理） */
function normalizeOrder(order: number | undefined): number | null {
  if (order === undefined) return null
  if (!Number.isInteger(order) || order < ORDER_MIN || order > ORDER_MAX) return null
  return order
}

// ── 派生视图产出形态 ──────────────────────────────────────────────────

/**
 * 派生视图统一条目（抽屉/侧栏标签数组与设置页分区共用基形；浮层为 OverlayContentTypeView）。
 * 文案二态（§6.16④）：labelKey（内置项恒走）与 label（插件声明原文）——消费端按
 * 「有 label 用原文，无 label 查 labelKey」渲染；core headless 无 i18n，key 解析归渲染端。
 */
export interface ContentSlotView { // oe-exempt:20261025:framework:派生视图数据契约（类型契约先行，非抽象接口单实现）
  id: string
  placement: ContentSlotPlacement
  source: 'builtin' | 'plugin'
  /** 内置项恒为 taiji-host */
  pluginId: string
  labelKey?: string
  label?: string
  icon?: string
  /** settings.section 分组归属（无组时消费端归「其他」） */
  group?: string
  /** settings.section 内容列限宽档（§7.5 声明化；缺省 = 默认档） */
  contentMaxWidth?: SettingsContentMaxWidth
  scope: 'session' | 'global'
  openableWithoutData: boolean
  emptyState?: { text?: string; hint?: string }
  emptyTextKey?: string
  emptyHintKey?: string
  renderer: ContentSlotRenderer
}

/** 浮层内容类型视图（§6.1 浮层行：内容类型表，不是标签条）。内置项 renderer 两态：
 * workflow（runs）= §6.5 宿主渲染项登记（host + WorkflowVizDag——DAG/甘特原语不足保留
 * 宿主）；其余内置 kind 留空（开合/渲染由浮层壳显式分支承载，§6.8：workflow 壳内标签条
 * 是宿主实现、切标签不改内容 kind 的不对称保留）；插件项 renderer 必有（声明校验保证）。 */
export interface OverlayContentTypeView { // oe-exempt:20261025:framework:派生视图数据契约（类型契约先行，非抽象接口单实现）
  /** 内置 = 4 kind（browser/workflow/scheduler/canvas）；插件 = 'plugin' */
  kind: OverlayContentKind
  source: 'builtin' | 'plugin'
  /** 插件项 = 声明 id（openOverlayContent 的寻址键）；内置项无 */
  contentId?: string
  pluginId: string
  labelKey?: string
  label?: string
  icon?: string
  scope: 'session' | 'global'
  openableWithoutData: boolean
  emptyState?: { text?: string; hint?: string }
  emptyTextKey?: string
  emptyHintKey?: string
  renderer?: ContentSlotRenderer
}

/** 设置页分组二级视图（§6.1 设置页行：分组 → 分区二级结构）。 */
export interface SettingsSectionGroupView { // oe-exempt:20261025:framework:派生视图数据契约（类型契约先行，非抽象接口单实现）
  /** 分组标识；undefined = 声明未带 group（消费端归「其他」） */
  group?: string
  sections: ContentSlotView[]
}

// ── 排序（§6.16 单点比较函数，四处容器共用）───────────────────────────

/** 排序键最小结构（比较只消费三标量；ContentSlotView 与 OverlayContentTypeView 两类条目共用）。 */
interface OrderableSlot { // oe-exempt:20261025:framework:排序输入数据形状（类型契约先行，非抽象接口单实现）
  /** 内置 = 下标×10；声明缺省/超范围 = 排内置项之后 */
  order: number
  seq: number
  pluginId: string
}

/** 排序内部条目（视图 + 排序键；seq = 抵达序决胜位，单次派生调用内稳定）。 */
interface SortableSlot extends OrderableSlot { // oe-exempt:20261025:framework:排序输入数据形状（类型契约先行，非抽象接口单实现）
  view: ContentSlotView
}

/** 内置项 order 派生步长（§6.16①：数组下标，起点 0 步长 10） */
const BUILTIN_ORDER_STEP = 10

/** 内置项 order 派生（§6.16①：数组下标，起点 0 步长 10） */
function builtinOrder(index: number): number {
  return index * BUILTIN_ORDER_STEP
}

/** 未声明/无效 order 的排位（排在内置项之后，§6.16②） */
const UNORDERED_SLOT_ORDER = Number.MAX_SAFE_INTEGER

/**
 * §6.16 序号契约的单点比较：order 升序 → 同值按 pluginId 字典序 → 仍同按抵达序
 *（seq；派生遍历序 = 注册表插入序，稳定确定）。
 */
export function compareContentSlotOrder(a: OrderableSlot, b: OrderableSlot): number {
  if (a.order !== b.order) return a.order - b.order
  if (a.pluginId !== b.pluginId) return a.pluginId < b.pluginId ? -1 : 1
  return a.seq - b.seq
}

// ── 注册表 ───────────────────────────────────────────────────────────

export class ContentSlotRegistry {
  /** 内置声明（registerBuiltin 登记的；侧栏/设置页内置项通道）。key = id。 */
  private builtin = new Map<string, ContentSlotEntry>()
  /** 插件声明，按 pluginId 分区（loadExternal 覆盖粒度 = per pluginId）。key = id。 */
  private external = new Map<string, Map<string, ContentSlotEntry>>()

  /** 响应式载体（§7.2）：整表快照（builtin ∪ external 的可用声明），变更方法内刷新。 */
  private readonly snapshotRef = shallowRef<readonly ContentSlotDeclaration[]>([])

  get snapshot(): Readonly<ShallowRef<readonly ContentSlotDeclaration[]>> {
    return this.snapshotRef
  }

  /** 刷新响应式快照（整表替换——shallowRef 只对 .value 赋值触发，禁止原地改）。 */
  private refreshSnapshot(): void {
    const all: ContentSlotDeclaration[] = []
    for (const entry of this.builtin.values()) {
      if (entry.unavailable === undefined) all.push(entry.declaration)
    }
    for (const partition of this.external.values()) {
      for (const entry of partition.values()) {
        if (entry.unavailable === undefined) all.push(entry.declaration)
      }
    }
    this.snapshotRef.value = all
  }

  /**
   * 登记内置声明（侧栏/设置页内置项通道；宿主渲染项 pluginId 恒为 taiji-host）。
   * 内置通道是宿主自身声明——校验失败 fail-fast throw（外部声明静默降级，宿主写错必须当场出声）。
   */
  registerBuiltin(declarations: ContentSlotDeclaration[]): void {
    for (const d of declarations) {
      if (d.pluginId !== HOST_PLUGIN_ID) {
        throw new Error(`[content-slot-registry] builtin 声明 pluginId 必须为保留值 '${HOST_PLUGIN_ID}'，got '${d.pluginId}'（id=${d.id}）`)
      }
      const invalid = validateContentSlotId(d.id, d.pluginId, true)
      if (invalid !== null) {
        throw new Error(`[content-slot-registry] builtin 声明 id 非法：${invalid}（id=${d.id}）`)
      }
      this.builtin.set(d.id, { declaration: this.clampDeclaration(d) })
    }
    this.refreshSnapshot()
  }

  /**
   * 注入插件声明（覆盖粒度 = per pluginId，重复调用幂等不翻倍——对齐 ContributionRegistry
   * loadExternal 同族语义）。声明逐条校验（§6.12 id / §6.1 host 组件 / §6.9 上限）：不合规
   * 条目判不可用（不派生、记录原因），不牵连同批其他声明（§5.4 声明级失败不牵连插件）。
   * 同一次调用内重复 id：后者判不可用且不保留记录（仅首条生效 + 一行 warning，§5.4 第三行）；
   * 跨调用同 id = 重放覆盖（幂等）。
   */
  loadExternal(pluginId: string, declarations: ContentSlotDeclaration[]): void {
    const partition = new Map<string, ContentSlotEntry>()
    for (const d of declarations) {
      const entry = this.validateDeclaration(d, pluginId, partition)
      // 同批重复 id：保留首条（validateDeclaration 已判后者不可用；不覆盖首条的可用记录）
      if (!partition.has(d.id)) partition.set(d.id, entry)
    }
    this.external.set(pluginId, partition)
    this.refreshSnapshot()
  }

  /**
   * 清除插件全部声明（崩溃/禁用/卸载清理族，幂等）。内置声明（taiji-host）不受影响
   *（§6.1 硬约束 2：宿主渲染项不被插件卸载清理误清）。
   */
  clearForPlugin(pluginId: string): void {
    if (pluginId === HOST_PLUGIN_ID) return
    this.external.delete(pluginId)
    this.refreshSnapshot()
  }

  /** 单条声明校验 + 归一（§5.4 行序：placement 族 → §6.12 id → 同批重复 → §6.1 host 组件 → §6.9 上限截断）。 */
  private validateDeclaration(
    d: ContentSlotDeclaration,
    pluginId: string,
    partition: Map<string, ContentSlotEntry>,
  ): ContentSlotEntry {
    // §5.4 行 2：placement 不在容器位位置族词表 = 已注册族内不存在的容器位（不派生、
    // 标记不可用；已知派生族见 CONTENT_SLOT_PLACEMENTS——panel.header 等宿主通道族
    // 不进本注册表，由装配方分发给既有通道）
    if (!(CONTENT_SLOT_PLACEMENTS as readonly string[]).includes(d.placement)) {
      warnFailureOnce(
        pluginId,
        d.id,
        'unknown-placement',
        `声明不可用（unknown-placement）：placement '${d.placement}' 不在容器位位置族词表（${pluginId}/${d.id}）——${FAILURE_JUDGEMENT_TABLE['unknown-placement'].recovery}`,
      )
      return { declaration: d, unavailable: 'unknown-placement' }
    }
    const idError = validateContentSlotId(d.id, pluginId)
    if (idError !== null) {
      warnFailureOnce(pluginId, d.id, 'invalid-id', `声明不可用（invalid-id）：${idError}（${pluginId}/${d.id}）——${FAILURE_JUDGEMENT_TABLE['invalid-id'].recovery}`)
      return { declaration: d, unavailable: 'invalid-id' }
    }
    if (partition.has(d.id)) {
      warnFailureOnce(pluginId, d.id, 'invalid-id', `声明不可用（invalid-id）：同批声明 id 重复（${pluginId}/${d.id}）——§5.4 声明 id 重复按不可用处理，仅首条生效`)
      return { declaration: d, unavailable: 'invalid-id' }
    }
    if (d.renderer.kind === 'host') {
      if (typeof d.renderer.component !== 'string' || d.renderer.component.length === 0) {
        // §6.1 硬约束 1：host 必须有 component，缺则该声明不派生
        warnFailureOnce(pluginId, d.id, 'missing-component', `声明不可用（missing-component）：renderer.kind='host' 缺 component（${pluginId}/${d.id}）——补 component 或改用 kind:'view'`)
        return { declaration: d, unavailable: 'missing-component' }
      }
      if (!(HOST_COMPONENT_WHITELIST as readonly string[]).includes(d.renderer.component)) {
        // §6.1 硬约束 3：插件声明只能命中白名单，不能创造
        warnFailureOnce(pluginId, d.id, 'component-not-allowed', `声明不可用（component-not-allowed）：component '${d.renderer.component}' 不在宿主组件白名单（${pluginId}/${d.id}）——改用白名单内组件或 kind:'view' 推树`)
        return { declaration: d, unavailable: 'component-not-allowed' }
      }
    }
    return { declaration: this.clampDeclaration({ ...d, pluginId }) }
  }

  /** 声明归一：文案截断（§6.9）+ scope 缺省补全（浅拷贝，不改调用方对象）。 */
  private clampDeclaration(d: ContentSlotDeclaration): ContentSlotDeclaration {
    const normalized: ContentSlotDeclaration = {
      ...d,
      label: clampText(d.label, 'label', d.pluginId, d.id),
      scope: d.scope ?? 'session',
    }
    if (d.emptyState !== undefined) {
      normalized.emptyState = {
        text: d.emptyState.text !== undefined
          ? clampText(d.emptyState.text, 'emptyState.text', d.pluginId, d.id)
          : undefined,
        hint: d.emptyState.hint !== undefined
          ? clampText(d.emptyState.hint, 'emptyState.hint', d.pluginId, d.id)
          : undefined,
      }
    }
    return normalized
  }

  /** 全量在册条目（含不可用标记；管理页/判定表消费）。 */
  listEntries(): ContentSlotEntry[] {
    return [...this.builtin.values(), ...[...this.external.values()].flatMap((p) => [...p.values()])]
  }

  /** 全局 id 空间命中（U5 ContainerSlotLookup.resolveTargets 的注册表侧查询原语）。 */
  findById(id: string): ContentSlotDeclaration[] {
    return this.listEntries()
      .filter((e) => e.unavailable === undefined && e.declaration.id === id)
      .map((e) => e.declaration)
  }

  // ── 四份派生视图（§6.1 四容器表）───────────────────────────────────

  /** 可用声明按位置族过滤（unavailable 条目不派生——§5.4 不可用声明降级）。
   *  读取点 = 响应式快照（§7.2 载体契约）：变更方法内整表替换 snapshotRef，消费方 computed
   *  经本读取点建立依赖后自动重算；走 listEntries 读裸 Map 则零依赖（U6 接线时实测
   *  clearForPlugin 后派生视图不刷新的缺陷根因）。 */
  private availableByPlacement(placement: ContentSlotPlacement): ContentSlotDeclaration[] {
    return this.snapshotRef.value.filter((d) => d.placement === placement)
  }

  /** 声明 → 视图投影（文案/图标/空态透传；openableWithoutData 缺省 true，§6.15）。 */
  private toView(d: ContentSlotDeclaration, source: 'builtin' | 'plugin'): ContentSlotView {
    return {
      id: d.id,
      placement: d.placement,
      source,
      pluginId: d.pluginId,
      label: d.label,
      labelKey: d.labelKey,
      icon: d.icon,
      group: d.group,
      contentMaxWidth: d.contentMaxWidth,
      scope: d.scope,
      openableWithoutData: d.openableWithoutData ?? true,
      emptyState: d.emptyState,
      emptyTextKey: d.emptyTextKey,
      emptyHintKey: d.emptyHintKey,
      renderer: d.renderer,
    }
  }

  /** 内置 ∪ 声明合并 + §6.16 排序（抽屉/侧栏/设置页共用；seq = 遍历序，单次派生内稳定）。 */
  private mergeAndSort(builtinViews: ContentSlotView[], externalViews: ContentSlotView[]): ContentSlotView[] {
    let seq = 0
    const merged: SortableSlot[] = []
    for (const view of builtinViews) {
      merged.push({ view, order: builtinOrder(merged.length), seq: seq++, pluginId: view.pluginId })
    }
    for (const view of externalViews) {
      merged.push({ view, order: this.externalOrderByView(view), seq: seq++, pluginId: view.pluginId })
    }
    return merged.sort(compareContentSlotOrder).map((s) => s.view)
  }

  /** 视图回查声明 order（合并排序需要声明侧 order；未命中 = 排内置项之后）。 */
  private externalOrderByView(view: ContentSlotView): number {
    for (const partition of this.external.values()) {
      const entry = partition.get(view.id)
      if (entry !== undefined && entry.unavailable === undefined) {
        return normalizeOrder(entry.declaration.order) ?? UNORDERED_SLOT_ORDER
      }
    }
    return UNORDERED_SLOT_ORDER
  }

  /**
   * 位置族派生视图的共用前奏（抽屉/侧栏/设置页三容器同构）：内置/插件分桶投影 +
   * mergeAndSort 合并排序。浮层（deriveOverlayContentTypes）视图类型与 order 回查
   * 不同，不共用本前奏。
   */
  private deriveViewsByPlacement(placement: ContentSlotPlacement): ContentSlotView[] {
    const available = this.availableByPlacement(placement)
    const builtinViews = available
      .filter((d) => d.pluginId === HOST_PLUGIN_ID)
      .map((d) => this.toView(d, 'builtin'))
    const externalViews = available
      .filter((d) => d.pluginId !== HOST_PLUGIN_ID)
      .map((d) => this.toView(d, 'plugin'))
    return this.mergeAndSort(builtinViews, externalViews)
  }

  /**
   * 右抽屉标签数组（§6.1：内置 8 项 ∪ 声明项，排序后）。内置侧 = registerBuiltin 登记
   * 的 drawer.tab 内置声明（装配方经 builtinDrawerSlots 从 RIGHT_DRAWER_REGISTRY 转换注入），
   * 声明侧 = placement='drawer.tab' 的插件声明。
   */
  deriveDrawerTabs(): ContentSlotView[] {
    return this.deriveViewsByPlacement('drawer.tab')
  }

  /**
   * 浮层内容类型表（§6.1：内置 4 kind ∪ 声明项；§6.8 内容类型注册表形态）。
   * 内置侧 = builtinViews 入参（装配方经 builtinOverlayTypeViews 从 OVERLAY_REGISTRY 转换，
   * 结构类型入参不产生 domain 依赖边）；openableWithoutData 按 §6.15：workflow（runs）显式
   * false（保持既有禁用规则），其余内置 true。声明侧 renderer 透传（contentId = 声明 id）。
   */
  deriveOverlayContentTypes(builtinViews: readonly OverlayContentTypeView[] = []): OverlayContentTypeView[] {
    const externalViews: OverlayContentTypeView[] = this.availableByPlacement('overlay.content').map((d) => ({
      kind: 'plugin',
      source: 'plugin',
      contentId: d.id,
      pluginId: d.pluginId,
      label: d.label,
      icon: d.icon,
      scope: d.scope,
      openableWithoutData: d.openableWithoutData ?? true,
      emptyState: d.emptyState,
      renderer: d.renderer,
    }))
    let seq = 0
    const merged: Array<{ view: OverlayContentTypeView; order: number; seq: number; pluginId: string }> = []
    for (const view of builtinViews) {
      merged.push({ view, order: builtinOrder(merged.length), seq: seq++, pluginId: view.pluginId })
    }
    for (const view of externalViews) {
      merged.push({ view, order: this.externalOrderByContentId(view.contentId), seq: seq++, pluginId: view.pluginId })
    }
    return merged.sort(compareContentSlotOrder).map((s) => s.view)
  }

  /** 浮层声明 order 回查（contentId = 声明 id；未命中 = 排内置项之后）。 */
  private externalOrderByContentId(contentId: string | undefined): number {
    if (contentId === undefined) return UNORDERED_SLOT_ORDER
    for (const partition of this.external.values()) {
      const entry = partition.get(contentId)
      if (entry !== undefined && entry.unavailable === undefined) {
        return normalizeOrder(entry.declaration.order) ?? UNORDERED_SLOT_ORDER
      }
    }
    return UNORDERED_SLOT_ORDER
  }

  /**
   * 侧栏标签数组（§6.1：内置 3 项 ∪ 声明项）。内置项经 registerBuiltin 登记
   *（placement='sidebar.tab'、pluginId=taiji-host——core 无侧栏静态表，消费单元登记）。
   */
  deriveSidebarTabs(): ContentSlotView[] {
    return this.deriveViewsByPlacement('sidebar.tab')
  }

  /**
   * 设置页分组二级结构（§6.1：内置项 ∪ 声明项，group 字段决定归属；无组时归
   * undefined 组——消费端呈现为「其他」）。合并排序后按 group 分桶（桶序 = 首现序）。
   */
  deriveSettingsSections(): SettingsSectionGroupView[] {
    const sorted = this.deriveViewsByPlacement('settings.section')
    const groups = new Map<string | undefined, ContentSlotView[]>()
    for (const view of sorted) {
      const bucket = groups.get(view.group)
      if (bucket !== undefined) bucket.push(view)
      else groups.set(view.group, [view])
    }
    return [...groups.entries()].map(([group, sections]) => ({ group, sections }))
  }
}

// ── 模块级单例（§6.1「一份注册表」的实体承载）──────────────────────────

/**
 * 容器位注册表唯一实例：四个容器的派生视图必须同源于一份注册表（§6.1），多实例 = 双权威
 * （同一插件声明在一个容器的派生视图出现、另一个容器的实例缺失）。容器消费单元（U6 抽屉 /
 * U7 浮层 / U8 侧栏设置页）与壳层声明通路/清理接线（loadExternal / clearForPlugin）共用；
 * 单测隔离用 `new ContentSlotRegistry()` 构造独立实例。
 *
 * @data-owner #86 —— 容器位声明注册表（GUI 数据源登记表：四容器声明全集 + 派生视图）。
 */
export const contentSlotRegistry = new ContentSlotRegistry()
