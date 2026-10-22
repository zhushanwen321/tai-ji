/**
 * 跨代残留清理单测（L2，验收 ④，设计 §3.3 D7）：残留 socket 探活清理（死删活留）+
 * 孤儿引擎 pid 收割（owner runtime 死 → 立即组杀；owner 活 → 跳过；引擎已死 → 删档；
 * pid 复用 → 不杀只删）。附 paths 形状断言（socket 长度门禁 / pid 文件名清洗）。
 *
 * 整治口径（docs/TEST-STRATEGY.md「新写测试判据」节 1.2 节，判据三档）：
 * - socket 探活（connect 成败）是「代码 + OS」组合事实：无监听者的 socket 文件 connect
 *   报错、有监听者 connect 成功，探活内部的 1s 超时在事件 loop 拥塞下可能与 connect/
 *   error 事件竞争，把活文件误判成死文件。单测层改经 node:net mock 按路径注入探活
 *   结果，被测逻辑保持为 sweep 的裁决（扫全族 / 跳过自身路径 / 死删活留）；
 * - 孤儿收割的杀链同样全桩化：isPidAlive 按 pid 区分、start time 固定同秒、确认窗 0，
 *   三个裁决分支（杀灭删档 / owner 活跳过 / 引擎已死删档）纯同步可断言；
 * - 「组杀信号真的杀死真实进程 + kill 后确认窗内探活翻死」这条端到端事实没有完成信号
 *   可等，留 1 条真进程冒烟移出单测层：TAIJI_TEST_INTEGRATION 门控（SSOT =
 *   test-guard/integration-gate.ts），本地默认跳过、CI 常驻执行；
 * - 全部非门控用例零真实进程、零真实挂钟窗口，单条耗时毫秒级、负载无关。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isPidAlive } from '../../../utils/protocol-background-task.js'
import {
  assertSocketPathLength,
  CONTROL_ENGINES_DIR_NAME,
  getControlEnginesDir,
  getControlRunDir,
  getControlSocketPath,
  getEnginePidFilePath,
} from '../../../infra/subagent-control/paths.js'
import { sweepOrphanEnginePids, sweepStaleControlSockets } from '../../../infra/subagent-control/sweep.js'
import { makeServer, makeTmpDir, rmTmpDir, waitFor } from './test-helpers.js'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../../test-guard/integration-gate.ts'

/**
 * socket 探活桩（按路径注入探活结果）。node:net 仅覆写 connect——sweep 的探活是模块内
 * 唯一的 net.connect 调用点；createServer 等其余面原样保留（control server 的 listen
 * 走真实实现，其 listening 回调即确定性完成信号，属判据第二档）。
 */
const probePlan = vi.hoisted(() => ({
  /** 判定为「有监听者」的 socket 路径集合（不在集合内 = connect 报错 = 死文件）。 */
  alive: new Set<string>(),
  /** 实际被探活的路径（「自身路径不探」的断言凭据）。 */
  probed: [] as string[],
}))

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return {
    ...actual,
    connect: (opts: { path: string }) => {
      probePlan.probed.push(opts.path)
      const alive = probePlan.alive.has(opts.path)
      return {
        once: (event: string, cb: () => void): void => {
          if ((alive && event === 'connect') || (!alive && event === 'error')) queueMicrotask(cb)
        },
        destroy: (): void => {},
      }
    },
  }
})

const tmpDirs: string[] = []
const cleanupJobs: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const job of cleanupJobs.splice(0)) {
    await job()
  }
  await Promise.all(tmpDirs.splice(0).map((d) => rmTmpDir(d)))
})

