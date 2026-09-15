// S3 锁互操作探针 · proper-lockfile 侧 worker（u-lock-probe，设计 §4 S3 / §3.2 D1-A）。
//
// 用法：node scripts/probe/file-lock-interop-worker-pl.mjs <targetFile> <iterations> <tag> <coordDir>
//（coordDir = 启动屏障协调目录，编排方建好；手工跑须自行创建 <coordDir>/go 放行，
//  或直接经 test/file-lock-parity.test.ts 编排）
//
// 持锁实现 = node_modules/proper-lockfile@4.1.2 实库（pi 内嵌同版本——npm ls 核实
// @earendil-works/pi-coding-agent@0.84.4 → proper-lockfile@4.1.2，node_modules 实装即
// pi 内嵌版的等价代表，设计 §3.2 D1-A「探针基线锁定 proper-lockfile 4.1.2」）。
//
// 取参忠实于 pi 真实驱动形态（node_modules/@earendil-works/pi-coding-agent/dist/core/
// auth-storage.js acquireLockAsyncWithRetry）：lock(path, { realpath: false, retries: 0,
// stale: 30_000 }) + 调用方退避循环 baseDelay = min(10·2^retry, 1000)、
// delay = round(base·(1+random))、30s deadline。pi 不传 update → proper-lockfile
// 默认间隔 stale/2=15s，临界区毫秒级且 release 即 clearTimeout，touch 不发生。
//
// 临界区协议与自实现侧 worker 对称（read-validate-append-write）——撕裂行/丢行在
// 当轮即失败。产物：stdout 末行 JSON 结果（consumed by test/file-lock-parity.test.ts）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import lock from 'proper-lockfile'

/** argv[0]=node、argv[1]=脚本路径，业务参数自下标 2 起。 */
const ARGV_FIRST_PARAM = 2
/** 用法错误的退出码（与运行失败 1 区分）。 */
const EXIT_USAGE = 2
/** 迭代间微抖动上限（ms）：保持双方在重叠时间窗内竞争。 */
const JITTER_MAX_MS = 7
/** 启动屏障：等待 go 文件的上限（编排方异常时的 fail-fast，防挂死）。 */
const GATE_TIMEOUT_MS = 15_000

const [targetRaw, iterationsRaw, tagRaw, coordDirRaw] = process.argv.slice(ARGV_FIRST_PARAM)
const target = targetRaw ?? ''
const iterations = Number.parseInt(iterationsRaw ?? '', 10)
const tag = tagRaw ?? 'b'
const coordDir = coordDirRaw ?? ''

if (!target || !Number.isInteger(iterations) || iterations <= 0 || !/^[a-z]$/.test(tag) || !coordDir) {
  console.error('usage: node file-lock-interop-worker-pl.mjs <targetFile> <iterations> <tag(a|b)> <coordDir>')
  process.exit(EXIT_USAGE)
}

const LINE_RE = /^(a|b):(\d+)$/

function validateLines(content) {
  for (const line of content.split('\n')) {
    if (line === '') continue
    if (!LINE_RE.test(line)) {
      throw new Error(`[worker ${tag}] 撕裂/畸形行（互斥被破坏的痕迹）: ${JSON.stringify(line)}`)
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 照抄 pi auth-storage.js acquireLockAsyncWithRetry 的等待循环（等待互斥，不 fail-fast）。 */
async function acquireWithPiRetry() {
  const staleMs = 30_000
  const maxDelayMs = 2_000
  const deadline = Date.now() + staleMs
  let retry = 0
  for (;;) {
    try {
      return await lock(target, { realpath: false, retries: 0, stale: staleMs })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
      const remainingMs = deadline - Date.now()
      if (code !== 'ELOCKED' || remainingMs <= 0) throw error
      const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2)
      retry++
      const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs)
      await sleep(delayMs)
    }
  }
}

async function main() {
  // 启动屏障：就绪挂牌 → 等 go（编排方收齐双侧 ready 后放行；两 worker 启动开销
  // 不对称——纯 node 毫秒级 vs tsx 数百毫秒——无屏障会让快侧先独跑完，探针退化）
  writeFileSync(join(coordDir, `ready-${tag}`), '')
  const gateDeadline = Date.now() + GATE_TIMEOUT_MS
  while (!existsSync(join(coordDir, 'go'))) {
    if (Date.now() > gateDeadline) throw new Error(`[worker ${tag}] 启动屏障等待 go 超时（编排方未放行）`)
    await sleep(2)
  }

  const startedAtMs = Date.now()
  for (let i = 1; i <= iterations; i++) {
    const release = await acquireWithPiRetry()
    try {
      // 首轮文件尚不存在 = 空内容（对端可能先创建；existsSync 显式判空，无异常路径）
      const content = existsSync(target) ? readFileSync(target, 'utf-8') : ''
      validateLines(content)
      writeFileSync(target, content + `${tag}:${i}\n`)
    } finally {
      await release()
    }
    await sleep(Math.floor(Math.random() * JITTER_MAX_MS))
  }
  // startedAtMs/endedAtMs（epoch ms）：供编排方断言两 worker 运行区间真实重叠
  //（并发形态守卫——防探针退化为先后交替执行仍「绿」）
  console.log(
    JSON.stringify({
      worker: tag,
      impl: 'proper-lockfile',
      iterations,
      ok: true,
      startedAtMs,
      endedAtMs: Date.now(),
    }),
  )
}

main().catch((err) => {
  console.error(`[worker ${tag}] FAILED: ${err && err.stack ? err.stack : String(err)}`)
  process.exit(1)
})
