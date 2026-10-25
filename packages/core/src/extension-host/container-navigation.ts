/**
 * 容器导航执行器 —— §6.4「请求宿主打开容器」原语的宿主侧执行端（容器扩展点统一）。
 *
 * 插件推送的组件树（action-bar item.hostAction / list-tree item.action.hostAction）点击后
 * 到达本执行器；执行器按落点契约校验后分派到目标容器。两条点击路径（commandId 命令链 /
 * hostAction 导航）在渲染端分流，宿主侧汇合于此——本模块不感知渲染原语形状。
 *
 * 落点契约（§6.4 表，实施裁决的唯一锚）：
 * - 目标解析在**全局 id 空间**（§6.12 命名空间前缀）：命中多条 = 歧义，报错不取第一条；
 * - `kind` 与目标位置族不匹配按「不存在」处理（同一失败出口，warning 附实际族）；
 * - `params` = 目标容器选项字段的透传：键名即容器选项字段名（下方 KNOWN_PARAMS_KEYS 登记，
 *   新增选项字段须同步登记），值只许标量（禁嵌套对象，与 action-bar args 同一校验口径）；
 * - 未知键忽略 + 一行 warning，不阻断动作；
 * - 会话上下文由宿主注入（插件不传，防自报与宿主不一致）：视图 scope sessionId 优先，
 *   缺省回退焦点会话（getBoundSessionId 端口）；
 * - **先校验后动作**：params 标量 → 目标解析 → 族匹配 → 可打开性 → 会话就绪，全通过才
 *   经 sink 写开合态与选中态；任一步失败零状态写入（失败显式出声，无乐观呈现）。
 *
 * 分层边界：本模块在 extension-host 消费端，不 import domain/stores（AC7 信息流向单向）——
 * 目标查询（容器位注册表）与状态写入（drawer/overlay 协调函数）经 ContainerSlotLookup /
 * ContainerNavigationSink 端口注入，壳层装配真实实现（对齐 drawer control.ts 的
 * bindDrawerSessionId「core headless + 壳层绑定」先例）。
 *
 * 失败降级三件套（§6.14，U13 落地）：本模块承载 §5.4 判定表行 5-8（unknown-target /
 * family-mismatch / not-openable / unknown-params-key）——种类值与 failure-degradation
 * 的 FAILURE_JUDGEMENT_TABLE（八行判定者/用户所见/恢复动作单一登记处）同名同形，fail
 * 出口的 detail 内嵌同一恢复动作（测试逐行对账判定表）。告警去重不适用本模块：点击是
 * 用户动作天然节流，每次点击至多一行 warning；进程级去重键（warnFailureOnce）承载
 * 渲染 / 广播重放驱动的告警（声明校验、图标解析、routeAll 订阅侧）。
 * 先校验后动作（三件套之三）：任一校验失败零状态写入——校验链顺序即下方 ①→⑤，
 * 成功路径唯一的 sink 写入在全部校验之后（⑥）。
 */
import type { HostContainerAction } from '@zhushanwen/extension-protocol'
import { FAILURE_JUDGEMENT_TABLE, type SlotFailureKind } from './failure-degradation'

// ── 落点契约词表 ──

/** kind → 位置族映射：导航声明的 kind 唯一对应一个 placement 族（§6.1 位置族词表子集）。 */
export const PLACEMENT_BY_KIND: Record<HostContainerAction['kind'], string> = {
  drawer: 'drawer.tab',
  overlay: 'overlay.content',
} as const

/**
 * 各位置族认识的 params 键（§6.4「显式登记为对外契约的内部字段名」登记处）。
 * 键名 = 目标容器选项的字段名；新增容器选项字段须同步登记本表。
 * - drawer.tab：OpenDrawerOptions 的字段（commandName = Doc tab 命令名 / filePath = Detail tab 文件路径）
 * - overlay.content：openOverlayContent(contentId, sessionId) 无额外选项字段（空表——
 *   任何 params 键都落「未知键忽略 + warning」）
 */
export const KNOWN_PARAMS_KEYS_BY_PLACEMENT: Record<string, readonly string[]> = {
  'drawer.tab': ['commandName', 'filePath'],
  'overlay.content': [],
} as const

// ── 端口：目标查询（容器位注册表的消费侧抽象）──

/** 导航目标——容器位声明的最小查询投影（权威数据源 = 容器位注册表）。 */
export interface ContainerNavigationTarget { // oe-exempt:20261025:framework:容器导航数据/端口契约（类型契约先行，非抽象接口单实现）
  /** 容器位 id（全局 id 空间，§6.12 命名空间前缀） */
  id: string
  /** 位置族（'drawer.tab' / 'overlay.content' / ...，§6.1 词表） */
  placement: string
  /** 归属插件 id（失败告警定位用） */
  pluginId: string
  /** 会话归属（§6.9：'session' 缺省；'global' 内容不参与会话级联） */
  scope: 'session' | 'global'
  /** 无数据时可打开（§6.15：缺省 true） */
  openableWithoutData: boolean
}

