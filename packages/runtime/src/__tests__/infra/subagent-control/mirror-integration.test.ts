/**
 * raw mirror 读取侧与 control server 的接线集成（u-m3-mirror 验收②/④的真进程形态）：
 * fixture 引擎在 fd3 写 `{v,recordId,seq,b64}` 帧 → server attachChildWiring 的 data
 * 监听 → SubagentMirrorHub → tee 帧发布 / getStreamStateByRecord / degraded / 通道关闭释放。
 *
 * 真 socket 环回 + 真子进程（fixture 从 spawn 的 stdio[3] 写镜像），不触碰真实数据目录
 * （socket/pid/日志均落 mkdtemp 注入目录；logger 未初始化 = 磁盘镜像 no-op）。
 */
import { resolve } from 'node:path'

import type { ServerMessage } from '@taiji/shared'
import { afterEach, describe, expect, it } from 'vitest'

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

const MIRROR_ENGINE_CLI = resolve(process.cwd(), 'src/__tests__/fixtures/mirror-engine-cli.mjs')

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
})

describe('control server × fd3 raw mirror（集成）', () => {
  it('镜帧到达 → tee 帧发布 + getStreamStateByRecord 可查；engine_close → record 释放', { timeout: 20_000 }, async () => {
    const published: Array<{ sid: string; msg: ServerMessage }> = []
    const server = await setupServer({ publish: (sid: string, msg: ServerMessage) => published.push({ sid, msg }) })

    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(await agent.open(launchSpec({ entryPath: MIRROR_ENGINE_CLI, args: [RECORD_ID] }), 'mirror-open'))

    // 状态查询：fixture 的 message_start + text_delta（in-flight）
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

    // 通道关闭：fixture 准出 → engine_closed → 镜像 record 释放（查询 undefined）
    agent.sendFrame(channelId, '__exit__')
    agent.send({ v: 1, kind: 'engine_close', channelId })
    await agent.waitForFrame((f) => f.kind === 'engine_closed', 'engine_closed')
    await waitFor(
      () => server.getStreamStateByRecord(ROOT_SID, RECORD_ID) === undefined,
      'mirror record released on channel close',
    )
    expect(server.getChannelForTest(channelId)).toBeUndefined()
    agent.destroy()
  })

  it('seq 空洞（写侧丢弃）→ degraded:true 且无 live chunk 发布；不中断该连接其它通道', { timeout: 20_000 }, async () => {
    const published: Array<{ sid: string; msg: ServerMessage }> = []
    const server = await setupServer({ publish: (sid: string, msg: ServerMessage) => published.push({ sid, msg }) })

    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()

    // 通道 A：gap fixture（seq 0/2）→ degraded
    const a = expectOpened(await agent.open(launchSpec({ entryPath: MIRROR_ENGINE_CLI, args: [RECORD_ID, '--gap'] }), 'gap-open'))
    await waitFor(
      () => server.getStreamStateByRecord(ROOT_SID, RECORD_ID)?.degraded === true,
      'gap record degraded',
    )
    expect(server.getStreamStateByRecord(ROOT_SID, RECORD_ID)).toMatchObject({ degraded: true })
    // 空洞帧未进 live 发布面（写侧丢弃的 record 无完整 live 流）
    expect(published.some((p) => p.msg.type === 'subagent.stream_chunk')).toBe(false)

    // 通道 B：正常 fixture（同连接，另一 record）不受通道 A 降级影响
    const b = expectOpened(await agent.open(launchSpec({ entryPath: MIRROR_ENGINE_CLI, args: ['rec-integration-mirror-b'] }), 'ok-open'))
    await waitFor(
      () => server.getStreamStateByRecord(ROOT_SID, 'rec-integration-mirror-b')?.found === true,
      'channel B stream state',
    )
    expect(server.getStreamStateByRecord(ROOT_SID, 'rec-integration-mirror-b')).toMatchObject({ found: true })
    expect(published.some((p) => p.msg.type === 'subagent.stream_chunk')).toBe(true)

    // 收尾：两通道各自准出（engine_close grace 有界）
    for (const ch of [a.channelId, b.channelId]) {
      agent.sendFrame(ch, '__exit__')
      agent.send({ v: 1, kind: 'engine_close', channelId: ch })
    }
    await agent.waitForFrame((f) => f.kind === 'engine_closed', 'engine_closed')
    agent.destroy()
  })
})
