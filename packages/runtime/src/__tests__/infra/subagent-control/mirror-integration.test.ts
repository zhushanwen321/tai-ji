/**
 * raw mirror 读取侧与 control server 的接线（u-m3-mirror 验收②/④的进程内形态）：
 * 引擎桩在 fd3 写 `{v,recordId,seq,b64}` 帧 → server attachChildWiring 的 data 监听 →
 * SubagentMirrorHub → tee 帧发布 / getStreamStateByRecord / degraded / 通道关闭释放。
 *
 * 分层（判据三档，docs/todo/test-single-layer-cleanup.md）：引擎进程换进程内桩
 * （fake-engine.ts，spawn 注入；fd3 由桩的 stdio[3] 提供），镜像帧的到达/释放全部经
 * 状态查询与 publish 回执收尾——第 ② 档「异步但有确定性完成信号」，零真 spawn、
 * 零墙钟窗口。真引擎经 fd3 写镜像的跨进程形态不属本层（第 ③ 档）。
 *
 * 不触碰真实数据目录（socket/pid/日志均落 mkdtemp 注入目录；logger 未初始化 = 磁盘镜像 no-op）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ServerMessage } from '@taiji/shared'
import { SubagentControlServer } from '../../../infra/subagent-control/control-server.js'
import {
  TestAgent,
  expectOpened,
  launchSpec,
  makeServer,
  makeTmpDir,
  rmTmpDir,
  waitFor,
} from './test-helpers.js'
import { lastFakeEngine, resetFakeEngines, type FakeEngineChild } from './fake-engine.js'

/** spawn 闸门（hoisted：vi.mock factory 与用例都要读写同一对象）。 */
const spawnGate = vi.hoisted(() => ({ real: false }))

// 引擎进程换进程内桩：fd3 由桩的 stdio[3] 提供（真 spawn 恒开 4 个 pipe，同构）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { fakeSpawn } = await import('./fake-engine.js')
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options?: unknown) =>
      spawnGate.real
        ? actual.spawn(command, args, options as never)
        : fakeSpawn(command, args, options),
  }
})

const ROOT_SID = 'sess-root-1'
const RECORD_ID = 'rec-integration-mirror'

const tmpDirs: string[] = []
const servers: SubagentControlServer[] = []

async function setupServer(overrides: Record<string, unknown> = {}): Promise<SubagentControlServer> {
  const dataDir = await makeTmpDir()
  tmpDirs.push(dataDir)
  const server = makeServer(dataDir, { closeGraceMs: 200, ...overrides })
  servers.push(server)
  await server.init()
  return server
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.destroy()
  }
  await Promise.all(tmpDirs.splice(0).map((d) => rmTmpDir(d)))
  resetFakeEngines()
})

/** 一条镜像 wire 帧（引擎侧 raw-mirror writer 的对偶形状）。 */
function mirrorFrame(recordId: string, seq: number, line: string): Record<string, unknown> {
  return { v: 1, recordId, seq, b64: Buffer.from(line, 'utf8').toString('base64') }
}

/** fixture 的两帧剧本：message_start + text_delta（保持 assistant 流 in-flight）。 */
function fixtureFrames(recordId: string, gap: boolean): Array<Record<string, unknown>> {
  return [
    mirrorFrame(recordId, 0, JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } })),
    mirrorFrame(recordId, gap ? 2 : 1, JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '镜像内容' } })),
  ]
}

/**
 * 打开一个镜像引擎通道并按剧本驱动 fd3 帧。
 *
 * spawn 发生在 resolveLaunch 之后（异步链），故先等桩就位再发帧——镜帧到达后
 * `getStreamStateByRecord` 的 found/degraded 就是确定性完成信号。
 */
async function openMirrorChannel(
  agent: TestAgent,
  frames: Array<Record<string, unknown>>,
  openId: string,
): Promise<{ channelId: string; engine: FakeEngineChild }> {
  const { channelId } = expectOpened(await agent.open(launchSpec({ engineId: 'fake-engine', args: [] }), openId))
  await waitFor(() => fakeEngineReady(), 'engine stub spawned')
  const engine = lastFakeEngine()
  for (const frame of frames) engine.emitMirrorLine(frame)
  return { channelId, engine }
}

