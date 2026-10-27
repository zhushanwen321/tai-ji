import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../../test-guard/integration-gate.ts';
import { ControlChannelRegistry, type ControlChannelInit } from '../../../infra/subagent-control/channel-registry.js';
import { SubagentControlServer, type ControlServerOptions } from '../../../infra/subagent-control/control-server.js';
import { ChannelDownQueue, type DownStdin } from '../../../infra/subagent-control/down-queue.js';
import { buildEngineLaunchEnv } from '../../../infra/subagent-control/engine-launch-env.js';
import { SUBAGENT_CONTROL_CLOSED_REASONS, SUBAGENT_CONTROL_FRAME_KINDS, SUBAGENT_CONTROL_PROTOCOL_VERSION, byteLengthOf, extractOversizeFrameHead, parseControlInboundFrame } from '../../../infra/subagent-control/frames.js';
import { getControlEnginesDir, getControlRunDir } from '../../../infra/subagent-control/paths.js';
import { sweepOrphanEnginePids, sweepStaleControlSockets } from '../../../infra/subagent-control/sweep.js';
import { isPidAlive } from '../../../utils/protocol-background-task.js';
import { lastFakeEngine, resetFakeEngines, type FakeEngineChild } from './fake-engine.js';
import { TestAgent, byeAndExpectClosed, cleanupTestServers, connectAgent, expectOpened, launchSpec, makeRegisteredTmpDir, makeServer, makeTmpDir, rmTmpDir, setupServer as setupServer_z2, waitFor } from './test-helpers.js';
import type { ServerMessage } from '@taiji/shared';
import { CONTROL_ENV_ROOT_SESSION_ID, CONTROL_ENV_SOCKET, ENGINE_ENV_DENY_LIST, ENGINE_ENV_L0_INFRA_KEYS, SUBAGENT_CONTROL_CLOSED_REASONS as SUBAGENT_CONTROL_CLOSED_REASONS_z2, SUBAGENT_CONTROL_FRAME_KINDS as SUBAGENT_CONTROL_FRAME_KINDS_z2, buildEngineChildEnv, buildOutboundChildEnv } from '@zhushanwen/subagent-engine-sdk';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/infra/subagent-control/channel-tree.test.ts
// ======================================================================

const VALID_LAUNCH = {
  engineId: 'fake-engine',
  entryPath: '/tmp/fake-engine.mjs',
  args: [],
  cwd: '/tmp',
  envPrefixes: [],
  rootSessionId: 'sess-1',
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('control-frames', () => {
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
});

// ======================================================================
// ← src/__tests__/infra/subagent-control/down-write-once.test.ts
// ======================================================================

type FakeStdin = EventEmitter & {
  destroyed: boolean
  writes: string[]
  write(chunk: string): boolean
}


/** write 回执按 results 序列返回（耗尽后恒 true）；记录每次写入的完整行。 */
function makeFakeStdin(results: boolean[]): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin
  let index = 0
  stdin.destroyed = false
  stdin.writes = []
  stdin.write = (chunk: string): boolean => {
    stdin.writes.push(chunk)
    const result = results[Math.min(index, results.length - 1)] ?? true
    index += 1
    return result
  }
  return stdin
}


