/**
 * Sidecar 绑定字段注册表（sidecar-binding-sync 设计文档决策 1 / 1b / 4）——单一权威源。
 *
 * 职责三件：① BINDING_FIELDS 声明每个绑定字段的入口适用性矩阵（SSOT）
 * ② hydrateBindingMeta 统一内存回填（create/handoff/restore/fork 四入口共用）
 * ③ CREATE_DERIVED_CALLERS 登记 sessionService.create 派生调用方（守卫测试静态扫描数据源）。
 *
 * 从 session-file-utils.ts 抽出的原因：后者聚焦 sidecar 文件 IO 与缓存治理（max-lines
 * 预算），本模块是纯声明数据 + 纯函数，独立成档职责更清晰；「新增第 6 个绑定字段」的
 * 完整改动路径 = 本表加一行 + 各写点 persist helper 照旧，回填与守卫自动获得。
 */
import type { ScannedSessionMeta } from './session-file-utils.js'

/**
 * 提取 T 的全部可选属性键（`-?` 修饰符把 `foo?: string` 的隐式 `| undefined` 显式化参与
 * 判定）。绑定字段注册表的键约束基础（决策 4）：ScannedSessionMeta 的可选字段全集经此
 * 派生，排除 header 派生字段后即绑定字段集——新增绑定字段漏登记注册表 = 编译错误。
 */
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]

/**
 * 绑定字段键全集：ScannedSessionMeta 可选字段 − { parentSession, forkEntryId }。
 *
 * 排除集是 header 派生字段（parseSessionHeader 从 JSONL 首行提取，非 sidecar 绑定），
 * 不走本注册表回填（parentSession / forkEntryId 由 initializeManagedSession 在 fork 入口
 * 显式透传，见 forkSession 的 parentSessionKey）。已核实的全集事实：ScannedSessionMeta
 * 可选字段恰好 9 个 = 2 排除 + 7 绑定（handedOffTo / launchPresetId / projectId /
 * spawnSource / parentAgentSessionId + modelId / thinkingLevel——后两者经 ModelBindingFields
 * extends 收编，声明在 session-model-sidecar.ts）；outcome 与 name 是 `| null` 非 `| undefined`，
 * 天然不进 OptionalKeys。决策 4 残余边界：必填字段不受此守卫保护——绑定字段天然可选
 *（sidecar 缺失 = undefined），误声明必填会在 scanSessionMeta 构造处撞理想类型冲突。
 */
export type BindingFieldKey = Exclude<OptionalKeys<ScannedSessionMeta>, 'parentSession' | 'forkEntryId'>

/**
 * 绑定字段的「内存实例重建入口」枚举（sidecar-binding-sync 设计文档 §3.3 决策 1）。
 *
 * handoff 是独立通道而非 create 的注释性变体：承接 session 走 sessionService.create
 *（派生调用方，见 CREATE_DERIVED_CALLERS），但语义 = 继承源字段而非新值——矩阵给
 * handoff 独立列，防「顺手继承」漂移（spawnSource 等字段在 handoff 列为 none）。
 */
export type BindingEntryKind = 'create' | 'handoff' | 'restore' | 'fork'

/**
 * 单入口列的语义值（矩阵单元格内容）：
 * - 'options'：值来自 create options（create 列）
 * - 'inherit-source'：继承源 session（handoff 承接 / fork 列）
 * - 'meta'：来自扫描 meta（restore 列，findScannedSession 全字段）
 * - 'resolved-in-entry'：入口已解析含兜底（如 restore 的 preset fallback builtin:full）
 * - 'none'：刻意不继承 / 不回填
 */
export type BindingEntrySemantics = 'options' | 'inherit-source' | 'meta' | 'resolved-in-entry' | 'none'

/** 绑定字段注册表的单字段声明（矩阵一行）。 */
export interface BindingFieldSpec {
  /**
   * 四入口完整性由类型强制：Record<BindingEntryKind, ...> 少一列编译红——「省略」不是
   * 选项，拿不准的入口必须显式写 'none'，把入口语义决策逼到显式化（设计文档 §3.1
   * 失败路径与恢复）。本表是回填入口适用性的 SSOT：hydrateBindingMeta 据此过滤，
   * Wave 3 守卫测试据此生成用例。
   */
  entries: Record<BindingEntryKind, BindingEntrySemantics>
}

