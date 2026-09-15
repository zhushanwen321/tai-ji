/**
 * E-1（relay.mjs 真代理进程）× E-2（relay-registry）跨组件集成测试。
 *
 * 为什么独立成文件：E-1/E-2 并行开发，relay-registry.test.ts 里的 TestAgent 是
 * 「讲 socket 协议的伪代理」，不经过 relay.mjs 的严格握手状态机——两组件的真实
 * 对齐（accept 帧、退出码传播、字节泵）只有把真代理进程拉起来才被验证。
 * 协议镜像常量（relay-env.ts ↔ relay.mjs）的一致性也在此锁定（E-3 conformance 前的组件级门）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { initRelayServer, deinitRelayServer } from '../../../infra/relay/relay-server.js'
import { getRelaySocketPath, getRelayPidFilePath } from '../../../infra/relay/relay-paths.js'
import { RELAY_ENV_SOCKET, RELAY_ENV_SESSION_ID, RELAY_ENV_RECORD_ID } from '@zhushanwen/subagent-core/relay-env'

const RELAY_MJS = resolve(process.cwd(), '../../extensions/universal/subagent-workflow/relay/relay.mjs')

/** 轮询等待条件成立（跨进程时序）。 */
async function waitFor(cond: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 假 pi：get_state 命令 → stdout 回 JSONL + stderr 一行；exit 命令 → exit 0。
 *  不能依赖 stdin 'end' 退出——E-1 代理语义是忽略 stdin EOF（真实 extension 只 kill 不 end）。 */
const FAKE_PI_SCRIPT = `
process.stdin.on('data', (c) => {
  const text = c.toString()
  if (text.includes('get_state')) {
    process.stdout.write(JSON.stringify({ type: 'response', id: 'gs', result: { ok: true } }) + '\\n')
    process.stderr.write('fake-pi stderr note\\n')
  }
  if (text.includes('exit-now')) process.exit(0)
})
`

interface SpawnedAgent {
  child: ChildProcess
  stdout: string
  stderr: string
  exited: Promise<{ code: number | null; signal: string | null }>
}

/** spawn 真 relay.mjs 代理（E-1），stdio 管道全接，行缓冲收集。 */
function spawnAgent(socketPath: string, fakePiPath: string, sessionId: string, recordId: string): SpawnedAgent {
  const child = spawn(process.execPath, [RELAY_MJS, fakePiPath], {
    env: {
      ...process.env,
      [RELAY_ENV_SOCKET]: socketPath,
      [RELAY_ENV_SESSION_ID]: sessionId,
      [RELAY_ENV_RECORD_ID]: recordId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state: SpawnedAgent = {
    child,
    stdout: '',
    stderr: '',
    exited: new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    }),
  }
  child.stdout?.on('data', (d: Buffer) => { state.stdout += d.toString('utf-8') })
  child.stderr?.on('data', (d: Buffer) => { state.stderr += d.toString('utf-8') })
  return state
}

const tmpDirs: string[] = []

async function setup(): Promise<{ dataDir: string; fakePiPath: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-int-'))
  tmpDirs.push(dataDir)
  const fakePiPath = join(dataDir, 'fake-pi.mjs')
  await writeFile(fakePiPath, FAKE_PI_SCRIPT, 'utf-8')
  return { dataDir, fakePiPath }
}

describe('E-1 × E-2 real-process integration', () => {
  afterEach(async () => {
    await deinitRelayServer()
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })))
  })

  it(
    '全链字节泵：stdin 命令 → 假 pi → stdout/stderr 回传 → exit code 传播（accept 状态机隐式验证）',
    async () => {
      const { dataDir, fakePiPath } = await setup()
      await initRelayServer({ projectRoot: process.cwd(), dataDir, publish: () => {}, piCommand: process.execPath })
      const socketPath = getRelaySocketPath(dataDir)

      const agent = spawnAgent(socketPath, fakePiPath, 'sess-int-1', 'rec-int-1')
      // 等 accept 后字节泵启动：写命令，假 pi 响应即证明 down/up 双向贯通
      await waitFor(() => !!(agent.child.stdin && !agent.child.stdin.destroyed), 5_000, 'agent stdin ready')
      agent.child.stdin?.write('{"type":"command","name":"get_state"}\n')
      await waitFor(() => agent.stdout.includes('"gs"'), 15_000, 'fake-pi response via relay up frames')
      expect(agent.stdout).toContain('"ok":true')
      await waitFor(() => agent.stderr.includes('fake-pi stderr note'), 10_000, 'stderr relayed')
      // pid 文件已随注册写入
      expect(existsSync(getRelayPidFilePath('rec-int-1', dataDir))).toBe(true)

      // exit 命令 → 假 pi exit 0 → exit 帧传播 → 代理以相同 code 退出
      agent.child.stdin?.write('{"type":"command","name":"exit-now"}\n')
      const { code } = await agent.exited
      expect(code).toBe(0)
      // 条目注销后 pid 文件清理
      await waitFor(() => !existsSync(getRelayPidFilePath('rec-int-1', dataDir)), 5_000, 'pid file cleanup')
    },
    25_000,
  )

  it(
    '代理被杀（崩溃矩阵③）：socket 断 → runtime 断连即杀假 pi + 清理条目',
    async () => {
      const { dataDir, fakePiPath } = await setup()
      await initRelayServer({ projectRoot: process.cwd(), dataDir, publish: () => {}, piCommand: process.execPath })
      const socketPath = getRelaySocketPath(dataDir)

      const agent = spawnAgent(socketPath, fakePiPath, 'sess-int-2', 'rec-int-2')
      await waitFor(() => !!(agent.child.stdin && !agent.child.stdin.destroyed), 5_000, 'agent stdin ready')
      agent.child.stdin?.write('{"type":"command","name":"get_state"}\n')
      await waitFor(() => agent.stdout.includes('"gs"'), 15_000, 'chain established')
      expect(existsSync(getRelayPidFilePath('rec-int-2', dataDir))).toBe(true)

      // 杀代理进程（SIGTERM）——runtime 侧断连即杀链收割假 pi
      agent.child.kill('SIGTERM')
      await agent.exited
      await waitFor(() => !existsSync(getRelayPidFilePath('rec-int-2', dataDir)), 10_000, 'registry cleanup after agent death')
    },
    25_000,
  )
})
