/**
 * terminal-instance-registry —— renderer 终端实例注册表（后台 runtime 注册表的界面侧镜像）。
 *
 * 背景（terminal-multi-instance 设计 §3.3「实例注册表与恢复」）：终端主键从会话 id 迁移到
 * 实例编号 `term:<会话id>:<序号>`。**事实源在 runtime**（ptyMap 键集），renderer 侧持一份
 * 镜像供三处消费：
 * - 实例切换条内容（终端面板顶部，按会话列出存活实例）
 * - 入队守卫判据（write-queue 入队前校验「实例注册表含该 terminalId（未关闭）」——
 *   判据是**注册成员资格**，与 ptyAlive 存活镜像解耦）
 * - 关闭沿 / 对账的条目集合（三腿清理与 `terminal.list` 增删对账）
 *
 * 键序与解析口径（设计 §0.5 P7）：会话 id 域不含冒号，枚举一律取**精确前缀**
 * `term:<sid>:`（后必须紧邻数字序号），**禁按冒号切分取段**——否则 sid 含冒号时
 * `term:a:` 会吞掉 sid 为 `a:1` 的键。
 *
 * 状态性质（ADR-0049「全局 sid 协调器例外类」）：模块级单例、无 Vue setup 上下文、
 * 方法显式接收 terminalId、alive 镜像非业务数据。生命周期 = 应用进程；会话销毁 / 世代
 * 变更时经显式清理入口（unregisterInstanceBySession / resetTerminalInstanceRegistry）。
 */
import { reactive } from 'vue'

/** 实例编号根前缀（编号格式 `term:<会话id>:<序号>`，设计 §3.3「编号格式」）。 */
export const TERMINAL_ID_ROOT = 'term:'

/** 注册表条目（镜像 runtime `TerminalInstanceSummary` + 界面派生子段）。 */
export type TerminalInstanceEntry = {
  /** 实例编号 `term:<sid>:<序号>`。 */
  terminalId: string
  /** 所属会话 id（由编号会话段解析）。 */
  sessionId: string
  /** 会话内序号（显示名「终端 <seq>」由 u3-bar 组件按 i18n 拼装）。 */
  seq: number
  /** PTY 存活镜像（ack 建档置 true / alive 帧幂等置 true / 回收后条目消失）。 */
  alive: boolean
}

/** `term:<sid>:` 前缀（精确前缀枚举基准）。 */
export function terminalIdPrefixOf(sessionId: string): string {
  return `${TERMINAL_ID_ROOT}${sessionId}:`
}

/**
 * 精确前缀匹配（设计 §0.5 P7）：`term:<sid>:` 之后必须是纯数字序号段。
 * 负例：sid 含冒号时 `term:a:` 不匹配键 `term:a:1:1`（序号段为 `1:1` 非纯数字）。
 *
 * **参数顺序口径（跨包同名函数防错序的唯一抓手）**：`(terminalId, sessionId)`——被查编号在前、
 * 归属会话在后，与本包全部调用点及 runtime 同名函数（terminal-service.ts）显式一致。
 * 两包无编译期约束，顺序一致是调用点传错序时能被读出的唯一信号（两参数同为 string，
 * 传反不报错、静默恒 false）——改动本签名须同步 runtime 同名函数与全部调用点。
 */
export function isTerminalIdOfSession(terminalId: string, sessionId: string): boolean {
  const prefix = terminalIdPrefixOf(sessionId)
  if (!terminalId.startsWith(prefix)) return false
  return /^\d+$/.test(terminalId.slice(prefix.length))
}

/** 由 terminalId 解析会话段；非法编号返回 null（sid 域不含冒号，取最后一个冒号前的余段）。 */
export function sessionIdOfTerminalId(terminalId: string): string | null {
  if (!terminalId.startsWith(TERMINAL_ID_ROOT)) return null
  const rest = terminalId.slice(TERMINAL_ID_ROOT.length)
  const idx = rest.lastIndexOf(':')
  if (idx <= 0) return null
  if (!/^\d+$/.test(rest.slice(idx + 1))) return null
  return rest.slice(0, idx)
}

/** 由 terminalId 解析会话内序号；非法编号返回 0（0 为无效序号，显示名回退原始编号）。 */
export function seqOfTerminalId(terminalId: string): number {
  if (!terminalId.startsWith(TERMINAL_ID_ROOT)) return 0
  const rest = terminalId.slice(TERMINAL_ID_ROOT.length)
  const idx = rest.lastIndexOf(':')
  if (idx <= 0) return 0
  const seq = rest.slice(idx + 1)
  if (!/^\d+$/.test(seq)) return 0
  return Number.parseInt(seq, 10)
}