/**
 * 绑定字段注册表（SSOT，sidecar-binding-sync 设计文档 §3.3 决策 1 / 决策 4）。
 *
 * 键约束：Record<BindingFieldKey, ...> —— 给 ScannedSessionMeta 新增可选字段而不在此
 * 登记 = 编译错误（「漏登记」被编译期拦截，任意字段类型均生效）。矩阵初值（设计文档
 * §3.3 决策 1 的表，加粗项为本次修复点，其余来自现状代码语义）：
 *
 * | 字段                 | create   | handoff（承接）    | restore           | fork                |
 * |----------------------|----------|--------------------|-------------------|---------------------|
 * | launchPresetId       | options  | none（源已消费）   | resolved-in-entry | inherit-source      |
 * | projectId            | options  | inherit-source（C）| meta（A-1）       | inherit-source（A-2）|
 * | spawnSource          | options  | none               | meta              | none（刻意不继承）  |
 * | parentAgentSessionId | options  | none               | meta              | none                |
 * | handedOffTo          | none     | none               | meta              | none                |
 *
 * handoff 列的运行时形态：承接 session 复用 create 入口（entry='create'），由
 * handoff-service 组装源继承值进 options——表列声明该通道的允许语义，「防顺手继承
 * 漂移」由 Wave 3 守卫测试对 CREATE_DERIVED_CALLERS 逐项断言实际传参。
 *
 * 能力边界（设计文档 §3.1）：拦「漏登记 / 漏回填 / 漏失效 / 派生调用方漏传多传」，
 * 不拦「语义定错」（该继承却写 none 属业务判断，靠 review）。
 */
export const BINDING_FIELDS: Record<BindingFieldKey, BindingFieldSpec> = {
  launchPresetId: {
    entries: {
      create: 'options',
      handoff: 'none', // 源 preset 已消费（现状保持：承接 session 不继承启动 preset）
      restore: 'resolved-in-entry', // target.launchPresetId ?? BUILTIN_PRESET_IDS.FULL 在入口解析
      fork: 'inherit-source', // forkPresetId：内存兑底 + 扫描 fallback 双源（入口解析）
    },
  },
  projectId: {
    entries: {
      create: 'options',
      handoff: 'inherit-source', // 缺陷 C 修复：承接继承源归属（与 fork / cwd 继承对称）
      restore: 'meta', // 缺陷 A-1 修复：restore 原来不回填，广播丢归属
      fork: 'inherit-source', // 缺陷 A-2 修复：原来只写 sidecar 不 patch 内存
    },
  },
  spawnSource: {
    entries: {
      create: 'options',
      handoff: 'none', // 承接是用户语义操作，非 agent spawn（防漂移显式声明）
      restore: 'meta', // 同型修复：agent badge 重开后保留
      fork: 'none', // 刻意不继承（fork 的防御性 unlink .agent.json 同语义，两机制并存）
    },
  },
  parentAgentSessionId: {
    entries: {
      create: 'options',
      handoff: 'none',
      restore: 'meta',
      fork: 'none',
    },
  },
  handedOffTo: {
    entries: {
      create: 'none', // 新 session 未交接
      handoff: 'none', // 承接者自身未交接（源 session 才被标记 handedOffTo）
      restore: 'meta', // 同型修复：「已交接」标记重开后保留
      fork: 'none', // fork 不写 handoff sidecar（现状保持）
    },
  },
  // D1 设计决策：restore='none' — 扫描值禁覆写 D2 播种真值（get_state 读回）。
  // modelId/thinkingLevel 的权威值来自 pi get_state（RPC 回执），restore 路径不从
  // sidecar 回填，防止覆盖 pi 从 model_change/thinking_level_change entry 恢复的终态。
  // create/handoff/fork='options'：Landing Chip / preset / 源 session 传入的生效值写入 sidecar。
  modelId: {
    entries: {
      create: 'options',
      handoff: 'options',
      restore: 'none',
      fork: 'options',
    },
  },
  thinkingLevel: {
    entries: {
      create: 'options',
      handoff: 'options',
      restore: 'none',
      fork: 'options',
    },
  },
}

