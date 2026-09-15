/**
 * ReplicatedState<T> —— 通用快照复制原语（data-source-governance P1.1 / W6）。
 *
 * 解决问题：六类标量 session 状态（label / thinkingLevel / modelId / usage / queue 深度 /
 * commands）此前各自维护内存缓存、各写各的失效逻辑，形成多源影子状态（D7 原则 4 病灶）。
 * 本原语把「快照拉取 + 事件只做失效 + 退避重拉」收敛为一个配置驱动的通用机制：
 * 每类状态退化为一个配置实例——配置三元组（快照 RPC / 失效触发源 / 合并策略含字段
 * 空值语义）即数据登记表条目（docs/architecture/data-source-registry.md）。
 *
 * 核心不变量：
 * 1. **事件永不直接写数据**：失效事件只调 markDirty()（置 dirty + 防抖触发重拉），
 *    数据只能经 fetchSnapshot → merge 写入。从结构上防退化为「事件直写」影子状态。
 * 2. **快照失败不清除 dirty**：失败保留上次快照（UI 继续显示旧值），按退避序列重试；
 *    序列耗尽后停止，等下一次 markDirty / refetch / 周期兜底再启动。
 * 3. **在途失效不丢**（epoch 守卫）：fetch 在途期间到达的 markDirty 不会被本次成功
 *    快照吞掉——仅当成功快照与发起时同 epoch 才清 dirty / 撤销后续拉取。
 *
 * D1b 两条合并规则内建（docs/architecture/data-source-governance.md §3.3 D1b）：
 * - 规则 1（owner 快照合并）：权威源整字段覆盖**含显式空值**。内建 merge 实现
 *   {@link ownerSnapshotMerge}——显式 undefined 整字段覆盖旧值（未命名 session 的
 *   sessionName undefined 必须覆盖旧名，否则影子状态复活，D1b 反例回归）。
 * - 规则 2（wire 层空值归一）：JSON 序列化会丢弃值为 undefined 的 key，「显式空值」
 *   到 wire 层退化为「key 缺失」。fetchSnapshot 结果先按 fieldsNullSemantics 归一：
 *   - 'explicit-null' 登记（如 sessionName）：key 缺失 → 物化为显式 undefined → 合并覆盖；
 *   - 'required' 登记（如 thinkingLevel，无空值语义、永不 guard）：key 缺失 = 协议异常，
 *     按快照失败处理（退避重试 + 保留旧值），禁止当「字段不动」；
 *   - 未登记字段 key 缺失 = 不在本快照域内，保持当前值（merge 的 spread 语义）。
 *
 * 零外部 npm 依赖（避免 tsup noExternal 变更）。本 wave（W6）只交付原语本体，
 * 不接线任何实例（W7/W8 做，接线时实例配置即登记表条目）。
 *
 * @module replicated-state
 */

/**
 * 字段空值语义登记条目（D1b 规则 2 wire 归一依据）。
 *
 * 语义区分必须在登记表唯一化（曾双登记出相反语义）：
 * - 'explicit-null' 只用于「空 = 权威合法态」的字段（sessionName 未命名）；
 * - 'required' 只用于「值域不含空、永不 guard」的字段（thinkingLevel）；
 * - 磁盘扫描占位值守卫（modelId ''/tokenCount 0，W15）不属本原语——占位符不是权威空值。
 */
export type FieldNullSemantic =
  /** key 缺失 = 显式空值（合法态，如 sessionName 未命名）→ 物化为显式 undefined，合并时整字段覆盖 */
  | 'explicit-null'
  /** 无空值语义（值域不含空、永不 guard，如 thinkingLevel）→ key 缺失 = 协议异常，按快照失败处理 */
  | 'required'

/**
 * 字段空值语义登记表：字段名 → 语义。
 * 空对象 = 快照无 wire 归一需求（如数组 / 标量形态状态）。
 */
export type FieldsNullSemantics = Readonly<Record<string, FieldNullSemantic>>

/** wire 快照协议异常（'required' 字段 key 缺失 / 声明了字段语义但快照非对象）。 */
export class WireSnapshotSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireSnapshotSchemaError'
  }
}

/**
 * ReplicatedState 构造配置——配置三元组的代码形态（快照 RPC / 合并策略含字段空值语义；
 * 失效触发源由调用方在自己的事件订阅里调 markDirty() 完成，不进本配置）。
 */
