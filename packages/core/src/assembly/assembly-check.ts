/**
 * 装配检查 helper（remote-use D9①）——双壳装配对齐的机器断言单点。
 *
 * 结构性根因（设计 §2.4）：壳层装配是弱契约的——core 端口束成员可选、InboundEffects 回调
 * 全可选，壳漏接一处即静默退化为 no-op，无报错无告警（S 级缺口 7 连发的共同根因）。本
 * helper 把「壳必须接线的最小装配面」收敛为唯一断言定义点，双壳测试各调同一函数（桌面防
 * 未来重构 useSidebar 时静默删注入；移动防装配面人工对照书写的缺口累积）。
 *
 * 断言逻辑（计算器/裁判分层）：helper 忠实映射输入 → 问题清单，不抛错不判死刑；通过判定
 * 由双壳测试断言（problems 为空 = 装配完成态）。
 *
 * 「非默认 no-op」两级判定：
 * - missing：键不存在（core 链内 `?? noop` 解析的静默退化前置形态）；
 * - noop：键存在但函数体为空（显式注入空实现的退化形态——与缺键在链内效果相同）。
 *   空体判定是启发式（arrow/function 声明/方法简写三种空体形态），仅测试期消费——
 *   helper 唯一使用方 = 双壳测试（vitest 非 minify，函数体形态稳定），生产构建不打进
 *   bundle（双壳生产代码零消费，由双壳测试的 grep 断言守护）。
 *
 * 成员清单与 D9② 真差异白名单互斥对齐（登记容器
 * docs/todo/remote-use-shell-unification-reserved-divergences.md §3）：cancelActiveFlow /
 * preloadFileTree / clearUnread 是壳合法缺省成员（移动壳无对应功能面），不在断言清单；
 * 清单覆盖关系由 core 侧契约测试锁死（Required<SessionEntryPort> 样例对象，新成员漏归边编译红）。
 */
import type { SessionEntryPort } from '../domain/session/api-port'
import type { InboundEffects } from '../coordination/route-inbound'

/**
 * D9① sessionEntry 断言清单：切入链订阅/LRU 三步的壳侧实现（S1 只看不发无 live 订阅 /
 * S7 内存无界的修复锚点——缺任一即静默退化）。
 */
export const REQUIRED_SESSION_ENTRY_MEMBERS = [
  'ensureStreamSubscription',
  'touchRecency',
  'evictLru',
] as const

/**
 * D9② 合法缺省成员（与 docs/todo 真差异白名单互斥对齐）：壳无对应功能面时缺省 no-op 是
 * 契约允许形态（use-session 链内 `?? noop` 解析），不进装配断言。
 */
export const EXEMPT_SESSION_ENTRY_MEMBERS = [
  'cancelActiveFlow',
  'preloadFileTree',
  'clearUnread',
] as const

/**
 * D9① effects 最小集：lifecycle factory 三生命周期回调（D5 单一归属——exited 的 markDead/
 * 流式终结、restored 的 revive/提示条/重订阅、restoreFailed 的熔断提示）。缺任一即 S6
 * 「会话崩溃不 markDead、无恢复提示无重订阅」回归。
 */
export const REQUIRED_EFFECT_CALLBACKS = [
  'onSessionExited',
  'onSessionRestored',
  'onSessionRestoreFailed',
] as const

/** 单条装配问题：member = 端口束/回调集成员名（入口级缺失用入口名）；reason 二值。 */
export interface AssemblyCheckProblem { // oe-exempt:20261003:framework:D9 装配检查 helper 的返回契约（忠实返回问题清单是设计形态）
  member: string
  reason: 'missing' | 'noop'
}

export interface AssemblyCheckResult { // oe-exempt:20261003:framework:D9 装配检查 helper 的返回契约（计算器/裁判分层——忠实返回问题清单是设计形态，单实现非待扩展口）
  /** true = 无问题（problems 为空）；false = 存在装配缺口 */
  ok: boolean
  problems: AssemblyCheckProblem[]
}

/**
 * 空函数体启发式（仅测试期消费，见文件头注释）。覆盖三种空体形态：
 * `() => {}` / `function [名]() {}` / `方法名() {}`（压空白后比对）。
 */
function isEmptyFunction(fn: unknown): boolean {
  if (typeof fn !== 'function') return false
  const src = fn.toString().replace(/\s+/g, '')
  return src === '()=>{}' || src === 'async()=>{}' || /^function[^(]*\(\)\{\}$/.test(src) || /^\w+\(\)\{\}$/.test(src)
}

/** 单成员装配判定：缺键 → missing；空函数体 → noop；真实现 → 无问题。 */
function checkMember(host: Record<string, unknown>, member: string): AssemblyCheckProblem | null {
  const value = host[member]
  if (typeof value !== 'function') return { member, reason: 'missing' }
  return isEmptyFunction(value) ? { member, reason: 'noop' } : null
}

/**
 * 断言壳的 sessionEntry 端口束装配（D9①）。输入壳侧原始 SessionEntryPort（成员可选形态
 * ——core 链内的 `?? noop` 默认解析产物无法区分缺省与真实现，故断言对象是壳注入前的原始
 * 束）。整束未传（undefined/null）报入口级 missing。
 */
export function checkSessionEntryAssembly(
  entry: SessionEntryPort | null | undefined,
): AssemblyCheckResult {
  if (entry === null || entry === undefined) {
    return { ok: false, problems: [{ member: 'sessionEntry', reason: 'missing' }] }
  }
  const host = entry as unknown as Record<string, unknown>
  const problems = REQUIRED_SESSION_ENTRY_MEMBERS.map((member) => checkMember(host, member)).filter(
    (p): p is AssemblyCheckProblem => p !== null,
  )
  return { ok: problems.length === 0, problems }
}

/**
 * 断言壳的 InboundEffects 覆盖生命周期最小集（D9①）。输入壳装配的回调集（移动壳 =
 * bootstrap `__testing.shellEffects`；桌面壳 = createInboundEffects() 产物）。整集未传报
 * 入口级 missing。
 */
export function checkInboundEffectsAssembly(
  effects: InboundEffects | null | undefined,
): AssemblyCheckResult {
  if (effects === null || effects === undefined) {
    return { ok: false, problems: [{ member: 'effects', reason: 'missing' }] }
  }
  const host = effects as unknown as Record<string, unknown>
  const problems = REQUIRED_EFFECT_CALLBACKS.map((member) => checkMember(host, member)).filter(
    (p): p is AssemblyCheckProblem => p !== null,
  )
  return { ok: problems.length === 0, problems }
}
