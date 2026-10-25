/**
 * failure-degradation.ts —— 容器位失败降级三件套（§5.4 判定表 / §6.14 告警去重 / §6.13 图标解析）。
 *
 * 与注册表本体（content-slot-registry.ts）的分工：本模块承载失败路径的判定与呈现口径
 * （判定表、告警去重、图标白名单——随 §5.4/§6.13/§6.14 演化）；注册表承载「声明 →
 * 派生视图」的结构与校验链。注册表校验链消费本模块的 warnFailureOnce 与判定表
 * recovery 文案；导航执行器（container-navigation.ts）消费判定表行 5-8。
 *
 * 告警去重键集合登记 docs/architecture/data-source-registry.md #80（载体 ①）。
 */

// ── §5.4 失败判定表（§6.14 三件套之一：判定表落地）────────────────────

/**
 * §5.4 判定表失败种类（八行，行号 = 设计文档 §5.4 表行序）。各判定出口：
 * - 行 1：挂载点路由（ContributionRegistry.routeAll）——core 侧 emit
 *   `unregistered-mount-point` 事件，告警与去重在 renderer 订阅侧（键同名同形）；
 * - 行 2-4：ContentSlotRegistry 校验链 + resolveContributionIcon（content-slot-registry.ts）；
 * - 行 5-8：导航执行器（ContainerNavigationExecutor，点击驱动逐次 warn，不去重）。
 *
 * 行 5-8 的种类值与 ContainerNavigationFailure 的 'unknown-target' / 'family-mismatch' /
 * 'not-openable' 同名（行 8 未知键在执行器内不构成失败结果，仅 warning）。
 */
export type SlotFailureKind =
  | 'unregistered-mount-point' // 行 1：声明引用了未注册的位置族
  | 'unknown-placement' // 行 2：声明引用了已注册族内不存在的容器位
  | 'invalid-id' // 行 3：声明 id 缺命名空间前缀 / 重复
  | 'icon-not-in-allowlist' // 行 4：图标名未命中白名单
  | 'unknown-target' // 行 5：导航目标 tabId/contentId 不存在
  | 'family-mismatch' // 行 6：导航目标属于另一个位置族
  | 'not-openable' // 行 7：导航目标需要数据但当前无数据
  | 'unknown-params-key' // 行 8：params 含目标容器不认识的键

/** 判定表行（§5.4 三列：判定者 / 用户所见 / 恢复动作；测试逐行对账锚）。 */
export interface FailureJudgement { // oe-exempt:20261025:framework:判定表行数据契约（类型契约先行，非抽象接口单实现）
  /** 设计文档 §5.4 表行号（1 起） */
  row: number
  /** 判定者（判定出口所在模块/函数） */
  judge: string
  /** 用户看到什么 */
  userVisible: string
  /** 恢复动作 */
  recovery: string
}

/**
 * §5.4 判定表（八行单一登记处）。各判定出口的 warning 文案内嵌同一恢复动作；
 * 本表是文案与测试的逐行对账锚——改判定出口文案须同步本表（反之亦然）。
 */
