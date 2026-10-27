#!/usr/bin/env node
// 调度层退出码判定：pnpm 递归 run 的 --no-bail 会继续跑完所有包（保全貌，b7ec0298a
// 立法动机）但退出码恒 0——失败事实本身被吞。两段式调度（test / test:integration）
// 的最终退出码改由本脚本对 junit 聚合判定：junit 由 taijiTestConfig 工厂 DEFAULTS
// 统一落在各包 test-results/vitest-junit.xml。
//
// 用法：
//   node scripts/check-test-results.mjs --clean   # 调度开头清掉上一轮 junit（防 stale 误判）
//   node scripts/check-test-results.mjs           # 调度末尾聚合判定：failures+errors>0 → exit 1
import { readdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 展开三类 junit 落点：packages/<pkg>/test-results、apps/<app>/test-results、apps/electron/main/test-results */
function collectResultDirs() {
  const dirs = []
  for (const base of ['packages', 'apps']) {
    const baseDir = path.join(repoRoot, base)
    if (!existsSync(baseDir)) continue
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(baseDir, entry.name, 'test-results')
      if (existsSync(candidate)) dirs.push(candidate)
    }
  }
  const mainResults = path.join(repoRoot, 'apps/electron/main/test-results')
  if (existsSync(mainResults)) dirs.push(mainResults)
  return dirs
}

if (process.argv.includes('--clean')) {
  let removed = 0
  for (const dir of collectResultDirs()) {
    rmSync(dir, { recursive: true, force: true })
    removed++
  }
  console.log(`[check-test-results] cleaned ${removed} test-results dirs`)
  process.exit(0)
}

const xmlPaths = collectResultDirs().flatMap((dir) =>
  readdirSync(dir).filter((f) => f.endsWith('.xml')).map((f) => path.join(dir, f)),
)
if (xmlPaths.length === 0) {
  console.error('[check-test-results] 未找到任何 junit 报告——调度链没有跑到任何包或 junit 覆盖被移除，按失败处理')
  process.exit(1)
}

// 零依赖解析：junit 的 testsuite 标签带 failures/errors 计数属性，属性正则即可。
let totalFail = 0
const failedSuites = []
for (const file of xmlPaths) {
  const rel = path.relative(repoRoot, file)
  const xml = readFileSync(file, 'utf8')
  for (const m of xml.matchAll(/<testsuite\b[^>]*>/g)) {
    const tag = m[0]
    const attr = (name) => {
      const a = tag.match(new RegExp(`${name}="(\\d+)"`))
      return a ? Number(a[1]) : 0
    }
    const fail = attr('failures') + attr('errors')
    totalFail += fail
    if (fail > 0) {
      const name = tag.match(/name="([^"]*)"/)?.[1] ?? '(unnamed)'
      failedSuites.push(`${rel} :: ${name} (${fail} failed)`)
    }
  }
}

if (totalFail > 0) {
  console.error(`[check-test-results] FAILED：${totalFail} 个失败断言，分布：`)
  for (const line of failedSuites) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`[check-test-results] OK：${xmlPaths.length} 份 junit 零失败`)