/**
 * 按注册表把绑定字段回填到内存 session 实例（统一回填，设计文档 §3.3 决策 1）。
 *
 * 职责边界：只做内存 patch——活跃 session 的绑定值只认内存实例（扫描侧被
 * getActiveFilePaths 排除，toSummary 从实例字段透传进广播）；sidecar 落盘仍走各
 * persist* helper（磁盘形态与内存解耦，两写点时机 / 条件各自独立）；caller 负责组装
 * meta（三入口三数据源在调用方归一：create 从 options、restore 传扫描 meta、fork 传
 * 入口已解析的继承值）。
 *
 * 过滤规则：entries[entry] === 'none' 或 meta[field] === undefined 的字段跳过
 *（undefined 不 patch——与原逐字段 `if (x)` 条件 patch 等价，restore 的 options 条件
 * 语义与 meta 值存在语义在 undefined 处等价）。handoff 承接通道复用 create 入口调用
 *（entry='create'），handoff 列的语义承诺由 CREATE_DERIVED_CALLERS 守卫测试断言。
 *
 * @param session initializeManagedSession 产出的 IManagedSessionView（实为可扩展的
 *                ManagedSession 实例——绑定字段不在 IManagedSessionView 声明，经
 *                Record<string, unknown> 写入，对齐 session-service 的 as-cast patch 惯例）
 * @param meta    调用方组装的绑定字段值集合（Partial：缺省字段跳过）
 * @param entry   重建入口（决定按矩阵哪一列过滤）
 */
export function hydrateBindingMeta(
  session: object,
  meta: Partial<Pick<ScannedSessionMeta, BindingFieldKey>>,
  entry: BindingEntryKind,
): void {
  const target = session as Record<string, unknown>
  for (const field of Object.keys(BINDING_FIELDS) as BindingFieldKey[]) {
    if (BINDING_FIELDS[field].entries[entry] === 'none') continue
    const value = meta[field]
    if (value === undefined) continue
    target[field] = value
  }
}

/**
 * sessionService.create 派生调用方登记项（决策 1b）。
 */
export interface CreateDerivedCaller {
  /** 相对 packages/runtime/src 的 posix 路径 */
  file: string
  /** 调用方通道语义（对应注册表矩阵的列选择） */
  semantic: 'user-facing' | 'agent-managed' | 'handoff'
  /** 允许透传的绑定字段清单（承诺子集） */
  passedBindingFields: readonly BindingFieldKey[]
}

/**
 * sessionService.create 的派生调用方登记处（决策 1b，Wave 3 守卫测试静态扫描的数据源）。
 *
 * 语义：create 的绑定字段除 lifecycle 主流程（user-facing 直连）外还有派生调用方——
 * 新增调用点必须在此登记，否则守卫测试红（静态扫描源码 create 调用点集合 vs 本清单）。
 * passedBindingFields 是「允许透传的绑定字段」承诺：防顺手继承漂移（如 handoff 顺手
 * 透传 spawnSource——矩阵 handoff 列为 none），守卫测试逐项断言实际传参与承诺一致。
 *
 * 边界：静态扫描不拦「调用方语义定错」（该不该传 projectId 传错属 review 职责）。
 */
export const CREATE_DERIVED_CALLERS: readonly CreateDerivedCaller[] = [
  { file: 'transport/session-message-handler.ts', semantic: 'user-facing', passedBindingFields: ['launchPresetId', 'projectId'] },
  { file: 'transport/session-manager-handler.ts', semantic: 'agent-managed', passedBindingFields: ['spawnSource', 'parentAgentSessionId'] },
  { file: 'services/handoff-service.ts', semantic: 'handoff', passedBindingFields: ['projectId'] },
]
