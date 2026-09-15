/**
 * createKVSlot —— KV 单键槽位工厂（state-truth-sync-architecture §3.3 D9「KV 单键族收编」）。
 *
 * 吸收 model-thinking-memory / last-used-model 两模块逐字节镜像的持久化生命周期骨架：
 * - 惰性 loadOnce（idle → loading → loaded 三态，幂等——重复调用不重复读 KV）
 * - loadedCallbacks 队列（加载完成后清空，之后注册立即同步触发）
 * - **加载窗口守卫**：KV 未加载完成前 record 只写内存 + 挂起写穿（deferredPersist），
 *   加载完成后补一次完整写收敛——防止拿局部内存快照覆写 KV 整键未知数据
 * - **persistChain 写串行链**：写穿排队执行，前一次 set 未完成时后一次不交错
 *   （内存快照在链上实际执行时读取，链序保证最终落盘为最新全量）
 * - 写穿容错：set 失败 console.warn 不回滚内存（catch 吞错保证链不断裂）
 *
 * 职责边界：本工厂只管「KV 持久化生命周期」，**不拥有内存容器**——响应式容器
 * （ref / reactive Map 等）与容器形态（单值 / 整表 Map）由调用侧持有，经钩子接入：
 * - parseSnapshot：加载侧形状门（JSON.parse 产物 → 领域快照；形状不符返回 undefined = 按空启动）
 * - mergeSnapshot：快照并入内存。**实现必须内建窗口守卫**（不覆写加载窗口内已 record 的内存新值）
 * - serialize：写侧快照（链执行时调用，读调用侧容器当前态）
 * - validate（可选）：record 值域钩子（E6 形态枚举校验）；缺省全收
 *
 * KV 经 getPlatform().storage（platform/port），本模块零 localStorage 直连、零 vue 依赖。
 */
import { getPlatform } from '../platform/port'

/**
 * KV 单键槽位配置钩子（全部指向调用侧持有的内存容器）。
 *
 * @param V KV 快照的领域值类型（单值形态 = 值本身；整表形态 = 反序列化后的表对象）
 */
export interface KVSlotOptions<V> {
  /** warn 日志标签（输出 `[<tag>] KV write-through failed:` 前缀，对齐既有两模块格式） */
  tag: string
  /**
   * 加载侧形状门：JSON.parse 产物 → 领域快照值。
   * 合法 JSON 但形状不符（数组/字符串/null 等）返回 undefined——与 JSON 损坏同等对待，
   * 按空启动（对齐 state-truth-sync-architecture.md D10-E1：KV 读失败或损坏 → 按空启动回落，不抛不阻塞）。
   */
  parseSnapshot: (parsed: unknown) => V | undefined
  /**
   * 快照并入内存（仅在 parseSnapshot 返回非 undefined 时调用一次）。
   * 实现必须内建加载窗口守卫：不覆写加载窗口内已 record 的内存新值
   * （在途 KV 旧快照晚到，覆写后 deferred 补写会把旧值落盘——双丢）。
   */
  mergeSnapshot: (value: V) => void
  /** 写侧快照：序列化当前内存态为 KV 字符串。在写穿链上实际执行时调用（晚快照）。 */
  serialize: () => string
  /**
   * record 值域校验钩子（E6 形态）：拒绝则内存与 KV 均不写（record 全程 no-op）。
   * 缺省 = 不校验（last-used-model 形态）。
   */
  validate?: (value: unknown) => boolean
}

/**
 * KV 单键槽位实例（loadOnce/record/onLoaded 与两既有模块签名对齐；__reset 供模块 reset 组合）。
 * 泛型 V 只进配置钩子（KVSlotOptions<V>）——槽位方法面与 V 无关（write 闭包已捕获容器）。
 */
