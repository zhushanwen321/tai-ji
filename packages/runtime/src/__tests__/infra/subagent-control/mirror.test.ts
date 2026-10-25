/**
 * subagent raw mirror 读取侧单测（u-m3-mirror 验收②：seq 连续/空洞→degraded/帧解析
 * 容错/不中断其它 channel；验收④：degraded 在状态查询与日志可见）。
 *
 * 被测对象 = SubagentMirrorHub（infra/subagent-control/mirror.ts）+ SubagentTee
 * （degraded 直构面）。帧由 test 侧按引擎 writer 的同款形态手工编码（去真实 fd3）；
 * 磁盘镜像用注入 sink 断言字节与 end 生命周期，另有 logger 初始化形态的真 fs 用例
 * 锚定 `pi-subagent-<date>-<recordId>.jsonl` 命名。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ServerMessage } from '@taiji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SubagentMirrorHub,
  isMirrorSeqContinuous,
  parseRawMirrorLine,
} from '../../../infra/subagent-control/mirror.js'
import { SubagentTee } from '../../../infra/subagent-control/subagent-tee.js'

const MAIN_SID = 'sess-mirror-main'
const REC = 'rec-mirror-1'

type Published = { sid: string; msg: ServerMessage }

type LogSpy = { chunks: Buffer[]; ended: number }

function encodeFrame(recordId: string, seq: number, line: string): string {
  return `${JSON.stringify({ v: 1, recordId, seq, b64: Buffer.from(line, 'utf8').toString('base64') })}\n`
}

function piLine(event: Record<string, unknown>): string {
  // 帧载荷 = 行内容（不含 \n；引擎 writer 按行切分、读取侧重建行界）
  return JSON.stringify(event)
}

function makeHub(overrides: Partial<ConstructorParameters<typeof SubagentMirrorHub>[0]> = {}): {
  hub: SubagentMirrorHub
  published: Published[]
  warnings: string[]
  logs: Map<string, LogSpy>
} {
  const published: Published[] = []
  const warnings: string[] = []
  const logs = new Map<string, LogSpy>()
  const hub = new SubagentMirrorHub({
    publish: (sid, msg) => published.push({ sid, msg }),
    createLog: (recordId) => {
      const spy: LogSpy = { chunks: [], ended: 0 }
      logs.set(recordId, spy)
      return {
        write: (bytes) => spy.chunks.push(Buffer.from(bytes)),
        end: () => {
          spy.ended += 1
        },
      }
    },
    warn: (message) => warnings.push(message),
    ...overrides,
  })
  return { hub, published, warnings, logs }
}

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  vi.resetModules()
})

describe('mirror 帧解析与 seq 判定（纯函数）', () => {
  it('parseRawMirrorLine：合法帧取 recordId/seq/b64；v 容错；畸形形状一律 null', () => {
    expect(parseRawMirrorLine(JSON.stringify({ v: 1, recordId: 'r', seq: 0, b64: 'YQ==' }))).toEqual({
      recordId: 'r',
      seq: 0,
      b64: 'YQ==',
    })
    expect(parseRawMirrorLine(JSON.stringify({ recordId: 'r', seq: 3, b64: '' }))).toEqual({
      recordId: 'r',
      seq: 3,
      b64: '',
    })
    expect(parseRawMirrorLine('not json')).toBeNull()
    expect(parseRawMirrorLine('[]')).toBeNull()
    expect(parseRawMirrorLine(JSON.stringify({ recordId: '', seq: 0, b64: 'x' }))).toBeNull()
    expect(parseRawMirrorLine(JSON.stringify({ recordId: 'r', seq: -1, b64: 'x' }))).toBeNull()
    expect(parseRawMirrorLine(JSON.stringify({ recordId: 'r', seq: 1.5, b64: 'x' }))).toBeNull()
    expect(parseRawMirrorLine(JSON.stringify({ recordId: 'r', seq: '0', b64: 'x' }))).toBeNull()
    expect(parseRawMirrorLine(JSON.stringify({ recordId: 'r', seq: 0 }))).toBeNull()
  })

  it('isMirrorSeqContinuous：首帧必须 seq=0（写侧从 0 起）；其后必须 +1（跳号/回退/重复均 false）', () => {
    expect(isMirrorSeqContinuous(undefined, 0)).toBe(true)
    expect(isMirrorSeqContinuous(undefined, 1)).toBe(false)
    expect(isMirrorSeqContinuous(undefined, 7)).toBe(false)
    expect(isMirrorSeqContinuous(0, 1)).toBe(true)
    expect(isMirrorSeqContinuous(0, 2)).toBe(false)
    expect(isMirrorSeqContinuous(5, 5)).toBe(false)
    expect(isMirrorSeqContinuous(5, 4)).toBe(false)
  })
})

describe('SubagentMirrorHub：连续帧 → tee 发布 + 状态查询', () => {
  it('连续帧产出 entry/chunk 帧；getStreamStateByRecord 可查（含 found:true 中间态）；跨 session 查询 undefined', () => {
    const { hub, published, logs } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)

    const start = piLine({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } })
    const delta = piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } })
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 0, start), 'utf8'))
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 1, delta), 'utf8'))

    // 状态查询：in-flight 三元组可见 + 跨 session 不命中
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toEqual({
      found: true,
      msgSeq: 1,
      lastDeltaSeq: 0,
      lines: ['你好'],
    })
    expect(hub.getStreamStateByRecord('sess-other', REC)).toBeUndefined()
    expect(hub.getStreamStateByRecord(MAIN_SID, 'rec-other')).toBeUndefined()

    // chunk 帧已发布（虚拟分区归属 + bus 主 sid）；entry 帧随 message_end 到达
    const chunks = published.filter((p) => p.msg.type === 'subagent.stream_chunk')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].sid).toBe(MAIN_SID)

    const end = piLine({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } })
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 2, end), 'utf8'))
    const entries = published.filter((p) => p.msg.type === 'session.subagentEntriesAppended')
    expect(entries).toHaveLength(1)
    expect(entries[0].sid).toBe(MAIN_SID)
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })

    // 磁盘镜像：逐帧原始字节 + 重建行界（无丢帧路径全量落盘）
    expect(logs.get(REC)?.chunks.map((b) => b.toString('utf8'))).toEqual([`${start}\n`, `${delta}\n`, `${end}\n`])
  })

  it('帧字节跨 ingest 边界（B64 行中间劈开）不丢不坏', () => {
    const { hub, published } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    const frames =
      encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })) +
      encodeFrame(REC, 1, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '跨边界' } }))
    const bytes = Buffer.from(frames, 'utf8')
    for (let i = 0; i < bytes.length; i += 13) {
      hub.ingestBytes('ch-1', bytes.subarray(i, Math.min(i + 13, bytes.length)))
    }
    expect(published.filter((p) => p.msg.type === 'subagent.stream_chunk')).toHaveLength(1)
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toMatchObject({ found: true, lines: ['跨边界'] })
  })
})

describe('SubagentMirrorHub：seq 空洞 → degraded（显式标注，不静默）', () => {
  it('空洞帧不发布 live、置 degraded:true、磁盘镜像仍写；其它 channel/record 不受影响', () => {
    const { hub, published, warnings, logs } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    hub.openChannel('ch-2', 'sess-mirror-other')

    // ch-1：seq 0/1 连续发布，随后跳号到 seq 3（写侧丢弃 seq 2）
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 1, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '前' } })), 'utf8'))
    const beforeGap = published.length
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 3, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '洞后' } })), 'utf8'))

    // 停止发布 live 帧：空洞帧与之后帧都不产 entry/chunk（DC-8 降级广播是唯一新增帧）
    expect(published.filter((p) => p.msg.type !== 'session.subagentStreamDegraded')).toHaveLength(beforeGap)
    expect(published.filter((p) => p.msg.type === 'session.subagentStreamDegraded')).toHaveLength(1)
    const state = hub.getStreamStateByRecord(MAIN_SID, REC)
    expect(state).toEqual({ found: true, msgSeq: 1, lastDeltaSeq: 0, lines: ['前'], degraded: true })
    expect(warnings.some((w) => w.includes('[subagent-mirror] degraded') && w.includes(REC))).toBe(true)
    // 磁盘镜像是证据面：空洞帧照写（逐帧字节不丢）
    expect(logs.get(REC)?.chunks.map((b) => b.toString('utf8'))).toHaveLength(3)

    // 另一 channel/record 的连续帧不受影响（隔离边界；其 live chunk 照发）
    hub.ingestBytes('ch-2', Buffer.from(encodeFrame('rec-other', 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))
    hub.ingestBytes('ch-2', Buffer.from(encodeFrame('rec-other', 1, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正常' } })), 'utf8'))
    expect(published.filter((p) => p.msg.type === 'subagent.stream_chunk')).toHaveLength(beforeGap + 1)
    expect(hub.getStreamStateByRecord('sess-mirror-other', 'rec-other')).toEqual({
      found: true,
      msgSeq: 1,
      lastDeltaSeq: 0,
      lines: ['正常'],
    })
  })

  it('首帧 seq>0（写侧首帧被丢弃）→ 立即 degraded，live 不发布但磁盘镜像照写', () => {
    const { hub, published, warnings, logs } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    const line = piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 1, line), 'utf8'))

    // live 帧不发布（start 本身不产帧）；唯一发布 = DC-8 降级广播
    expect(published.filter((p) => p.msg.type !== 'session.subagentStreamDegraded')).toHaveLength(0)
    expect(published.filter((p) => p.msg.type === 'session.subagentStreamDegraded')).toHaveLength(1)
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toEqual({
      found: false,
      msgSeq: 0,
      lastDeltaSeq: 0,
      lines: [],
      degraded: true,
    })
    expect(warnings.some((w) => w.includes('first frame seq mismatch') && w.includes(REC))).toBe(true)
    // 证据面不受降级影响：首达帧仍落盘
    expect(logs.get(REC)?.chunks.map((b) => b.toString('utf8'))).toEqual([`${line}\n`])
  })

  it('DC-8：markDegraded 发布 session.subagentStreamDegraded 广播（payload = 主 sid + recordId）恰一次（幂等）', () => {
    const { hub, published } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))

    // 空洞帧（跳过 seq 1）触发 markDegraded → 广播恰一条（sid = bus 路由键 = 主 sid）
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 2, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })), 'utf8'))
    const degradedFrames = published.filter((p) => p.msg.type === 'session.subagentStreamDegraded')
    expect(degradedFrames).toHaveLength(1)
    expect(degradedFrames[0].sid).toBe(MAIN_SID)
    expect(degradedFrames[0].msg.payload).toEqual({ sessionId: MAIN_SID, recordId: REC })

    // 幂等：降级后到达的后续帧不重发（markDegraded 早退，rec.degraded 已置）
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 3, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'y' } })), 'utf8'))
    expect(published.filter((p) => p.msg.type === 'session.subagentStreamDegraded')).toHaveLength(1)
  })

  it('畸形帧丢弃 + 计数告警（不抛出、不升连）；其后的 seq 断档按自然归因触发 degraded', () => {
    const { hub, published, warnings } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))
    expect(() => hub.ingestBytes('ch-1', Buffer.from('{broken json\n', 'utf8'))).not.toThrow()
    expect(warnings.some((w) => w.includes('malformed mirror frame dropped'))).toBe(true)
    // 畸形帧在写侧同样消耗 seq（写侧丢弃也递增）→ 下一完整帧 seq 应为 2，对比 lastSeq 0 判空洞
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 2, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })), 'utf8'))
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toMatchObject({ degraded: true })
    // 空洞帧不发布：仅 message_start 无 live 帧（start 本身不产帧），chunk 帧数 0
    expect(published.filter((p) => p.msg.type === 'subagent.stream_chunk')).toHaveLength(0)
  })

  it('degraded 后 satisfy：后续帧不再重建 record tee 输出（state 保持降级标注）', () => {
    const { hub } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 2, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })), 'utf8'))
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 3, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'y' } })), 'utf8'))
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toMatchObject({ degraded: true, lines: [''] })
  })
})

describe('SubagentMirrorHub：通道生命周期', () => {
  it('openChannel 幂等；disposeChannel 释放 record（查询 undefined）且 end 磁盘镜像', () => {
    const { hub, published, logs } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    hub.openChannel('ch-1', MAIN_SID) // 幂等：不产生第二个行泵（重复帧不双发）
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 1, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'once' } })), 'utf8'))
    expect(published.filter((p) => p.msg.type === 'subagent.stream_chunk')).toHaveLength(1)

    hub.disposeChannel('ch-1')
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toBeUndefined()
    expect(hub.recordCount).toBe(0)
    expect(logs.get(REC)?.ended).toBe(1)
    // dispose 后再来帧（迟到数据）无通道可路由 → no-op，不重建 record
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 2, piLine({ type: 'message_end', message: { role: 'assistant', content: [] } })), 'utf8'))
    expect(hub.recordCount).toBe(0)
  })

  it('[S-8] 同 record 跨通道（同 rootSessionId）：各通道独立镜像（seq 各自从 0 连续）、查询取最新、dispose 只释放本通道', () => {
    const { hub, warnings } = makeHub()
    hub.openChannel('ch-1', MAIN_SID)
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))
    hub.ingestBytes('ch-1', Buffer.from(encodeFrame(REC, 1, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'from-ch1' } })), 'utf8'))
    // 换代重连形态：ch-2 是新引擎进程，同一 record 的写侧计数器重新从 0 起——
    // 身份键含 channelId 时这是两个独立镜像（不混串、不误降级）。
    hub.openChannel('ch-2', MAIN_SID)
    hub.ingestBytes('ch-2', Buffer.from(encodeFrame(REC, 0, piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })), 'utf8'))
    hub.ingestBytes('ch-2', Buffer.from(encodeFrame(REC, 1, piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'from-ch2' } })), 'utf8'))
    expect(warnings).toEqual([]) // 无 seq 断裂告警（两路各自连续）
    expect(hub.recordCount).toBe(2)
    // 查询面无 channel 维度：取最近登记（ch-2 = 当前活跃流）
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toMatchObject({ lines: ['from-ch2'] })

    hub.disposeChannel('ch-2')
    expect(hub.recordCount).toBe(1)
    // ch-1 的镜像不因 ch-2 关闭被释放，也不延后（随本通道关闭即释放）
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toMatchObject({ lines: ['from-ch1'] })
    hub.disposeChannel('ch-1')
    expect(hub.getStreamStateByRecord(MAIN_SID, REC)).toBeUndefined()
    expect(hub.recordCount).toBe(0)
  })
})

describe('SubagentTee degraded（直构）', () => {
  it('markDegraded → 停止发布 + 状态带 degraded:true；dispose 后标注保留；幂等', () => {
    const published: Published[] = []
    const tee = new SubagentTee({ mainSessionId: MAIN_SID, recordId: REC, publish: (sid, msg) => published.push({ sid, msg }) })
    tee.feed(Buffer.from(`${piLine({ type: 'message_start', message: { role: 'assistant', content: [] } })}\n${piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } })}\n`, 'utf8'))
    expect(published).toHaveLength(1)

    tee.markDegraded()
    expect(tee.degraded).toBe(true)
    const afterDegrade = published.length
    tee.feed(Buffer.from(`${piLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } })}\n`, 'utf8'))
    expect(published.length).toBe(afterDegrade)
    expect(tee.getStreamState()).toEqual({ found: true, msgSeq: 1, lastDeltaSeq: 0, lines: ['a'], degraded: true })

    tee.dispose()
    expect(tee.getStreamState()).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [], degraded: true })
  })
})

describe('磁盘镜像命名（logger 初始化形态）', () => {
  it('写入 <dataDir>/logs/pi-subagent-<date>-<recordId>.jsonl（原始行 + 行界）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-log-'))
    tmpDirs.push(dir)
    vi.resetModules()
    const loggerMod = await import('../../../infra/logger.js')
    loggerMod.initLogger(dir)
    try {
      const { SubagentMirrorHub: FreshHub } = await import('../../../infra/subagent-control/mirror.js')
      const hub = new FreshHub()
      hub.openChannel('ch-log', MAIN_SID)
      // 帧载荷 = 行内容（不含行界；行界由读取侧重建）——与引擎 writer 的切分语义一致
      const line = JSON.stringify({ type: 'turn_start' })
      hub.ingestBytes('ch-log', Buffer.from(encodeFrame(REC, 0, line), 'utf8'))
      hub.disposeChannel('ch-log')

      // 写流异步落盘：轮询等待内容就绪（与 logger 单测同款）。
      const logsDir = join(dir, 'logs')
      let files: string[] = []
      let content = ''
      const deadline = Date.now() + 5000
      for (;;) {
        files = readdirSync(logsDir).filter((f) => f.startsWith('pi-subagent-'))
        if (files.length === 1) {
          content = readFileSync(join(logsDir, files[0]), 'utf8')
          if (content === `${line}\n`) break
        }
        if (Date.now() > deadline) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(new RegExp(`^pi-subagent-\\d{4}-\\d{2}-\\d{2}-${REC}\\.jsonl$`))
      expect(content).toBe(`${line}\n`)
    } finally {
      await loggerMod.closeLogger()
    }
  })
})
