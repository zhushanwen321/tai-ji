// src/core/concurrency-pool.ts
//
// 并发控制 + 优先级排队。background=1000（单一优先级，保留 priority 机制供未来扩展）。

/** 队列条目：优先级 + resolver + rejecter + 入队序号（同优先级 FIFO）。 */
interface QueueEntry {
  priority: number;
  resolve: () => void;
  reject: (err: Error) => void;
  seq: number;
  /** abort listener（用于 resolve/abort 时清理）。 */
  onAbort?: () => void;
  /** 关联的 signal（用于 resolve 时 removeEventListener）。 */
  signal?: AbortSignal;
}

/**
 * 排队策略（D7/U4）：release 时从等待队列放行哪个条目。策略差异是宿主声明的
 * 有意决策（pi=priority / zsw=strict-fifo），保留为参数而非消灭（见 sink 设计
 * subagent-core-sink-design.md（已删，git 可追溯） §3.3 D7）。
 *
 * - `"priority"`（缺省）：priority 值最小（0=最高）者优先，同优先级按入队序（FIFO）。
 *   与 pi 既有行为等值。
 * - `"strict-fifo"`：忽略 priority，严格按入队顺序（seq）放行。纯 FIFO 语义，
 *   供 zsw 侧等需要「先到先得、不许插队」语义的宿主消费。
 */
export type QueuePolicy = "priority" | "strict-fifo";

/** 并发池接口（可注入，便于测试 mock）。 */
export interface ConcurrencyPool {
  /**
   * 排队获取槽位（priority 0=最高；"strict-fifo" 策略下该值仅记录不参与出队选择，
   * 见 createConcurrencyPool）。可选 effectiveMaxConcurrent 覆盖实例级默认配额。
   * 可选 AbortSignal 在 abort 时 reject 排队条目。
   */
  acquire(priority: number, effectiveMaxConcurrent?: number, signal?: AbortSignal): Promise<void>;
  /** 归还槽位。必须无条件执行（finally）。 */
  release(): void;
  /** 当前已占用槽位数（诊断/widget 用）。 */
  readonly active: number;
  /** 实例级最大并发配额。调用方可据此计算分层配额（max(1, maxConcurrent - depth)）。 */
  readonly maxConcurrent: number;
}

/**
 * 默认实现：maxConcurrent 槽位 + 可策略化排队队列。
 *
 *   acquire(priority, effectiveMaxConcurrent?):
 *     effective = effectiveMaxConcurrent ?? maxConcurrent
 *     active < effective → active++, resolve
 *     否则 → 入队 { priority, resolve, seq }
 *
 *   release():
 *     queue 非空 → 按 queuePolicy 选一个条目出队 resolve（active 不变）：
 *       - "priority"：priority 升序 + 同优先级 seq FIFO
 *       - "strict-fifo"：纯 seq FIFO（priority 仅记录）
 *     queue 空 → active--（防下溢）
 *
 *   已知契约边界（审查 S-2 登记）：分层配额（effectiveMaxConcurrent）仅在
 *   acquire 时点判定；release 授予排队条目时不复查其 effective——即活跃数
 *   仍 ≥ 条目 effective 时，单次释放也可能授予该条目（pi 运行时既有行为，
 *   concurrency-pool.test T-A2 锚定）。需要严格分层隔离的宿主应在条目侧
 *   自行保证，勿依赖 release 时点复查。
 *
 * 类保留内部消费（subagent-service 深路径）；对外导出面走 createConcurrencyPool
 * 工厂（对象参数 + 策略枚举，不暴露本类名与位置参数构造——D7/U4 裁决）。
 */
export class DefaultConcurrencyPool implements ConcurrencyPool {
  private _active = 0;
  private readonly queue: QueueEntry[] = [];
  private seqCounter = 0;
  private readonly queuePolicy: QueuePolicy;