function makeQueue(stdin: FakeStdin): {
  queue: ChannelDownQueue
  state: { connectionBytes: number; overflows: number }
} {
  const state = { connectionBytes: 0, overflows: 0 }
  const queue = new ChannelDownQueue({
    channelId: 'ch-test',
    getStdin: () => stdin,
    channelMaxBytes: 1024,
    channelMaxFrames: 16,
    getConnectionBytes: () => state.connectionBytes,
    setConnectionBytes: (bytes) => { state.connectionBytes = bytes },
    connectionMaxBytes: 4096,
    onOverflow: () => { state.overflows += 1 },
  })
  return { queue, state }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('down-write-once', () => {
describe('down 写路径（R3-N1 每帧恰好投递一次）', () => {
  it('write 返回 true：只写一次，其后 drain 不重写', () => {
    const stdin = makeFakeStdin([true])
    const { queue, state } = makeQueue(stdin)
    queue.push('line-true')
    expect(stdin.writes).toEqual(['line-true\n'])
    // 健康写从未产生背压，drain 事件即使到达也没有可重写的帧
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['line-true\n'])
    expect(state.connectionBytes).toBe(0)
    expect(state.overflows).toBe(0)
  })

  it('write 返回 false：已受理帧不入队；drain 只重写背压期入队帧且各恰好一次', () => {
    // 回执序列：first=false（已受理、不入队）；second=false（入队帧冲刷时再次背压）；
    // third=true（队列清空）
    const stdin = makeFakeStdin([false, false, true])
    const { queue, state } = makeQueue(stdin)

    queue.push('first')
    expect(stdin.writes).toEqual(['first\n'])

    // 背压期：只入队、不写（保持 FIFO，也绝不再写 first）
    queue.push('second')
    queue.push('third')
    expect(stdin.writes).toEqual(['first\n'])
    expect(state.connectionBytes).toBe(Buffer.byteLength('second\n') + Buffer.byteLength('third\n'))
    // 同一背压期只挂一个 drain 监听（旧实现每帧一个 → >10 帧触发 MaxListenersExceededWarning）
    expect(stdin.listenerCount('drain')).toBe(1)

    // 第一次 drain：second 写出（false 已被受理）→ 出队并重新等 drain；third 留队
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['first\n', 'second\n'])
    expect(state.connectionBytes).toBe(Buffer.byteLength('third\n'))
    expect(stdin.listenerCount('drain')).toBe(1)

    // 第二次 drain：third 写出（true）→ 队列清空、聚合计数归零
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['first\n', 'second\n', 'third\n'])
    expect(state.connectionBytes).toBe(0)
    expect(stdin.listenerCount('drain')).toBe(0)
  })

  it('背压期队列越界 → onOverflow 显式失败（不静默丢帧）', () => {
    const stdin = makeFakeStdin([false])
    const { queue, state } = makeQueue(stdin)
    queue.push('x'.repeat(2048)) // 首帧 write=false（已受理，不入队）
    expect(state.connectionBytes).toBe(0)
    queue.push('x'.repeat(2048)) // 入队即超 per-channel 上限
    expect(state.overflows).toBe(1)
    expect(state.connectionBytes).toBe(0)
  })
})
});

// ======================================================================
// ← src/__tests__/infra/subagent-control/engine-launch-env.test.ts
// ======================================================================

/** runtime 进程 env 快照（测试受控基座；注入必剥键证明 deny 链生效）。 */
const RUNTIME_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  TAIJI_RUNTIME_TOKEN: 'leak-me-not',
  TAIJI_AGENT_PACKAGED: '1',
  TERM: 'xterm-256color',
}


const BASE_OPTS = {
  runtimeEnv: RUNTIME_ENV,
  dataDir: '/tmp/dd',
  engineNode: '/usr/local/bin/node',
  electronRunAsNode: true,
  envPrefixes: ['MYENGINE_'],
  processEnv: { MYENGINE_FEATURE: 'on', LEAK_ME: 'no' },
  piAgentDir: '/tmp/dd/agent',
  piDir: '/opt/pi/bin',
  controlSocket: '/tmp/dd/run/subagent-1.sock',
  rootSessionId: 'sess-root-1',
  rawMirror: true,
}


