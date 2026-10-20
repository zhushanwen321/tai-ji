/**
 * channel 树登记 + 递归收割单测（L2，验收 ②，设计 §3.3 D4 嵌套子代理）：嵌套通道以
 * parentRecordId 挂父通道 recordId 建树；父通道终止（exit / engine_close / 断连）→
 * 递归杀子通道引擎组（跨连接生效——嵌套 task pi 与父引擎不在同一条 control 连接）。
 * 结构性兜底与登记面正交：recordId 缺省通道无树挂点，收割由进程组 + 连接 fan-out 保证。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { SUBAGENT_CONTROL_FRAME_KINDS, SUBAGENT_CONTROL_CLOSED_REASONS } from '@zhushanwen/subagent-engine-sdk'
import { isPidAlive } from '../../../utils/protocol-background-task.js'
import { SubagentControlServer, type ControlServerOptions } from '../../../infra/subagent-control/control-server.js'
import { TestAgent, cleanupTestServers, launchSpec, setupServer, waitFor } from './test-helpers.js'

afterEach(async () => {
  await cleanupTestServers()
})

/** 树用例前导：起 server + 连 agent（hello 由 openHangEngine 按连接 id 自带，不走默认 h1）。 */
async function connectTreeAgent(overrides: ControlServerOptions = {}): Promise<{ server: SubagentControlServer; agent: TestAgent }> {
  const { server } = await setupServer(overrides)
  const agent = new TestAgent(server.listeningSocketPath)
  await agent.opened
  return { server, agent }
}

/** 关闭引擎并等其 engine_closed 帧（bye-now 走真实退出路径，不等默认宽限；label = 超时归因）。 */
async function closeEngineAndWait(agent: TestAgent, channelId: string, label: string): Promise<Record<string, unknown>> {
  agent.sendFrame(channelId, 'bye-now')
  agent.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId })
  return agent.waitForFrame(
    (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === channelId,
    label,
  )
}

async function openHangEngine(server: SubagentControlServer, agent: TestAgent, launch: Record<string, unknown>, id: string | number): Promise<{ channelId: string; pid: number }> {
  agent.hello(`h-${String(id)}`)
  // --exit-on bye-now：engine_close 前发 dispose 帧（bye-now）即退 —— 走「窗口内真实退出」
  // 路径（engine_closed reason engine_exit → finalize → 树杀），不被 3s 默认宽限拖慢
  const opened = await agent.open(launchSpec({ args: ['--exit-on', 'bye-now'], ...launch }), id)
  if (opened.channelId === undefined || opened.pid === undefined) {
    throw new Error(`engine_open failed: ${JSON.stringify(opened.failed)}`)
  }
  return { channelId: opened.channelId, pid: opened.pid }
}

