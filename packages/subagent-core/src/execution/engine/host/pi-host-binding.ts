// src/execution/engine/host/pi-host-binding.ts
//
// pi 引擎的宿主侧绑定点（W6 建立；[W3 chat 域收口] 重写为纯协议形态）。
// 职责 = pi 引擎的 EnginePort 解析与公共常量的宿主侧单一出口——chat 域 inproc 引擎
// （inproc pi 引擎目录）已随 chat-domain-v1x-liveness-governance W3 删除，chat 轮次与 run
// 域同样经协议客户端（RemoteEngine，registry 'pi' 由三级发现装载 cli descriptor）
// 发往 pi-subagent-cli 引擎进程（G1：pi 引擎单一 CLI 形态，core 壳侧零内建引擎）。
//
// 出口（[池抽象降级 2026-09-13] 原 PI_POOL_KEY 常量已随 poolKey 协议面退役删除，
// 消费方改用 SDK SHARED_POOL_KEY）：
//   - resolveHostPiEnginePort：宿主侧（SAR / chat 域路由）pi EnginePort 解析——
//     携带窗口键（chat 轮次 = record.id，U3）时经窗口实例解析单点（per-window 引擎
//     窗口内创建复用、shared-service 透传 registry）；无窗口键 = registry 'pi' 直取
//     （发现器装载的 cli 形态 port，RemoteEngine）；未注册（引擎包
//     未装/发现失败）→ 不可用 stub：路由层对 pi 恒同步短路（本地 pi 恒可用口径），
//     真正的拒绝发生在首次 engine.run——stub 抛 EngineNotFoundError（含安装指引），
//     由 SAR「不 reject」契约收口进 result.error。
//
// maxTurnsToWatchdogMs：maxTurns→watchdog 毫秒换算的 barrel 公共出口（U3/U4 / D7，
// 两宿主预算一致性 S2 的函数级锚点）。原 inproc session-runner（已删） 定义随删件
// 收敛到本文件——算法（floor 30min + 每轮 5min，均 floor 语义）与运行时真实消费方
// （pi-subagent-cli spawn-runner 的 spawn watchdog）保持同源常量，漂移由 conformance
// chat golden（spawn-args 断言）在引擎包侧守护。

import type { EnginePort } from "../port.ts";
import { EngineNotFoundError, getEngine, hasEngine, listEngines } from "../registry.ts";
// [U3 pi-workflow-run-resource-model] 窗口实例解析单点（U2 在 routing.ts「窗口实例
// 状态」段建立）：chat 域轮窗口与 workflow run 窗口共用同一解析单点与收尾释放原语。
import { resolveWorkflowWindowEnginePort } from "../routing.ts";

/** watchdog 换算下限（分钟）：与引擎包 spawn-runner 的 floor 同源（30min）。 */
const WATCHDOG_FLOOR_MINUTES = 30;
/** watchdog 每轮预算（分钟/turn）：同源常量（5min/turn）。 */
const WATCHDOG_MINUTES_PER_TURN = 5;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** maxTurns → spawn watchdog 毫秒估算（floor 语义：maxTurns 小时取下限）。 */
export function maxTurnsToWatchdogMs(maxTurns: number): number {
  return Math.max(
    WATCHDOG_FLOOR_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND,
    maxTurns * WATCHDOG_MINUTES_PER_TURN * SECONDS_PER_MINUTE * MS_PER_SECOND,
  );
}

/**
 * 宿主侧 pi EnginePort 解析（SAR / 会话形态轮路由）：pi 已注册时经窗口实例解析单点
 * 或 registry 取 cli 形态 port（RemoteEngine）——续聊轮与 run 域同路（协议 run 帧发往
 * pi-subagent-cli 引擎进程）。
 *
 * [U3 pi-workflow-run-resource-model] 窗口实例改道：`windowKey` 非 undefined（chat
 * 轮次路径，键 = record.id）时经 resolveWorkflowWindowEnginePort 解析——per-window
 * 引擎（U0 落地后 pi 的 manifest 形态）在该窗口内首触创建登记、窗口内复用、轮 idle
 * 随窗口收尾 dispose（薄壳不跨窗口常驻，G1）；shared-service 形态（现行缺省网关恒
 * shared-service）透传 registry 单例路径，现状行为零变化。`windowKey` 缺省（无窗口
 * 作用域的调用方，如 execute() 路由的 pi 同步短路位）保持 registry 直取——该 port
 * 只被同步只读消费（capabilities），不 spawn。
 * [U-2 一致性修复] pi **未注册**（引擎包未装/发现失败）时返回不可用 stub，不静默
 * 直构任何本地实例——保留设计 D4「全不可用 → 派发期 engine_not_found + 安装指引」
 * 错误契约（zcode 侧 d8-compat 同语义，两引擎对称）；stub 判定先于窗口解析（未注册
 * 时窗口路径的 registry 透传会变成解析期同步 throw，破坏「pi 恒同步短路、拒绝点
 * 延迟到首次 run」契约）。
 *
 * @param getService 未消费（历史签名兼容位——inproc per-session DI 重绑形态随
 *   inproc pi 引擎目录 删除消亡；保留形参使 SAR 调用点零改动，W8 收口时随调用面一并清理）。
 * @param windowKey 派发窗口键（U3：chat 轮次 = record.id；undefined = 无窗口作用域，
 *   registry 直取）。
 */
export function resolveHostPiEnginePort(_getService?: () => unknown, windowKey?: string): EnginePort {
  if (hasEngine("pi")) {
    return windowKey !== undefined
      ? resolveWorkflowWindowEnginePort(windowKey, "pi")
      : getEngine("pi");
  }
  return piUnavailableEnginePort();
}

/** pi 不可用 stub（D4）：一切执行面抛 engine_not_found；capabilities 全放行（拒绝点唯一化在 run）。 */
function piUnavailableEnginePort(): EnginePort {
  const fail = (): never => {
    throw new EngineNotFoundError("pi", listEngines());
  };
  return {
    id: "pi",
    // 与 pi-subagent-cli manifest capabilities 逐位一致（快照权威；stub 的能力位
    // 只被 gate 同步面在 run 前读取，真正的拒绝发生在 stub.run 抛 engine_not_found）。
    capabilities: () => ({
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "native",
      personaInjection: "flag",
      eventGranularity: "stream",
      sandbox: "emulated",
      sessionRead: "full",
      resume: "native",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: true,
      // [subagent-model-switch] setModel 位同批补位（stub 快照权威 = 与 pi-subagent-cli
      // manifest 逐位一致；位缺省 undefined 语义上是 unsupported，但快照注释声明逐位
      // 对齐，漏位即快照漂移）
      setModel: "native",
    }),
    probe: () => fail(),
    run: () => fail(),
    read: () => fail(),
  };
}
