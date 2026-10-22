/**
 * A4/DC-1 跨包集成：runtime SubagentControlServer × 真实 @zhushanwen/pi-subagent-cli
 * 引擎 bin × 假 pi 子进程（fixture）。零 LLM、零 GUI：引擎进程是真的（NDJSON 协议、
 * 真实 initialize/run 分发、真实 spawn pi 子进程），pi 侧由 fixture 应答最小 RPC 面。
 *
 * 链路（每跳都是真实进程/真实 socket）：
 *   TestAgent（伪 extension）—unix socket→ SubagentControlServer（engine_open/
 *   engine_frame 双向）—spawn→ pi-subagent-cli bin（dist/main.js 或 src fallback）
 *   —spawnEngineChild→ fake pi（PATH 注入 `pi`）。
 *
 * 覆盖：engine_open（真实 bin 启动）→ initialize 应答（真实协议版本协商）→ run
 * 帧往返（prompt 送达回执 + 事件回流 + 反向通道 host/childSpawned 等应答）→
 * engine_close → engine_closed（组杀回收真实引擎进程树）。
 *
 * 环境门禁（禁静默 skip）：
 *   - 显式开关 TAIJI_SKIP_REAL_ENGINE_E2E=1 → console.warn + skip；
 *   - bin 缺失 = 仓内资产缺失 → 硬失败（不 skip）；
 *   - dist 缺失且当前 Node 不支持 TS type-stripping（workspace src fallback 不可用）
 *     → console.warn + skip（附重建命令）；
 *   - 集成测试门控 TAIJI_TEST_INTEGRATION（SSOT = test-guard/integration-gate.ts）：
 *     本地默认跳过、CI 与按改动范围触发时真跑。与上方三种判据正交叠加（门控关闭时
 *     门控理由优先展示）。2026-10-22 测试整治（docs/todo/test-single-layer-cleanup.md
 *     1.2 节）补挂：该 env 全仓无设置点，这两条 90s/120s 真引擎 bin 用例原本在本地与
 *     merge 门禁（scripts/pr-pre-merge.sh 只设 TAIJI_SKIP_REAL_PI）默认轨真跑——挂上
 *     门控后本地与 merge 门禁跳过、CI（test-runtime 已设 env=1）照常真跑，覆盖不变。
 *     e2e-map 登记（待集中分配序号）：R2 / trigger=on-diff / layer=L2 / serial=true；
 *     run = TAIJI_TEST_INTEGRATION=1 pnpm --filter @taiji/runtime exec vitest run
 *     src/__tests__/infra/subagent-control/real-engine-integration.test.ts。
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

import type { ServerMessage } from '@taiji/shared'
import { afterEach, describe, expect, it } from 'vitest'

import {
  SUBAGENT_CONTROL_CLOSED_REASONS,
  SUBAGENT_CONTROL_FRAME_KINDS,
} from '@zhushanwen/subagent-engine-sdk'

import { isPidAlive } from '../../../utils/protocol-background-task.js'
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
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../../test-guard/integration-gate.ts'

const REAL_ENGINE_BIN = resolve(process.cwd(), '../pi-subagent-cli/bin/pi-subagent-cli.mjs')
const REAL_ENGINE_DIST = resolve(dirname(REAL_ENGINE_BIN), '../dist/main.js')
const FAKE_PI = resolve(process.cwd(), 'src/__tests__/fixtures/real-engine-fake-pi.mjs')

const ENGINE_PROTOCOL_VERSION = 1
const ROOT_SID = 'sess-real-engine-root'
const SKIP_ENV = 'TAIJI_SKIP_REAL_ENGINE_E2E'

/** 环境门禁：null = 可跑；字符串 = skip 理由（必带 console.warn，禁静默）。 */
function realEngineSkipReason(): string | null {
  if (process.env[SKIP_ENV] === '1') {
    const reason = `${SKIP_ENV}=1 (explicit opt-out)`
    console.warn(`[real-engine-e2e] skipped: ${reason}`)
    return reason
  }
  if (!existsSync(REAL_ENGINE_BIN)) {
    // bin 是仓内源码资产：缺失意味着入库/工作区损坏，必须硬失败而非 skip
    throw new Error(`[real-engine-e2e] engine bin missing: ${REAL_ENGINE_BIN}`)
  }
  if (!existsSync(REAL_ENGINE_DIST) && !process.features.typescript) {
    const reason =
      `pi-subagent-cli dist/main.js missing and Node ${process.version} lacks TS type-stripping `
      + '(workspace src fallback unavailable)'
    console.warn(
      `[real-engine-e2e] skipped: ${reason}; `
      + 'rebuild with `pnpm --filter @zhushanwen/pi-subagent-cli build`',
    )
    return reason
  }
  return null
}

