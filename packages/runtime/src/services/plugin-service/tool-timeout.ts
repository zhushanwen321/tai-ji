/**
 * 插件工具执行超时取值链（pi1-disposition-chat-flow D7⑤：自 bridge-interop 迁出的通用
 * 工具函数族——迁移时实现零变化，仅换驻留文件；消费方 commands-executor / commands-api /
 * ui-api 的注释引用同步更新）。
 */

/**
 * 工具执行默认超时（任务级防挂死兜底）。
 *
 * 旧值 30s 固定墙钟误杀长工具（失败模式 A）；新默认可被 ToolRegistration.timeoutMs
 * 声明覆盖（声明通道 U2 落地），声明 <=0 / Infinity 显式 opt-out（见 resolveToolTimeoutMs）。
 * 30min 与本仓既有裁决同值：subagent-core dialog-queue DEFAULT_DIALOG_TIMEOUT_MS。
 */
export const DEFAULT_TOOL_EXECUTE_TIMEOUT_MS = 1_800_000

/**
 * Node setTimeout delay 安全上限（2^31-1）：超域 delay 会被 Node 塌缩为 1ms 立即
 * 触发（语义反转：刚发起就超时）。权威源 @zhushanwen/subagent-core/shared/timer-delay.ts
 * （dialog-queue 同款 clamp 惯例）——runtime 尚无该符号的 import 先例，本地同值定义
 * （平台常量无漂移面），避免首创跨包深路径耦合。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * declared 是否为参与取值的合法正数声明（合法域判定的单一权威源）：
 * finite 且 > 0 才生效——NaN / ±Infinity / undefined / 运行时脏值均不算合法声明。
 * 导出供 commands-executor（D4）复用，消除 declaredActive 内联复制的假差异。
 */
export function isDeclaredTimeoutActive(declared: number | undefined): declared is number {
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
}

/**
 * 解析工具执行的有效超时（对齐 dialog-queue resolveDialogTimeoutMs 形态，D1 取值链）：
 * 1. 合法正数声明优先，clamp 到 MAX_TIMER_DELAY_MS（超域值经 Node setTimeout 会塌缩
 *    1ms 反转为立即超时，clamp 是「近乎不限时」意图在 timer 域内的安全近似）；
 * 2. declared <= 0 或 Infinity 视为显式 opt-out（不限时）——invoke 的 timeoutMs 必传
 *    （plugin-rpc-server.ts，不注册 timer 需改其签名），故以 clamp 上界 2^31-1 近似
 *    「不限时」（约 24.8 天，实际等价于不设防挂死兜底）；
 * 3. 非法值（undefined / NaN / 非数值）回落 DEFAULT_TOOL_EXECUTE_TIMEOUT_MS——不因
 *    脏参数拆掉防挂死兜底。
 */
export function resolveToolTimeoutMs(declared?: number): number {
  if (isDeclaredTimeoutActive(declared)) {
    return Math.min(declared, MAX_TIMER_DELAY_MS)
  }
  if (typeof declared !== 'number' || Number.isNaN(declared)) {
    return DEFAULT_TOOL_EXECUTE_TIMEOUT_MS
  }
  return MAX_TIMER_DELAY_MS
}

/** 时长文案换算基数（命名常量惯例对齐 subagent-core dialog-queue / session-runner） */
const MS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND

/** 毫秒时长 → 诚实可读文案（整分/整秒/毫秒，不四舍五入以免低报等待时长）。
 * 导出供 commands-executor（D4 busy 提示）复用，消除本地复制的假差异（输出格式 SSOT）。 */
export function formatDurationMs(ms: number): string {
  if (ms % MS_PER_MINUTE === 0) return `${ms / MS_PER_MINUTE}min`
  if (ms % MS_PER_SECOND === 0) return `${ms / MS_PER_SECOND}s`
  return `${ms}ms`
}
