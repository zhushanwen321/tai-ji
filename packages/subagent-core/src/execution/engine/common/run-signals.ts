// src/execution/engine/common/run-signals.ts
//
// [H2 W2 迁移步⑥] 运行期 signal 合流公共 helper——原定义在 subprocess-agent-runner.ts
// （模块内直调），随 service 统一编排入口 executeWorkflowAgent 接管 workflow 派发
// （设计 docs/design/subagent-workflow-record-unification.md §5 W2 八步迁移表）提为
// engine/common 公共面：SAR 与 SubagentService 两调用点共用同一实现（行为逐字节
// 等价搬移，函数体不改）。SAR 侧经 re-export 保持既有 import 路径（测试消费面零
// 改动），W4 掏空 SAR.run 后本文件成为唯一权威落点。

import { HOST_TIMEOUT_ABORT_REASON } from "./kill-chain.ts";

/** 合并 signal 的句柄：signal 供 engine.run 消费，dispose 移除桥接 listener（finally 必达）。 */
export interface MergedRunSignalHandle {
  signal: AbortSignal;
  /** 移除全部桥接 listener（幂等）。run 正常收敛（merged 不 abort）时是唯一清理通道。 */
  dispose(): void;
}

/**
 * D-A9 + [M3] 运行期 signal 合流：外部 signal（run 级 abort）+ per-call 墙钟 timeoutMs
 * + [M3] no-progress watchdog abort —— 任一 abort 都让返回 signal abort。
 *
 * reason 语义保持 D-A9 原样：timeoutMs 到期 abort 带 HOST_TIMEOUT_ABORT_REASON 标记
 *（引擎合成终态时判别「宿主超时」vs「外部 cancel」）；外部 signal 与 watchdog 的
 * abort 不带标记（wireAbortSignal 只消费 abort 事实，不读 reason）。
 *
 * 无任何信号源（timeoutMs 缺省/<=0 且无 watchdog）时原样返回 external signal（零新对象，
 * 既有行为逐点不变）。
 *
 * dispose 的必要性：merged signal 正常收敛（不 abort）时，桥接在外部 run 级 signal 上的
 * listener 不会自行移除——同一 run 多次 agent 调用会累积 listener 直至
 * MaxListenersExceededWarning，故由调用方 finally 调 dispose。
 */
export function mergeRunSignals(
  signal: AbortSignal,
  timeoutMs?: number,
  noProgressSignal?: AbortSignal,
): MergedRunSignalHandle {
  const hasTimeout = timeoutMs !== undefined && timeoutMs > 0;
  if (!hasTimeout && noProgressSignal === undefined) {
    return { signal, dispose: () => {} };
  }

  const controller = new AbortController();
  const bridges: Array<{ source: AbortSignal; handler: () => void }> = [];
  let timer: NodeJS.Timeout | undefined;

  const dispose = (): void => {
    for (const bridge of bridges) bridge.source.removeEventListener("abort", bridge.handler);
    bridges.length = 0;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // 先挂清理 listener：任一信号源已 abort 时 bridge 会同步 abort controller，若清理
  // listener 尚未就位，timeout timer / 已挂 listener 将不会被回收（原实现的既有时序盲区）。
  controller.signal.addEventListener(
    "abort",
    () => dispose(),
    { once: true },
  );

  if (hasTimeout) {
    timer = setTimeout(() => controller.abort(HOST_TIMEOUT_ABORT_REASON), timeoutMs);
    timer.unref();
  }

  const bridge = (source: AbortSignal): void => {
    // 已 abort（前序信号源抢先 / 外部 signal 传入时已中止）后不再挂新 listener：
    // 否则该 listener 永远等不到 controller 的清理（已过 abort 时点）。
    if (controller.signal.aborted) return;
    const handler = (): void => controller.abort();
    bridges.push({ source, handler });
    if (source.aborted) handler();
    else source.addEventListener("abort", handler, { once: true });
  };
  bridge(signal);
  if (noProgressSignal !== undefined) bridge(noProgressSignal);

  return { signal: controller.signal, dispose };
}
