/**
 * ClaimLedger 测试共享 harness：手动时钟 + ledger 台账自动回收 + 每例重置。
 *
 * 供 notify-claims 系测试文件共用（makeLedger 工厂 / 时钟推进 / 台账兜底回收）；
 * vi.useFakeTimers/useRealTimers 由各测试文件在自身钩子里调用（fake timers 的主语是
 * 测试文件，保证工厂内 TTL 清扫 setInterval 不落真实事件循环——AGENTS.md timer 规则）。
 */
import { createClaimLedger, type ClaimLedger, type ClaimLedgerDeps } from '../../notify-claims.js'

/** 主 session id（债权持有方 / 被 respond 方）。 */
export const P = 'parent-1'
/** 被管理子会话 id。 */
export const S = 'child-1'
/** TTL 基准窗口（ms），与源码 TTL 下界钳制值（MIN_TTL_MS = 10min）同值。 */
export const TTL = 10 * 60_000

export function createLedgerHarness() {
  let clock = 0
  let open: ClaimLedger[] = []
  return {
    makeLedger(deps: ClaimLedgerDeps = {}) {
      const l = createClaimLedger({ now: () => clock, ...deps })
      open.push(l)
      return l
    },
    setClock(ms: number) {
      clock = ms
    },
    advance(ms: number) {
      clock += ms
    },
    reset() {
      clock = 0
      open = []
    },
    disposeAll() {
      for (const l of open) l.dispose()
      open = []
    },
  }
}
