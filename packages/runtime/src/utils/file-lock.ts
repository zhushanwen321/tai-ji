/**
 * 跨进程同步/异步文件锁（D1a，integrity-hardening.md §3.1；锁统一 D1-A，
 * docs/architecture/file-lock-unification-and-reaper-sink.md §3.2）。
 *
 * 为什么存在：settings.json / auth.json / providers.json 等文件被 xyz runtime 与
 * pi 子进程双写（跨进程 RMW），Node 单线程只能保证进程内不交错，挡不住跨进程的
 * 「后写者基于旧快照覆盖先写者」。
 *
 * 锁原语统一（D1-A）：本模块不再本地封装 proper-lockfile，改从
 * `@zhushanwen/pi-file-lock/core` 引入零依赖自实现 mkdir 锁单次原语
 * （acquireLock / acquireLockSync；磁盘协议逐字段照抄 proper-lockfile@4.1.2——
 * 与 pi 内嵌 proper-lockfile 互斥同一把锁的兼容性权威源，协议细节见该包
 * lock-core.ts 头注释）。本文件职责收敛为：本地签名适配层（导出面与旧版逐项
 * 一致，调用方零改动）+ 重试编排（重试属消费方，core 只做单次原语）。
 * extension 侧 @zhushanwen/pi-file-lock 与本模块同源 lock-core——不再是「孪生
 * 双实现靠参数对齐」，两侧协议一致由构造保证；本地默认常量导出保留供
 * parity 测试断言两侧相等。
 *
 * realpath:false 统一：core 的路径规范化仅做字符串绝对化（path.resolve），
 * 不解析 symlink——与 pi auth-storage 及 extension 包现状一致。runtime async
 * 锁旧版（proper-lockfile 默认 realpath:true）属历史偏差，统一为 false 属纠正；
 * 锁目标路径（auth.json 在 getPiAgentDir()、settings 在 getDataDir() 派生目录）
 * 均动态推导、无 symlink 场景，影响面声明为零（设计 §3.2 D1-A）。
 *
 * [行为变化声明] 旧版 withFileLockAsync 的 onCompromised（proper-lockfile 保活
 * 定时器检测到锁 mtime 被刷新/锁目录消失时延迟抛出）在新实现下不存在——统一锁
 * 不做周期 touch（设计 §3.2 D1-A 显式决策：现有契约临界区毫秒级，远小于
 * stale/2，保活无必要）。后果：锁被外部删除/夺取后 fn 照常执行、release 对
 * 锁目录已消失静默成功（ENOENT 容忍）。AsyncFileLockOptions 对外形状不变
 * （ensure/logTag），消费方无感。
 *
 * 契约：
 *   - fn 内仅做既定读改写（读目标文件 + 纯内存变更 + 原子写），禁其他 I/O 与
 *     再次对本文件加锁（嵌套取锁必然 ELOCKED → 重试耗尽 → fail-fast），毫秒级
 *     完成（必须远小于 stale——无保活 touch，超时持锁会被对端 stale 夺取）。
 *     async 版 fn 允许 await，临界区时长约束同上。
 *   - 预算耗尽 fail-fast 抛错（对齐 pi 放弃保存的语义），不静默不重排队——
 *     同步 busy-wait 阻塞整个 event loop，预算必须被严格限制在 ~1s 量级。
 *
 * 归属：跨层共享叶子层 utils/（与 json-store 同层），无业务语义。
 *
 * 锁协议登记：docs/architecture/data-source-registry.md §6（与 extension 侧
 * 同一把 lockfile `<目标文件>.lock` 互斥）。
 */

import { acquireLock, acquireLockSync, type LockRelease } from '@zhushanwen/pi-file-lock/core'

export interface SyncFileLockOptions {
  /** 锁 mtime 超过该值视为持锁者已死可夺取（stale 语义）。默认 30_000ms。 */
  staleMs?: number
  /** ELOCKED 重试间隔（同步 sleep）。默认 25ms。 */
  retryDelayMs?: number
  /** ELOCKED 重试总预算，耗尽 fail-fast。默认 1_000ms。 */
  retryBudgetMs?: number
}

/**
 * 默认锁参数（导出供对照测试断言与 extension 侧 @zhushanwen/pi-file-lock
 * 的 sync 版默认值相等——互斥由 lockfile 路径 + mkdir 原子协议保证，默认值
 * 对齐锚定的是两侧夺取时机（stale）与失败速度（重试参数）行为一致；
 * test/file-lock-parity.test.ts）。
 */
export const DEFAULT_STALE_MS = 30_000
export const DEFAULT_RETRY_DELAY_MS = 25
export const DEFAULT_RETRY_BUDGET_MS = 1_000

