/**
 * subagent raw mirror 读取侧（M3 relay-spawn-transport §3.3 D6 / §3.4.4）。
 *
 * 引擎进程 stdout 的原始字节经 fd3 pipe 以 NDJSON 帧 `{v, recordId, seq, b64}` 到达
 * （引擎侧 writer = pi-subagent-cli/src/raw-mirror.ts）。本模块把镜像帧还原为字节行，
 * 按 `(rootSessionId, recordId, channelId)` 找/建 SubagentTee（首个 mirror 帧登记；
 * engine_closed / control close → dispose 该通道全部 record），并同步落盘磁盘镜像
 * `pi-subagent-<date>-<recordId>.jsonl`。
 *
 * seq 连续性检查（D6）：写侧 seq **per recordId** 单调递增（引擎进程级计数器，跨 run
 * 接续、丢弃也递增），读取侧 record 生命周期 = 通道（= 引擎进程），两侧口径一致——
 * workflow 成员复用使同 recordId 第二轮 run 继续沿用同一 RecordMirror。因此首帧
 * `seq === 0`（该 record 在本引擎进程的首次镜像）、其后严格 `last+1`；任一不满足即判定
 * 该 record 的 live 派生视图出现空洞，`markDegraded()` 停止发布 live entries/chunks 并让
 * 状态查询带 `degraded: true`（显式标注，不静默）。磁盘镜像与 reload 腿不受影响：tee
 * 只是可由权威数据（pi session 文件 + journal）重建的派生视图。
 *
 * 帧解析容错：畸形行（非 JSON/字段缺失）丢弃 + 计数，不抛出不升连——单个坏帧不影响
 * 其他 record/channel；attributable 的空洞语义仍由 seq 检查承担（坏帧同样消耗写侧 seq，
 * 其后的首个完整帧自然触发 degraded）。
 *
 * 隔离边界：本模块不做 WS 帧内容翻译（SubagentTee 负责）；control server 只在
 * attachChildWiring 接线字节流、finalizeClosed 调 disposeChannel。
 */
import type { ServerMessage } from '@taiji/shared'

import { createPiSubagentLog, logger } from '../logger.js'
import { toErrorMessage } from '../../utils/errors.js'
import { SubagentTee, type SubagentTeeStreamState } from './subagent-tee.js'

/** 帧发布端口（组合根注入 messageBus.publish 的定向包装）。 */
export type MirrorPublish = (sessionId: string, msg: ServerMessage) => void

/** 磁盘镜像写入器端口（生产 = createPiSubagentLog；测试注入）。 */
export type MirrorLogSink = {
  write(bytes: Buffer): void
  end(): void
}

/** fd3 镜像帧 wire 形状（引擎侧 RawMirrorFrame 对偶；v 容错读取，不入返回值）。 */
export type RawMirrorWireFrame = {
  recordId: string
  seq: number
  b64: string
}

export type SubagentMirrorHubOptions = {
  /** WS 帧发布（缺省 no-op——单测形态：状态可查询、无帧副作用）。 */
  publish?: MirrorPublish
  /** 磁盘镜像工厂（缺省 createPiSubagentLog；测试注入）。 */
  createLog?: (recordId: string) => MirrorLogSink
  /** 降级/畸形帧告警出口（缺省 logger.warn；测试注入）。 */
  warn?: (message: string) => void
}

/** 单 record 的镜像状态（tee + 磁盘日志 + seq 水位；数据形状用 type 别名）。 */
type RecordMirror = {
  rootSessionId: string
  recordId: string
  channelId: string
  tee: SubagentTee
  log: MirrorLogSink
  /** 已处理帧的最大 seq（首个帧登记；其后必须 +1 连续）。跨 run 保留：写侧 seq 按
   * recordId 进程级单调，record 复用（workflow 成员第二轮）时必须接续而非重置。 */
  lastSeq: number | undefined
  degraded: boolean
}

/**
 * seq 连续性判定（纯函数，单测直构）：写侧 seq 按 recordId 在引擎进程内单调递增
 *（per-record 计数器，跨 run 不重置）、丢弃也递增，因此该 record 在本引擎进程的
 * 首帧必为 seq 0（首帧被写侧丢弃时，读取侧首个到达帧 seq>0 = 空洞，必须显式降级）；
 * 其后必须严格 last+1。
 */
export function isMirrorSeqContinuous(previous: number | undefined, next: number): boolean {
  return previous === undefined ? next === 0 : next === previous + 1
}