/** 目标查询端口：壳层装配容器位注册表后的真实实现（注册表未接线的空实现 = 恒无目标）。 */
export interface ContainerSlotLookup { // oe-exempt:20261025:framework:port 注入契约（壳层装配生产单实现 + 测试 mock）
  /**
   * 全局 id 空间解析：返回全部命中声明。命中多条 = 声明歧义（§6.12，不取第一条）；
   * 命中零条 = 目标不存在。
   */
  resolveTargets(tabId: string): ContainerNavigationTarget[]
  /** 目标容器当前是否有数据（可打开性判定的数据事实；openableWithoutData=true 时不查询）。 */
  hasData(target: ContainerNavigationTarget): boolean
}

// ── 端口：状态写入（校验全通过后的唯一出口）──

/**
 * 动作端口：全部校验通过后写目标容器的开合态与选中态。壳层实现对接各容器协调函数
 * （drawer 选中态 = 瞬时参数 + control 开合；overlay 内容态含级联判据 payload.sessionId）。
 */
export interface ContainerNavigationSink { // oe-exempt:20261025:framework:port 注入契约（壳层装配生产单实现 + 测试 mock）
  /**
   * 打开右抽屉并切到 tabId，params 透传容器选项字段（已知键过滤后）。
   * sessionId = 解析出的归属会话；drawer 选中态分区键走壳层绑定的焦点会话（ADR-0053
   * 单例抽屉语义），本参数为浮层级联（§6.8）保留统一签名。
   */
  openDrawerTab(sessionId: string, tabId: string, params: Record<string, string | number | boolean>): void
  /** 打开浮层内容（contentId = 目标声明 id；sessionId 进 payload 级联判据，§6.8）。 */
  openOverlayContent(sessionId: string, contentId: string): void
}

// ── 执行器 ──

export interface ContainerNavigationDeps { // oe-exempt:20261025:framework:port 注入契约（壳层装配生产单实现 + 测试 mock）
  lookup: ContainerSlotLookup
  sink: ContainerNavigationSink
  /** 焦点会话解析（壳层绑定；core headless 不读 pinia）。未绑定 / 无焦点会话返回 null。 */
  getBoundSessionId?: () => string | null
}

export interface NavigateOptions { // oe-exempt:20261025:framework:导航选项数据契约（类型契约先行，非抽象接口单实现）
  /** 视图 scope sessionId（组件树所属视图的会话；会话注入优先级第一档，§6.4）。 */
  viewSessionId?: string
}

/** 失败种类（§5.4 判定表行 5-8 的执行器内投影 + 落点契约的扩展拒绝；warning 文案随种类附恢复指引）。
 *  与判定表 SlotFailureKind 同名成员：unknown-target（行 5）/ family-mismatch（行 6）/
 *  not-openable（行 7）；invalid-params / ambiguous-target / no-session 是 §6.4 落点契约的
 *  扩展拒绝（不在判定表八行——行 8 未知键不构成失败，动作照常执行）。 */
export type ContainerNavigationFailure =
  | 'invalid-params'
  | 'unknown-target'
  | 'ambiguous-target'
  | 'family-mismatch'
  | 'not-openable'
  | 'no-session'

export interface ContainerNavigationResult { // oe-exempt:20261025:framework:导航结果数据契约（类型契约先行，非抽象接口单实现）
  ok: boolean
  /** 失败种类；成功 = undefined */
  reason?: ContainerNavigationFailure
  /** 人读详情（warning 同文；测试断言用） */
  detail?: string
}