export interface KVSlot {
  /** 触发惰性预载（fire-and-forget，幂等）。加载完成前内存值保持初始态。 */
  loadOnce(): void
  /**
   * 写提交：validate 通过 → write 写内存 → 未加载则挂起写穿（加载完成后补写收敛），
   * 已加载则入写穿串行链。validate 拒绝 → 全程 no-op（存储层最后一道值域防线）。
   *
   * @param value 供 validate 校验的值域载体（E6：待写入的档位值）
   * @param write 内存写动作（调用侧容器形态各异：ref 整值替换 / Map 单条 set）
   */
  record(value: unknown, write: () => void): void
  /** 注册加载完成回调；已完成则立即同步触发（供下游加载完成后补一次读取/重设）。 */
  onLoaded(cb: () => void): void
  /** 仅测试用：重置生命周期状态（加载态 / 回调队列 / 挂起写 / 写链）。内存容器清理由调用侧 reset 组合承担。 */
  __resetForTesting(): void
}

/** 创建一个 KV 单键槽位。同 key 多实例不共享状态（模块级单例由调用侧持有一个实例）。 */
export function createKVSlot<V>(key: string, options: KVSlotOptions<V>): KVSlot {
  const { tag, parseSnapshot, mergeSnapshot, serialize, validate } = options

  type LoadState = 'idle' | 'loading' | 'loaded'

  /** 预载状态：loadOnce 幂等（loading/loaded 不重复读 KV）的判定依据。 */
  let loadState: LoadState = 'idle'

  /** 加载完成回调队列。加载完成后本数组即被清空，之后注册走立即触发路径。 */
  let loadedCallbacks: Array<() => void> = []

  /**
   * 加载完成前置起的写标记（含 idle 与 loading 两个窗口）。
   * 为什么挂起而不立即写穿：KV 快照尚未读入（或读取在途）时写穿，会拿局部
   * 内存快照覆写整键，未知数据被静默清掉——必须等加载完成后补一次完整写收敛。
   */
  let deferredPersist = false

  /** KV 写穿串行链：防止并发写穿的写乱序（旧快照晚到覆盖新值）。 */
  let persistChain: Promise<void> = Promise.resolve()

  /** 读 KV 入内存。任何读失败 / 损坏都收敛到空启动（不抛不吞），加载状态必然推进到 loaded。 */
  async function loadFromKV(): Promise<void> {
    let snapshot: V | undefined
    try {
      const raw = await getPlatform().storage.get(key)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        snapshot = parseSnapshot(parsed)
      }
    } catch {
      // D10-E1：KV 读失败 / JSON 损坏 → 空启动（不抛不吞）。加载窗口内已 record 的
      // 内存新值保留（mergeSnapshot 不被调用，无从覆写），由 deferred 补写收敛
      snapshot = undefined
    }
    if (snapshot !== undefined) mergeSnapshot(snapshot)
    loadState = 'loaded'
    const callbacks = loadedCallbacks
    loadedCallbacks = []
    for (const cb of callbacks) cb()
    if (deferredPersist) {
      // 加载窗口内挂起的写在此补写收敛（KV 已知全量，快照不再局部）
      deferredPersist = false
      void enqueuePersist()
    }
  }

  function loadOnce(): void {
    if (loadState !== 'idle') return
    loadState = 'loading'
    void loadFromKV()
  }

  function record(value: unknown, write: () => void): void {
    if (validate && !validate(value)) return
    write()
    if (loadState !== 'loaded') {
      deferredPersist = true
      return
    }
    void enqueuePersist()
  }

  /** 整键写穿。失败不回滚内存（best-effort：本次运行内仍生效，重启后丢），catch 吞错保证链不断裂。 */
  async function persist(): Promise<void> {
    try {
      await getPlatform().storage.set(key, serialize())
    } catch (err) {
      // 降级策略（best-effort 写穿）：写穿失败不回滚内存、不向调用方传播——
      // 偏好类数据可丢失，本次运行内仍生效、重启后丢，warn 留排障线索即可
      console.warn(`[${tag}] KV write-through failed:`, err)
    }
  }

  /** 排队一次写穿；快照在链上实际执行时读取，链序保证最终落盘的是最新全量态。 */
  function enqueuePersist(): Promise<void> {
    persistChain = persistChain.then(persist)
    return persistChain
  }

  function onLoaded(cb: () => void): void {
    if (loadState === 'loaded') {
      cb()
      return
    }
    loadedCallbacks.push(cb)
  }

  function __resetForTesting(): void {
    loadState = 'idle'
    loadedCallbacks = []
    deferredPersist = false
    persistChain = Promise.resolve()
  }

  return { loadOnce, record, onLoaded, __resetForTesting }
}