  /** 下限 1——maxConcurrent=0 会让 acquire 永久排队死锁（C3 修复）。 */
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number, queuePolicy: QueuePolicy = "priority") {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.queuePolicy = queuePolicy;
  }

  acquire(priority: number, effectiveMaxConcurrent?: number, signal?: AbortSignal): Promise<void> {
    // effectiveMaxConcurrent 覆盖实例级默认配额（分层配额：调用方传 max(1, maxConcurrent - depth)）。
    // 不修改实例级 maxConcurrent——实例配额是全局共享上限，分层配额是本次 acquire 的局部上限。
    const effective = effectiveMaxConcurrent ?? this.maxConcurrent;
    if (this._active < effective) {
      this._active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { priority, resolve, reject, seq: this.seqCounter++ };
      // H2: abort 时 reject 排队条目并从 queue 移除，防止永久挂起
      if (signal) {
        if (signal.aborted) {
          // S1: abort reject 需带 name="AbortError"，对齐包内 AbortError 错误语义约定（消费方按 err.name 判别）
          const err = new Error("acquire aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        entry.signal = signal;
        entry.onAbort = (): void => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            // S1: abort reject 需带 name="AbortError"，与 pre-aborted 分支一致
            const err = new Error("acquire aborted");
            err.name = "AbortError";
            reject(err);
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  /**
   * 出队候选比较：cur 是否优于 best（release 时选谁获得释放的槽位）。
   * 策略单一分派点——新增策略只需在此分支，acquire/abort/clamp 逻辑策略无关。
   */
  private isBetterCandidate(cur: QueueEntry, best: QueueEntry): boolean {
    if (this.queuePolicy === "strict-fifo") {
      // 纯 FIFO：seq 单调递增，先入队者 seq 必更小——priority 完全不参与
      return cur.seq < best.seq;
    }
    // priority：取优先级最高（priority 最小）的；同优先级 FIFO（seq 最小）
    return cur.priority < best.priority || (cur.priority === best.priority && cur.seq < best.seq);
  }

  release(): void {
    if (this.queue.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.isBetterCandidate(this.queue[i], this.queue[bestIdx])) {
          bestIdx = i;
        }
      }
      const next = this.queue.splice(bestIdx, 1)[0];
      // H2: 条目已获槽位——移除 abort listener（防 listener 泄漏到长生命周期 signal）
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve();
      // active 不变（一个离开队列立即进入活跃）
    } else if (this._active > 0) {
      // 防御性下界：release 调用次数多于 acquire 时不让 active 为负
      this._active -= 1;
    }
  }

  get active(): number {
    return this._active;
  }
}

/** createConcurrencyPool 选项（对象参数构造——导出面禁止位置参数歧义，D7/U4）。 */
export interface CreateConcurrencyPoolOptions {
  /** 实例级最大并发配额。0/负数 clamp 到 1（防 acquire 永久排队死锁，C3 修复语义）。 */
  maxConcurrent: number;
  /**
   * 排队策略（见 QueuePolicy）。缺省 `"priority"`——与 pi 既有消费
   * （`new DefaultConcurrencyPool(n)`）行为逐点等值，缺省即零回归。
   */
  queuePolicy?: QueuePolicy;
}

/**
 * 并发池工厂（D7/U4 导出面）：宿主经此创建并发池，无需感知实现类。
 *
 * 返回 ConcurrencyPool 接口而非 DefaultConcurrencyPool——barrel 导出面只认
 * 「对象参数 + 策略枚举」，实现类可内部替换，策略差异（pi=priority /
 * zsw=strict-fifo）显式化为参数而非两份复刻实现（深度分层公式与下限常量单源，
 * 公式见类注释与 slots 消费方）。
 */
export function createConcurrencyPool(options: CreateConcurrencyPoolOptions): ConcurrencyPool {
  return new DefaultConcurrencyPool(options.maxConcurrent, options.queuePolicy ?? "priority");
}