export interface ReplicatedStateConfig<T> {
  /** 快照 RPC：权威源唯一读取入口（如 get_state / get_commands）。唯一数据写入来源。 */
  fetchSnapshot: () => Promise<T>
  /** 失效防抖窗口（ms）：markDirty 后静默 debounceMs 再触发重拉，聚合失效风暴。 */
  debounceMs: number
  /** 快照失败退避序列（ms，canonical [1000, 5000, 15000]）。耗尽后停止重试，等下一次失效/重连/周期。 */
  backoffSchedule: readonly number[]
  /** 周期兜底重拉间隔（ms，可选，默认关闭 = 不启动周期定时器）。W7 thinkingLevel 依赖：
   *  pi 同档位切换不发射事件，纯事件失效覆盖不住，需要周期兜底。 */
  pollIntervalMs?: number
  /** 合并策略：D1b 规则 1 语义可直接用内建 {@link ownerSnapshotMerge}。 */
  merge: (snapshot: T, current: T) => T
  /** 字段空值语义登记（D1b 规则 2 wire 归一依据）。 */
  fieldsNullSemantics: FieldsNullSemantics
}

/**
 * D1b 规则 1 内建合并：owner 快照整字段覆盖，含显式空值。
 *
 * spread 复制 snapshot 的自有属性（含显式 undefined——覆盖 current 同名字段实现
 * 「空值覆盖旧值」）；snapshot 上不存在的字段保持 current（不在本快照域内）。
 * wire 层的「key 缺失」必须先经 {@link normalizeWireSnapshot} 归一为显式 undefined，
 * 才能走到本函数的覆盖分支——两规则协同，缺一则空值覆盖失效。
 */
export function ownerSnapshotMerge<T extends object>(snapshot: T, current: T): T {
  return { ...current, ...snapshot }
}

/**
 * D1b 规则 2 内建 wire 归一：key 缺失按 fieldsNullSemantics 判定语义。
 *
 * JSON 序列化丢弃值为 undefined 的 key，故 wire 快照上「显式空值」表现为「key 缺失」。
 * 本函数把 wire 形态还原为内存语义：
 * - 'explicit-null' 字段 key 缺失 → 物化为自有属性 undefined（合并时整字段覆盖）；
 * - 'required' 字段 key 缺失 → 抛 {@link WireSnapshotSchemaError}（协议异常，
 *   由调用方按快照失败处理：退避重拉 + 保留旧值）；
 * - 未登记字段不动（key 缺失 = 不在快照域内，合并保持当前值）。
 *
 * 返回浅拷贝（需要物化时），不修改 fetchSnapshot 返回的原始对象。
 */
export function normalizeWireSnapshot<T>(raw: T, semantics: FieldsNullSemantics): T {
  const fields = Object.keys(semantics)
  if (fields.length === 0) return raw
  // 声明了字段语义却拿到非对象快照 = 配置与快照形态不匹配，按协议异常处理
  if (typeof raw !== 'object' || raw === null) {
    throw new WireSnapshotSchemaError(
      `wire snapshot is not an object while field null semantics are registered: ${fields.join(', ')}`,
    )
  }
  const record = raw as Record<string, unknown>
  // 浅拷贝（Object.assign 保住泛型 T），不修改 fetchSnapshot 返回的原始对象
  const normalized = Object.assign({}, raw)
  const normalizedRecord = normalized as Record<string, unknown>
  for (const field of fields) {
    const semantic = semantics[field]
    const keyMissing = !(field in record)
    if (semantic === 'explicit-null') {
      if (keyMissing) {
        // 物化显式空值：禁止把 wire 层 key 缺失当「字段不动」
        normalizedRecord[field] = undefined
      }
    } else if (keyMissing) {
      throw new WireSnapshotSchemaError(
        `required field "${field}" is missing on wire snapshot (no null semantics; key missing = protocol anomaly)`,
      )
    }
  }
  return normalized
}

/**
 * 通用快照复制原语。
 *
 * 生命周期：构造（可含周期兜底定时器）→ markDirty/refetch/poll 驱动拉取 → dispose()
 * 清理全部定时器（per-session 实例随 session 销毁调用，防定时器泄漏）。
 * dispose 后 markDirty/refetch 为 no-op，get() 仍可读最后快照（纯读无害）。
 */
