/**
 * CreateIdempotencyRegistry —— session.create 的 clientUuid 幂等登记表（发现 B 修复）。
 *
 * 问题（发现 B，P1）：**客户端放弃 ≠ 服务端放弃**。create 请求已发出、runtime 正在 spawn pi
 * （冷启动/hang 可超过 renderer 的 RPC_BACKSTOP_TIMEOUT_MS≈65s）时，客户端 backstop 超时
 * 或 WS 断连会 reject 并提示「创建失败」，但 runtime 不受影响照常建号（session 已建、pi 已活）
 * → 用户重试产生重复 session，且 config.sessions 快照浮现用户没建过的幻影空壳 session。
 *
 * 语义（对齐 message 通道 clientUuid 幂等范式——message.send 透传 / send.rejected 原样带回 /
 * SegmentsMetadataEntry 按 clientUuid 覆盖去重）：
 * - 同 clientUuid 的 create 重复到达（网络重试）→ 复用同一 Promise：in-flight 中返回同一
 *   在途结果（不重复 spawn/建号），已完成返回已建 SessionSummary。
 * - **失败即清**：create reject（model 未配置 / getState 失败等 runtime 侧可检测失败，均已
 *   safeDestroy 清场）→ 立即移除登记，同 uuid 重试可重新创建（失败的 create 不该被缓存）。
 * - uuid 缺省（options.clientUuid === undefined）根本不进本表——fork/handoff/agent-managed
 *   等内部入口行为与旧版逐字节一致（调用方在 SessionLifecycle.create 入口分流）。
 *
 * 组装（C-data-18）：in-flight 去重半边组装 @taiji/core 共享原语 createInflightDedup——
 * 同 key 并发复用同一 Promise / settle 即清 / 引用比对防误删 / then 双分支接管 rejection
 * 的全族不变量由原语内建，禁止手写同构实现。本类只承载幂等语义与原语的真差异——
 * **成功结果保留期**（原语 settle 即清不保留，幂等重试需要已落定结果在窗口内可复用），
 * 以保留表外层装饰组合，不重写底层。
 *
 * 回收策略（登记面有界，防内存泄漏）：
 * 1. **短保留 TTL（10min）**：成功落定后记入保留表 expiresAt = now + TTL，到期在下一次
 *    run 的惰性 sweep 中删除（无 timer 常驻，同 pending.ts 惰性判定模式）。TTL 量级取
 *    5-10min 建议区间上限：需覆盖「backstop 65s 放弃 + 用户阅读错误 + 重试」与 WS 重连/
 *    重启窗口，而过期后的同 uuid 重试退化为新建（残留风险见文件尾注）。
 * 2. **容量上限（256 条）**：保留表超限驱逐最老（Map 迭代序 = 插入序，同 pending.ts
 *    MAX_PENDING 先例）；被驱逐 uuid 的迟到重试退化为新建——有界内存优先，256 远超
 *    10min 窗口内的现实创建速率。in-flight 表不设容量上限：create 正常路径无墙钟超时
 *    （超时默认原则，任务级禁止自带超时），落定必达，原语 settle 即清自然回收。
 * 3. 保留表只收成功落定者（失败即清语义由原语承载），in-flight 期间无过期参与。
 *
 * [残留风险·已知接受] TTL 过期/容量驱逐后的同 uuid 重试会新建第二个 session（旧 session
 * 是用户可见的真实 session，非幽灵）；登记期内用户手动删除 session 后同 uuid 重试会返回
 * 已删 session 的 summary（调用方渲染空列表项，可再删）。两者都要求同一 create 流的黏滞
 * uuid 跨越 10min 重放，现实概率极低，且后果可恢复（删掉多余 session 即可）。
 */
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'
import type { SessionSummary } from '@taiji/shared'

/** 成功记录保留 TTL（ms = 10 分钟）：覆盖客户端放弃→重试窗口，到期惰性回收（见类头回收策略 §1）。 */
export const CREATE_IDEMPOTENCY_TTL_MS = 600_000

/** 保留表容量上限：超限驱逐最老（见类头回收策略 §2）。 */
export const CREATE_IDEMPOTENCY_MAX_ENTRIES = 256

/** 保留表条目：已成功落定的 create 结果（重试方 await 同一已 resolve 的 Promise 即可）。 */
interface RetainedRecord {
  promise: Promise<SessionSummary>
  /** 成功保留截止（ms epoch）。 */
  expiresAt: number
}

export class CreateIdempotencyRegistry {
  /**
   * in-flight 去重半边（C-data-18 共享原语）：同 uuid 并发 run 共享同一 entry、失败即清、
   * 引用比对防误删——族不变量见原语头注，本类不再自实现。
   */
  private readonly inflight = createInflightDedup<SessionSummary>()

  /** 成功保留半边（幂等真差异）：TTL 内同 uuid 重试直接返回已落定结果。 */
  private readonly retained = new Map<string, RetainedRecord>()

  /**
   * 幂等执行 create：保留期内已落定 → 复用既有结果 Promise；in-flight 中 → 复用原语
   * entry（不重复 spawn/建号）；未命中 → 执行 exec 并登记，成功留 TTL、失败即清。
   *
   * @param clientUuid 幂等键（调用方保证非空串；同一「新建任务」的重试复用同一 uuid）
   * @param exec 单次真实创建体（SessionLifecycle.createNew）
   */
  run(clientUuid: string, exec: () => Promise<SessionSummary>): Promise<SessionSummary> {
    this.sweep(Date.now())
    const retained = this.retained.get(clientUuid)
    if (retained) return retained.promise
    // 发起者判定（同步段内无竞态）：保留登记回调只由首次发起者挂一次，
    // 并发复用者从原语拿同一 entry，不再重复登记
    const isIssuer = !this.inflight.has(clientUuid)
    const entry = this.inflight.run(clientUuid, exec)
    if (isIssuer) {
      // 原语时序契约：其 settle 清理回调先于调用方挂的 then 执行，成功登记时
      // in-flight 条目已清出（同 uuid 新一轮 run 可安全发起）
      void entry.promise.then(
        () => {
          this.retain(clientUuid, entry.promise)
        },
        // 失败即清由 in-flight 原语内建；此分支仅接管 rejection 防 unhandled
        () => {},
      )
    }
    return entry.promise
  }

  /** 成功落定 → 记入保留表（TTL 轨道），容量超限先驱逐最老（残留代价见类头尾注）。 */
  private retain(clientUuid: string, promise: Promise<SessionSummary>): void {
    while (this.retained.size >= CREATE_IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.retained.keys().next().value
      if (oldest === undefined) break
      this.retained.delete(oldest)
    }
    this.retained.set(clientUuid, {
      promise,
      expiresAt: Date.now() + CREATE_IDEMPOTENCY_TTL_MS,
    })
  }

  /** 惰性 TTL 清扫（每次 run 入口触发，只扫保留表）。 */
  private sweep(now: number): void {
    for (const [key, record] of this.retained) {
      if (record.expiresAt <= now) this.retained.delete(key)
    }
  }

  /** 测试观察口：当前登记条目数（in-flight + 保留表，回收策略生效断言用）。 */
  get size(): number {
    return this.retained.size + this.inflight.keys().length
  }

  /** 测试重置用（无生产调用方——登记随 SessionLifecycle 实例同生命周期）。 */
  clear(): void {
    this.inflight.clear()
    this.retained.clear()
  }
}