const skipReason = realEngineSkipReason()

/** 集成门控叠加：门控关闭（本地 / merge 门禁）时门控理由优先展示；开启时回归原判据。 */
const gatedSkip = !INTEGRATION_TESTS_ENABLED || skipReason !== null
const gatedSkipLabel = !INTEGRATION_TESTS_ENABLED ? INTEGRATION_TESTS_SKIP_REASON : skipReason

const tmpDirs: string[] = []
const servers: SubagentControlServer[] = []
const agents: TestAgent[] = []

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy()
  for (const server of servers.splice(0)) {
    await server.destroy()
  }
  await Promise.all(tmpDirs.splice(0).map((d) => rmTmpDir(d)))
})

type EngineFrame = Record<string, unknown> & { id?: number | string; method?: string }

/**
 * 经 control 通道扮演引擎宿主：发送 engine-protocol 正向请求帧、应答反向请求
 * （host/* 反向通道是真实引擎生命周期的一部分：childSpawned/handleReady/streamDelta…）。
 */
class ControlHost {
  readonly childPids: number[] = []
  private cursor = 0
  private responder: NodeJS.Timeout | null = null

  constructor(private readonly agent: TestAgent) {}

  startReverseResponder(): void {
    this.responder = setInterval(() => {
      for (; this.cursor < this.agent.frames.length; this.cursor++) {
        const frame = this.agent.frames[this.cursor]
        if (frame.kind !== SUBAGENT_CONTROL_FRAME_KINDS.engineFrame) continue
        const parsed = parseLine(frame.line)
        if (parsed === null) continue
        if (typeof parsed.method === 'string' && parsed.method.startsWith('host/')) {
          if (parsed.method === 'host/childSpawned') {
            const pid = (parsed.params as { pid?: unknown } | undefined)?.pid
            if (typeof pid === 'number') this.childPids.push(pid)
          }
          // 反向请求必须应答（未应答的 in-flight 请求会走引擎 30s 自灭计时）
          this.sendRaw({ id: parsed.id, result: { ok: true } })
        }
      }
    }, 20)
  }

  stop(): void {
    if (this.responder !== null) clearInterval(this.responder)
    this.responder = null
  }

