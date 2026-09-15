/**
 * 双侧锁实现对照测试（integrity-hardening 实施审查 SUGGESTION #6）。
 *
 * runtime 侧 utils/file-lock.ts 与 extension 侧 @zhushanwen/pi-file-lock 的 sync 版
 * 是同一锁协议的两份孪生实现——「同一把锁」的互斥由 lockfile 路径推导一致
 * （<目标文件>.lock）+ mkdir 原子协议保证；两侧默认参数一致锚定的是夺取时机
 * （stale）与等待形态（retry 间隔/预算）行为一致。两份实现分属不同包，纯靠头注释互指的纪律同步会漂移：
 * ① 常量对照断言两侧导出的默认参数相等；② 行为对照断言两侧对同一目标文件
 * 真互斥（一侧持锁时另一侧按预算 fail-fast，释放后可获取）——后者同时守护
 * lockfile 路径推导不漂移。
 *
 * import 取舍：经包名主入口 import 会拉 extension-logger→pi SDK peer 链进
 * runtime 测试图（runtime 生产仅经 /core 零依赖子入口），对照测试以相对路径
 * 直连其 workspace 源码；若 extension 包移位，本测试的 import 会先于任何参数
 * 漂移红掉，兼作「孪生适配层位置契约」的护栏。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * S3 锁互操作集成探针（锁统一设计 §4 S3 / §3.2 D1-A，u-lock-probe 实施期门）：
 * runtime 自实现锁（经 @zhushanwen/pi-file-lock/core 的 withFileLockAsync 适配层）
 * × proper-lockfile@4.1.2 实库——两个真子进程对同一目标文件并发各循环 100 次
 * lock→write→unlock。这是「唯一跨实现互斥对」（设计 §3.2 D1-A：三方参与者中
 * runtime/extension 两侧同源 lock-core，协议按构造一致），实跑绿 = 待验证检查点 1
 * 的实施期门通过；探针红 = D1 不算完成，须升级主 agent，禁止调参掩盖。
 * 对端取 node_modules 实装 proper-lockfile@4.1.2（npm ls 核实与 pi
 * @0.84.4 内嵌同版本，设计 §3.2 D1-A 探针基线），取参照抄 pi auth-storage.js
 * acquireLockAsyncWithRetry（realpath:false / retries:0 / stale:30s + 调用方退避）。
 * utimes 精度边界（检查点 1 原文）：两侧在该参数形态下都不做周期 utimes touch
 * （pi 不传 update → proper-lockfile 默认间隔 stale/2=15s，临界区毫秒级且 release
 * 即 clearTimeout，touch 不发生；自实现无 touch），本探针行使的是 mkdir/rmdir/stat
 * 判死全协议。
 * worker 脚本在 scripts/probe/（领地约束），进程内并发 + fake timers 均不适用
 * （真实文件系统竞争，vitest 默认真实定时器）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_STALE_MS,
  withFileLockSync,
} from '../src/utils/file-lock.js'
import {
  DEFAULT_RETRY_BUDGET_MS as EXT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_DELAY_MS as EXT_RETRY_DELAY_MS,
  DEFAULT_STALE_MS as EXT_STALE_MS,
  withFileLockSync as extWithFileLockSync,
} from '../../../extensions/shared/file-lock/src/file-lock.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'file-lock-parity-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('file-lock parity（runtime ↔ extension sync 孪生实现）', () => {
  it('两侧默认参数相等（stale / retry 间隔 / 重试预算）', () => {
    expect(EXT_STALE_MS).toBe(DEFAULT_STALE_MS)
    expect(EXT_RETRY_DELAY_MS).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(EXT_RETRY_BUDGET_MS).toBe(DEFAULT_RETRY_BUDGET_MS)
  })

  it('默认值与登记表锁协议一致（stale 30s / 25ms / 1s，data-source-registry §6）', () => {
    expect(DEFAULT_STALE_MS).toBe(30_000)
    expect(DEFAULT_RETRY_DELAY_MS).toBe(25)
    expect(DEFAULT_RETRY_BUDGET_MS).toBe(1_000)
  })

  it('两侧共用同一 lockfile：一侧持锁时另一侧 fail-fast，释放后可获取', () => {
    const target = join(tmpDir, 'parity-target.json')
    const events: string[] = []

    withFileLockSync(target, () => {
      events.push('runtime-critical')
      // runtime 持锁期间，extension 侧取同一把锁：压缩预算快速验证 fail-fast
      //（抛 ELOCKED 而非静默拿到——证明两侧 lockfile 路径推导一致，互斥真实成立）
      expect(() =>
        extWithFileLockSync(target, () => events.push('ext-in-runtime-critical'), {
          retryDelayMs: 5,
          retryBudgetMs: 50,
        }),
      ).toThrow()
      expect(events).toEqual(['runtime-critical'])
    })

    // runtime 释放后 extension 立即可获取（无 stale 夺取冲突）
    extWithFileLockSync(target, () => events.push('ext-after-release'))
    expect(events).toEqual(['runtime-critical', 'ext-after-release'])
  })
})

// ──────────────────── S3 锁互操作集成探针（真子进程并发） ────────────────────

/** 本测试文件目录（packages/runtime/test）→ 仓库根（向上 3 级）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKER_SELF = join(REPO_ROOT, 'scripts', 'probe', 'file-lock-interop-worker-self.ts')
const WORKER_PL = join(REPO_ROOT, 'scripts', 'probe', 'file-lock-interop-worker-pl.mjs')
/** tsx CLI（runtime devDep，pnpm hoisted 布局下经 createRequire 从本文件位置可达）。 */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')