describe('channel 树：登记 + 递归收割', () => {
  it('同连接树杀：A（recordId rec-A）终止 → 子通道 B（parentRecordId rec-A）组杀（killed_by_control）', { timeout: 30_000 }, async () => {
    const { server, agent } = await connectTreeAgent()
    const a = await openHangEngine(server, agent, { engineId: 'engine-a', recordId: 'rec-A' }, 1)
    const b = await openHangEngine(server, agent, { engineId: 'engine-b', parentRecordId: 'rec-A', depth: 1 }, 2)
    expect(isPidAlive(a.pid)).toBe(true)
    expect(isPidAlive(b.pid)).toBe(true)
    expect(server.getChannelForTest(a.channelId)?.recordId).toBe('rec-A')
    expect(server.getChannelForTest(b.channelId)?.parentRecordId).toBe('rec-A')

    // 父通道 engine_close（有界等待注入足够长，走真实退出路径：fixture 见 exit 命令即退）
    await closeEngineAndWait(agent, a.channelId, 'A engine_closed')
    await waitFor(() => !isPidAlive(a.pid), 'A engine reaped')
    // 递归树杀：B 的引擎组被连带收割
    await waitFor(() => !isPidAlive(b.pid), 'B engine reaped by tree kill')
    const bClosed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === b.channelId,
      'B engine_closed',
    )
    expect(bClosed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
  })

  it('跨连接树杀：嵌套通道在独立连接（同 rootSessionId）→ 父连接断开 fan-out 连带孙代', { timeout: 30_000 }, async () => {
    const { server } = await setupServer({ closeGraceMs: 10_000 })
    // 连接 1 = 顶层扩展（父通道 A，recordId rec-A）
    const topAgent = new TestAgent(server.listeningSocketPath)
    await topAgent.opened
    const a = await openHangEngine(server, topAgent, { engineId: 'engine-a', recordId: 'rec-A' }, 1)
    // 连接 2 = 嵌套 task pi 的扩展（B：parentRecordId rec-A，挂 A 的树）
    const nestedAgent = new TestAgent(server.listeningSocketPath)
    await nestedAgent.opened
    const b = await openHangEngine(server, nestedAgent, {
      engineId: 'engine-b',
      rootSessionId: 'sess-root-1',
      parentRecordId: 'rec-A',
      depth: 1,
    }, 1)
    expect(isPidAlive(b.pid)).toBe(true)

    // 顶层连接断开（主 pi 死亡形态）：A 组杀 → 树杀 B（跨连接）
    topAgent.destroy()
    await waitFor(() => !isPidAlive(a.pid), 'A reaped on disconnect')
    await waitFor(() => !isPidAlive(b.pid), 'B reaped by cross-connection tree kill')
    // 嵌套连接还活着（连接本身无恙），B 的终局帧送达该连接
    const bClosed = await nestedAgent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'B engine_closed')
    expect(bClosed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
  })

  it('树杀传递：A → B → C 链上祖父终止收割全部后代（BFS 传递）', { timeout: 30_000 }, async () => {
    const { server, agent } = await connectTreeAgent()
    const a = await openHangEngine(server, agent, { engineId: 'engine-a', recordId: 'rec-A' }, 1)
    const b = await openHangEngine(server, agent, { engineId: 'engine-b', parentRecordId: 'rec-A', recordId: 'rec-B', depth: 1 }, 2)
    const c = await openHangEngine(server, agent, { engineId: 'engine-c', parentRecordId: 'rec-B', depth: 2 }, 3)

    await closeEngineAndWait(agent, a.channelId, 'A engine_closed')
    await waitFor(() => !isPidAlive(a.pid) && !isPidAlive(b.pid) && !isPidAlive(c.pid), 'whole chain reaped')
  })

  it('环形申报不死循环：parentRecordId/recordId 成环时 findDescendantIds 有限终止', { timeout: 20_000 }, async () => {
    const { server, agent } = await connectTreeAgent()
    // A 自申报 rec-A 且以 rec-A 为父（自环），B 挂 rec-A——树杀不因环卡死/重复杀
    const a = await openHangEngine(server, agent, { engineId: 'engine-a', recordId: 'rec-A', parentRecordId: 'rec-A' }, 1)
    const b = await openHangEngine(server, agent, { engineId: 'engine-b', parentRecordId: 'rec-A' }, 2)

    await closeEngineAndWait(agent, a.channelId, 'A engine_closed (cycle-safe)')
    await waitFor(() => !isPidAlive(a.pid) && !isPidAlive(b.pid), 'cycle-safe reap done')
  })

  it('recordId 缺省通道无树挂点：终止不波及 parentRecordId 申报者（结构性兜底另行保证）', { timeout: 30_000 }, async () => {
    const { server, agent } = await connectTreeAgent()
    // A 无 recordId 申报；B 挂 rec-X（无人在册持有）——A 终止不杀 B
    const a = await openHangEngine(server, agent, { engineId: 'engine-a' }, 1)
    const b = await openHangEngine(server, agent, { engineId: 'engine-b', parentRecordId: 'rec-X', depth: 1 }, 2)

    await closeEngineAndWait(agent, a.channelId, 'A engine_closed')
    await waitFor(() => !isPidAlive(a.pid), 'A reaped')
    // A 清理链（含树杀环节）完成的确定性信号 = channelCount 落到 1：树杀若误伤 B，
    // kill 必发生在该链内——链完成后再断言 B 无恙（替代固定 300ms 盲等）
    await waitFor(() => server.channelCount === 1, 'A channel finalized')
    expect(isPidAlive(b.pid)).toBe(true)
    expect(server.channelCount).toBe(1) // B 仍在册
  })
})