export const FAILURE_JUDGEMENT_TABLE: Record<SlotFailureKind, FailureJudgement> = {
  'unregistered-mount-point': {
    row: 1,
    judge: '挂载点路由（ContributionRegistry.routeAll）',
    userVisible: '插件管理页该贡献行标记不可用（插件状态保持 active）；控制台一行 warning 含位置名',
    recovery: '插件作者改用已注册位置',
  },
  'unknown-placement': {
    row: 2,
    judge: '容器位注册表（ContentSlotRegistry.loadExternal）',
    userVisible: '插件管理页该贡献行标记不可用；不派生进任何容器；一行 warning 含位置族名',
    recovery: '改用已注册位置族（CONTENT_SLOT_PLACEMENTS 词表）',
  },
  'invalid-id': {
    row: 3,
    judge: '声明解析（validateContentSlotId）',
    userVisible: '插件管理页该贡献行标记不可用；一行 warning',
    recovery: '按 §6.12 约定改 id（<命名空间>.<名称>，[a-z0-9._-]，≤128 字符）',
  },
  'icon-not-in-allowlist': {
    row: 4,
    judge: '图标解析函数（resolveContributionIcon）',
    userVisible: '该 tab/按钮用兜底图标；一次 warning',
    recovery: '改用白名单图标名（CONTRIBUTION_ICON_KEYS）',
  },
  'unknown-target': {
    row: 5,
    judge: '导航执行器（ContainerNavigationExecutor）',
    userVisible: '点击无动作（不写任何状态）；一行 warning 含目标 id',
    recovery: '核对声明里 id 与 views[].id 是否一致',
  },
  'family-mismatch': {
    row: 6,
    judge: '导航执行器（ContainerNavigationExecutor）',
    userVisible: '点击无动作；一行 warning 附实际族',
    recovery: '改 kind 或改目标',
  },
  'not-openable': {
    row: 7,
    judge: '导航执行器（ContainerNavigationExecutor）',
    userVisible: '点击无动作（不打开空容器）',
    recovery: '先让插件推数据，或声明 openableWithoutData: true',
  },
  'unknown-params-key': {
    row: 8,
    judge: '导航执行器（ContainerNavigationExecutor）',
    userVisible: '动作照常执行，未知键被忽略；一行 warning',
    recovery: '核对目标容器的选项字段名（KNOWN_PARAMS_KEYS_BY_PLACEMENT）',
  },
}

// ── 降级告警去重（§6.14 三件套之二：去重键，进程级持存）────────────────

/** 去重键的失败种类段：判定表八行 ∪ 不可用声明细目（呈现口径同行 1-3）∪ 文案截断（§6.9 上限处理，非判定表行）。 */
export type WarnDedupKind = SlotFailureKind | 'missing-component' | 'component-not-allowed' | 'text-truncated'

/**
 * 告警去重键集合（登记 docs/architecture/data-source-registry.md #80）。
 * 进程级持存 = 模块级持有（跨注册表实例与跨会话生效）；**插件重启不清空是设计内语义**
 *（clearForPlugin/loadExternal 均不触碰本集合——同一无效声明在插件反复启停下只提示一次）。
 */
const warnedKeys = new Set<string>() // @data-owner #80

/**
 * §6.14 统一告警出口：键 = `pluginId::contributionId::失败种类`，同键只 warn 一次。
 * 渲染驱动 / 广播重放驱动的告警（声明校验、图标解析、routeAll 订阅侧）必须走本出口；
 * 用户点击驱动的告警（导航执行器）天然节流，不走本出口。
 */
export function warnFailureOnce(
  pluginId: string,
  contributionId: string,
  kind: WarnDedupKind,
  message: string,
): void {
  const key = `${pluginId}::${contributionId}::${kind}`
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(`[failure-degradation] ${message}`)
}

// ── 图标解析（§6.13 单函数：四容器与头部按钮共用）────────────────────

/**
 * 贡献图标白名单（lucide 名，单一事实源）：初始成员 = 渲染端既有四套映射表的并集——
 * DrawerPanel.ICON_BY_ID（11）/ TrayWidgetButton.WIDGET_ICON_ENTRIES（11，与抽屉表
 * 重叠 square-check-big、bot）/ HeaderActionsHost.HEADER_ACTION_ICONS（1）+ 两个登记项：
 * 'layout-grid' = 统一兜底图标自指（插件显式声明兜底 = 合法）；'panel-right' = 设计
 * §5.2 成功路径示例 icon（照文档写的声明不得落兜底）。渲染端四套映射表接线本表后退役。
 */