export class ReplicatedState<T> {
  private readonly config: ReplicatedStateConfig<T>
  /** 上次成功应用的快照。undefined = 尚无成功快照（首次拉取完成前）。 */
  private snapshot: T | undefined = undefined
  /** 快照可能过期标志：markDirty 置位，仅「成功应用快照且在途无新失效」时清除（失败不清除）。 */
  private dirty = false
  /** 失效代数：每次 markDirty 自增。守卫「fetch 在途期间的失效不被成功快照吞掉」。 */
  private invalidationEpoch = 0
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** 退避游标：下次失败重试延迟取 backoffSchedule[backoffAttempt]，成功归零。 */
  private backoffAttempt = 0
  private inFlight = false
  /** 在途 fetch 期间又有拉取触发（防抖到点/周期/重连）→ 挂起，fetch 结束后补拉一次。 */
  private chainedRefetch = false
  private disposed = false

  constructor(config: ReplicatedStateConfig<T>) {
    this.config = config
    if (config.pollIntervalMs !== undefined) {
      this.pollTimer = setInterval(() => {
        void this.doFetch()
      }, config.pollIntervalMs)
    }
  }

  /**
   * 失效入口：失效事件（如 session_info_changed）到达时调用。
   *
   * 只置 dirty + 防抖触发重拉，**永不直接写数据**（核心不变量 1）。
   * 窗口内重复 markDirty 重置防抖定时器（经典防抖，聚合失效风暴为一次拉取）。
   */
  markDirty(): void {
    if (this.disposed) return
    this.dirty = true
    this.invalidationEpoch += 1
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.doFetch()
    }, this.config.debounceMs)
  }

  /**
   * 读当前快照值。dirty 时返回上次快照（失败路径 UI 显示旧值，核心不变量 2）。
   * 返回值禁止原地修改（浅引用，无防御性拷贝）。
   */
  get(): T | undefined {
    return this.snapshot
  }

  /** 快照是否可能过期（markDirty 置位、成功拉取清除、失败不清除）。 */
  isDirty(): boolean {
    return this.dirty
  }

  /**
   * 重连兜底全量重拉：绕过防抖立即拉取，并重置退避游标（重新走完整 1s/5s/15s 序列）。
   * 调用点：重连 / session 激活后的主动拉取（broadcast 时序竞争的结构性兜底）。
   */
  refetch(): void {
    if (this.disposed) return
    this.backoffAttempt = 0
    void this.doFetch()
  }

  /** 停止全部定时器（防抖 / 退避 / 周期兜底），实例不再拉取。per-session 实例销毁时调用。 */
  dispose(): void {
    this.disposed = true
    this.clearDebounceTimer()
    this.clearBackoffTimer()
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** 拉取一次：wire 归一 → merge 应用；失败退避重试。在途时挂起补拉（chainedRefetch）。 */
  private async doFetch(): Promise<void> {
    if (this.inFlight) {
      this.chainedRefetch = true
      return
    }
    this.inFlight = true
    const epochAtStart = this.invalidationEpoch
    try {
      const raw = await this.config.fetchSnapshot()
      const normalized = normalizeWireSnapshot(raw, this.config.fieldsNullSemantics)
      this.applySnapshot(normalized, epochAtStart)
    } catch {
      // 快照失败（含 wire 协议异常）：保留 dirty + 保留上次快照，退避重试
      this.scheduleBackoffRetry()
    } finally {
      this.inFlight = false
      if (this.chainedRefetch && !this.disposed) {
        this.chainedRefetch = false
        void this.doFetch()
      }
    }
  }

  /** 应用归一后的快照。首份快照直接落位（无 current 可合并）。 */
  private applySnapshot(normalized: T, epochAtStart: number): void {
    this.snapshot =
      this.snapshot === undefined ? normalized : this.config.merge(normalized, this.snapshot)
    if (epochAtStart === this.invalidationEpoch) {
      // 拉取期间无新失效：数据新鲜 → 清 dirty、归零退避、撤销冗余的后续拉取
      this.dirty = false
      this.backoffAttempt = 0
      this.clearBackoffTimer()
      this.clearDebounceTimer()
    }
    // 拉取期间有 markDirty：dirty 保持 true；markDirty 已重挂防抖定时器，失效不丢
  }

  /** 失败退避：按 backoffSchedule 逐级重试；已有重试在途或序列耗尽则不再排。 */
  private scheduleBackoffRetry(): void {
    if (this.disposed) return
    if (this.backoffTimer !== null) return
    if (this.backoffAttempt >= this.config.backoffSchedule.length) return
    const delay = this.config.backoffSchedule[this.backoffAttempt]
    this.backoffAttempt += 1
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null
      void this.doFetch()
    }, delay)
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private clearBackoffTimer(): void {
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
  }
}
