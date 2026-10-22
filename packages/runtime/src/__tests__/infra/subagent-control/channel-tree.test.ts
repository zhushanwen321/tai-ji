/**
 * channel 树：登记面（纯台账）+ 递归收割（真进程组，门控）。
 *
 * 分层（判据三档，docs/todo/test-single-layer-cleanup.md）：
 * - 默认组：`ControlChannelRegistry.findDescendantIds` 的图遍历语义（父链 fan-out、
 *   跨连接、BFS 间接后代、环形申报有限终止、recordId 缺省无挂点）。纯函数进/出，第 ① 档，
 *   零 socket 零进程。
 * - 门控组（TAIJI_TEST_INTEGRATION）：递归收割的进程侧效果——父通道终止后子通道引擎组
 *   是否真被连带杀掉、终局 reason 是否 killed_by_control。这是「代码 + OS 组合行为」
 *   （第 ③ 档，只能观测窗口），本地默认跳过、CI 或按改动范围触发时真跑。
 *
 * 设计 §3.3 D4 嵌套子代理：嵌套通道以 parentRecordId 挂父通道 recordId 建树；父通道终止
 * （exit / engine_close / 断连）→ 递归杀子通道引擎组（跨连接生效——嵌套 task pi 与父引擎
 * 不在同一条 control 连接）。结构性兜底与登记面正交：recordId 缺省通道无树挂点，收割由
 * 进程组 + 连接 fan-out 保证。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { SUBAGENT_CONTROL_FRAME_KINDS, SUBAGENT_CONTROL_CLOSED_REASONS } from '@zhushanwen/subagent-engine-sdk'
import { isPidAlive } from '../../../utils/protocol-background-task.js'
import {
  ControlChannelRegistry,
  type ControlChannelInit,
} from '../../../infra/subagent-control/channel-registry.js'
import { SubagentControlServer, type ControlServerOptions } from '../../../infra/subagent-control/control-server.js'
import { TestAgent, cleanupTestServers, launchSpec, setupServer, waitFor } from './test-helpers.js'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../../test-guard/integration-gate.ts'

afterEach(async () => {
  await cleanupTestServers()
})

/** 建一条通道登记（树遍历用例的最小输入；IO 与杀链不在本层）。 */
function registerChannel(
  registry: ControlChannelRegistry,
  overrides: Partial<ControlChannelInit> & { channelId: string },
): void {
  registry.register({
    connectionId: 'conn-1',
    engineId: 'engine',
    openKey: overrides.channelId,
    rootSessionId: 'sess-root-1',
    parentRecordId: null,
    depth: null,
    recordId: null,
    pidFile: `/tmp/${overrides.channelId}.pid`,
    ...overrides,
  })
}

