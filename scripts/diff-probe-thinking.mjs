// 差分探针（G3，pi-boundary-reliability §3.3 D6/D7；U7b 改目标）：
// 比对「能力注册表计算路径」与 pi-ai 同源函数直调在思考档位上的逐模型一致性。
//
// 演化：U6 删除 resolveAvailableLevels（前端影子实现）后，原「xyz 实现 vs pi-ai」
// 比对对象已不存在；本探针改为守卫 registry 自身不漂移——
// packages/runtime/src/services/model-capability.ts 的 computeSupportedLevels
// 是 pi 档位语义在 xyz 侧的唯一入口（D2），若长出影子逻辑（改写 / 钳制 / 默认值
// 偏移），与 pi-ai getSupportedThinkingLevels 直调的差分即红。
//
// 比对集：
//   1. 代表性手工集：reasoning 缺失 / false（事故 B 形态，PS-02 两级门控）、
//      正常、无 map、mimo 族 map=null（PS-12）、xhigh/max 族；
//   2. builtin-providers.json 全目录（真实世界全量回归）。
//
// 用法：node scripts/diff-probe-thinking.mjs（任意 cwd；pre-commit G3 步 / 手动）
// 退出码：0 一致 / 1 不一致（✗ 明细 + 恢复动作）

import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// model-capability.ts 是 TS 源码，plain node 有两处吃不下：
//   ① class 参数属性（ModelCapabilityRegistry 构造器）——strip-only 模式不支持，
//     需 --experimental-transform-types；
//   ② 相对导入写 .js 后缀（TS 编译目标写法，源树下无 .js 产物）——需 resolve
//     回退到同名 .ts。
// 自包含处理（最小适配，不动源文件）：缺 flag 时重 exec 自身（对调用方透明，
// pre-commit / CI / 手动一律 `node scripts/diff-probe-thinking.mjs`）；
// resolve hook 就地注册（零旁文件）。
if (!process.execArgv.includes('--experimental-transform-types')) {
  const rerun = spawnSync(process.execPath, [
    '--experimental-transform-types',
    '--no-warnings',
    ...process.argv.slice(1),
  ], { stdio: 'inherit' })
  process.exit(rerun.status ?? 1)
}

const RUNTIME_SRC_URL_PREFIX = pathToFileURL(join(REPO_ROOT, 'packages', 'runtime', 'src') + '/').href
// [merge dev-0.9.17 2026-09] shared/src 前缀：logger.ts 的 readLogKeepDays
// （crash-resilience D6-⑦，该设计文档已删 git 可追溯）运行时 import '@xyz-agent/shared'
// → workspace exports 解析到 src/index.ts，其内部
// 是 bundler resolution 风格的无扩展名相对 import（'./protocol'）——Node ESM 严格解析吃不下，
// 与 runtime src 的 .js 后缀问题同型，hook 同款兜底（.ts 回退，bare specifier 不碰）。
const SHARED_SRC_URL_PREFIX = pathToFileURL(join(REPO_ROOT, 'packages', 'shared', 'src') + '/').href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && (context.parentURL ?? '').startsWith(RUNTIME_SRC_URL_PREFIX)) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      } catch {
        // 命中真实 .js 产物时回退原解析
      }
    }
    if (
      (context.parentURL ?? '').startsWith(SHARED_SRC_URL_PREFIX) &&
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.(js|ts|json|mjs|cjs|node|css)$/.test(specifier)
    ) {
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        // 目录 import / 真实产物存在时回退原解析
      }
    }
    return nextResolve(specifier, context)
  },
  // shared/src 的 json import 无 with { type: 'json' } 属性（bundler resolution 惯例，
  // vitest/打包链宽松），Node 严格 ESM 拒绝——load hook 把 json 短路成 ESM default export
  //（与 resolve hook 同款「不动源文件」哲学）。
  load(url, _context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export default ${JSON.stringify(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')))}\n`,
      }
    }
    return nextLoad(url)
  },
})

// 须在重 exec 守卫之后动态 import TS 模块（静态 import 会在守卫前求值）
const { computeSupportedLevels } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages', 'runtime', 'src', 'services', 'model-capability.ts')).href
)
const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai')
const builtinData = await import(
  pathToFileURL(join(REPO_ROOT, 'packages', 'runtime', 'src', 'generated', 'builtin-providers.json')).href,
  { with: { type: 'json' } },
)

// ── 代表性手工集（PS-02 两级门控 / PS-12 族钳制 / 无 map 回退的形态覆盖）──
const REPRESENTATIVE = [
  { id: 'reasoning-missing', model: { thinkingLevelMap: { off: 'off', high: 'high', max: 'xhigh' } } },
  { id: 'reasoning-false', model: { reasoning: false, thinkingLevelMap: { off: 'off', high: 'high', max: 'xhigh' } } },
  { id: 'normal-full-map', model: { reasoning: true, thinkingLevelMap: { off: 'off', high: 'high', max: 'xhigh' } } },
  { id: 'no-map', model: { reasoning: true } },
  { id: 'mimo-family-null-map', model: { reasoning: true, thinkingLevelMap: null } },
  { id: 'xhigh-max-family', model: { reasoning: true, thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' } } },
]

let total = 0
let mismatches = 0
const samples = []

function diff(id, model) {
  total++
  const expected = getSupportedThinkingLevels(model) // pi 权威（直调）
  const actual = computeSupportedLevels(model) // registry 计算路径（xyz 唯一入口）
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    mismatches++
    if (samples.length < 10) {
      samples.push({ id, reasoning: model.reasoning ?? null, map: model.thinkingLevelMap ?? null, expected, actual })
    }
  }
}

for (const { id, model } of REPRESENTATIVE) diff(id, model)
for (const p of builtinData.default.providers) {
  for (const m of p.models ?? []) {
    // 快照语义：thinkingLevelMap=null 表示 pi-ai 模型无此字段 → 等价 undefined
    const snapMap = m.thinkingLevelMap === null ? undefined : m.thinkingLevelMap
    diff(`${p.id}/${m.id}`, { reasoning: m.reasoning, thinkingLevelMap: snapMap })
  }
}

console.log(`total models: ${total}, mismatches: ${mismatches}`)
for (const s of samples) console.log(`✗ ${JSON.stringify(s)}`)
if (mismatches > 0) {
  console.error('✗ registry 计算路径与 pi-ai 同源函数不一致（G3 差分探针）')
  console.error('  恢复动作：检查 packages/runtime/src/services/model-capability.ts 的 computeSupportedLevels')
  console.error('  是否偏离「原样委托 pi-ai getSupportedThinkingLevels」（影子钳制/默认值 = 判据 1 复活），')
  console.error('  修复后重跑 node scripts/diff-probe-thinking.mjs')
  process.exit(1)
}
