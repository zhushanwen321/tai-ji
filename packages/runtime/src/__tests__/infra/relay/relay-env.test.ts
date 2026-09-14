/**
 * relay env 注入探针单测（E-2，验收 2）。
 *
 * 覆盖：probeNodeExecutor（真 node 通过 / 假执行器失败）、getRelaySpawnEnv 三态
 * （server 激活 + 脚本存在 + 探针通过 → 注入三 env；探针失败 → {}；server 未激活 → {}；
 * staged 脚本缺失 → {}）。
 *
 * [2026-09 测试舰队审查 r2-22] 「§10-1 探针实测」describe（1 例）已删：断言
 * `process.versions.electron === undefined` + execPath 含 node 锁的是「vitest 跑在
 * node 上」这一测试环境自述，非 SUT 行为，环境本就恒真。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeNodeExecutor, getRelaySpawnEnv, resetRelayNodeProbeCache } from '../../../infra/relay/relay-env.js'
import { initRelayServer, deinitRelayServer } from '../../../infra/relay/relay-server.js'
import { getActiveRelaySocketPath } from '../../../infra/relay/relay-server.js'
import { RELAY_ENV_SOCKET, RELAY_ENV_NODE, RELAY_ENV_SCRIPT } from '@zhushanwen/subagent-core/relay-env'
import type { ServerMessage } from '@xyz-agent/shared'

describe('probeNodeExecutor', () => {
  it('node 执行器 + 非 Electron → 通过', async () => {
    expect(await probeNodeExecutor(process.execPath, false)).toBe(true)
  })

  it('不存在的执行器 → 失败（探针 5s 内返回）', async () => {
    const start = Date.now()
    expect(await probeNodeExecutor(join(tmpdir(), 'no-such-node-binary'), false)).toBe(false)
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('Electron 形态注入 ELECTRON_RUN_AS_NODE（node 忽略该 env，仍通过——同 env 语义验证）', async () => {
    // dev 机无 Electron 二进制可探；isElectron=true 时探针 env 带 RUN_AS_NODE，
    // 对 node 执行器无影响（plugin-host-process 先例注释「node 环境该 env 无害被忽略」），
    // 此用例锁定该语义：Electron 判定不会误伤 node 执行器路径。
    expect(await probeNodeExecutor(process.execPath, true)).toBe(true)
  })
})

describe('getRelaySpawnEnv', () => {
  let dataDir: string
  let fakeScript: string

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetRelayNodeProbeCache()
    dataDir = await mkdtemp(join(tmpdir(), 'relay-env-'))
    fakeScript = join(dataDir, 'relay.mjs')
    await writeFile(fakeScript, '// fake staged relay script\n')
  })

  afterEach(async () => {
    await deinitRelayServer().catch(() => {})
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
    vi.restoreAllMocks()
  })

  const noopPublish = (_sid: string, _msg: ServerMessage): void => { void _sid; void _msg }

  it('server 激活 + 脚本存在 + execPath 为 node → 注入三 env（socket 路径 = 实际监听路径）', async () => {
    await initRelayServer({ projectRoot: dataDir, dataDir, publish: noopPublish, piCommand: process.execPath })
    const env = await getRelaySpawnEnv(dataDir, { scriptPath: fakeScript })
    expect(Object.keys(env).sort()).toEqual([RELAY_ENV_NODE, RELAY_ENV_SCRIPT, RELAY_ENV_SOCKET].sort())
    expect(env[RELAY_ENV_SOCKET]).toBe(getActiveRelaySocketPath())
    expect(env[RELAY_ENV_NODE]).toBe(process.execPath)
    expect(env[RELAY_ENV_SCRIPT]).toBe(fakeScript)
    // dev（node 执行器）形态不注入 ELECTRON_RUN_AS_NODE
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('探针失败（execPath 不存在）→ 不注入（relay 降级不激活）', async () => {
    await initRelayServer({ projectRoot: dataDir, dataDir, publish: noopPublish, piCommand: process.execPath })
    const env = await getRelaySpawnEnv(dataDir, {
      scriptPath: fakeScript,
      execPath: join(tmpdir(), 'no-such-node-binary'),
    })
    expect(env).toEqual({})
  })

  it('relay server 未激活 → 不注入（回落现状直连）', async () => {
    const env = await getRelaySpawnEnv(dataDir, { scriptPath: fakeScript })
    expect(env).toEqual({})
  })

  it('staged 脚本缺失（并行任务 bundle 未就绪）→ 不注入、不抛错', async () => {
    await initRelayServer({ projectRoot: dataDir, dataDir, publish: noopPublish, piCommand: process.execPath })
    const env = await getRelaySpawnEnv(dataDir, { scriptPath: join(dataDir, 'not-staged-yet.mjs') })
    expect(env).toEqual({})
  })

  it('isElectron=true 时同点注入 ELECTRON_RUN_AS_NODE（打包形态语义，node 探针仍通过）', async () => {
    await initRelayServer({ projectRoot: dataDir, dataDir, publish: noopPublish, piCommand: process.execPath })
    const env = await getRelaySpawnEnv(dataDir, { scriptPath: fakeScript, isElectron: true })
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env[RELAY_ENV_NODE]).toBe(process.execPath)
  })
})
