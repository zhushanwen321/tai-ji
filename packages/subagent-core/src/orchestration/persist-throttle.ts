// src/orchestration/persist-throttle.ts
//
// RunStore 两 adapter 共享的落盘节流决策（判定 + 记账单点）。
//
// 收编前 FileRunStore.save 与 pi 壳 JsonlRunStore.doFlush 各持一份同构实现
// （五要素：首写豁免 / 终态豁免 / 窗口跳过 / 零禁用 / 成功后记账）——等价只靠
// 注释互指（「语义对齐 core FileRunStore.save OR-5 ⑥a」）与间隔常量单源维系，
// 无共享测试锚定。B3 写序事故只在壳侧发生、只修壳侧，是两份平行实现独立演化
// 的实证。本模块把决策收编为 core 单点：两 adapter 只保留 IO 策略差异（FileRunStore
// 单通道 append-only 整体跳过；JsonlRunStore 只对 appendEntry 权威通道节流，
// state 覆盖写不受节流——覆盖写无 append-only 的 O(n²) 累积问题）。
//
// 记账语义（调用方义务）：recordPersisted 只能在受保护通道成功后调用——IO
// 失败不记账，保留下次重试机会（FileRunStore：appendFile 失败 → 下次不节流；
// JsonlRunStore：appendEntry 成功 + state writeFile 失败 → 记账保持——entry
// 已落账是既成事实，重试 writeFile 无需重复 append）。判据跟随「自己保护的
// 通道」的成功，两侧一致。

/**
 * run 快照落盘节流器（纯内存，无 IO）。
 *
 * 时间源由调用方传入（`now` 参数）——判定与记账都是纯函数式入口，fake timers
 * 测试下调用方推进时钟即可，节流器自身不持计时器。
 */
export interface RunPersistThrottle {
  /**
   * 判定本次是否应落盘。五要素：
   * - `minIntervalMs <= 0`（含构造钳制后的 0）→ 恒 true（禁用节流）；
   * - 终态（isTerminal）→ true（最终状态必落盘，末行即终态快照）；
   * - 首写（该 runId 无记账）→ true（新 run 至少一条快照，loadAll 重水合可发现）；
   * - running 中间态距上次落盘不足窗口 → false（跳过；状态仍在调用方内存，
   *   下次落盘带全量最新快照——未落盘的 running 尾部丢失等价崩溃语义，由恢复
   *   路径收编）；
   * - 窗口到期 → true。
   */
  shouldPersist(runId: string, isTerminal: boolean, now: number): boolean;
  /**
   * 落盘成功后的判据记账（见模块头注的调用方义务）。
   * 终态记账即删条目（终态后 runId 不再 save）；running 记账为本次 now。
   * 残留条目只出现在「running 中 run 消失（崩溃/宿主弃用）」场景，单条 ~100B
   * 可忽略——与 store 侧 per-runId 链条目残留同一取舍。
   */
  recordPersisted(runId: string, isTerminal: boolean, now: number): void;
}

/**
 * 构造 run 快照落盘节流器。`minIntervalMs` 负值钳制为 0（= 禁用节流）；
 * 缺省窗口常量见 `DEFAULT_SAVE_MIN_INTERVAL_MS`（file-run-store.ts 单源）。
 */
export function createRunPersistThrottle(minIntervalMs: number): RunPersistThrottle {
  const interval = Math.max(0, minIntervalMs);
  const lastPersistedAt = new Map<string, number>();
  return {
    shouldPersist(runId: string, isTerminal: boolean, now: number): boolean {
      if (interval <= 0) return true;
      if (isTerminal) return true;
      const last = lastPersistedAt.get(runId);
      if (last === undefined) return true;
      return now - last >= interval;
    },
    recordPersisted(runId: string, isTerminal: boolean, now: number): void {
      if (isTerminal) {
        lastPersistedAt.delete(runId);
      } else {
        lastPersistedAt.set(runId, now);
      }
    },
  };
}
