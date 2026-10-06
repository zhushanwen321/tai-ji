#!/usr/bin/env node
/**
 * 代码重复度一键重跑（生产口径 SSOT，登记文档 = docs/CODE-DUPLICATION-BASELINE.md）。
 *
 * 口径（与登记文档逐字一致，改任何一项 = 基线失效，须同批重测登记文档数字）：
 *   工具 jscpd 5.4.0（本仓 node_modules 实装，npx --no-install 不拉网）
 *   参数 --min-tokens 50 --mode strict --format typescript（只认 .ts 逻辑通道，
 *   不开多语言——.vue 拆分通道与 .md/.css/.json 通道的重复多为 token/文档噪声，
 *   且与 .ts 同源重复双计）
 *   范围 packages apps extensions scripts e2e（全仓源码五域）
 *   排除 __tests__/*. *.test.ts *.spec.ts generated/ fixtures/ + node_modules、
 *   dist、dist.* 变体、resources（依赖与打包 staged 产物，非手写生产代码）
 *
 * 用法：node scripts/measure-code-duplication.mjs（输出 clones / duplicatedLines /
 * percentage 三数，与登记基线对照）。纯只读统计，不写仓库文件（报告落 os.tmpdir）。
 */
import { createRequire } from 'node:module'
import { rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const IGNORE = [
  '**/__tests__/**',
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/generated/**',
  '**/fixtures/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/dist.*/**',
  '**/resources/**',
].join(',')

const outDir = mkdtempSync(path.join(tmpdir(), 'jscpd-baseline-'))
// bin 入口取 jscpd package.json 的 bin 字段（硬编码文件名会随上游打包形态漂移）
const jscpdPkg = require('jscpd/package.json')
const jscpdBin = path.join(path.dirname(require.resolve('jscpd/package.json')), jscpdPkg.bin.jscpd)
const res = spawnSync(
  process.execPath,
  [jscpdBin, 'packages', 'apps', 'extensions', 'scripts', 'e2e',
    '--min-tokens', '50', '--mode', 'strict', '--format', 'typescript',
    '--reporters', 'json', '--output', outDir, '--ignore', IGNORE],
  { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120_000 },
)
if (res.error || res.status !== 0) {
  console.error(`[measure-code-duplication] jscpd 执行失败：${res.error ? res.error.message : `exit ${res.status}`}`)
  console.error(res.stderr ? res.stderr.split('\n').filter((l) => l && !l.startsWith('npm warn')).join('\n') : '')
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}
try {
  const report = JSON.parse(readFileSync(path.join(outDir, 'jscpd-report.json'), 'utf-8'))
  const s = report.statistics.total
  console.log(`jscpd 生产口径（min-tokens 50 / strict / typescript 通道 / 五域源码 / 排除测试与生成物）`)
  console.log(`clones=${s.clones} duplicatedLines=${s.duplicatedLines} percentage=${Number(s.percentage).toFixed(2)}%`)
  console.log(`登记基线与判读见 docs/CODE-DUPLICATION-BASELINE.md`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
if (res.error) {
  console.error(`[measure-code-duplication] jscpd 执行失败：${res.error.message}`)
  process.exit(1)
}
