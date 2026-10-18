/**
 * 引擎通道注册表 + channel 树（M3，设计 relay-spawn-transport §3.3 D4/D7）。
 *
 * 职责：engine_open 生命周期的台账（opening 占位 → open → closing → 注销）、按连接的
 * 通道枚举（断连 fan-out）、按 parentRecordId→recordId 父链的树查询（递归收割的登记面）。
 * 纯台账 + 查询，不做 IO/杀链——帧收发与杀链编排在 control-server（需要 socket/子进程
 * 句柄上下文）。
 *
 * 树语义（D4 嵌套子代理）：每通道可自申报 recordId（launch.recordId，可选 wire 扩展）；
 * 嵌套通道以 parentRecordId 指向父通道 recordId 建树。父通道终止 → findDescendantIds
 * 枚举全部后代 → 逐一杀组（递归收割）。结构性兜底与登记面正交：嵌套 task pi 死亡必关
 * 其 control 连接（kill-on-disconnect fan-out），recordId 缺省（null）的通道无树挂点，
 * 收割仍由进程组 + 连接 fan-out 保证。
 */
import type { ChildProcess } from 'node:child_process'

/** 通道生命周期状态（§3.4.3 状态机）：opening 占位先于 spawn，open = engine_opened 已应答。 */
export type ControlChannelState = 'opening' | 'open' | 'closing'

export type ControlChannelInit = {
  channelId: string
  /** 持有连接 id（control-server 分配；fan-out 与连接级上限的归属键）。 */
  connectionId: string
  engineId: string
  /** 受理该通道的 engine_open requestId（open 超时反查的精确归属键）。 */
  openKey: string
  rootSessionId: string
  parentRecordId: string | null
  depth: number | null
  /** 自申报 record id（树父链挂点；launch.recordId 可选扩展）。 */
  recordId: string | null
  pidFile: string
}

export type EngineChannelRecord = ControlChannelInit & {
  state: ControlChannelState
  pid: number | null
  child: ChildProcess | null
}

export class ControlChannelRegistry {
  private readonly channels = new Map<string, EngineChannelRecord>()

  get size(): number {
    return this.channels.size
  }

  /** 全量通道数（滚动重启在途面组合根消费：getActiveControlServer().channelCount）。 */
  get channelCount(): number {
    return this.channels.size
  }

  register(init: ControlChannelInit): EngineChannelRecord {
    const record: EngineChannelRecord = { ...init, state: 'opening', pid: null, child: null }
    this.channels.set(init.channelId, record)
    return record
  }

  get(channelId: string): EngineChannelRecord | undefined {
    return this.channels.get(channelId)
  }

  remove(channelId: string): void {
    this.channels.delete(channelId)
  }

  listByConnection(connectionId: string): EngineChannelRecord[] {
    const out: EngineChannelRecord[] = []
    for (const record of this.channels.values()) {
      if (record.connectionId === connectionId) out.push(record)
    }
    return out
  }

  /** 全连接全通道枚举（destroyAll）。 */
  listAll(): EngineChannelRecord[] {
    return [...this.channels.values()]
  }

  /**
   * 按 recordId→parentRecordId 父链枚举 channelId 的全部后代（含间接；BFS + visited
   * 防环——parentRecordId 是外部输入，环形申报不能打死循环）。不含自身。
   */
  findDescendantIds(channelId: string): string[] {
    const self = this.channels.get(channelId)
    if (self === undefined || self.recordId === null) return []
    const out: string[] = []
    const visited = new Set<string>([channelId])
    let frontier: string[] = [self.recordId]
    while (frontier.length > 0) {
      const parentRecordId = frontier.shift() as string
      for (const record of this.channels.values()) {
        if (visited.has(record.channelId)) continue
        if (record.parentRecordId !== parentRecordId) continue
        visited.add(record.channelId)
        out.push(record.channelId)
        if (record.recordId !== null) frontier.push(record.recordId)
      }
    }
    return out
  }
}