export const CONTRIBUTION_ICON_KEYS: readonly string[] = [
  // DrawerPanel.ICON_BY_ID ∪ TrayWidgetButton.WIDGET_ICON_ENTRIES ∪ HeaderActionsHost.HEADER_ACTION_ICONS
  'terminal',
  'globe',
  'git-branch',
  'book-open',
  'file-text',
  'bot',
  'square-terminal',
  'square-check-big',
  'messages-square',
  'workflow',
  'list-tree',
  'list-checks',
  'list-todo',
  'circle-check',
  'circle-dot',
  'target',
  'clock',
  'zap',
  'flag',
  'gauge',
  // 统一兜底图标（= PluginViewContainer.DEFAULT_ICON / TrayWidgetButton.FALLBACK_WIDGET_ICON 同源 lucide 名）
  'layout-grid',
  // 设计 §5.2 成功路径示例
  'panel-right',
]

/** 未命中兜底图标（lucide 名）。注：DrawerPanel 现行兜底为 FileText（容器侧差异），U6 接线本函数时收敛到本键。 */
export const FALLBACK_CONTRIBUTION_ICON = 'layout-grid'

/** 白名单键归一化：沿用托盘 normalizeIconKey 口径（trim + 小写 + 去除 -/_/空白）——插件侧拼写习惯各异，宽容优于强制单写法。 */
export function normalizeIconKey(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]/g, '')
}

const CONTRIBUTION_ICON_LOOKUP: ReadonlyMap<string, string> = new Map(
  CONTRIBUTION_ICON_KEYS.map((key) => [normalizeIconKey(key), key]),
)

/** 图标解析结果（§6.13）：unset = 未声明（容器用兜底，不告警）；declared = 命中白名单（key = 归一化后登记键）；fallback = 未命中（已落兜底 + 按去重键 warn 一次）。 */
export type ContributionIconResolution =
  | { status: 'unset' }
  | { status: 'declared'; key: string }
  | { status: 'fallback' }

export interface ContributionIconInput { // oe-exempt:20261025:framework:解析入参数据契约（类型契约先行，非抽象接口单实现）
  pluginId: string
  contributionId: string
  /** lucide 图标名；undefined / 空串 / 纯空白 = 未声明。meta.icon 的 {paths} 自定义形状不在本函数范围（渲染端调用前分流）。 */
  icon?: string
}

/**
 * §6.13 图标解析单函数：四容器与头部按钮共用的唯一解析入口。
 * 归一化后查单一白名单（CONTRIBUTION_ICON_KEYS）；未命中返回 fallback 并按
 * §6.14 去重键（pluginId::contributionId::icon-not-in-allowlist）warn 一次；
 * 空串等同未声明（unset，不告警）。运行时脏数据（非字符串，如 {paths} 形状误传）
 * 判形状非法落兜底 + 同键 warn——坏数据出声且不崩渲染（容器保持可渲染）。
 */
export function resolveContributionIcon(input: ContributionIconInput): ContributionIconResolution {
  const { pluginId, contributionId, icon } = input
  if (icon === undefined) return { status: 'unset' }
  if (typeof icon !== 'string') {
    warnFailureOnce(
      pluginId,
      contributionId,
      'icon-not-in-allowlist',
      `图标声明形状非法（icon-not-in-allowlist）：${typeof icon} 不是 lucide 名字符串（${pluginId}/${contributionId}）——该位置已落兜底图标 ${FALLBACK_CONTRIBUTION_ICON}；icon 只收白名单 lucide 名（{paths} 自定义形状仅协议 widget 区支持）`,
    )
    return { status: 'fallback' }
  }
  if (icon.trim() === '') return { status: 'unset' } // 空串等同未声明（§6.13）
  const hit = CONTRIBUTION_ICON_LOOKUP.get(normalizeIconKey(icon))
  if (hit !== undefined) return { status: 'declared', key: hit }
  warnFailureOnce(
    pluginId,
    contributionId,
    'icon-not-in-allowlist',
    `图标未命中白名单（icon-not-in-allowlist）：'${icon}' 不在 CONTRIBUTION_ICON_KEYS（${pluginId}/${contributionId}）——该位置已落兜底图标 ${FALLBACK_CONTRIBUTION_ICON}；改用白名单图标名（大小写/-/_ 不敏感）`,
  )
  return { status: 'fallback' }
}
