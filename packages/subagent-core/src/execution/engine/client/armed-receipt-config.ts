// armed 回执等待窗与 cancel 收敛窗的常量配置（自 remote-engine.ts 提取——
// max-lines 约束；常量与解析函数是纯配置无引擎状态，独立成文件语义自洽。
// 测试经 remote-engine.ts 的 re-export 消费，import 路径保持不变）。
import { getLogger } from "../../../core/logger.ts";

const logger = getLogger("remote-engine");

/**
 * cancel 后 run 应答收敛的兜底窗（超时 = 本地合成 abort 终态收尾 record；进程回收
 * 归资源归属链——per-window 引擎随窗口收尾 dispose（薄壳死 = 孙进程同进程组连带
 * 收割，P2/P3），shared-service 引擎（zcode）stall 出声不杀（dispose 对其是宿主
 * 停机/引擎退役语义，ADR-0047 静默 ≠ 卡死：无进展的判定由任务级无进展检测承载，
 * 此处不杀不判死）。
 *
 * 量级校准依据（全局超时原则：兜底窗按被保护对象粒度校准——本窗保护的是
 * 「pi 引擎 cancel 停轮收敛」这一任务级过程，非控制范围单请求）：pi 引擎 cancel
 * 停轮链 = SIGTERM → trap-flush（在途工具/turn 收尾写盘）→ 进程退出 → run 应答
 * 返回，实测可达 15s（S1 验收 timeline 取证）；兜底窗取实测值的 2× 量级 = 30s。
 * 历史 3s（SDK CANCEL_SETTLE_GRACE_MS）按「控制范围单请求秒级」量级误校准到本
 * 任务级窗口上——常驻引擎在 pi 正常收敛途中被按进程组终止，续聊轮 run 陪葬（S1 主路径
 * 8/8 失败，P1）。SDK 常量仍由 engine-client.cancelRun 作为单请求超时使用（秒级
 * 量级对 cancel 请求往返正确），两窗语义自此分离。
 */
export const CANCEL_SETTLE_GRACE_WINDOW_MS = 30_000;

/**
 * [D3 协议版 P6] armed 回执等待窗缺省值：native 引擎 + schema 任务的 run 在本窗内
 * 未收到引擎 armed 回执 → run fail-fast（合成失败 outcome，错误含双形态恢复指引）。
 *
 * 量级依据：armed 在引擎侧是 spawn 成功后立即上报（启动期，非执行期）——正常链路
 * 到达耗时 = 引擎进程 spawn + 一帧 IPC，秒级以内；10s 覆盖慢宿主/慢磁盘的裕量，
 * 远小于「schema 链路断掉烧完整 run」的沉没成本（G1 的保险丝语义）。用户通道：
 * env 覆盖（测试调短窗 + 排障调长窗），TAIJI_SUBAGENT_* 前缀（ENV_WHITELIST_PREFIXES
 * 白名单——PI_ 前缀在桌面 spawn 链被静默丢弃的教训，对齐 TAIJI_SUBAGENT_IDLE_TIMEOUT_MS
 * 的改名先例）。
 */
export const ARMED_RECEIPT_TIMEOUT_MS = 10_000;

/** armed 回执等待窗的 env 覆盖通道（>0 毫秒数生效；未设/非法 = 缺省 10s）。 */
export const ARMED_RECEIPT_TIMEOUT_ENV = "TAIJI_SUBAGENT_ARMED_RECEIPT_TIMEOUT_MS";

/**
 * 等待窗解析（每次 run 现读，不缓存——测试逐用例改 env 零串扰；非法值 warn 回落
 * 缺省，对齐 TAIJI_SUBAGENT_IDLE_TIMEOUT_MS 的 LC-7 教训：非法回落必须可见）。
 */
function resolveArmedReceiptTimeoutMs(): number {
  const raw = process.env[ARMED_RECEIPT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return ARMED_RECEIPT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[remote-engine] ${ARMED_RECEIPT_TIMEOUT_ENV}="${raw}" is invalid (expected a positive millisecond number) — ` +
        `falling back to the default armed-receipt window (${ARMED_RECEIPT_TIMEOUT_MS}ms). ` +
        `Recovery: set a plain ms value (e.g. 500 for tests) or unset the env.`,
    );
    return ARMED_RECEIPT_TIMEOUT_MS;
  }
  return parsed;
}

export { resolveArmedReceiptTimeoutMs };