/** L0 清单必需键集（runtime 宿主注入面必须全量在场）。 */
const REQUIRED_L0_KEYS = ENGINE_ENV_L0_INFRA_KEYS

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('engine-launch-env', () => {
describe('buildEngineLaunchEnv 键集合（锚定 u-foundation 冻结清单）', () => {
  const env = buildEngineLaunchEnv(BASE_OPTS)

  it('L0 基础设施键全部在场', () => {
    for (const key of REQUIRED_L0_KEYS) {
      expect(env[key], `L0 key ${key} must be present`).toBeTruthy()
    }
  })

  it('deny 清单键全不在场（runtime env 注入的 TOKEN/PACKAGED 被剥）', () => {
    for (const key of ENGINE_ENV_DENY_LIST) {
      expect(env[key], `deny key ${key} must be absent`).toBeUndefined()
    }
  })

  it('L2 manifest 放行：声明前缀进、未声明前缀不出', () => {
    expect(env.MYENGINE_FEATURE).toBe('on')
    expect(env.LEAK_ME).toBeUndefined()
  })

  it('runtime 宿主补齐键：PI_CODING_AGENT_DIR / PATH 前缀 / raw mirror', () => {
    expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/dd/agent')
    expect(env.PATH?.startsWith('/opt/pi/bin:')).toBe(true)
    expect(env.TAIJI_ENGINE_RAW_MIRROR).toBe('1')
  })

  it('rawMirror=false / control 缺席 → 对应键显式删除（不残留基座旧值）', () => {
    const off = buildEngineLaunchEnv({ ...BASE_OPTS, rawMirror: false, controlSocket: undefined, rootSessionId: undefined })
    expect(off.TAIJI_ENGINE_RAW_MIRROR).toBeUndefined()
    expect(off[CONTROL_ENV_SOCKET]).toBeUndefined()
    expect(off[CONTROL_ENV_ROOT_SESSION_ID]).toBeUndefined()
  })

  it('纯函数：不 mutate 入参基座（runtimeEnv 快照零副作用）', () => {
    const snapshot = { ...RUNTIME_ENV }
    buildEngineLaunchEnv(BASE_OPTS)
    expect(RUNTIME_ENV).toEqual(snapshot)
  })
})
describe('local vs runtime launch env 等价（D4 env 形状测试，验收 ⑤）', () => {
  /**
   * 两侧归一到「task pi env」（引擎出站 = SDK buildOutboundChildEnv，deny 剥除后
   * pass-all 基座）再比较关键键——设计等价语义的锚点是 task pi 链，不是引擎 env 本体。
   * local 侧 = 扩展宿主（主 pi）ambient 携带 control 两键 + PI_CODING_AGENT_DIR + pi
   * 目录 PATH（taiji 托管形态的主 pi env），经 buildEngineChildEnv（local transport
   * 既有路径）；runtime 侧 = buildEngineLaunchEnv（本单元）。
   */
  const HOST_ENV_LOCAL = {
    ...RUNTIME_ENV,
    [CONTROL_ENV_SOCKET]: '/tmp/dd/run/subagent-1.sock',
    [CONTROL_ENV_ROOT_SESSION_ID]: 'sess-root-1',
    PI_CODING_AGENT_DIR: '/tmp/dd/agent',
    PATH: '/opt/pi/bin:/usr/bin:/bin',
    // 刻意不含 TAIJI_ENGINE_RAW_MIRROR：该键是 runtime 宿主宣告（D4 矩阵 engine 行），
    // local 形态无此键——见下方差集有界断言的注释。
  }

  const localTaskEnv = buildOutboundChildEnv({
    parentEnv: buildEngineChildEnv(HOST_ENV_LOCAL, {
      dataDir: BASE_OPTS.dataDir,
      engineNode: BASE_OPTS.engineNode,
      electronRunAsNode: BASE_OPTS.electronRunAsNode,
      envPrefixes: BASE_OPTS.envPrefixes,
      processEnv: BASE_OPTS.processEnv,
    }),
  })

  const runtimeTaskEnv = buildOutboundChildEnv({
    parentEnv: buildEngineLaunchEnv(BASE_OPTS),
  })

  /** 关键键锚单（impl-plan 验收 ⑤「关键键一致」；socket/root 为链路身份键，值同源相等）。 */
  const ANCHOR_KEYS = [
    'TAIJI_AGENT_DATA_DIR',
    'TAIJI_AGENT_ENGINE_NODE',
    'ELECTRON_RUN_AS_NODE',
    'TAIJI_AGENT_SUBAGENT',
    'PI_CODING_AGENT_DIR',
    CONTROL_ENV_SOCKET,
    CONTROL_ENV_ROOT_SESSION_ID,
  ]

  it('关键键双侧在场且值一致', () => {
    for (const key of ANCHOR_KEYS) {
      expect(localTaskEnv[key], `local task env missing ${key}`).toBeTruthy()
      expect(runtimeTaskEnv[key], `runtime task env missing ${key}`).toBeTruthy()
      expect(runtimeTaskEnv[key], `value mismatch on ${key}`).toBe(localTaskEnv[key])
    }
  })

  it('PATH 双侧可达 pi 目录（值形态等价：pi 目录前缀都在）', () => {
    expect(localTaskEnv.PATH?.includes('/opt/pi/bin')).toBe(true)
    expect(runtimeTaskEnv.PATH?.includes('/opt/pi/bin')).toBe(true)
  })

  it('deny 键双侧皆无（task pi 出站基座不泄漏 TOKEN/PACKAGED）', () => {
    for (const key of ENGINE_ENV_DENY_LIST) {
      expect(localTaskEnv[key]).toBeUndefined()
      expect(runtimeTaskEnv[key]).toBeUndefined()
    }
  })

  it('键集合差集有界：runtime 侧相对 local 的新增键 = raw mirror（runtime 宿主向引擎进程宣告 fd3 通道；task pi 侧的剥除归引擎出站构建器，不在本函数职责内）', () => {
    const localKeys = new Set(Object.keys(localTaskEnv))
    const runtimeOnly = Object.keys(runtimeTaskEnv).filter((k) => !localKeys.has(k))
    expect(new Set(runtimeOnly)).toEqual(new Set(['TAIJI_ENGINE_RAW_MIRROR']))
  })
})
});

