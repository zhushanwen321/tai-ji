/**
 * surface-by-session —— `session.surfaces` 派生视图消息的 renderer 侧只读派生表
 * （会话架构四层分离 W4a，设计 §3.3.6「抑制分支判别器」）。
 *
 * 职责（一件事）：持有 runtime 注册表 surface 事实的只读副本，供抑制类分支做成员判别
 * （线完成不进全局通知 / 线内派生任务不上抛托盘 / 线不显 fork 反馈——三读取点登记于
 * docs/constraints.json 抑制类清单，I2 用途②）。
 *
 * 数据契约（设计 §3.3.6 候选 B）：
 * - **整表替换**：每次收到帧（注册/rekey 后广播 或 sendInitialState 冷启动段）整表
 *   替换——无差减逻辑、无单条目移除时机问题；surface 是存储位置的函数、对同一会话
 *   终身不可变，故无失效逻辑。
 * - **表外查找 = 非线**（false）：帧未覆盖的会话 id（未注册 / 帧丢失 / 冷启动前）
 *   一律判非 btw——失败方向 = 偶发全局通知/托盘派生（可接受），反向「猜成线」会
 *   永久丢通知（不可接受，ADR-0122 不猜）。
 * - **坏形状帧不落表**：entries 非数组 / 条目缺 sessionId 或 surface 非词表值 →
 *   warn 留痕 + 保持原表（不猜、不半截替换）。
 *
 * 订阅装配不在本模块（core domain 零 transport 依赖）：renderer 壳
 * useForkNoticeEffect.bindForkNoticeEffect 经 events.onGlobalType('session.surfaces')
 * 订阅并调 applySurfacesFrame（App setup 单点，先于 WS 连接，冷启动段不丢）；
 * mock 模式（VITE_MOCK）帧由 core transport/mock 直发同一 events global 通道，
 * 两条到达路径同一收敛点。
 */
import { readonly, shallowRef } from 'vue'
import type { SessionSurface, ServerMessageMap } from '@taiji/shared'

/** session.surfaces 帧 payload 形状（协议 SSOT = shared protocol.ts ServerMessageMap）。 */
type SurfacesFrame = ServerMessageMap['session.surfaces']

/** surface 词表值域（协议 SSOT = shared session.ts SessionSurface；坏形状帧判别用）。 */
const SURFACE_VALUES: ReadonlySet<string> = new Set<SessionSurface>(['sidebar', 'btw'])

/**
 * 只读派生表本体（模块级 shallowRef + 整表替换触发响应式；useTrayCounts 等 computed
 * 消费方经 .value 读，替换即失效重算）。
 *
 * @data-owner #77 —— session.surfaces 派生表（renderer 侧只读副本；权威源 = runtime
 * 会话注册表 surface 事实〔SessionLifecycle.sessions / IManagedSessionView.surface〕，
 * 唯一写入口 = applySurfacesFrame 整表替换，无第二写方）
 */
const table = shallowRef<ReadonlyMap<string, SessionSurface>>(new Map())

/** 只读派生表（响应式；消费者只读 .value，写入只能经 applySurfacesFrame）。 */
export const surfaceBySessionId = readonly(table)

/**
 * 应用一帧 session.surfaces（广播或冷启动段同一收敛点）：校验通过 → 整表替换；
 * 坏形状 → warn 留痕 + 保持原表（半截替换会让判别器在表内/表外间抖动，比丢一帧更坏）。
 */
export function applySurfacesFrame(payload: unknown): void {
  const frame = payload as Partial<SurfacesFrame> | null | undefined
  if (!frame || !Array.isArray(frame.entries)) {
    console.warn('[surface-by-session] ignoring malformed session.surfaces frame (entries not an array)')
    return
  }
  const next = new Map<string, SessionSurface>()
  for (const entry of frame.entries) {
    if (
      !entry ||
      typeof entry.sessionId !== 'string' ||
      entry.sessionId === '' ||
      typeof entry.surface !== 'string' ||
      !SURFACE_VALUES.has(entry.surface)
    ) {
      console.warn('[surface-by-session] ignoring malformed session.surfaces entry:', entry)
      return // 整帧作废：不落半截表（保持上一张全量表）
    }
    next.set(entry.sessionId, entry.surface)
  }
  table.value = next
}

/** 读某会话的 surface（表外 = undefined = 该会话 surface 未知，调用方按非线处置）。 */
export function surfaceOfSession(sessionId: string): SessionSurface | undefined {
  return table.value.get(sessionId)
}

/**
 * 抑制类判别（三个登记读取点专用）：该会话是否为 btw 线（surface === 'btw'）。
 * 表外/未知一律 false（失败方向 = 偶发全局通知，见文件头契约）。
 */
export function isBtwSession(sessionId: string): boolean {
  return table.value.get(sessionId) === 'btw'
}

/** 测试隔离：清空派生表（生产代码禁止调用）。 */
export function __resetSurfaceTableForTest(): void {
  table.value = new Map()
}
