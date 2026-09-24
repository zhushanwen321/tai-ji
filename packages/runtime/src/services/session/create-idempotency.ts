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
 * 回收策略（登记面有界，防内存泄漏）：
 * 1. **短保留 TTL（10min）**：成功记录落定后记 expiresAt = now + TTL，到期在下一次 run 的
 *    惰性 sweep 中删除（无 timer 常驻，同 pending.ts 惰性判定模式）。TTL 量级取 5-10min
 *    建议区间上限：需覆盖「backstop 65s 放弃 + 用户阅读错误 + 重试」与 WS 重连/重启窗口，
 *    而过期后的同 uuid 重试退化为新建（残留风险见文件尾注）。
 * 2. **容量上限（256 条）**：超限驱逐最老（Map 迭代序 = 插入序，同 pending.ts MAX_PENDING
 *    先例）；被驱逐 uuid 的迟到重试退化为新建——有界内存优先，256 远超 10min 窗口内的
 *    现实创建速率。
 * 3. in-flight 记录不过期（expiresAt 落定前不参与 sweep）——create 正常路径无墙钟超时
 *    （超时默认原则，任务级禁止自带超时），落定必达，随后走 TTL/失败即清。
 *
 * [残留风险·已知接受] TTL 过期/容量驱逐后的同 uuid 重试会新建第二个 session（旧 session
 * 是用户可见的真实 session，非幽灵）；登记期内用户手动删除 session 后同 uuid 重试会返回
 * 已删 session 的 summary（调用方渲染空列表项，可再删）。两者都要求同一 create 流的黏滞
 * uuid 跨越 10min 重放，现实概率极低，且后果可恢复（删掉多余 session 即可）。
 */
import type { SessionSummary } from '@taiji/shared'

/** 成功记录保留 TTL（ms = 10 分钟）：覆盖客户端放弃→重试窗口，到期惰性回收（见类头回收策略 §1）。 */
export const CREATE_IDEMPOTENCY_TTL_MS = 600_000

/** 登记表容量上限：超限驱逐最老（见类头回收策略 §2）。 */
export const CREATE_IDEMPOTENCY_MAX_ENTRIES = 256

export class CreateIdempotencyRegistry {
  private readonly records = new Map<
    string,
    {
      /** 该 clientUuid 的唯一创建结果（in-flight 与已落定共用同一 Promise，重试方 await 即可）。 */
      promise: Promise<SessionSummary>
      /** 成功保留截止（ms epoch）；in-flight 期间 undefined = 不过期（落定后写入，见回收策略 §3）。 */
      expiresAt?: number
    }
  >()

  /**
   * 幂等执行 create：命中登记（in-flight 或 TTL 内已落定）→ 复用既有 Promise；
   * 未命中 → 执行 exec 并登记，成功留 TTL、失败即清。
   *
   * @param clientUuid 幂等键（调用方保证非空串；同一「新建任务」的重试复用同一 uuid）
   * @param exec 单次真实创建体（SessionLifecycle.createNew）
   */
  run(clientUuid: string, exec: () => Promise<SessionSummary>): Promise<SessionSummary> {
    this.sweep(Date.now())
    const hit = this.records.get(clientUuid)
    if (hit) return hit.promise
    // 容量上限：驱逐最老（Map 插入序 = 最早登记；in-flight 同样可被驱逐，代价见类头残留风险）
    while (this.records.size >= CREATE_IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) break
      this.records.delete(oldest)
    }
    const record = { promise: exec() }
    this.records.set(clientUuid, record)
    // 落定回调：成功 → 记保留截止（进入 TTL 回收轨道）；失败 → 即清（重试可重建）。
    // identity 守卫：回调到达时登记可能已被驱逐/替换，只操作仍指向本 record 的条目。
    record.promise.then(
      () => {
        if (this.records.get(clientUuid) === record) {
          record.expiresAt = Date.now() + CREATE_IDEMPOTENCY_TTL_MS
        }
      },
      () => {
        if (this.records.get(clientUuid) === record) {
          this.records.delete(clientUuid)
        }
      },
    )
    return record.promise
  }

  /** 惰性 TTL 清扫（每次 run 入口触发；in-flight 记录 expiresAt 为 undefined 不参与）。 */
  private sweep(now: number): void {
    for (const [key, record] of this.records) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) {
        this.records.delete(key)
      }
    }
  }

  /** 测试观察口：当前登记条目数（回收策略生效断言用）。 */
  get size(): number {
    return this.records.size
  }

  /** 测试重置用（无生产调用方——登记随 SessionLifecycle 实例同生命周期）。 */
  clear(): void {
    this.records.clear()
  }
}
