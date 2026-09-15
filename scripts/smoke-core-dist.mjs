#!/usr/bin/env node
/**
 * smoke-core-dist.mjs —— subagent-core dist 发布回归门（D9-②，设计
 * docs/architecture/subagent-core-package-extraction.md §3.3 D9-② / V7 产品化）。
 *
 * 背景：workspace 消费者永远吃最新 TS 源，npm 消费者吃 tsup dist——src 侧全绿
 * 不代表 dist 未坏（tsup 配置漂移 / 依赖升级 / d.ts 缺陷都可能「src 绿 dist 坏」
 * 照常发布）。本脚本在发布前强制走一遍 npm 消费者视角的最小回路：
 *
 *   1. build：cd packages/subagent-core && pnpm run build（tsup ESM+CJS 双 dist）
 *   2. require：node require CJS dist——主入口 + 三条语义子入口
 *      （engine/paths、engine/engine-discovery-scan、relay-env；[W11/H3] 引擎
 *      子入口已随内建引擎删除），
 *      经 package.json exports 的 require 条件解析（Node self-reference），
 *      等价验证 npm 消费者的加载路径与 exports→dist 映射，而非直接拼文件路径；
 *      随后同一 CJS 上下文跑 dist 行为断言——主入口（routeEngine mock 注入断言
 *      三层路由 call 层生效 + DEFAULT_DATA_ROOT / CORE_PACKAGE_VERSION 导出形态）
 *      与 engine/paths 子入口（纯函数确定性输出）；5 个入口的 .d.cts 类型产物
 *      做存在性断言（[W11] 起为 3+1 个入口）。语义边界如实登记：V7 golden 回放跑在 src TS 源（步骤 3 的
 *      vitest），dist 侧行为面 = 上述主入口 + paths 子入口断言，d.cts 仅验证
 *      存在性（不做内容 / TS 编译面校验）
 *   3. golden 回放：vitest run 跑 conformance 免 LLM 免二进制测试集
 *      （golden-replay.pi/zcode + contract.probe/abort/agent-events/read-degradation，
 *      全部 fake 注入），质量资产随 dist 形态可用
 *
 * 全绿 exit 0；任一步失败非零退出（发布管线据此拦截）。
 *
 * 挂载点（发布门接线，u1-guards）：
 *   - scripts/npm-prerelease.sh 阶段 1.5（本地，分支/changeset 变更之前，fail-fast）
 *   - .github/workflows/release-npm.yml publish job（"Publish to npm" 步骤之前）
 *
 * node 版本说明：engines 声明 node>=20。本脚本实际执行环境跟随调用方
 * （本机 dev / release-npm.yml CI 均为 node 24）。TODO(node20 runner)：真正的
 * node 20 require 复验需 node 20 runner——[W11/H3] 起 core dist 全入口
 * require 链不含 node:sqlite（bare import("sqlite") 守卫已随 reader 迁引擎包
 * 构建），node 20 可加载面与 node 24 一致。语义等价声明：本脚本在 node 24 上
 * 验证的是「构建产物可加载 + exports 映射正确 + golden 回放绿」的回归语义。
 *
 * 零第三方依赖（node:child_process/node:module/node:path）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CORE_DIR = join(ROOT, 'packages', 'subagent-core')
const CORE_PKG_NAME = '@zhushanwen/subagent-core'

// conformance 免 LLM 免二进制测试集（golden 回放层；engine-conformance.live.test.ts
// 是真机 live 层，刻意不在列——发布门不允许依赖真机/凭据）
const GOLDEN_TEST_FILES = [
  'src/execution/engine/__tests__/conformance/golden-replay.pi.test.ts',
  'src/execution/engine/__tests__/conformance/golden-replay.zcode.test.ts',
  'src/execution/engine/__tests__/conformance/contract.probe.test.ts',
  'src/execution/engine/__tests__/conformance/contract.abort.test.ts',
  'src/execution/engine/__tests__/conformance/contract.agent-events.test.ts',
  'src/execution/engine/__tests__/conformance/contract.read-degradation.test.ts',
]

// CJS dist 必须可加载的入口（exports require 条件的映射验证面）。
// [W11/H3] 引擎子入口 @zhushanwen/subagent-core/engines/zcode/{reader,constants}
// 已随内建引擎删除（impl-plan §2.11 二选一处置，选「删除这两项、保留其余 dist 冒烟」：
// 引擎包 @zhushanwen/zcode-subagent-cli 是 TS-source 包（无 CJS dist），不构成
// require 冒烟面；其产物自包含性由 check-engine-package-boundary / 打包 staging
// 冒烟覆盖）。
const CJS_ENTRY_SPECS = [
  CORE_PKG_NAME,
  `${CORE_PKG_NAME}/engine/paths`,
  `${CORE_PKG_NAME}/engine/engine-discovery-scan`,
  `${CORE_PKG_NAME}/relay-env`,
]

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`  ✗ ${cmd} ${args.join(' ')} 失败（exit ${r.status ?? r.signal}）`)
    process.exit(r.status ?? 1)
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 20) {
  console.error(`  ✗ node >= 20 required（engines），当前 ${process.versions.node}`)
  process.exit(1)
}

console.log('[1/3] build subagent-core dist（tsup ESM+CJS）...')
run('pnpm', ['run', 'build'], { cwd: CORE_DIR })

console.log('[2/3] require CJS dist（exports require 条件 → dist 产物）...')
// require 解析根锚定在 C 包内（Node self-reference）——等价 npm 消费者的
// exports 解析路径；dist 缺失/映射漂移都在此显式报错
const coreRequire = createRequire(join(CORE_DIR, 'package.json'))
for (const spec of CJS_ENTRY_SPECS) {
  try {
    const mod = coreRequire(spec)
    const ok = mod !== null && typeof mod === 'object'
    if (!ok) throw new Error(`module loaded but not an object namespace`)
    console.log(`  ✓ require("${spec}")`)
  } catch (e) {
    console.error(`  ✗ require("${spec}") 失败: ${e.message}`)
    console.error('    排查：cd packages/subagent-core && pnpm run build 后重跑；')
    console.error('    exports require 条件与 dist 产物映射核对 package.json（D4 双形态契约）')
    process.exit(1)
  }
}

console.log('  [2/3] dist 类型产物存在性断言（exports require.types → dist .d.cts，5 入口）...')
// npm 消费者的 TS 编译面走 exports require 条件的 types 字段——声明存在但 dist
// .d.cts 未产出（tsup dts 配置漂移）会让消费者类型解析断裂。路径按 exports
// require 条件映射推导（不手工拼），映射本身漂移也在此报错。
const pkgRaw = JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8'))
for (const spec of CJS_ENTRY_SPECS) {
  // spec → exports 键换算：主入口 spec 是完整包名，exports 键是 "."；
  // 子入口 spec 是 "pkg/sub"，exports 键是 "./sub"
  const exportsKey = spec === CORE_PKG_NAME ? '.' : `.${spec.slice(CORE_PKG_NAME.length)}`
  const dcts = pkgRaw.exports?.[exportsKey]?.require?.types
  if (typeof dcts !== 'string' || !dcts.endsWith('.d.cts')) {
    console.error(`  ✗ exports["${spec}"].require.types 缺失或非 .d.cts（D4 双形态契约漂移？核对 package.json exports）`)
    process.exit(1)
  }
  if (!existsSync(join(CORE_DIR, dcts))) {
    console.error(`  ✗ dist 类型产物缺失: ${dcts}（exports 声明了但 tsup 未产出——核对 packages/subagent-core/tsup.config.ts 的 dts 输出）`)
    process.exit(1)
  }
  console.log(`  ✓ ${dcts}`)
}

// dist paths 子入口行为断言（engine/paths 是零 IO 零状态的纯函数模块，读源码确认；
// 断言其确定性输出在 dist 形态下不变——路径穿越归一 + D5 journal 布局 SSOT）。
console.log('  [2/3] dist paths 子入口行为断言（纯函数确定性输出）...')
const pathsMod = coreRequire(`${CORE_PKG_NAME}/engine/paths`)
const pathsChecks = [
  {
    ok: pathsMod.sanitizeSeg('../../etc/passwd') === 'etc-passwd',
    msg: "sanitizeSeg 路径穿越归一（'../../etc/passwd' → 'etc-passwd'）",
  },
  {
    ok:
      pathsMod.resolveJournalPath('/data', 'zcode', 'pool:1', 'task 2') ===
      '/data/engines/zcode/pool-1/journal-task-2.jsonl',
    msg: 'resolveJournalPath 布局 SSOT 输出（D5 journal 路径形态）',
  },
]
for (const c of pathsChecks) {
  if (!c.ok) {
    console.error(`  ✗ dist paths 断言失败: ${c.msg}`)
    console.error('    排查：dist 行为面与 src 不一致——核对 packages/subagent-core/tsup.config.ts 与 src/execution/engine/paths.ts')
    process.exit(1)
  }
  console.log(`  ✓ ${c.msg}`)
}

// dist 主入口行为 golden 断言（同一 CJS 上下文）：上方 require 探针只证明「可加载 +
// exports 映射正确」，此处补最小行为面——纯路由与常量导出在 dist 形态下返回值
// 确定性正确。全部 mock 注入（零 LLM / 零子进程 / 零宿主状态）。语义边界见头注释：
// golden 回放本体跑在 src TS 源（步骤 3），dist 侧行为面 = 主入口 + paths 子入口
// 上述断言，不宣称「golden 在 dist 上字面成立」。
console.log('  [2/3] dist 主入口行为 golden 断言（routeEngine mock 注入 + 导出常量形态）...')
const coreMod = coreRequire(CORE_PKG_NAME)
let routed
try {
  routed = await coreMod.routeEngine({
    // 第一层（调用参数）非缺省引擎 → 必走 probe 分支；probe mock 返回 ok →
    // 确定性返回 { engineId: 'smoke-mock-engine', source: 'call' }，零 fallback
    routing: { callEngine: 'smoke-mock-engine' },
    strict: true,
    probe: async () => ({
      ok: true,
      engineVersion: '0.0.0-smoke',
      checks: [{ name: 'smoke', ok: true }],
    }),
    getEngineFn: () => ({ __smoke: true }),
    hasEngineFn: () => true,
    listEnginesFn: () => ['smoke-mock-engine'],
  })
} catch (e) {
  console.error(`  ✗ dist golden 断言失败: routeEngine 抛错: ${e.message}`)
  console.error('    排查：dist 产物行为面与 src 不一致（tsup 配置漂移 / 导出面收窄）——')
  console.error('    核对 packages/subagent-core/tsup.config.ts 与 src/execution/engine/routing.ts barrel 导出')
  process.exit(1)
}
const distGoldenChecks = [
  {
    ok: routed.engineId === 'smoke-mock-engine' && routed.source === 'call',
    msg: `routeEngine 三层路由第一层生效（engineId=${routed.engineId} source=${routed.source}）`,
  },
  {
    ok:
      typeof coreMod.DEFAULT_DATA_ROOT === 'string' &&
      coreMod.DEFAULT_DATA_ROOT.endsWith('.subagent-core'),
    msg: `DEFAULT_DATA_ROOT 为 string 且锚定 .subagent-core（实际 ${typeof coreMod.DEFAULT_DATA_ROOT}）`,
  },
  {
    ok: typeof coreMod.CORE_PACKAGE_VERSION === 'string' && coreMod.CORE_PACKAGE_VERSION !== '',
    msg: `CORE_PACKAGE_VERSION 非空 string（实际 ${typeof coreMod.CORE_PACKAGE_VERSION}）`,
  },
]
for (const g of distGoldenChecks) {
  if (!g.ok) {
    console.error(`  ✗ dist golden 断言失败: ${g.msg}`)
    console.error('    排查：dist 产物行为面与 src 不一致（tsup 配置漂移 / 导出面收窄）——')
    console.error('    核对 packages/subagent-core/tsup.config.ts 与 src/index.ts barrel（D5 公共 API 面）')
    process.exit(1)
  }
  console.log(`  ✓ ${g.msg}`)
}

console.log('[3/3] golden 回放层（conformance 免 LLM 免二进制，6 文件）...')
run('pnpm', ['exec', 'vitest', 'run', ...GOLDEN_TEST_FILES], { cwd: CORE_DIR })

console.log('✓ subagent-core dist smoke 通过（build + require CJS dist + golden 回放全绿）')