  /** 发一条引擎协议请求帧并等其应答（id 关联；应答帧同样是 engine_frame.line）。 */
  async request(frameId: number, method: string, params: unknown, timeoutMs = 30_000): Promise<EngineFrame> {
    this.sendRaw({ id: frameId, method, params })
    const start = Date.now()
    for (;;) {
      for (const frame of this.agent.frames) {
        if (frame.kind !== SUBAGENT_CONTROL_FRAME_KINDS.engineFrame) continue
        const parsed = parseLine(frame.line)
        if (parsed !== null && parsed.id === frameId) return parsed
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for engine response id=${String(frameId)} method=${method}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  sendRaw(payload: unknown): void {
    this.agent.sendFrame(this.channelId, JSON.stringify(payload))
  }

  channelId = ''
}

function parseLine(line: unknown): EngineFrame | null {
  if (typeof line !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as EngineFrame) : null
  } catch {
    return null
  }
}

describe.skipIf(gatedSkip)(
  `control server × 真实 pi-subagent-cli 引擎（跨包集成）${gatedSkipLabel ? `｜skip：${gatedSkipLabel}` : ''}`,
  () => {
  it('engine_open → initialize → run（假 pi 往返）→ engine_close → engine_closed 全链', { timeout: 90_000 }, async () => {
    const dataDir = await makeTmpDir('real-engine-')
    tmpDirs.push(dataDir)
    // PATH 注入假 pi：真实引擎的 getPiInvocation 在自举守卫后按名字解析 `pi`
    const fakePiDir = join(dataDir, 'fake-pi-bin')
    mkdirSync(fakePiDir, { recursive: true })
    symlinkSync(FAKE_PI, join(fakePiDir, 'pi'))

    const server = makeServer(dataDir, {
      // piCommand 只用于推导引擎 PATH 前缀（runtime-sidecar 执行器走 process.execPath）
      piCommand: join(fakePiDir, 'pi'),
      runtimeEnv: {
        PATH: `${fakePiDir}${delimiter}${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
      },
      closeGraceMs: 1_000,
    })
    servers.push(server)
    await server.init()

    const agent = new TestAgent(server.listeningSocketPath)
    agents.push(agent)
    await agent.opened
    agent.hello('real-engine-hello')

    // 1) engine_open：spawn 真实引擎 bin（dist/main.js 优先，workspace src fallback）
    const opened = expectOpened(await agent.open(
      launchSpec({
        engineId: 'pi',
        entryPath: REAL_ENGINE_BIN,
        args: [],
        cwd: dataDir,
        envPrefixes: ['PI_'],
        rootSessionId: ROOT_SID,
      }),
      'real-open',
    ))
    const host = new ControlHost(agent)
    host.channelId = opened.channelId
    host.startReverseResponder()

    try {
      // 2) initialize：真实协议版本协商 + 能力应答
      const init = await host.request(1, 'initialize', {
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        hostInfo: { name: 'runtime-control-e2e', version: '0.0.0', dataRoot: dataDir },
        engineConfig: {},
      })
      expect(init.error).toBeUndefined()
      const initResult = init.result as { engineId: string; capabilities: { maxTurns: boolean } }
      expect(initResult.engineId).toBe('pi')
      expect(initResult.capabilities.maxTurns).toBe(true)

      // 3) run：真实引擎 spawn 假 pi 子进程，事件经 engine_frame 回流
      const runPromise = host.request(2, 'run', {
        runId: 'run-real-engine-1',
        task: { prompt: 'say hi', description: 'real-engine e2e', agent: 'worker' },
        ctx: {
          cwd: dataDir,
          sessionDir: join(dataDir, 'subagent-sessions'),
          model: 'fake-provider/fake-model',
          sessionRootId: ROOT_SID,
        },
      }, 45_000)
      // 假 pi 子进程 pid 经反向通道到达（真实 spawnEngineChild + 反向请求链）。
      // 不在此断言存活：run 收敛后引擎会立刻收割子进程，反向帧到达与收割的时序
      // 在并行负载下不可控；「确实执行过」由 run 终态内容证明，回收由收尾断言兜底。
      await waitFor(() => host.childPids.length > 0, 'host/childSpawned reverse request')
      const childPid = host.childPids[0]
      expect(childPid).toBeGreaterThan(0)

      const run = await runPromise
      expect(run.error).toBeUndefined()
      const runResult = run.result as {
        handle: { engineId: string; sessionRef: Record<string, string> }
        outcome: { content: string; usage?: { input: number } }
      }
      expect(runResult.handle.engineId).toBe('pi')
      expect(runResult.handle.sessionRef.recordId).toBe('run-real-engine-1')
      expect(runResult.outcome.content).toContain('real-engine-ok')
      expect(runResult.outcome.usage?.input).toBeGreaterThan(0)

      // 4) dispose（真实引擎协议终态面，幂等）
      const dispose = await host.request(3, 'dispose', {})
      expect((dispose.result as { ok?: boolean }).ok).toBe(true)

      // 5) engine_close → 有界等待 → 组杀 → engine_closed；真实引擎进程树全灭
      agent.send({ v: ENGINE_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId: opened.channelId })
      const closed = await agent.waitForFrame(
        (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === opened.channelId,
        'engine_closed from real engine channel',
      )
      expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
      await waitFor(() => !isPidAlive(opened.pid), 'real engine process reaped')
      await waitFor(() => !isPidAlive(childPid), 'fake pi child reaped with engine group')
      expect(server.getChannelForTest(opened.channelId)).toBeUndefined()
    } finally {
      host.stop()
    }
  })

  it('同通道连续两 run 同 recordId → seq 跨 run 接续（第二轮不判 degraded，live 流持续）', { timeout: 120_000 }, async () => {
    // 回归 R2-B-U-1（真实写侧 → 真实读取侧）：workflow 成员复用会让同一 recordId 在
    // 后续 run 再次派发。写侧 seq 若 per-run 重置，读取侧 RecordMirror（生命周期 =
    // 通道/引擎进程）会把第二轮首帧判为空洞并永久停发 live 流。这里两轮 run 共用
    // resume.recordId，断言 live chunk 持续增长且从未 degraded。
    const dataDir = await makeTmpDir('real-engine-reuse-')
    tmpDirs.push(dataDir)
    const fakePiDir = join(dataDir, 'fake-pi-bin')
    mkdirSync(fakePiDir, { recursive: true })
    symlinkSync(FAKE_PI, join(fakePiDir, 'pi'))

    const published: Array<{ sid: string; msg: ServerMessage }> = []
    const server = makeServer(dataDir, {
      piCommand: join(fakePiDir, 'pi'),
      runtimeEnv: {
        PATH: `${fakePiDir}${delimiter}${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
      },
      closeGraceMs: 1_000,
      publish: (sid: string, msg: ServerMessage) => published.push({ sid, msg }),
    })
    servers.push(server)
    await server.init()

    const agent = new TestAgent(server.listeningSocketPath)
    agents.push(agent)
    await agent.opened
    agent.hello('real-engine-reuse-hello')

    const reuseRecordId = 'rec-workflow-member-reuse'
    const opened = expectOpened(await agent.open(
      launchSpec({
        engineId: 'pi',
        entryPath: REAL_ENGINE_BIN,
        args: [],
        cwd: dataDir,
        envPrefixes: ['PI_'],
        rootSessionId: ROOT_SID,
      }),
      'reuse-open',
    ))
    const host = new ControlHost(agent)
    host.channelId = opened.channelId
    host.startReverseResponder()

    const chunkCount = (): number => published.filter((p) => p.msg.type === 'subagent.stream_chunk').length
    const runOnce = (runId: string, frameId: number): Promise<EngineFrame> => host.request(frameId, 'run', {
      runId,
      task: { prompt: 'say hi', description: 'record reuse e2e', agent: 'worker' },
      ctx: {
        cwd: dataDir,
        sessionDir: join(dataDir, 'subagent-sessions'),
        model: 'fake-provider/fake-model',
        sessionRootId: ROOT_SID,
      },
      resume: { recordId: reuseRecordId },
    }, 45_000)

    try {
      const init = await host.request(1, 'initialize', {
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        hostInfo: { name: 'runtime-record-reuse-e2e', version: '0.0.0', dataRoot: dataDir },
        engineConfig: {},
      })
      expect(init.error).toBeUndefined()

      // 第一轮 run：镜像 record 建立，live chunk 到达。假 pi 每轮固定发 2 条
      // text_delta（fixture 契约）；等满 2 条再取水位，排除「第一轮 fd3 帧迟到」
      // 被误算成第二轮产出的可能。
      const run1 = await runOnce('run-reuse-1', 10)
      expect(run1.error).toBeUndefined()
      await waitFor(() => chunkCount() >= 2, 'live chunks from first run')
      const chunksAfterRun1 = chunkCount()
      expect(server.getStreamStateByRecord(ROOT_SID, reuseRecordId)?.degraded).toBeUndefined()

      // 第二轮 run：同 recordId 再次派发——写侧 seq 接续，读取侧不得判 degraded；
      // 再等满 2 条增量 = 第二轮确实持续发布 live 流。
      const run2 = await runOnce('run-reuse-2', 11)
      expect(run2.error).toBeUndefined()
      await waitFor(
        () => chunkCount() >= chunksAfterRun1 + 2,
        'live chunks continue on second run',
      )
      expect(server.getStreamStateByRecord(ROOT_SID, reuseRecordId)?.degraded).toBeUndefined()

      // 收尾：dispose + engine_close → 真实引擎进程树回收
      const dispose = await host.request(3, 'dispose', {})
      expect((dispose.result as { ok?: boolean }).ok).toBe(true)
      agent.send({ v: ENGINE_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId: opened.channelId })
      const closed = await agent.waitForFrame(
        (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === opened.channelId,
        'engine_closed from reused-record channel',
      )
      expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
      await waitFor(() => !isPidAlive(opened.pid), 'real engine process reaped (reuse case)')
    } finally {
      host.stop()
    }
  })
})