/** 帧行解析（容错：任何形状问题 → null，调用方计数丢弃）。 */
export function parseRawMirrorLine(line: string): RawMirrorWireFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = parsed as Record<string, unknown>
  if (typeof raw.recordId !== 'string' || raw.recordId.length === 0) return null
  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0) return null
  if (typeof raw.b64 !== 'string') return null
  return { recordId: raw.recordId, seq: raw.seq, b64: raw.b64 }
}

/**
 * record 身份键（含 channelId，S-8）：同一 (rootSessionId, recordId) 在多 channel 场景
 * （换代重连窗口内新旧引擎进程并存、record 复用）必须各持独立镜像——写侧 seq 是
 * per-recordId **进程级**计数器，两个引擎进程各自从 0 递增，若共身份键会把两路帧序
 * 混进同一 record（seq 断裂误降级 + record 生命周期绑定首个 channel、释放延后到
 * owner channel 关闭）。channel 入键后每通道一个镜像、随本通道关闭释放。
 */
function mirrorKey(rootSessionId: string, recordId: string, channelId: string): string {
  return `${rootSessionId}\u0000${recordId}\u0000${channelId}`
}

/** 换行帧界（镜像行载荷是 b64+JSON，全 ASCII；string 缓冲安全）。 */
const NEWLINE = '\n'

/** 每通道 fd3 行泵（control server 每引擎通道一个；dispose 幂等）。 */
class ChannelMirrorReader {
  private buffer = ''
  private malformed = 0
  private disposed = false

  constructor(
    private readonly channelId: string,
    private readonly rootSessionId: string,
    private readonly hub: SubagentMirrorHub,
  ) {}

  ingest(chunk: Buffer): void {
    if (this.disposed || chunk.length === 0) return
    this.buffer += chunk.toString('utf8')
    let nl = this.buffer.indexOf(NEWLINE)
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      nl = this.buffer.indexOf(NEWLINE)
      if (line.trim().length === 0) continue
      const frame = parseRawMirrorLine(line)
      if (frame === null) {
        this.malformed += 1
        this.hub.noteMalformedFrame(this.channelId, this.malformed)
        continue
      }
      this.hub.routeFrame(this.channelId, this.rootSessionId, frame)
    }
  }

  dispose(): void {
    this.disposed = true
    this.buffer = ''
  }
}

/**
 * 镜像 hub：通道 → 行泵 + record → tee/日志 的双索引。组合根形态 = control server
 * 每实例一个（`SubagentControlServer` 私有字段）；查询入口
 * {@link getStreamStateByRecord} 供组合根 getSubagentStreamState 路由消费。
 */
export class SubagentMirrorHub {
  private readonly records = new Map<string, RecordMirror>()
  private readonly channelRecords = new Map<string, Set<string>>()
  private readonly readers = new Map<string, ChannelMirrorReader>()
  private readonly publish: MirrorPublish
  private readonly createLog: (recordId: string) => MirrorLogSink
  private readonly warn: (message: string) => void

  constructor(opts: SubagentMirrorHubOptions = {}) {
    this.publish = opts.publish ?? (() => {})
    this.createLog = opts.createLog ?? ((recordId) => createPiSubagentLog(recordId))
    this.warn = opts.warn ?? ((message) => logger.warn(message))
  }

  /** 打开通道行泵（engine spawn 成功、wiring 挂载时；重复调用幂等）。 */
  openChannel(channelId: string, rootSessionId: string): void {
    if (this.readers.has(channelId)) return
    this.readers.set(channelId, new ChannelMirrorReader(channelId, rootSessionId, this))
  }

  /** fd3 原始字节入口（NDJSON 行；无该通道 = no-op——spawn 失败/未宣告形态）。 */
  ingestBytes(channelId: string, chunk: Buffer): void {
    this.readers.get(channelId)?.ingest(chunk)
  }

  /** 通道关闭（engine_closed / control close / server destroy）：行泵 + 该通道 record 全释放。 */
  disposeChannel(channelId: string): void {
    this.readers.get(channelId)?.dispose()
    this.readers.delete(channelId)
    const keys = this.channelRecords.get(channelId)
    if (keys !== undefined) {
      // [S-8] 身份键含 channelId：keys 集合内的 record 全归本通道，逐一释放即可。
      for (const key of keys) {
        this.disposeRecord(key)
      }
      this.channelRecords.delete(channelId)
    }
  }

  /** 全量释放（server destroy 兜底）。 */
  disposeAll(): void {
    for (const channelId of [...this.readers.keys()]) {
      this.disposeChannel(channelId)
    }
    for (const key of [...this.records.keys()]) {
      this.disposeRecord(key)
    }
  }

