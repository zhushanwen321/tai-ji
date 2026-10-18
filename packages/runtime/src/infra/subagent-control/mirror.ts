/**
 * subagent raw mirror 读取侧（M3 relay-spawn-transport §3.3 D6 / §3.4.4）。
 *
 * 引擎进程 stdout 的原始字节经 fd3 pipe 以 NDJSON 帧 `{v, recordId, seq, b64}` 到达
 * （引擎侧 writer = pi-subagent-cli/src/raw-mirror.ts）。本模块把镜像帧还原为字节行，
 * 按 `(rootSessionId, recordId)` 找/建 SubagentTee（首个 mirror 帧登记；engine_closed /
 * control close → dispose 该通道全部 record），并同步落盘磁盘镜像
 * `pi-subagent-<date>-<recordId>.jsonl`。
 *
 * seq 连续性检查（D6）：写侧「丢弃也递增」且每个 record 从 0 起——读取侧要求首帧
 * `seq === 0`、其后严格 `last+1`；任一不满足即判定该 record 的 live 派生视图出现空洞，
 * `markDegraded()` 停止发布 live entries/chunks 并让状态查询带 `degraded: true`（显式
 * 标注，不静默）。磁盘镜像与 reload 腿不受影响：tee 只是可由权威数据（pi session 文件
 * + journal）重建的派生视图。
 *
 * 帧解析容错：畸形行（非 JSON/字段缺失）丢弃 + 计数，不抛出不升连——单个坏帧不影响
 * 其他 record/channel；attributable 的空洞语义仍由 seq 检查承担（坏帧同样消耗写侧 seq，
 * 其后的首个完整帧自然触发 degraded）。
 *
 * 隔离边界：本模块不做 WS 帧内容翻译（SubagentTee 负责）；control server 只在
 * attachChildWiring 接线字节流、finalizeClosed 调 disposeChannel。
 */
import type { ServerMessage } from '@taiji/shared'

import { createPiSubagentLog } from '../logger.js'
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
  /** 降级/畸形帧告警出口（缺省 console.warn；测试注入）。 */
  warn?: (message: string) => void
}

/** 单 record 的镜像状态（tee + 磁盘日志 + seq 水位；数据形状用 type 别名）。 */
type RecordMirror = {
  rootSessionId: string
  recordId: string
  channelId: string
  tee: SubagentTee
  log: MirrorLogSink
  /** 已处理帧的最大 seq（首个帧登记；其后必须 +1 连续）。 */
  lastSeq: number | undefined
  degraded: boolean
}

/**
 * seq 连续性判定（纯函数，单测直构）：写侧每个 record 从 0 起、丢弃也递增，因此首帧
 * 必为 seq 0（首帧被写侧丢弃时，读取侧首个到达帧 seq>0 = 空洞，必须显式降级）；
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

function mirrorKey(rootSessionId: string, recordId: string): string {
  return `${rootSessionId}\u0000${recordId}`
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
    this.warn = opts.warn ?? ((message) => console.warn(message))
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
      for (const key of keys) {
        this.disposeRecord(key, channelId)
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
   * 跨 session 查询（key 不匹配）返回 undefined——组合根按缺省形态处理。
   */
  getStreamStateByRecord(sessionId: string, recordId: string): SubagentTeeStreamState | undefined {
    return this.records.get(mirrorKey(sessionId, recordId))?.tee.getStreamState()
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
    const key = mirrorKey(rootSessionId, frame.recordId)
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
    this.warn(
      `[subagent-mirror] degraded rootSessionId=${rec.rootSessionId} recordId=${rec.recordId} `
        + `channelId=${rec.channelId} seq=${seq}: ${reason}; live stream stopped, reload shows full history`,
    )
  }

  private disposeRecord(key: string, ownerChannelId?: string): void {
    const rec = this.records.get(key)
    if (rec === undefined) return
    if (ownerChannelId !== undefined && rec.channelId !== ownerChannelId) return
    rec.tee.dispose()
    try {
      rec.log.end()
    } catch (e) {
      // 磁盘镜像关闭 best-effort：失败只 debug 留痕，不阻塞通道清理
      console.debug('[subagent-mirror] disk mirror close failed:', e)
    }
    this.records.delete(key)
  }
}