describe('channel 树登记面：findDescendantIds 图遍历', () => {
  it('同连接父子：父通道终止 → 直接子代入列（树杀 fan-out 的枚举源）', () => {
    const registry = new ControlChannelRegistry()
    registerChannel(registry, { channelId: 'ch-a', recordId: 'rec-A' })
    registerChannel(registry, { channelId: 'ch-b', parentRecordId: 'rec-A', depth: 1 })

    expect(registry.findDescendantIds('ch-a')).toEqual(['ch-b'])
    expect(registry.get('ch-a')?.recordId).toBe('rec-A')
    expect(registry.get('ch-b')?.parentRecordId).toBe('rec-A')
  })

  it('多子共享同一父：全部子代入列（一个父通道带多个嵌套引擎）', () => {
    const registry = new ControlChannelRegistry()
    registerChannel(registry, { channelId: 'ch-a', recordId: 'rec-A' })
    registerChannel(registry, { channelId: 'ch-b', parentRecordId: 'rec-A', depth: 1 })
    registerChannel(registry, { channelId: 'ch-c', parentRecordId: 'rec-A', depth: 1 })

    expect(registry.findDescendantIds('ch-a').sort()).toEqual(['ch-b', 'ch-c'])
  })

  it('跨连接父子：嵌套通道在独立连接（同 rootSessionId）仍入列', () => {
    const registry = new ControlChannelRegistry()
    // 连接 1 = 顶层扩展（父通道 A）；连接 2 = 嵌套 task pi 的扩展（B 挂 A 的树）
    registerChannel(registry, { channelId: 'ch-a', connectionId: 'conn-top', recordId: 'rec-A' })
    registerChannel(registry, { channelId: 'ch-b', connectionId: 'conn-nested', parentRecordId: 'rec-A', depth: 1 })

    expect(registry.findDescendantIds('ch-a')).toEqual(['ch-b'])
    // 反向：父不在册/无 recordId 时子通道不被任何父链枚举到
    expect(registry.findDescendantIds('ch-b')).toEqual([])
  })

  it('A → B → C 链：祖父终止枚举全部间接后代（BFS 传递）', () => {
    const registry = new ControlChannelRegistry()
    registerChannel(registry, { channelId: 'ch-a', recordId: 'rec-A' })
    registerChannel(registry, { channelId: 'ch-b', parentRecordId: 'rec-A', recordId: 'rec-B', depth: 1 })
    registerChannel(registry, { channelId: 'ch-c', parentRecordId: 'rec-B', depth: 2 })

    expect(registry.findDescendantIds('ch-a')).toEqual(['ch-b', 'ch-c'])
    // 中间层终止只收割其下（不含已枚举过的上层）
    expect(registry.findDescendantIds('ch-b')).toEqual(['ch-c'])
  })

  it('环形申报不死循环：parentRecordId/recordId 成环时有限终止且不含自身', () => {
    const registry = new ControlChannelRegistry()
    // 三环：A 的父是 C 的 record、B 的父是 A 的 record、C 的父是 B 的 record——
    // 从 A 出发沿父链走会绕回 A，visited 必须截断；自身不得入列（父链终止不杀自己）
    registerChannel(registry, { channelId: 'ch-a', recordId: 'rec-A', parentRecordId: 'rec-C' })
    registerChannel(registry, { channelId: 'ch-b', recordId: 'rec-B', parentRecordId: 'rec-A' })
    registerChannel(registry, { channelId: 'ch-c', recordId: 'rec-C', parentRecordId: 'rec-B' })
    // 自环：A 自申报 rec-A 且以 rec-A 为父（B 挂 rec-A）——同样不得卡死/重复杀
    registerChannel(registry, { channelId: 'ch-self', recordId: 'rec-self', parentRecordId: 'rec-self' })
    registerChannel(registry, { channelId: 'ch-under-self', parentRecordId: 'rec-self' })

    expect(registry.findDescendantIds('ch-a')).toEqual(['ch-b', 'ch-c'])
    expect(registry.findDescendantIds('ch-self')).toEqual(['ch-under-self'])
  })

  it('recordId 缺省通道无树挂点：终止不波及 parentRecordId 申报者（结构性兜底另行保证）', () => {
    const registry = new ControlChannelRegistry()
    // A 无 recordId 申报；B 挂 rec-X（无人在册持有）——A 终止不杀 B
    registerChannel(registry, { channelId: 'ch-a' })
    registerChannel(registry, { channelId: 'ch-b', parentRecordId: 'rec-X', depth: 1 })

    expect(registry.findDescendantIds('ch-a')).toEqual([])
    expect(registry.findDescendantIds('ch-b')).toEqual([])
  })

  it('通道不在册 → 空枚举（无 self 可锚定）', () => {
    const registry = new ControlChannelRegistry()
    registerChannel(registry, { channelId: 'ch-a', recordId: 'rec-A' })
    expect(registry.findDescendantIds('ch-missing')).toEqual([])
  })
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

async function openHangEngine(agent: TestAgent, launch: Record<string, unknown>, id: string | number): Promise<{ channelId: string; pid: number }> {
  agent.hello(`h-${String(id)}`)
  // --exit-on bye-now：engine_close 前发 dispose 帧（bye-now）即退 —— 走「窗口内真实退出」
  // 路径（engine_closed reason engine_exit → finalize → 树杀），不被 3s 默认宽限拖慢
  const opened = await agent.open(launchSpec({ args: ['--exit-on', 'bye-now'], ...launch }), id)
  if (opened.channelId === undefined || opened.pid === undefined) {
    throw new Error(`engine_open failed: ${JSON.stringify(opened.failed)}`)
  }
  return { channelId: opened.channelId, pid: opened.pid }
}

/**
 * channel 树递归收割（真进程组）——判据第 ③ 档：父通道终止后子通道引擎组是否真被连带
 * 杀掉，只能观测进程存亡窗口，无完成信号可等。本地默认跳过，CI 或按改动范围触发时设
 * TAIJI_TEST_INTEGRATION=1 真跑（helper = test-guard/integration-gate.ts；登记见
 * docs/testing/e2e-map.json）。
 */
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `channel 树：递归收割（真进程组）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
  () => {
    it('同连接树杀：A（recordId rec-A）终止 → 子通道 B（parentRecordId rec-A）组杀（killed_by_control）', async () => {
      const { server, agent } = await connectTreeAgent()
      const a = await openHangEngine(agent, { engineId: 'engine-a', recordId: 'rec-A' }, 1)
      const b = await openHangEngine(agent, { engineId: 'engine-b', parentRecordId: 'rec-A', depth: 1 }, 2)
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

    it('跨连接树杀：嵌套通道在独立连接（同 rootSessionId）→ 父连接断开 fan-out 连带孙代', async () => {
      const { server } = await setupServer({ closeGraceMs: 10_000 })
      // 连接 1 = 顶层扩展（父通道 A，recordId rec-A）
      const topAgent = new TestAgent(server.listeningSocketPath)
      await topAgent.opened
      const a = await openHangEngine(topAgent, { engineId: 'engine-a', recordId: 'rec-A' }, 1)
      // 连接 2 = 嵌套 task pi 的扩展（B：parentRecordId rec-A，挂 A 的树）
      const nestedAgent = new TestAgent(server.listeningSocketPath)
      await nestedAgent.opened
      const b = await openHangEngine(nestedAgent, {
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
  },
)