  /**
   * RPC 路由：流状态查询（session.getSubagentStreamState 的 control 侧数据源）。
   * 跨 session 查询（无匹配）返回 undefined——组合根按缺省形态处理。
   * [S-8] 键含 channelId 后同一 (session, record) 可有多通道镜像（换代重连窗口）；
   * 查询面无 channel 维度，取最近登记的一个（Map 迭代序 = 插入序，新 channel 的
   * 镜像后建 = 当前活跃流；旧 channel 的镜像随其关闭释放）。
   */
  getStreamStateByRecord(sessionId: string, recordId: string): SubagentTeeStreamState | undefined {
    let latest: RecordMirror | undefined
    for (const rec of this.records.values()) {
      if (rec.rootSessionId === sessionId && rec.recordId === recordId) latest = rec
    }
    return latest?.tee.getStreamState()
  }

  /** 在册 record 数（仅测试/诊断消费）。 */
  get recordCount(): number {
    return this.records.size
  }

  // ── 内部（ChannelMirrorReader 调用；模块外不直接调用）────────────────────────

  /** 畸形帧计数告警（每通道首次上报；不升连其它通道）。 */
  noteMalformedFrame(channelId: string, count: number): void {
    if (count === 1) {
      this.warn(
        `[subagent-mirror] malformed mirror frame dropped channelId=${channelId}; ` +
          `seq continuity check will mark the affected record degraded on the next complete frame`,
      )
    }
  }

  /** 已解析帧路由（record 查找/登记 + seq 检查 + 落盘 + live feed）。 */
  routeFrame(channelId: string, rootSessionId: string, frame: RawMirrorWireFrame): void {
    const key = mirrorKey(rootSessionId, frame.recordId, channelId)
    let rec = this.records.get(key)
    if (rec === undefined) {
      rec = {
        rootSessionId,
        recordId: frame.recordId,
        channelId,
        tee: new SubagentTee({ mainSessionId: rootSessionId, recordId: frame.recordId, publish: this.publish }),
        log: this.createLog(frame.recordId),
        lastSeq: undefined,
        degraded: false,
      }
      this.records.set(key, rec)
      let keys = this.channelRecords.get(channelId)
      if (keys === undefined) {
        keys = new Set()
        this.channelRecords.set(channelId, keys)
      }
      keys.add(key)
    }
    const bytes = Buffer.from(frame.b64, 'base64')
    const continuous = isMirrorSeqContinuous(rec.lastSeq, frame.seq)
    const previous = rec.lastSeq
    rec.lastSeq = frame.seq
    // 磁盘镜像先落（降级后同样写——帧字节本身仍是真实证据；write 是 best-effort）。
    try {
      rec.log.write(Buffer.concat([bytes, Buffer.from(NEWLINE, 'utf8')]))
    } catch (err) {
      this.warn(
        `[subagent-mirror] disk mirror write failed recordId=${frame.recordId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!continuous) {
      this.markDegraded(
        rec,
        previous === undefined
          ? `first frame seq mismatch (got ${frame.seq}, writer starts at 0)`
          : `seq discontinuity (got ${frame.seq} after ${previous})`,
        frame.seq,
      )
      return
    }
    if (rec.degraded) return // 停止发布 live entries/chunks（degraded 后 feed 为 no-op）
    rec.tee.feed(Buffer.concat([bytes, Buffer.from(NEWLINE, 'utf8')]))
  }

  private markDegraded(rec: RecordMirror, reason: string, seq: number): void {
    if (rec.degraded) return
    rec.degraded = true
    rec.tee.markDegraded()
    // DC-8：降级即时广播——降级后 tee feed 变 no-op、不再有 chunk，drawer 已打开且无
    // 失步拉取时用户得不到任何信号。payload 与 session.subagentEntriesAppended 同约定
    //（sessionId = 主 session id，recordId 即 subagentId）；消费端写到与拉取响应
    // degraded 字段同一位（拉取快照仍是权威来源）。
    this.publish(rec.rootSessionId, {
      type: 'session.subagentStreamDegraded',
      payload: { sessionId: rec.rootSessionId, recordId: rec.recordId },
    })
    this.warn(
      `[subagent-mirror] degraded rootSessionId=${rec.rootSessionId} recordId=${rec.recordId} `
        + `channelId=${rec.channelId} seq=${seq}: ${reason}; live stream stopped, reload shows full history`,
    )
  }

  private disposeRecord(key: string): void {
    const rec = this.records.get(key)
    if (rec === undefined) return
    rec.tee.dispose()
    try {
      rec.log.end()
    } catch (e) {
      // 磁盘镜像关闭 best-effort：失败只 debug 留痕，不阻塞通道清理
      logger.debug(`[subagent-mirror] disk mirror close failed: ${toErrorMessage(e)}`)
    }
    this.records.delete(key)
  }
}