/** params 值的标量判据（协议契约：string | number | boolean 之外一律拒绝）。 */
function isScalarParam(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export class ContainerNavigationExecutor {
  constructor(private readonly deps: ContainerNavigationDeps) {}

  /**
   * 执行一次容器导航：按落点契约逐段校验，全通过后经 sink 写状态。
   * 任一校验失败 → 零状态写入 + 一行 warning（含恢复指引），返回失败种类。
   */
  navigate(action: HostContainerAction, options?: NavigateOptions): ContainerNavigationResult {
    // ① params 标量校验（输入合法性先行：畸形参数连目标解析都不该发生）。
    // 显式 unknown：`action.params ?? {}` 的联合含 `{}` 分支，entries 值会上抛成 unknown。
    // 一遍循环同时完成校验与归一（坏键收集 + 标量落地），后续段只消费 scalarParams。
    const rawParams: Record<string, unknown> = action.params ?? {}
    const scalarParams: Record<string, string | number | boolean> = {}
    const badKeys: string[] = []
    for (const [key, value] of Object.entries(rawParams)) {
      if (isScalarParam(value)) scalarParams[key] = value
      else badKeys.push(key)
    }
    if (badKeys.length > 0) {
      return this.fail('invalid-params', action, `params 含非标量值（键：${badKeys.join(', ')}）——值只许 string/number/boolean，禁嵌套对象；插件侧修正 params 形状`)
    }

    // ② 全局 id 空间解析（§6.12：歧义报错不取第一条）
    const targets = this.deps.lookup.resolveTargets(action.tabId)
    if (targets.length > 1) {
      const owners = targets.map((t) => t.pluginId).join(', ')
      return this.fail('ambiguous-target', action, `目标 id 命中多条声明（归属：${owners}）——在声明里用带插件命名空间前缀的完整 id 消歧`)
    }
    if (targets.length === 0) {
      // §5.4 行 5：恢复动作取自判定表（单一登记处）
      return this.fail('unknown-target', action, `容器位 '${action.tabId}' 不存在`, 'unknown-target')
    }
    const target = targets[0]

    // ③ 族匹配（kind 与目标位置族不匹配按「不存在」处理，warning 附实际族）
    const expectedPlacement = PLACEMENT_BY_KIND[action.kind]
    if (target.placement !== expectedPlacement) {
      // §5.4 行 6：恢复动作取自判定表
      return this.fail('family-mismatch', action, `目标 '${action.tabId}' 属于 '${target.placement}' 族，与 kind='${action.kind}'（${expectedPlacement}）不匹配`, 'family-mismatch')
    }

    // ④ 可打开性（§6.15：声明不可无数据进入且当前无数据 → 不打开空容器）
    if (!target.openableWithoutData && !this.deps.lookup.hasData(target)) {
      // §5.4 行 7：恢复动作取自判定表
      return this.fail('not-openable', action, `目标 '${action.tabId}' 声明 openableWithoutData=false 且当前无数据`, 'not-openable')
    }

    // ⑤ 会话解析（宿主注入：视图 scope sessionId > 焦点会话；无法确定 = 校验失败）
    const sessionId = options?.viewSessionId ?? this.deps.getBoundSessionId?.() ?? null
    if (sessionId === null) {
      return this.fail('no-session', action, '无法确定归属会话（无视图会话也无焦点会话）——导航动作需要会话上下文，跳过')
    }

    // ⑥ 全通过 → 动作：未知 params 键过滤（忽略 + 一行 warning，不阻断动作；§5.4 行 8）
    const knownKeys = KNOWN_PARAMS_KEYS_BY_PLACEMENT[target.placement]
    const filtered: Record<string, string | number | boolean> = {}
    const unknownKeys: string[] = []
    for (const [key, value] of Object.entries(scalarParams)) {
      if (knownKeys !== undefined && knownKeys.includes(key)) filtered[key] = value
      else unknownKeys.push(key)
    }
    if (unknownKeys.length > 0) {
      console.warn(
        `[container-navigation] 未知 params 键已忽略（目标 '${action.tabId}' 认识：${knownKeys === undefined ? '该族未登记' : knownKeys.join(', ') || '（无）'}；忽略：${unknownKeys.join(', ')}）——${FAILURE_JUDGEMENT_TABLE['unknown-params-key'].recovery}`,
      )
    }
    if (action.kind === 'drawer') this.deps.sink.openDrawerTab(sessionId, action.tabId, filtered)
    else this.deps.sink.openOverlayContent(sessionId, action.tabId)
    return { ok: true }
  }

  /**
   * 统一失败出口：一行 warning（判定表口径：点击无动作 + 恢复指引）+ 结构化结果。
   * judgementKind 在场时恢复动作拼自 FAILURE_JUDGEMENT_TABLE（§5.4 判定表 = 恢复动作
   * 单一登记处，本模块不持第二份文案）；不在场 = 落点契约的扩展拒绝（判定表八行之外），
   * detail 自带恢复指引。
   */
  private fail(
    reason: ContainerNavigationFailure,
    action: HostContainerAction,
    detail: string,
    judgementKind?: SlotFailureKind,
  ): ContainerNavigationResult {
    const recovery = judgementKind !== undefined ? `——${FAILURE_JUDGEMENT_TABLE[judgementKind].recovery}` : ''
    console.warn(`[container-navigation] ${reason}（kind=${action.kind} tabId=${action.tabId}）——点击无动作，未写入任何容器状态。${detail}${recovery}`)
    return { ok: false, reason, detail }
  }
}
