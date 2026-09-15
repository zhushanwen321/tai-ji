// S3 锁互操作探针 · 自实现侧 worker（u-lock-probe，设计 §4 S3 / §3.2 D1-A）。
//
// 用法：tsx scripts/probe/file-lock-interop-worker-self.ts <targetFile> <iterations> <tag> <coordDir>
//（coordDir = 启动屏障协调目录，编排方建好；手工跑传任意空目录即可——先跑者挂牌等待，
//  需手工创建 <coordDir>/go 放行，或直接经 test/file-lock-parity.test.ts 编排）
//
// 以「runtime 适配层」形态持有锁——packages/runtime/src/utils/file-lock.ts 的
// withFileLockAsync（内部经 @zhushanwen/pi-file-lock/core 自实现 mkdir 锁）。这正是
// runtime 与 pi 内嵌 proper-lockfile 在 auth.json / providers.json 上互斥同一把锁的
// 生产配对形态（auth-storage.ts / provider-extras-store.ts 消费面）。
//
// 每轮迭代：acquire（ELOCKED 指数退避等待）→ 临界区内 read-validate-append-write
// → release。临界区读全文并逐行校验形态——互斥一旦失效，并发 RMW 会产生丢行（后写者
// 覆盖先写者）或撕裂行，worker 当轮即失败退出；「读校验」同时是数据竞争的主动检测器，
// 不依赖最终态单一断言。
//
// 启动屏障（第 4 参数 coordDir）：两 worker 启动开销不对称（tsx ~300ms vs 纯 node
// 毫秒级），裸并发会让快侧先独跑完、慢侧全程无竞争（探针退化）。worker 就绪后写
// ready-<tag> 并等 go 文件，编排方收齐两个 ready 再放行——双方同刻起跑，并发形态
// 确定性成立。
//
// 经 tsx 运行（node_modules/tsx，runtime devDep）：native node 不做 .js→.ts 说明符
// 重写（ERR_MODULE_NOT_FOUND，已实测），runtime 适配层源码的相对 .js import 需要
// tsx 解析。产物：stdout 末行输出 JSON 结果（consumed by test/file-lock-parity.test.ts）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { withFileLockAsync } from '../../packages/runtime/src/utils/file-lock.js'

/** argv[0]=node、argv[1]=脚本路径，业务参数自下标 2 起。 */
const ARGV_FIRST_PARAM = 2
/** 用法错误的退出码（与运行失败 1 区分）。 */
const EXIT_USAGE = 2
/** 迭代间微抖动上限（ms）：保持双方在重叠时间窗内竞争。 */
const JITTER_MAX_MS = 7
/** 启动屏障 go 文件轮询间隔（ms）。 */
const GATE_POLL_MS = 2
/** 启动屏障：等待 go 文件的上限（编排方异常时的 fail-fast，防挂死）。 */
const GATE_TIMEOUT_MS = 15_000

const [targetRaw, iterationsRaw, tagRaw, coordDirRaw] = process.argv.slice(ARGV_FIRST_PARAM)
const target = targetRaw ?? ''
const iterations = Number.parseInt(iterationsRaw ?? '', 10)
const tag = tagRaw ?? 'a'
const coordDir = coordDirRaw ?? ''

if (!target || !Number.isInteger(iterations) || iterations <= 0 || !/^[a-z]$/.test(tag) || !coordDir) {
  console.error(`usage: tsx file-lock-interop-worker-self.ts <targetFile> <iterations> <tag(a|b)> <coordDir>`)
  process.exit(EXIT_USAGE)
}

const LINE_RE = /^(a|b):(\d+)$/

function validateLines(content: string): void {
  for (const line of content.split('\n')) {
    if (line === '') continue
    if (!LINE_RE.test(line)) {
      throw new Error(`[worker ${tag}] 撕裂/畸形行（互斥被破坏的痕迹）: ${JSON.stringify(line)}`)
    }
  }
}

async function main(): Promise<void> {
  // 启动屏障：就绪挂牌 → 等 go（编排方收齐双侧 ready 后放行，见文件头注释）
  writeFileSync(join(coordDir, `ready-${tag}`), '')
  const gateDeadline = Date.now() + GATE_TIMEOUT_MS
  while (!existsSync(join(coordDir, 'go'))) {
    if (Date.now() > gateDeadline) throw new Error(`[worker ${tag}] 启动屏障等待 go 超时（编排方未放行）`)
    await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS))
  }

  const startedAtMs = Date.now()
  for (let i = 1; i <= iterations; i++) {
    // 等待互斥：withFileLockAsync 内部 ELOCKED 退避重试（100ms~10s randomize ×10），
    // 预算内拿不到才抛——「全部成功获取」的验收语义由此承载
    await withFileLockAsync(
      target,
      {
        ensure: () => {},
        logTag: `s3-probe-worker-${tag}`,
      },
      async () => {
        // 首轮文件尚不存在 = 空内容（对端可能先创建；existsSync 显式判空，无异常路径）
        const content = existsSync(target) ? readFileSync(target, 'utf-8') : ''
        validateLines(content)
        writeFileSync(target, content + `${tag}:${i}\n`)
      },
    )
    // 迭代间微抖动：双方在重叠时间窗内持续竞争（保持真并发形态，
    // 避免一方纯顺序跑完、另一方独跑的退化解）
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * JITTER_MAX_MS)))
  }
  // startedAtMs/endedAtMs（epoch ms）：供编排方断言两 worker 运行区间真实重叠
  //（并发形态守卫——防探针退化为先后交替执行仍「绿」）
  console.log(
    JSON.stringify({
      worker: tag,
      impl: 'self',
      iterations,
      ok: true,
      startedAtMs,
      endedAtMs: Date.now(),
    }),
  )
}

main().catch((err) => {
  console.error(`[worker ${tag}] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