/** 桩是否已创建（open 与 spawn 之间有 resolveLaunch 异步链）。 */
function fakeEngineReady(): boolean {
  try {
    lastFakeEngine()
    return true
  } catch {
    return false
  }
}

describe('control server × fd3 raw mirror（进程内桩）', () => {
  it('镜帧到达 → tee 帧发布 + getStreamStateByRecord 可查；engine_close → record 释放', async () => {
    const published: Array<{ sid: string; msg: ServerMessage }> = []
    const server = await setupServer({ publish: (sid: string, msg: ServerMessage) => published.push({ sid, msg }) })

    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, engine } = await openMirrorChannel(agent, fixtureFrames(RECORD_ID, false), 'mirror-open')

    // 状态查询：message_start + text_delta（in-flight）
    await waitFor(
      () => server.getStreamStateByRecord(ROOT_SID, RECORD_ID)?.found === true,
      'mirror stream state found',
    )
    expect(server.getStreamStateByRecord(ROOT_SID, RECORD_ID)).toMatchObject({
      found: true,
      msgSeq: 1,
      lastDeltaSeq: 0,
      lines: ['镜像内容'],
    })
    // live WS 帧（chunk）经 publish 出口到达；跨 session 查询不命中
    expect(published.some((p) => p.msg.type === 'subagent.stream_chunk' && p.sid === ROOT_SID)).toBe(true)
    expect(server.getStreamStateByRecord('sess-other', RECORD_ID)).toBeUndefined()

    // 通道关闭：引擎准出 → engine_closed → 镜像 record 释放（查询 undefined）
    engine.exitWith(0)
    await agent.waitForFrame((f) => f.kind === 'engine_closed', 'engine_closed')
    await waitFor(
      () => server.getStreamStateByRecord(ROOT_SID, RECORD_ID) === undefined,
      'mirror record released on channel close',
    )
    expect(server.getChannelForTest(channelId)).toBeUndefined()
    agent.destroy()
  })

  it('seq 空洞（写侧丢弃）→ degraded:true 且无 live chunk 发布；不中断该连接其它通道', async () => {
    const published: Array<{ sid: string; msg: ServerMessage }> = []
    const server = await setupServer({ publish: (sid: string, msg: ServerMessage) => published.push({ sid, msg }) })

    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()

    // 通道 A：gap 剧本（seq 0/2）→ degraded
    const a = await openMirrorChannel(agent, fixtureFrames(RECORD_ID, true), 'gap-open')
    await waitFor(
      () => server.getStreamStateByRecord(ROOT_SID, RECORD_ID)?.degraded === true,
      'gap record degraded',
    )
    expect(server.getStreamStateByRecord(ROOT_SID, RECORD_ID)).toMatchObject({ degraded: true })
    // 空洞帧未进 live 发布面（写侧丢弃的 record 无完整 live 流）
    expect(published.some((p) => p.msg.type === 'subagent.stream_chunk')).toBe(false)

    // 通道 B：正常剧本（同连接，另一 record）不受通道 A 降级影响
    const b = await openMirrorChannel(agent, fixtureFrames('rec-integration-mirror-b', false), 'ok-open')
    await waitFor(
      () => server.getStreamStateByRecord(ROOT_SID, 'rec-integration-mirror-b')?.found === true,
      'channel B stream state',
    )
    expect(server.getStreamStateByRecord(ROOT_SID, 'rec-integration-mirror-b')).toMatchObject({ found: true })
    expect(published.some((p) => p.msg.type === 'subagent.stream_chunk')).toBe(true)

    // 收尾：两通道各自准出（engine_close grace 有界）
    for (const channel of [a, b]) {
      channel.engine.exitWith(0)
      agent.send({ v: 1, kind: 'engine_close', channelId: channel.channelId })
    }
    await agent.waitForFrame((f) => f.kind === 'engine_closed', 'engine_closed')
    agent.destroy()
  })
})
