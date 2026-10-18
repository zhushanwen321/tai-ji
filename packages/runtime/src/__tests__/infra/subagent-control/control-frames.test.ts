/**
 * control 帧层单测（L1）：形状守卫解析 / 顶层别名合并 / 超长帧头部归因 / 字节计数。
 * 词表与版本单源 = SDK control-protocol.ts（u-foundation），本文件只锁 runtime 侧解析行为。
 */
import { describe, it, expect } from 'vitest'
import {
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  SUBAGENT_CONTROL_FRAME_KINDS,
  byteLengthOf,
  extractOversizeFrameHead,
  parseControlInboundFrame,
} from '../../../infra/subagent-control/frames.js'

const VALID_LAUNCH = {
  engineId: 'fake-engine',
  entryPath: '/tmp/fake-engine.mjs',
  args: [],
  cwd: '/tmp',
  envPrefixes: [],
  rootSessionId: 'sess-1',
}

describe('parseControlInboundFrame', () => {
  it('hello：合法帧解析；id 缺失 / 版本不匹配 / kind 不在词表 → null', () => {
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'hello', id: 'h1', hostPid: 42, hostKind: 'pi' })))
      .toEqual({ v: 1, kind: 'hello', id: 'h1', hostPid: 42, hostKind: 'pi' })
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'hello' }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ v: 2, kind: 'hello', id: 'h1' }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'nope' }))).toBeNull()
    expect(parseControlInboundFrame('not-json')).toBeNull()
    expect(parseControlInboundFrame('42')).toBeNull()
  })

  it('engine_open：launch 权威形态解析；顶层同名字段存在即覆盖（设计帧表写法兼容）', () => {
    const frame = parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'engine_open', id: 3, launch: VALID_LAUNCH }))
    expect(frame).not.toBeNull()
    expect(frame?.kind).toBe('engine_open')
    if (frame?.kind === 'engine_open') {
      expect(frame.launch.engineId).toBe('fake-engine')
      expect(frame.launch.rootSessionId).toBe('sess-1')
      expect(frame.launch.parentRecordId).toBeUndefined()
    }

    const aliased = parseControlInboundFrame(JSON.stringify({
      v: 1, kind: 'engine_open', id: 4,
      launch: { ...VALID_LAUNCH, rootSessionId: 'sess-stale' },
      rootSessionId: 'sess-authoritative',
      parentRecordId: 'rec-parent',
      depth: 2,
      recordId: 'rec-self',
    }))
    if (aliased?.kind === 'engine_open') {
      expect(aliased.launch.rootSessionId).toBe('sess-authoritative')
      expect(aliased.launch.parentRecordId).toBe('rec-parent')
      expect(aliased.launch.depth).toBe(2)
      expect(aliased.launch.recordId).toBe('rec-self')
    } else {
      expect.unreachable('aliased engine_open should parse')
    }
  })

  it('engine_open：launch 形状守卫（engineId/entryPath/cwd/rootSessionId 非空 string、args/envPrefixes 全 string）', () => {
    const base = { v: 1, kind: 'engine_open', id: 1 }
    expect(parseControlInboundFrame(JSON.stringify({ ...base, launch: { ...VALID_LAUNCH, engineId: '' } }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ ...base, launch: { ...VALID_LAUNCH, entryPath: 42 } }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ ...base, launch: { ...VALID_LAUNCH, args: ['ok', 1] } }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ ...base, launch: { ...VALID_LAUNCH, rootSessionId: '' } }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ ...base, launch: 'not-object' }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ ...base }))).toBeNull()
  })

  it('engine_frame / engine_close：channelId+line（或 channelId）形状守卫', () => {
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'engine_frame', channelId: 'ch-1', line: '{}' })))
      .toEqual({ v: 1, kind: 'engine_frame', channelId: 'ch-1', line: '{}' })
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'engine_frame', channelId: '', line: '{}' }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'engine_frame', channelId: 'ch-1' }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'engine_close', channelId: 'ch-1' })))
      .toEqual({ v: 1, kind: 'engine_close', channelId: 'ch-1' })
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'engine_close', channelId: 7 }))).toBeNull()
  })

  it('R→C 方向的 kind 出现在 C→R → null（runtime 不接收自己的应答帧）', () => {
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'hello_ok', id: 1 }))).toBeNull()
    expect(parseControlInboundFrame(JSON.stringify({ v: 1, kind: 'engine_closed', channelId: 'ch-1', code: 0, signal: null, reason: 'engine_exit' }))).toBeNull()
  })
})

describe('extractOversizeFrameHead（D8 前 1KB 归因提取）', () => {
  it('完整 JSON 头提取 kind/channelId', () => {
    const head = extractOversizeFrameHead(JSON.stringify({ v: 1, kind: 'engine_frame', channelId: 'ch-9', line: 'x'.repeat(5000) }))
    expect(head.kind).toBe('engine_frame')
    expect(head.channelId).toBe('ch-9')
  })

  it('截断 JSON（line 载荷截断不可解析）仍能按字段名归因 kind/channelId', () => {
    const truncated = JSON.stringify({ v: 1, kind: 'engine_frame', channelId: 'ch-9', line: 'y'.repeat(5000) }).slice(0, 300)
    const head = extractOversizeFrameHead(truncated)
    // envelope 头部字段在截断窗内：正则提取不受 JSON 截断影响（D8 通道归因的关键）
    expect(head.kind).toBe('engine_frame')
    expect(head.channelId).toBe('ch-9')
  })

  it('channelId 在截断窗之外 → 不归因（关整条连接的保守分支）', () => {
    const lateChannel = JSON.stringify({ v: 1, kind: 'engine_frame', line: 'y'.repeat(2000), channelId: 'ch-late' })
    const head = extractOversizeFrameHead(lateChannel.slice(0, 50))
    expect(head.kind).toBe('engine_frame')
    expect(head.channelId).toBeUndefined()
  })
})

describe('byteLengthOf / 常量锚定', () => {
  it('UTF-8 多字节按字节计（CJK 三字节）', () => {
    expect(byteLengthOf('a')).toBe(1)
    expect(byteLengthOf('太')).toBe(3)
    expect(byteLengthOf('太极'.repeat(4))).toBe(24)
  })

  it('词表/版本与 SDK 单源同值（防手写字面量漂移）', () => {
    expect(SUBAGENT_CONTROL_PROTOCOL_VERSION).toBe(1)
    expect(SUBAGENT_CONTROL_FRAME_KINDS.engineOpen).toBe('engine_open')
    expect(SUBAGENT_CONTROL_FRAME_KINDS.helloReject).toBe('hello_reject')
  })
})