// ======================================================================
// ← src/__tests__/infra/subagent-control/logging-branch-coverage.test.ts
// ======================================================================

/** spawn 闸门（hoisted：vi.mock factory 与用例都要读写同一对象）。 */
const spawnGate = vi.hoisted(() => ({ real: false }))


// 引擎进程换进程内桩（零真 spawn）。本文件无真进程组用例，闸门恒 false。
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


function makeDownQueue(stdin: DownStdin | null): ChannelDownQueue {
  return new ChannelDownQueue({
    channelId: 'ch-logcov',
    getStdin: () => stdin,
    channelMaxBytes: 1024,
    channelMaxFrames: 16,
    getConnectionBytes: () => 0,
    setConnectionBytes: () => {},
    connectionMaxBytes: 4096,
    onOverflow: () => {},
  })
}


/** 孤儿 pid 文件的登记形状（spawn 后原子写；owner 死 + 引擎 pid 活 + start 晚于登记）。 */
function writeReusedPidFile(pidFile: string, enginePid: number): void {
  writeFileSync(pidFile, JSON.stringify({
    pid: enginePid,
    spawnedAt: Date.now(), // 登记 = 现在；注入的 start = 2h 后 → start 晚于登记 = 已复用
    runtimePid: 999_999_999, // owner 死（不可能的 pid）
    instanceId: '999999999',
    hostKind: 'runtime-sidecar',
  }))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('logging-branch-coverage', () => {
afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupTestServers()
  resetFakeEngines()
})
describe('down-queue 降级分支', () => {
  it('stdin 不可用（null）：push 静默丢帧不抛错', () => {
    const queue = makeDownQueue(null)
    expect(() => queue.push('frame-1')).not.toThrow()
  })

  it('stdin.write 抛错（EPIPE 族）：push 吞错降级不外抛', () => {
    const throwingStdin: DownStdin = {
      destroyed: false,
      write: () => {
        throw new Error('EPIPE: broken pipe')
      },
      once: () => undefined,
    }
    const queue = makeDownQueue(throwingStdin)
    expect(() => queue.push('frame-1')).not.toThrow()
  })
})
describe('sweep 降级分支', () => {
  it('stale socket 删除失败（socket 名被目录占位）：保留不阻塞、不抛错', async () => {
    const dataDir = await makeRegisteredTmpDir('ctl-sweepfail-')
    const runDir = getControlRunDir(dataDir)
    mkdirSync(runDir, { recursive: true })
    const blockedPath = join(runDir, 'subagent-77777.sock')
    mkdirSync(blockedPath) // 目录占 socket 名 → unlinkSync 必失败（EISDIR/EPERM）

    await expect(sweepStaleControlSockets(dataDir, '')).resolves.toBeUndefined()
    expect(existsSync(blockedPath)).toBe(true) // best-effort：单项失败保留待下次扫
  })

  it('pid 文件 instanceId 与 runtimePid 不一致 → 判活告警并保守跳过', async () => {
    const dataDir = await makeRegisteredTmpDir('ctl-mirror-id-')
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const pidFile = join(enginesDir, 'sess-m-fake-m-ch-m.pid')
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid, // owner = 本测试进程（活）
      spawnedAt: Date.now(),
      runtimePid: process.pid,
      instanceId: 'not-my-instance-id', // 与 String(runtimePid) 不匹配
      hostKind: 'runtime-sidecar',
    }))

    await sweepOrphanEnginePids(dataDir)
    expect(existsSync(pidFile)).toBe(true) // owner 活 → 跳过（身份不可核实只告警）
  })

  it('pid 复用（start 晚于登记）→ 不杀只删', async () => {
    const dataDir = await makeRegisteredTmpDir('ctl-reuse-')
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const pidFile = join(enginesDir, 'sess-r-fake-r-ch-r.pid')
    // 合成 pid：判活/杀链/start time 全部经 deps 注入，无需真进程（真实探活由
    // control-server 的门控用例与 sweep.test.ts 承担）
    const enginePid = 999_000_001
    writeReusedPidFile(pidFile, enginePid)

    const killSpy = vi.fn()
    await sweepOrphanEnginePids(dataDir, {
      // 只让引擎 pid 判活（owner runtime 的 999_999_999 必须判死才会进入收割判定）
      isPidAlive: (pid) => pid === enginePid,
      killProcessTree: killSpy,
      getProcessStartTimeSec: () => Math.floor(Date.now() / 1000) + 7200, // start 晚于登记 = 已复用
    })

    expect(killSpy).not.toHaveBeenCalled() // 复用判定 → 不杀（宁不杀勿误杀）
    expect(existsSync(pidFile)).toBe(false) // 只删记录
  })

  it('pid 文件删除失败（目录只读）→ 降级保留，不抛错', async () => {
    const dataDir = await makeRegisteredTmpDir('ctl-reuse-ro-')
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const pidFile = join(enginesDir, 'sess-r-fake-r-ch-r.pid')
    writeReusedPidFile(pidFile, 999_000_002)
    chmodSync(enginesDir, 0o555) // 只读 → removeQuietly 的 unlink 必失败（叠加第二个降级点）
    try {
      const killSpy = vi.fn()
      await expect(sweepOrphanEnginePids(dataDir, {
        isPidAlive: (pid) => pid === 999_000_002,
        killProcessTree: killSpy,
        getProcessStartTimeSec: () => Math.floor(Date.now() / 1000) + 7200,
      })).resolves.toBeUndefined()
      expect(killSpy).not.toHaveBeenCalled() // 复用判定仍不杀
      expect(existsSync(pidFile)).toBe(true) // 删除失败 → 保留（warn 留痕）
    } finally {
      chmodSync(enginesDir, 0o755)
    }
  })
})
describe('control-server 降级分支', () => {
  it('spawn ENOENT（resolveLaunch 注入不可执行 command）→ engine process error → engine_closed(127)', async () => {
    const { agent } = await connectAgent({
      resolveLaunch: async () => ({
        command: '/nonexistent/pi-runner-for-test',
        args: ['--flag'],
        env: { PATH: process.env.PATH ?? '' },
        electronRunAsNode: false,
      }),
    })
    // spawn error 路径没有 engine_opened/engine_open_failed 回执——open 永远等不到应答，
    // 只挂 catch 防 unhandled rejection，终态断言走 engine_closed 帧（桩按 Node 同款
    // 异步 error + 无 pid 形态送达）
    void agent.open(launchSpec(), 'open-spawn-err').catch(() => {})
    const closed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed,
      'engine_closed(spawn error)',
    )
    // SPAWN_FAILURE_EXIT_CODE（127，command not found 惯例）
    expect(closed.code).toBe(127)
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
  })

  it('hello 后畸形帧：丢弃并保持连接可用', async () => {
    const { agent } = await connectAgent()
    await agent.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.helloOk, 'hello_ok')
    agent.sendRaw('not-json {{{') // 解析失败 → 丢弃、连接保持

    // 连接仍可用：合法 open 照常走通
    const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 'open-after-bad'))
    expect(channelId).toBeTruthy()
  })

  it('destroy 时 socket 文件被目录占位：unlink 失败降级，关停不阻断', async () => {
    const { server } = await setupServer_z2()
    const socketPath = server.listeningSocketPath
    rmSync(socketPath)
    mkdirSync(socketPath) // 目录占位 → unlinkSync 必失败

    await expect(server.destroy()).resolves.toBeUndefined()
    expect(existsSync(socketPath)).toBe(true)
    // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除与在途异步写竞争防瞬态失败
    rmSync(socketPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('引擎目录只读：pid 文件写失败降级，open 照常成功', async () => {
    const { agent, dataDir } = await connectAgent()
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    chmodSync(enginesDir, 0o555)
    try {
      const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 'open-pidfail'))
      expect(channelId).toBeTruthy() // pid 文件写失败不阻塞（退出走清理）
    } finally {
      chmodSync(enginesDir, 0o755)
    }
  })

  it('引擎目录只读 + 引擎退出：pid 文件清理失败降级，closed 照常送达', async () => {
    const { agent, dataDir } = await connectAgent()
    const { channelId } = expectOpened(
      await agent.open(launchSpec({ args: ['--exit-on', 'bye', '--exit-code', '7'] }), 'open-cleanup'),
    )
    const enginesDir = getControlEnginesDir(dataDir)
    chmodSync(enginesDir, 0o555)
    const closed = await byeAndExpectClosed(agent, channelId, 7)
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    chmodSync(enginesDir, 0o755) // 恢复写权限：降级残留的 pid 文件随 tmp 清理
  })
})
});

// ======================================================================
// ← src/__tests__/infra/subagent-control/mirror-integration.test.ts
// ======================================================================

/** spawn 闸门（hoisted：vi.mock factory 与用例都要读写同一对象）。 */
const spawnGate_m2 = vi.hoisted(() => ({ real: false }))


// 引擎进程换进程内桩：fd3 由桩的 stdio[3] 提供（真 spawn 恒开 4 个 pipe，同构）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { fakeSpawn } = await import('./fake-engine.js')
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options?: unknown) =>
      spawnGate_m2.real
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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mirror-integration', () => {
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.destroy()
  }
  await Promise.all(tmpDirs.splice(0).map((d) => rmTmpDir(d)))
  resetFakeEngines()
})
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
});

// ======================================================================
// ← src/__tests__/infra/subagent-control/real-engine-integration.test.ts