/**
 * 同步跨进程文件锁内执行 fn：acquireLockSync（realpath:false，stale 判死夺取）
 * + ELOCKED busy-wait 重试（core 单次原语抛 ELOCKED，重试编排在本层），预算耗尽
 * 抛带 ELOCKED code 的错误；unlock 放 finally（fn 抛错也释放）。
 *
 * 锁前父目录确保由 core 内部兜底（recursive mkdir，已存在静默成功）。
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, opts?: SyncFileLockOptions): T {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const retryBudgetMs = opts?.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS

  const deadline = Date.now() + retryBudgetMs
  let release: (() => void) | undefined
  while (release === undefined) {
    try {
      release = acquireLockSync(filePath, { staleMs })
    } catch (err) {
      if (!isElocked(err)) throw err
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(
            `[file-lock] ${filePath} 写锁获取失败：ELOCKED 重试预算 ${retryBudgetMs}ms 耗尽` +
            `（持锁方临界区异常或已崩溃，stale ${staleMs}ms 后可夺取）。恢复指引：稍后重试本次写入。`,
            { cause: err },
          ),
          { code: 'ELOCKED' },
        )
      }
      sleepSync(retryDelayMs)
    }
  }
  try {
    return fn()
  } finally {
    release()
  }
}

function isElocked(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ELOCKED'
}

// ──────────────────────── async 版（auth.json / providers.json 写锁共用） ────────────────────────

export interface AsyncFileLockOptions {
  /** 锁前调用方的初始化钩子（如 auth.json 确保文件存在——对齐 pi ensureFileExists 惯例）。 */
  ensure: () => void
  /** release 失败 warn 的日志前缀（如 'auth-storage' / 'provider-extras-store'）。 */
  logTag: string
}

// 退避参数（语义对齐旧版 proper-lockfile retries 参数，即内部 retry 库调用
// { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true }）：
// 首试 + DEFAULT_RETRIES 次重试 = 最多 11 次 acquire。
const DEFAULT_RETRIES = 10
const RETRY_FACTOR = 2
const RETRY_MIN_TIMEOUT_MS = 100
const RETRY_MAX_TIMEOUT_MS = 10_000

/**
 * 第 attempt 次尝试失败后的退避等待（attempt 从 0 计）。
 * 公式照抄 proper-lockfile 内部 retry 库（retry.timeouts/createTimeout）：
 *   randomize ? round((random()+1) * minTimeout * factor**attempt) capped maxTimeout
 * 倍率区间 [1, 2)，故第 attempt 次等待 ∈ [minTimeout*factor**attempt, 2*...)，上限 10s。
 */
function backoffDelayMs(attempt: number): number {
  const exponential = RETRY_MIN_TIMEOUT_MS * RETRY_FACTOR ** attempt
  return Math.min(Math.round((Math.random() + 1) * exponential), RETRY_MAX_TIMEOUT_MS)
}

/**
 * 跨进程异步文件锁：acquireLock（realpath:false + stale 30s 判死夺取）+ 指数退避
 * 重试（10 次 / factor 2 / 100ms~10s / randomize），参数对齐 pi
 * FileAuthStorageBackend.withLockAsync（与 pi 侧刷新写回互斥同一把锁）；重试耗尽
 * 抛 code:"ELOCKED" 错误。unlock 放 finally，失败仅 warn 不外抛（fn 结果优先）。
 * 锁协议单点维护——auth-storage 与 provider-extras-store 共用，勿在调用方复制参数。
 *
 * [与旧版的行为差异] 旧版 proper-lockfile 的 onCompromised 已移除（见模块头
 * [行为变化声明]）：统一锁无保活定时器，不存在 compromise 检测；锁被外部删除/
 * 夺取后 fn 照跑、release 静默成功（ENOENT 容忍）。
 */
export async function withFileLockAsync<T>(
  filePath: string,
  opts: AsyncFileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  opts.ensure()
  let release: LockRelease | undefined
  for (let attempt = 0; release === undefined; attempt++) {
    try {
      release = await acquireLock(filePath, { staleMs: DEFAULT_STALE_MS })
    } catch (err) {
      if (!isElocked(err)) throw err
      // 首试 + retries 次重试全部失败 → 抛 ELOCKED（对齐 retry 库 retries 次数语义）
      if (attempt >= DEFAULT_RETRIES) throw err
      await sleep(backoffDelayMs(attempt))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      await release()
    } catch (error) {
      // release 仅在非 ENOENT 的 fs 错误（权限等）时失败——不外抛（fn 结果优先），
      // warn 而非静默：锁被外部删等异常需要可观测
      console.warn(`[${opts.logTag}] release lock failed (continuing, lock may be compromised):`, error)
    }
  }
}

/** Atomics.wait 需要一个共享内存对象作等待目标；4 字节 = 一个 Int32 元素，仅占位不被写入。 */
const SLEEP_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_WAIT_BUFFER, 0, 0, ms)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
