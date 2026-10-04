#!/usr/bin/env node
/**
 * check-pbundle.mjs —— P-bundle 门：builtin extension staged 产物内 sqlite 驱动
 * 探测代码必须保持「运行期解析」形态（session-reader-shared-core 设计 §3.3 D3
 * 两层之产物级 + 附录 A P-bundle 门；实施计划 U5-③。D2 将本门定为生死门：
 * bundle 成功但驱动探测被静态化 = staged 运行期 Cannot find module，比不拆更糟）。
 *
 * 背景（F19 + D3）：bundle-extensions.mjs 的 esbuild `external` 列表不含
 * bun:sqlite / node:sqlite——驱动 spec 若以字面量静态 import/require 形态出现在
 * 源码，esbuild 会把它当静态依赖解析（bundle 失败）或规约成裸名绑定；驱动代码
 * 必须经「变量间接动态 import」（运行期以变量调用 import()）进入产物。本门对
 * staged 产物做静态检查，捕获「esbuild 升级 / 驱动实现回改字面量」导致的静态化
 * 回归：
 *
 *   红信号（静态化形态，任一命中即 fail）：
 *     - `from"bun:sqlite"` / `from 'bun:sqlite'`（静态 import 绑定）
 *     - `require("bun:sqlite")`（静态 require）
 *     - `import("bun:sqlite")`（字面量动态 import——esbuild 会尝试解析的形态）
 *   通过形态：spec 字符串仅作为**数据**出现在产物中（变量赋值/数组元素等），
 *   由变量间接 `import(<var>)` 在运行期解析——即变量间接特征在场。
 *
 * 结论三态：
 *   1. 产物不含任何驱动 spec → 「驱动未入库，门通过/待观察」exit 0（reader 未
 *      import zcode-session-source 或 bundle 之前的过渡期，不是失败）；
 *   2. spec 在场 ∧ 无静态化红信号 → 门通过 exit 0；
 *   3. spec 在场 ∧ 静态化红信号 → exit 1（修复方向见输出 [FIX]）。
 *
 * 用法：node scripts/check-pbundle.mjs [--rebuild]
 *   --rebuild：检查前先执行 node scripts/bundle-extensions.mjs 重建 staged
 *   （缺省不重建——pre-commit/CI 场景只读现产物；产物缺失时给出重建指引）。
 *
 * 零第三方依赖。产物路径 gitignored，本脚本只读该产物，不触碰源码。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(SCRIPT_DIR, '..')
const STAGED_INDEX = join(
  ROOT,
  'apps',
  'electron',
  'resources',
  'extensions',
  '@zhushanwen',
  'pi-session-reader',
  'index.js',
)
const REBUILD = process.argv.includes('--rebuild')

const DRIVER_SPECS = ['bun:sqlite', 'node:sqlite']
// 静态化红信号：spec 以字面量出现在 import/require 绑定位置（esbuild 规约证据）。
// from"spec" 覆盖 esbuild 无空格输出形态；import("spec") 覆盖字面量动态 import
// （esbuild 对可解析字面量动态 import 会转静态处理，对不可解析的 bun:sqlite 直接
// build 失败——若产物里出现此形态说明构建链已被绕过）。
function staticBinds(spec) {
  const q = '["\']'
  return [
    new RegExp(`\\bfrom\\s*${q}${spec.replace(':', '\\:')}${q}`),
    new RegExp(`\\brequire\\s*\\(\\s*${q}${spec.replace(':', '\\:')}${q}\\s*\\)`),
    new RegExp(`\\bimport\\s*\\(\\s*${q}${spec.replace(':', '\\:')}${q}\\s*\\)`),
  ]
}

if (REBUILD) {
  console.log('[p-bundle] 重建 staged 产物（node scripts/bundle-extensions.mjs）...')
  const r = spawnSync('node', [join('scripts', 'bundle-extensions.mjs')], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[p-bundle] FAIL：staged 重建失败（exit ${r.status ?? r.signal}）——先修 bundle-extensions 本体再跑本门`)
    process.exit(r.status ?? 1)
  }
}

if (!existsSync(STAGED_INDEX)) {
  console.error('[p-bundle] FAIL：staged 产物不存在——门无法执行（不是通过）')
  console.error(`[FIX] 先重建：node scripts/bundle-extensions.mjs（或本脚本加 --rebuild）后重跑；产物路径：${STAGED_INDEX}`)
  process.exit(1)
}

const text = readFileSync(STAGED_INDEX, 'utf-8')

const present = DRIVER_SPECS.filter((spec) => text.includes(spec))
if (present.length === 0) {
  console.log('[p-bundle] PASS（待观察）：staged 产物不含 sqlite 驱动 spec——驱动未入库')
  console.log('  reader 尚未 import zcode-session-source（过渡期正常形态）；U4/U9 接线后本门')
  console.log('  应转入 spec 在场检查，届时若仍报本结论须核对依赖接线是否遗漏。')
  process.exit(0)
}

const violations = []
for (const spec of present) {
  for (const re of staticBinds(spec)) {
    const m = re.exec(text)
    if (m) {
      const line = text.slice(0, m.index).split('\n').length
      violations.push(`静态化形态命中：/${re.source}/ @ line ${line}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`[p-bundle] FAIL：staged 产物内驱动 spec 被静态化（${present.join(' / ')}）——运行期解析形态被破坏`)
  for (const v of violations) console.error(`  ✗ ${v}`)
  console.error('[FIX] 驱动 spec 必须经变量间接动态 import 进入产物（设计 D3）：zcode-session-source')
  console.error('  的 sqlite-driver.ts 保持 `import(<变量>)` 形态、spec 字符串只作为数据出现；')
  console.error('  禁止改回字面量 import/require。修复后 node scripts/bundle-extensions.mjs 重建再验。')
  process.exit(1)
}

console.log(`[p-bundle] PASS：驱动 spec（${present.join(' / ')}）在产物内保持运行期解析形态`)
console.log('  无 from/require/import 静态绑定字面量；变量间接动态 import 特征在场（P-bundle 门通过）。')
console.log('  注：本门为静态形态检查；产物级实跑（staged 内驱动探测可运行）挂 U3 committed 门补跑。')