/**
 * 注册表状态（reactive：切换条 / current 分区 computed 读它建立依赖）。
 * - byId：terminalId → 条目
 * - orderBySession：sid → terminalId 有序数组（注册顺序 = 切换条显示顺序）
 * - activeBySession：sid → 当前显示实例编号（null = 空态）
 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：终端实例注册表界面镜像（生命周期 = runtime 世代 / 应用进程）
const registry = reactive({
  byId: {} as Record<string, TerminalInstanceEntry>,
  orderBySession: {} as Record<string, string[]>,
  activeBySession: {} as Record<string, string | null>,
})

/** 注册（幂等）实例条目；已存在则仅更新存活镜像。返回条目（非法编号返回 null）。 */
export function registerInstance(terminalId: string, alive: boolean): TerminalInstanceEntry | null {
  const sessionId = sessionIdOfTerminalId(terminalId)
  if (sessionId === null) return null
  const existing = registry.byId[terminalId]
  if (existing) {
    existing.alive = alive
    return existing
  }
  const entry: TerminalInstanceEntry = { terminalId, sessionId, seq: seqOfTerminalId(terminalId), alive }
  registry.byId[terminalId] = entry
  const order = registry.orderBySession[sessionId]
  if (order) order.push(terminalId)
  else registry.orderBySession[sessionId] = [terminalId]
  // 首个实例自动成为当前显示实例（后续新建不抢占用户已选中的实例）
  if (registry.activeBySession[sessionId] == null) registry.activeBySession[sessionId] = terminalId
  return entry
}

/** 置位存活镜像（alive 帧 / ack 建档幂等；条目不存在则 no-op）。 */
export function setInstanceAlive(terminalId: string, alive: boolean): void {
  const entry = registry.byId[terminalId]
  if (entry) entry.alive = alive
}

/** 入队守卫判据：实例注册表是否含该 terminalId（未关闭）——与 ptyAlive 镜像解耦。 */
export function hasInstance(terminalId: string): boolean {
  return registry.byId[terminalId] != null
}

/** 该会话的实例条目（切换条顺序 = 注册顺序）。 */
export function listInstances(sessionId: string): TerminalInstanceEntry[] {
  const order = registry.orderBySession[sessionId]
  if (!order) return []
  const out: TerminalInstanceEntry[] = []
  for (const id of order) {
    const entry = registry.byId[id]
    if (entry) out.push(entry)
  }
  return out
}

/** 该会话的实例编号数组（快照拷贝——调用方遍历中可能触发增删）。 */
export function terminalIdsOfSession(sessionId: string): string[] {
  return [...(registry.orderBySession[sessionId] ?? [])]
}

export function activeTerminalIdOf(sessionId: string): string | null {
  return registry.activeBySession[sessionId] ?? null
}

/** 设置当前显示实例（terminalId 必须已注册；null = 空态）。 */
export function setActiveTerminalId(sessionId: string, terminalId: string | null): void {
  registry.activeBySession[sessionId] = terminalId
}

/** 全部已注册编号快照（世代变更重置前收集受影响会话用）。 */
export function allTerminalIds(): string[] {
  return Object.keys(registry.byId)
}

/**
 * 注销条目（关闭沿 / 对账回收）。
 *
 * 当前显示实例被注销时按**关闭沿显示规则**落位：取该实例在原顺序中的**右侧相邻**
 * （无右取左，设计 §3.3「焦点规则」）；无相邻则回空态。
 */
export function unregisterInstance(terminalId: string): void {
  const entry = registry.byId[terminalId]
  if (!entry) return
  const { sessionId } = entry
  delete registry.byId[terminalId]
  const order = registry.orderBySession[sessionId]
  let removedIndex = -1
  if (order) {
    removedIndex = order.indexOf(terminalId)
    if (removedIndex >= 0) order.splice(removedIndex, 1)
    if (order.length === 0) delete registry.orderBySession[sessionId]
  }
  if (registry.activeBySession[sessionId] === terminalId) {
    const remaining = registry.orderBySession[sessionId] ?? []
    // splice 后同索引即原右邻；无右取左；都没有则空态
    registry.activeBySession[sessionId] = remaining[removedIndex] ?? remaining[removedIndex - 1] ?? null
  }
}

/** 会话销毁扇出：按精确前缀注销该会话全部实例条目（不依赖实例注册表遍历入参）。 */
export function unregisterInstanceBySession(sessionId: string): void {
  for (const terminalId of terminalIdsOfSession(sessionId)) unregisterInstance(terminalId)
  delete registry.activeBySession[sessionId]
}

/**
 * 清空注册表全量（世代变更失效重置的必需动作，生产路径 resetTerminalDomain 调用；
 * 会话维度的关闭沿删条用 unregisterInstanceBySession）。清空后由重建链按 runtime 清单恢复。
 */
export function resetTerminalInstanceRegistry(): void {
  for (const key of Object.keys(registry.byId)) delete registry.byId[key]
  for (const key of Object.keys(registry.orderBySession)) delete registry.orderBySession[key]
  for (const key of Object.keys(registry.activeBySession)) delete registry.activeBySession[key]
}

// ── 测试专用 hooks（生产代码禁止调用，参照 useTerminal __reset 先例）──────────

/** 测试专用：清空注册表（全量）——与生产重置共用同一实现。 */
export function __resetTerminalInstanceRegistryForTest(): void {
  resetTerminalInstanceRegistry()
}