/** S3 每侧迭代数（设计 §4 S3：各循环 100 次 lock→write→unlock）。 */
const S3_ITERATIONS = 100

interface WorkerResult {
  code: number
  stdout: string
  stderr: string
}

function runWorker(command: string, args: string[], target: string, tag: string): Promise<WorkerResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, [...args, target, String(S3_ITERATIONS), tag, tmpDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => rejectP(err))
    child.on('exit', (code) => resolveP({ code: code ?? -1, stdout, stderr }))
  })
}

/** 启动屏障放行：等双侧 ready-<tag> 挂牌后写 go（tmpDir 即协调目录，随 afterEach 清理）。 */
async function releaseGate(): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(existsSync(join(tmpDir, 'ready-a')) && existsSync(join(tmpDir, 'ready-b')))) {
    if (Date.now() > deadline) throw new Error('启动屏障超时：worker ready 挂牌未收齐')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  writeFileSync(join(tmpDir, 'go'), '')
}

interface WorkerReport {
  worker: string
  impl: string
  iterations: number
  ok: boolean
  startedAtMs: number
  endedAtMs: number
}

/** 取 worker stdout 的末行 JSON（结果行）。 */
function parseWorkerReport(res: WorkerResult, tag: string): WorkerReport {
  const lines = res.stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  const report = JSON.parse(last) as WorkerReport
  expect(report.worker, `worker ${tag} 自报身份`).toBe(tag)
  expect(report.ok, `worker ${tag} 自报 ok`).toBe(true)
  expect(report.iterations, `worker ${tag} 完成迭代数`).toBe(S3_ITERATIONS)
  return report
}

describe('S3 锁互操作集成探针（runtime 自实现 × proper-lockfile@4.1.2 实库，真子进程并发）', () => {
  // 真实并发：两子进程各 100 轮「ELOCKED 等待 → 临界区 RMW → 释放」。本机实测 ~1s，
  // CI 慢机余量取 120s（vitest 默认 5s 远不够；无 fake timers——真实定时器是探针语义本体）
  it(
    '双方各 100 次 lock→write→unlock 并发竞争：全部成功获取（等待互斥）、最终内容无交错损坏',
    async () => {
      const target = join(tmpDir, 's3-target.jsonl')

      // 两个真子进程同时 spawn，启动屏障收齐双侧 ready 后同刻放行（并发非交替，
      // 且不受 tsx 与纯 node 启动开销不对称影响）
      const [selfRes, plRes] = await Promise.all([
        runWorker(process.execPath, [TSX_CLI, WORKER_SELF], target, 'a'),
        runWorker(process.execPath, [WORKER_PL], target, 'b'),
        releaseGate(),
      ])

      // ① 双方全部成功：退出码 0（任何一轮获取失败/校验失败 worker 都会非零退出）
      expect(selfRes.stderr, '自实现侧 worker stderr（失败现场）').toBe('')
      expect(selfRes.code, `自实现侧 worker 退出码（stderr: ${selfRes.stderr}）`).toBe(0)
      expect(plRes.stderr, 'proper-lockfile 侧 worker stderr（失败现场）').toBe('')
      expect(plRes.code, `proper-lockfile 侧 worker 退出码（stderr: ${plRes.stderr}）`).toBe(0)

      const selfReport = parseWorkerReport(selfRes, 'a')
      const plReport = parseWorkerReport(plRes, 'b')

      // ② 并发形态守卫：两 worker 运行区间真实重叠（防探针退化为先后交替执行仍「绿」）
      const overlapMs =
        Math.min(selfReport.endedAtMs, plReport.endedAtMs) - Math.max(selfReport.startedAtMs, plReport.startedAtMs)
      expect(overlapMs, '两 worker 运行区间重叠毫秒数（并发形态守卫）').toBeGreaterThan(0)

      // ③ 最终内容无交错损坏：恰好 200 行、行行成形、每方序号恰为 1..100 顺序完整
      //（并发 RMW 互斥失效 → 后写者覆盖先写者 → 丢行；撕裂写 → 畸形行——双双在此红）
      const content = await readFile(target, 'utf-8')
      const lines = content.split('\n').filter((l) => l !== '')
      expect(lines.length, '最终总行数（100×2，丢行 = 互斥被破坏）').toBe(S3_ITERATIONS * 2)

      const seqByWorker: Record<string, number[]> = { a: [], b: [] }
      let alternations = 0
      let prevWorker = ''
      for (const line of lines) {
        const m = /^(a|b):(\d+)$/.exec(line)
        expect(m, `畸形行（交错损坏痕迹）: ${JSON.stringify(line)}`).not.toBeNull()
        const worker = m![1]!
        seqByWorker[worker]!.push(Number(m![2]))
        if (worker !== prevWorker) alternations++
        prevWorker = worker
      }
      expect(seqByWorker.a, '自实现侧序号序列（须恰为 1..100 顺序完整）').toEqual(
        Array.from({ length: S3_ITERATIONS }, (_, i) => i + 1),
      )
      expect(seqByWorker.b, 'proper-lockfile 侧序号序列（须恰为 1..100 顺序完整）').toEqual(
        Array.from({ length: S3_ITERATIONS }, (_, i) => i + 1),
      )
      // 写序交替 ≥2 = 至少发生过一次持锁权易手（真竞争的直接物证；严格先后跑 = 恒 1）
      expect(alternations, 'a/b 写序交替次数（真竞争物证）').toBeGreaterThanOrEqual(2)
    },
    120_000,
  )
})