describe('stale socket 清理（D7：扫 subagent-*.sock 全族）', () => {
  it('死文件（探活报错）删除；活文件（有监听者）保留；自身 socket 路径不探不删', async () => {
    const dataDir = await makeTmpDir('ctl-sweep-')
    tmpDirs.push(dataDir)
    const runDir = getControlRunDir(dataDir)
    mkdirSync(runDir, { recursive: true })

    const deadPath = join(runDir, 'subagent-88888.sock')
    const livePath = join(runDir, 'subagent-99999.sock')
    const selfPath = getControlSocketPath(dataDir) // 本实例即将 listen 的路径（不探不删）
    for (const p of [deadPath, livePath, selfPath]) writeFileSync(p, '')
    probePlan.alive.clear()
    probePlan.probed.length = 0
    probePlan.alive.add(livePath)

    await sweepStaleControlSockets(dataDir, selfPath)

    expect(existsSync(deadPath)).toBe(false) // 探活报错 → 死文件 → unlink
    expect(existsSync(livePath)).toBe(true) // 有监听者 → 保留（另一活实例在听，不动它）
    expect(existsSync(selfPath)).toBe(true) // 自身路径不探不删
    expect([...probePlan.probed].sort()).toEqual([deadPath, livePath].sort())
  })

  it('server init 触发同款清理：init 前放置的死残留被删，server 正常 listen', async () => {
    const dataDir = await makeTmpDir('ctl-sweep2-')
    tmpDirs.push(dataDir)
    const runDir = getControlRunDir(dataDir)
    mkdirSync(runDir, { recursive: true })
    const deadPath = join(runDir, 'subagent-77777.sock')
    writeFileSync(deadPath, '')
    probePlan.alive.clear()
    probePlan.probed.length = 0

    const server = makeServer(dataDir)
    cleanupJobs.push(() => server.destroy())
    await server.init()

    expect(existsSync(deadPath)).toBe(false)
    expect(existsSync(getControlSocketPath(dataDir))).toBe(true)
    // init 的清理只动跨代残留：本实例自身路径（skipPath）不被探活
    expect(probePlan.probed).not.toContain(getControlSocketPath(dataDir))
  })
})

describe('孤儿引擎 pid 收割（owner runtime 死 → 立即组杀）', () => {
  it('owner 死 + 引擎活 → 组杀 + 删档；owner 活 → 跳过；引擎已死 → 删档不杀', async () => {
    // 确定性同步化（2026-10-22 测试整治，docs/TEST-STRATEGY.md「新写测试判据」节 1.2 节）：
    // 原形态 spawn 两个真实长驻 node 进程 + 真实探活 + waitFor 真实杀灭，杀链确认依赖
    // 真实进程状态翻转（无完成信号可等，负载下窗口被拉长）。改全桩化——探活按 pid 区分、
    // kill 桩翻转存活态（= 杀灭成功）、start time 固定同秒（身份判定通过）、确认窗 0
    // （kill 后立即复核），三个裁决分支纯同步可断言。真实组杀端到端由下方 CI-only 冒烟承接。
    const dataDir = await makeTmpDir('ctl-pid-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })

    const deadOwnerPid = 999_999_999
    const orphanEnginePid = 424_242
    const guardedEnginePid = 424_243
    const deadEnginePid = 999_999_998
    const spawnedAt = 1_000_000 // epoch ms；秒值 1000，与下方 start time 桩同秒

    // ① 孤儿：owner runtimePid 死，引擎活
    writeFileSync(join(enginesDir, 'sess-1-fake-1-ch-1.pid'), JSON.stringify({
      pid: orphanEnginePid,
      spawnedAt,
      runtimePid: deadOwnerPid,
      instanceId: '999999999',
      hostKind: 'runtime-sidecar',
    }))
    // ② owner 活着（本测试进程）：另一活实例在管，跳过
    writeFileSync(join(enginesDir, 'sess-1-fake-2-ch-2.pid'), JSON.stringify({
      pid: guardedEnginePid,
      spawnedAt,
      runtimePid: process.pid,
      instanceId: String(process.pid),
      hostKind: 'runtime-sidecar',
    }))
    // ③ 引擎已死：只删档不杀
    writeFileSync(join(enginesDir, 'sess-1-fake-3-ch-3.pid'), JSON.stringify({
      pid: deadEnginePid,
      spawnedAt,
      runtimePid: deadOwnerPid,
    }))

    const alivePids = new Set<number>([orphanEnginePid, guardedEnginePid, process.pid])
    const killedPids: number[] = []
    await sweepOrphanEnginePids(dataDir, {
      isPidAlive: (pid) => alivePids.has(pid) && !killedPids.includes(pid),
      getProcessStartTimeSec: () => 1_000,
      killProcessTree: (pid) => {
        killedPids.push(pid)
      },
      killConfirmTimeoutMs: 0,
    })

    expect(killedPids).toEqual([orphanEnginePid]) // 只组杀 owner 已死的活引擎
    expect(existsSync(join(enginesDir, 'sess-1-fake-1-ch-1.pid'))).toBe(false) // 杀灭 → 删档
    expect(existsSync(join(enginesDir, 'sess-1-fake-2-ch-2.pid'))).toBe(true) // owner 活 → 保留
    expect(existsSync(join(enginesDir, 'sess-1-fake-3-ch-3.pid'))).toBe(false) // 引擎已死 → 删档
  })
})

describe('pid 判据与失败语义（m-rt-3 / m-rt-4）', () => {
  it('m-rt-3：start time 不可得（Windows/ps 不可用）→ 保守跳过击杀并保留 pid 文件', async () => {
    // 确定性同步化（2026-10-22 测试整治）：原形态 spawn 真实长驻进程 + 真实探活断言，
    // 只验「start time 取不到 → 不杀」的保守分支。改全桩化——无真实进程，引擎存活与
    // 身份不可得均由注入桩表达，分支裁决同步可断言。
    const dataDir = await makeTmpDir('ctl-pid-nostart-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const enginePid = 424_244 // 无真实进程——存活与身份由注入桩表达
    const pidFile = join(enginesDir, 'sess-x-fake-x-ch-x.pid')
    writeFileSync(pidFile, JSON.stringify({
      pid: enginePid,
      spawnedAt: 1_000_000,
      runtimePid: 999_999_999,
      instanceId: '999999999',
      hostKind: 'runtime-sidecar',
    }))

    const kill = vi.fn()
    await sweepOrphanEnginePids(dataDir, {
      isPidAlive: (pid) => pid === enginePid, // 引擎活（owner 死）
      getProcessStartTimeSec: () => undefined, // start time 不可得
      killProcessTree: kill,
    })
    expect(kill).not.toHaveBeenCalled()
    expect(existsSync(pidFile)).toBe(true) // 保留 + warn（宁不杀勿误杀）
  })

  it('m-rt-4：kill 未能杀灭（权限/系统错误）→ 保留 pid 文件供下次 sweep', async () => {
    // 确定性同步化（2026-10-22 测试整治，docs/TEST-STRATEGY.md「新写测试判据」节）：
    // 原形态 spawn 真实长驻进程 + 真实探活 + 真实 30ms 确认窗，有两处时序脆弱点——
    // ① 探测 start time 用「当前秒」，与 spawnedAt 跨秒边界时 pidStartMatchesRegistered
    //   的降级判据（actual <= floor(spawnedAt/1000)）翻转成「pid 已复用」误删档；
    // ② 探活与断言之间的间隙被 CPU 抢占拉长。
    // 「kill 未杀灭」前提改由注入桩表达：owner 判死 / 引擎判活（恒真桩需按 pid 区分，
    // 否则 ownerRuntimeAlive 提前跳过）、start time 固定同秒、kill 空操作、确认窗 0
    // （waitForProcessDeath 立即判超时 = 未死）。决策逻辑「确认窗过后仍活 → 保留」
    // 纯同步可断言；真进程 kill 失败路径的端到端验收由 CI-only 冒烟承接（todo 文档 1.2 节）。
    const dataDir = await makeTmpDir('ctl-pid-killfail-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const enginePid = 424_242 // 无真实进程——存活与身份由注入桩表达
    const pidFile = join(enginesDir, 'sess-y-fake-y-ch-y.pid')
    writeFileSync(pidFile, JSON.stringify({
      pid: enginePid,
      spawnedAt: 1_000_000, // epoch ms；秒值 1000，与下方 start time 桩同秒
      runtimePid: 999_999_999, // 非真实进程 → owner 判死（桩下同语义）
      instanceId: '999999999',
    }))

    await sweepOrphanEnginePids(dataDir, {
      isPidAlive: (pid) => pid === enginePid, // owner 死 / 引擎活（kill 未杀灭前提）
      getProcessStartTimeSec: () => 1_000, // 固定同秒：通过身份判定，无跨秒翻转
      killProcessTree: () => {},
      killConfirmTimeoutMs: 0, // 确认窗零等待：立即判「仍活」
    })
    expect(existsSync(pidFile)).toBe(true) // 未能杀灭 → 保留供下次 sweep
  })

  it('不可解析 pid 文件 → 保留 + warn（不静默销账）', async () => {
    // 无真进程形态：JSON 解析失败即返回（不进入任何 pid 探活），保留 + warn 交人工核实。
    const dataDir = await makeTmpDir('ctl-pid-corrupt-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const pidFile = join(enginesDir, 'sess-z-fake-z-ch-z.pid')
    writeFileSync(pidFile, '{"pid":')
    await sweepOrphanEnginePids(dataDir)
    expect(existsSync(pidFile)).toBe(true)
  })
})

/**
 * 真组杀冒烟（CI-only）：上面的收割裁决走注入桩，「kill 进程树真的杀死真实进程组 +
 * kill 后确认窗内探活翻死」是「代码 + OS」组合事实——没有完成信号可等，只能轮询观测，
 * 负载下窗口被拉长无稳定上界，不满足单测层「只测逻辑、高负载极快」定位（判据第三档）。
 * 门控 = TAIJI_TEST_INTEGRATION（SSOT = test-guard/integration-gate.ts）：本地默认跳过，
 * CI（test-runtime job 已设 env=1）与按改动范围触发时真跑。
 *
 * e2e-map 登记（待集中分配序号）：R2 / trigger=on-diff / layer=L2 / serial=true；
 * run = TAIJI_TEST_INTEGRATION=1 pnpm --filter @taiji/runtime exec vitest run
 * src/__tests__/infra/subagent-control/sweep.test.ts；scope = 本文件 import 的被测源
 * （infra/subagent-control/sweep.ts + paths.ts + control-server.ts）。
 */
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `孤儿引擎真组杀冒烟（真 node 长驻进程 × 真 kill 进程树）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
  () => {
    it('owner 死 + 真引擎进程 → 真实组杀 + 确认窗内探活翻死 → 删档', { timeout: 30_000 }, async () => {
      const dataDir = await makeTmpDir('ctl-pid-realkill-')
      tmpDirs.push(dataDir)
      const enginesDir = getControlEnginesDir(dataDir)
      mkdirSync(enginesDir, { recursive: true })
      const engine = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      const enginePid = engine.pid
      if (enginePid === null || enginePid === undefined) throw new Error('spawn pid unavailable')
      const pidFile = join(enginesDir, 'sess-rt-fake-rt-ch-rt.pid')
      writeFileSync(pidFile, JSON.stringify({
        pid: enginePid,
        spawnedAt: Date.now(),
        runtimePid: 999_999_999,
        instanceId: '999999999',
        hostKind: 'runtime-sidecar',
      }))

      try {
        // 全缺省依赖：真实探活 + 真实 start time（ps）+ 真实 kill 进程树 + 真实确认窗
        await sweepOrphanEnginePids(dataDir)
        await waitFor(() => !isPidAlive(enginePid), 'orphan engine reaped by real kill')
        expect(existsSync(pidFile)).toBe(false)
      } finally {
        engine.kill('SIGKILL')
      }
    })
  },
)

describe('paths 形状门禁', () => {
  it('socket 路径含 pid 唯一；超长路径 fail-fast（104 字节门禁）', () => {
    const p1 = getControlSocketPath('/tmp/dd')
    expect(p1).toContain(`subagent-${process.pid}.sock`)
    expect(assertSocketPathLength(p1)).toBeUndefined()

    const deep = `${'/x'.repeat(60)}/run`
    expect(() => assertSocketPathLength(getControlSocketPath(deep))).toThrow(/socket path too long/)
  })

  it('pid 文件名组件清洗（穿越/异常字符收窄为 _）+ 目录名常量', () => {
    const p = getEnginePidFilePath('../../etc', 'eng/ine', 'ch-1', '/tmp/dd')
    expect(p.startsWith(join('/tmp/dd', 'run', CONTROL_ENGINES_DIR_NAME))).toBe(true)
    // 组件清洗：路径分隔符与穿越序列收窄，文件名不含目录分隔符
    expect(basename(p)).toBe('.._.._etc-eng_ine-ch-1.pid')
  })
})
