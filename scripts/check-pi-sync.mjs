#!/usr/bin/env node
/**
 * check-pi-sync.mjs —— pi 构建期派生锚点跟随守卫。
 * （设计：docs/design/pi-evolution-consistency-and-project-switcher.md §3.2 方向 1A / D1 / D2；实施单元 u2）
 *
 * 与 check-pi-semantics.mjs 的分工（设计 §2.1 分工声明）——逐项零重叠自查：
 * - check-pi-semantics 管「实装内部一致 + pi 语义漂移」：pi-coding-agent/pi-ai/pi-agent-core
 *   三包实装互检 + runtime package.json 的 pi-ai pin 比对 + docs/pi-semantics.json 登记表
 *   schema/探针存在性/verifiedWith 门禁。本脚本不复刻其中任何一项（不做包间互检、不读
 *   pi-semantics.json），两脚本可独立运行、可同时全绿/全红。
 * - 本脚本管「构建期派生锚点的跟随」，基准只有两类（D1）：
 *   ① 声明基准 = 根 package.json 的 pi 包声明版本（devDependencies 优先，pnpm.overrides 兜底）
 *      → S1 build.yml PI_VERSION env / S2 prepare-pi-resources.sh 默认值 / S5 extensions pi 依赖
 *   ② 实装基准 = node_modules 实装版本（与声明的一致性由 check-pi-semantics 四包门禁先行锁定）
 *      → S3 快照 piAiVersion / S4 快照新鲜度 / S6 KNOWN_PI_API_TYPES / S7 pi-tui 实装
 *
 * 守卫矩阵 8 项（§3.2）：
 *   S1 build.yml PI_VERSION env == 声明 pi-coding-agent                  [声明/fail]
 *   S2 prepare-pi-resources.sh PI_VERSION 默认值 == 同上                  [声明/fail]
 *   S3 快照 piAiVersion == 实装 pi-ai                                     [实装/fail]
 *   S4 快照 providers/catalogGeneratedAt == 实装 pi-ai 内存重生成
 *      （import gen 脚本纯函数，零副作用不落盘；与 t10 测试构成 D3 明文的
 *       「不同拦截时点双通道」：t10 在测试期、本守卫在提交期+CI invariants） [实装/fail]
 *   S5 extensions 各包 package.json 的 pi 依赖 satisfies 对应包声明        [声明/fail]
 *   S6 KNOWN_PI_API_TYPES == pi-ai KnownApi 源码提取值                    [实装/fail]
 *   S7 实装 pi-tui == 声明 pi-tui（check-pi-semantics PI_PKGS 三包缺口的补位）[实装/fail]
 *   S8 resources/pi binary package.json 版本 == 声明 pi-coding-agent
 *      （dev-only：binary 缓存可有意多版本共存 → warn 不 fail；文件缺失如 CI 静默跳过）[声明/warn]
 *
 * 用法：
 *   node scripts/check-pi-sync.mjs               # 常规校验（pre-commit / CI invariants）
 *   node scripts/check-pi-sync.mjs --self-test   # 纯函数轻量自检（解析/satisfies/提取）
 *
 * 零第三方依赖。退出码：0 = 通过（允许含 warn）；1 = 存在 fail。
 * 解析失败一律 fail（宁可误报不可漏报，§3.1 终态 1 失败路径）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_YML = join(ROOT, '.github', 'workflows', 'build.yml')
const PREPARE_SH = join(ROOT, 'scripts', 'prepare-pi-resources.sh')
const SNAPSHOT_JSON = join(ROOT, 'packages', 'runtime', 'src', 'generated', 'builtin-providers.json')
const GEN_SCRIPT = join(ROOT, 'packages', 'runtime', 'scripts', 'gen-builtin-providers.mjs')
const SHARED_CONSTANTS = join(ROOT, 'packages', 'shared', 'src', 'constants.ts')
const ROOT_PKG = join(ROOT, 'package.json')
const PI_SCOPE = '@earendil-works'
const PI_CODING_AGENT = `${PI_SCOPE}/pi-coding-agent`
const PI_TUI = `${PI_SCOPE}/pi-tui`
const PI_AI = `${PI_SCOPE}/pi-ai`
const RESOURCES_PI_PKG = join(ROOT, 'apps', 'electron', 'resources', 'pi', 'package.json')

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}
const warn = (msg) => console.warn(`  ⚠ ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)

// ── 纯函数（--self-test 覆盖）────────────────────────────────────────

/** 提取 build.yml 的 PI_VERSION env 值。恰 1 处命中返回 {version}，否则 {error}（含 0 处/多处的歧义态）。 */
export function parseBuildYmlPiVersion(text) {
  const matches = [...text.matchAll(/^\s*PI_VERSION:\s*['"]([^'"]+)['"]\s*$/gm)]
  if (matches.length === 0) return { error: '未找到 PI_VERSION env（键被改名/移除？）' }
  if (matches.length > 1) return { error: `找到 ${matches.length} 处 PI_VERSION env，无法确定权威值` }
  return { version: matches[0][1] }
}

/** 提取 prepare-pi-resources.sh 的 PI_VERSION 默认值（PI_VERSION="${1:-X.Y.Z}"）。 */
export function parseScriptDefault(text) {
  const matches = [...text.matchAll(/PI_VERSION="\$\{1:-([^}]+)\}"/g)]
  if (matches.length === 0) return { error: '未找到 PI_VERSION="${1:-...}" 默认值行' }
  if (matches.length > 1) return { error: `找到 ${matches.length} 处默认值赋值，无法确定权威值` }
  return { version: matches[0][1] }
}

/** 从声明文本提取 semver（devDeps 若写成 ^x.y.z 也能取到版本主体；提取不到返回 null）。 */
export function extractSemver(text) {
  const m = String(text).match(/(\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

/** semver 比较：a<b → -1，a=b → 0，a>b → 1（仅数字段，pi 版本均为 x.y.z 形态）。 */
export function cmpSemver(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

/**
 * range 是否满足 version。支持 extensions peerDeps 实际在用的形态：
 * '*' / '^x.y.z' / '~x.y.z' / '>=x.y.z' / 'x.y.z'。无法识别返回 null（调用方按 fail 处理，宁可误报）。
 */
export function satisfiesRange(range, version) {
  const r = String(range).trim()
  if (r === '*') return true
  const m = r.match(/^(>=|\^|~)?(\d+\.\d+\.\d+)$/)
  if (!m) return null
  const [, op, base] = m
  if (!op) return cmpSemver(version, base) === 0
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null
  const c = cmpSemver(version, base)
  if (op === '>=') return c >= 0
  if (op === '^') {
    // semver caret 规范（0.x 是 pi 版本常态，必须按规范锁窄）：
    // ^x.y.z (x>0) = 同 major 且 >= base；^0.y.z = 同 major.minor 且 >= base；^0.0.z = 精确
    const [vmaj, vmin] = version.split('.')
    const [bmaj, bmin] = base.split('.')
    if (bmaj !== '0') return vmaj === bmaj && c >= 0
    if (bmin !== '0') return vmaj === bmaj && vmin === bmin && c >= 0
    return c === 0
  }
  // '~'：同 major.minor 且 >= base
  const [vmaj, vmin] = version.split('.')
  const [bmaj, bmin] = base.split('.')
  return vmaj === bmaj && vmin === bmin && c >= 0
}

/** 从 pi-ai dist/types.d.ts 文本提取 KnownApi 联合类型的字符串字面量集合。 */
export function extractKnownApi(dtsText) {
  const m = dtsText.match(/export type KnownApi\s*=\s*([\s\S]*?);/)
  if (!m) return { error: 'types.d.ts 中未找到 export type KnownApi 定义（pi-ai 源码形态变化？）' }
  const values = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  if (values.length === 0) return { error: 'KnownApi 定义中提取不到任何字符串字面量' }
  return { values }
}

/** 求集合差异：extra = a 有 b 无；missing = b 有 a 无。 */
export function setDiff(a, b) {
  const bs = new Set(b)
  const as = new Set(a)
  return {
    extra: [...as].filter((x) => !bs.has(x)),
    missing: [...bs].filter((x) => !as.has(x)),
  }
}

// ── --self-test：纯函数轻量自检（不触真实仓库文件）────────────────────

function selfTest() {
  const assert = (cond, name) => {
    if (!cond) {
      console.error(`  ✗ self-test: ${name}`)
      process.exitCode = 1
    } else {
      console.log(`  ✓ self-test: ${name}`)
    }
  }

  // parseBuildYmlPiVersion：命中 / 注释不误报 / 多值歧义 / 缺失
  const yaml1 = "env:\n  # 与 prepare-pi-resources.sh 默认值对齐（0.84.1）\n  PI_VERSION: '0.84.4'\n"
  assert(parseBuildYmlPiVersion(yaml1).version === '0.84.4', 'build.yml 解析命中且忽略注释')
  assert(parseBuildYmlPiVersion('env:\n  FOO: 1\n').error !== undefined, 'build.yml 缺 PI_VERSION 报 error')
  assert(
    parseBuildYmlPiVersion("PI_VERSION: '1.0.0'\nPI_VERSION: '2.0.0'\n").error !== undefined,
    'build.yml 多处 PI_VERSION 报 error（歧义态宁可误报）',
  )
  // parseScriptDefault
  assert(parseScriptDefault('PI_VERSION="${1:-0.84.4}"\n').version === '0.84.4', '脚本默认值解析命中')
  assert(parseScriptDefault('PI_VERSION="$1"\n').error !== undefined, '脚本默认值非 ${1:-} 形态报 error')
  assert(
    parseScriptDefault('PI_VERSION="${1:-1.0.0}"\nPI_VERSION="${1:-2.0.0}"\n').error !== undefined,
    '脚本多处默认值赋值报 error（歧义态宁可误报）',
  )
  // extractSemver / cmpSemver
  assert(extractSemver('^0.84.4') === '0.84.4' && extractSemver('latest') === null, 'extractSemver 提取与拒绝')
  assert(cmpSemver('0.84.4', '0.84.4') === 0 && cmpSemver('0.84.4', '0.84.10') < 0 && cmpSemver('1.0.0', '0.9.9') > 0, 'cmpSemver 三态')
  // satisfiesRange：extensions 实际在用的形态 + 拒绝未知形态
  assert(satisfiesRange('^0.84.4', '0.84.4') === true, '^0.84.4 satisfies 0.84.4')
  assert(satisfiesRange('^0.84.4', '0.85.0') === false, '^0.84.4 不满足 0.85.0（0.x caret 锁 minor）')
  assert(satisfiesRange('^0.84.4', '0.84.9') === true, '^0.84.4 satisfies 0.84.9（0.x caret 同 minor 补丁）')
  assert(satisfiesRange('^1.2.3', '1.9.0') === true && satisfiesRange('^1.2.3', '2.0.0') === false, '^1.2.3 非 0 major 同 major 语义')
  assert(satisfiesRange('^0.84.4', '1.84.4') === false, '^0.84.4 不满足跨 major')
  assert(satisfiesRange('>=0.73.0', '0.84.4') === true, '>=0.73.0 satisfies 0.84.4（plan 包形态）')
  assert(satisfiesRange('*', '0.84.4') === true, '* 恒满足（session-manager 形态）')
  assert(satisfiesRange('~0.84.4', '0.84.9') === true && satisfiesRange('~0.84.4', '0.85.0') === false, '~ 限 minor')
  assert(satisfiesRange('0.84.4', '0.84.4') === true && satisfiesRange('0.84.4', '0.84.5') === false, '精确版本')
  assert(satisfiesRange('latest', '0.84.4') === null, '未知 range 返回 null（调用方 fail 宁可误报）')
  // extractKnownApi：0.84.4 实测单行形态 + 多行形态
  const dts1 = 'export type KnownApi = "openai-completions" | "mistral-conversations" | "pi-messages";\nexport type Api = KnownApi | (string & {});'
  assert(JSON.stringify(extractKnownApi(dts1).values) === JSON.stringify(['openai-completions', 'mistral-conversations', 'pi-messages']), 'KnownApi 单行提取')
  const dts2 = 'export type KnownApi =\n  | "a"\n  | "b"\n;'
  assert(JSON.stringify(extractKnownApi(dts2).values) === JSON.stringify(['a', 'b']), 'KnownApi 多行提取')
  assert(extractKnownApi('export type Foo = "x";').error !== undefined, 'KnownApi 缺定义报 error')
  // setDiff
  const d = setDiff(['a', 'b'], ['b', 'c'])
  assert(JSON.stringify(d.extra) === '["a"]' && JSON.stringify(d.missing) === '["c"]', 'setDiff 双向差异')

  if (process.exitCode === 1) {
    console.error('pi-sync self-test 未通过')
    process.exit(1)
  }
  console.log('✓ pi-sync self-test 全部通过')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

// ── 实装定位（与 gen 脚本 readPiAiVersion 同款爬包根手法，校验 name 防爬出包）──

/** 定位 node_modules 实装 pi-ai 包根，返回 {root} 或 {error}。不执行 pi-ai 代码，纯路径解析。 */
export function resolvePiAiRoot() {
  let dir
  try {
    // exports 封锁 './package.json'，只能从可导入子路径入口爬（gen-builtin-providers.mjs 已验证）
    dir = dirname(fileURLToPath(import.meta.resolve(`${PI_AI}/providers/all`)))
  } catch (e) {
    return { error: `无法解析 ${PI_AI} 入口（未安装？）：${e.message.split('\n')[0]}` }
  }
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
      if (pkg.name === PI_AI) return { root: dir }
    } catch {
      // 当前目录无 package.json，继续向上
    }
    const parent = dirname(dir)
    if (parent === dir) return { error: `从 providers/all 入口向上未定位到 ${PI_AI} 包根` }
    dir = parent
  }
}

/** 读 node_modules 实装包版本；缺失返回 undefined。 */
function installedVersion(pkgName) {
  const file = join(ROOT, 'node_modules', ...pkgName.split('/'), 'package.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')).version
  } catch {
    return undefined
  }
}

// ── 基准读取 ─────────────────────────────────────────────────────────

let rootPkg
try {
  rootPkg = JSON.parse(readFileSync(ROOT_PKG, 'utf-8'))
} catch (e) {
  console.error(`  ✗ 根 package.json 不可解析: ${e.message}——恢复动作：修正 JSON 语法后重跑 node scripts/check-pi-sync.mjs`)
  process.exit(1)
}

/** 声明基准：devDependencies 优先，pnpm.overrides 兜底。返回原始声明文本或 undefined。 */
function declaredSpec(pkgName) {
  return rootPkg.devDependencies?.[pkgName] ?? rootPkg.pnpm?.overrides?.[pkgName]
}

/** 声明基准的 semver 主体（0.84.4）。缺失/不可解析返回 null。 */
function declaredVersion(pkgName) {
  const spec = declaredSpec(pkgName)
  return spec ? extractSemver(spec) : null
}

const declaredAgent = declaredVersion(PI_CODING_AGENT)
if (!declaredAgent) {
  console.error(
    `  ✗ 根 package.json 无 ${PI_CODING_AGENT} 可解析版本声明（D1 唯一锚点缺失）——恢复动作：在 devDependencies 声明精确版本后重跑 node scripts/check-pi-sync.mjs`,
  )
  process.exit(1)
}
console.log(`pi-sync 守卫：声明基准 ${PI_CODING_AGENT}=${declaredAgent}，实装基准取 node_modules`)

// ── S1 build.yml PI_VERSION env（声明基准）────────────────────────────
{
  if (!existsSync(BUILD_YML)) {
    fail(`S1 build.yml 不存在: ${BUILD_YML}——恢复动作：核对 .github/workflows/build.yml 是否被移动/删除（脚本以自身位置锚定仓库根，与当前工作目录无关），恢复文件后重跑 node scripts/check-pi-sync.mjs`)
  } else {
    const r = parseBuildYmlPiVersion(readFileSync(BUILD_YML, 'utf-8'))
    if (r.error) {
      fail(`S1 build.yml PI_VERSION env 无法解析: ${r.error}——恢复动作：核对 .github/workflows/build.yml env 段的 PI_VERSION: '<版本>' 键后重跑`)
    } else if (r.version !== declaredAgent) {
      fail(
        `S1 build.yml PI_VERSION env = ${r.version}, expected ${declaredAgent}——恢复动作：同步 .github/workflows/build.yml 的 PI_VERSION 到根 package.json 的 ${PI_CODING_AGENT} 版本（混装 binary 风险：JS 层与 binary 协议漂移），重跑 node scripts/check-pi-sync.mjs`,
      )
    } else {
      ok(`S1 build.yml PI_VERSION env = ${r.version}`)
    }
  }
}

// ── S2 prepare-pi-resources.sh 默认值（声明基准）──────────────────────
{
  if (!existsSync(PREPARE_SH)) {
    fail(`S2 prepare-pi-resources.sh 不存在: ${PREPARE_SH}——恢复动作：确认脚本未被移动/改名`)
  } else {
    const r = parseScriptDefault(readFileSync(PREPARE_SH, 'utf-8'))
    if (r.error) {
      fail(`S2 prepare-pi-resources.sh 默认值无法解析: ${r.error}——恢复动作：核对脚本头部 PI_VERSION="\${1:-X.Y.Z}" 行后重跑`)
    } else if (r.version !== declaredAgent) {
      fail(
        `S2 prepare-pi-resources.sh 默认值 = ${r.version}, expected ${declaredAgent}——恢复动作：同步 scripts/prepare-pi-resources.sh 第 14 行附近默认值到 ${declaredAgent}，重跑 node scripts/check-pi-sync.mjs`,
      )
    } else {
      ok(`S2 prepare-pi-resources.sh 默认值 = ${r.version}`)
    }
  }
}

// ── 实装基准可用性探测（S3/S4/S6 共用）───────────────────────────────
const piAiRoot = resolvePiAiRoot()
let installedAiVersion
if (piAiRoot.error) {
  fail(
    `S3/S4/S6 前置：node_modules 实装 pi-ai 不可用（${piAiRoot.error}）——恢复动作：仓库根执行 pnpm install 后重跑 node scripts/check-pi-sync.mjs`,
  )
} else {
  try {
    installedAiVersion = JSON.parse(readFileSync(join(piAiRoot.root, 'package.json'), 'utf-8')).version
  } catch (e) {
    fail(`S3/S4/S6 前置：实装 pi-ai package.json 不可读（${piAiRoot.root}）：${e.message}`)
  }
}

// ── S3 快照 piAiVersion == 实装（实装基准）───────────────────────────
let snapshot
{
  if (!existsSync(SNAPSHOT_JSON)) {
    fail(`S3 快照不存在: ${SNAPSHOT_JSON}——恢复动作：执行 pnpm gen:builtin-providers 生成后重跑`)
  } else {
    try {
      snapshot = JSON.parse(readFileSync(SNAPSHOT_JSON, 'utf-8'))
    } catch (e) {
      fail(`S3 快照 JSON 不可解析: ${e.message}——恢复动作：执行 pnpm gen:builtin-providers 重生成后重跑`)
    }
    if (snapshot && installedAiVersion && snapshot.piAiVersion !== installedAiVersion) {
      fail(
        `S3 快照 piAiVersion = ${snapshot.piAiVersion}, node_modules 实装 pi-ai = ${installedAiVersion}（快照未重生成或 gen 脚本未跑）——恢复动作：执行 pnpm gen:builtin-providers 重生成快照并 review diff，重跑 node scripts/check-pi-sync.mjs`,
      )
    } else if (snapshot && installedAiVersion) {
      ok(`S3 快照 piAiVersion = ${snapshot.piAiVersion} == 实装`)
    }
  }
}

// ── S4 快照新鲜度：磁盘快照 == 实装 pi-ai 内存重生成（实装基准，零副作用）──
{
  if (snapshot && installedAiVersion) {
    let gen
    try {
      // 动态 import：gen 脚本仅在直接执行时写文件（其尾部 main 守卫），import 复用纯函数零副作用
      gen = await import(pathToFileURL(GEN_SCRIPT).href)
    } catch (e) {
      fail(
        `S4 gen 脚本 import 失败（无法内存重生成快照）: ${e.message.split('\n')[0]}——恢复动作：确认 node_modules 实装完整（pnpm install）后重跑 node scripts/check-pi-sync.mjs`,
      )
    }
    if (gen) {
      try {
        const regenerated = gen.generateBuiltinProviders()
        const freshCatalogAt = gen.getBuiltinModelDataGeneratedAt?.() ?? snapshot.catalogGeneratedAt
        const sameProviders = JSON.stringify(snapshot.providers) === JSON.stringify(regenerated)
        const sameCatalogAt = snapshot.catalogGeneratedAt === freshCatalogAt
        if (!sameProviders || !sameCatalogAt) {
          const parts = []
          if (!sameProviders) parts.push('providers 内容不一致')
          if (!sameCatalogAt) parts.push(`catalogGeneratedAt 快照=${snapshot.catalogGeneratedAt} 实装=${freshCatalogAt}`)
          fail(
            `S4 快照过期（node_modules pi-ai 已是 ${installedAiVersion}，快照未重生成）：${parts.join('；')}——恢复动作：执行 pnpm gen:builtin-providers 重生成快照并 review diff（升级 PR 的快照 diff 需人工确认内容合理），重跑 node scripts/check-pi-sync.mjs`,
          )
        } else {
          ok(`S4 快照与实装重生成一致（${snapshot.providerCount} providers / ${snapshot.totalModels} models）`)
        }
      } catch (e) {
        fail(`S4 内存重生成失败（pi-ai 实装提取逻辑异常）: ${e.message.split('\n')[0]}——恢复动作：核对 gen 脚本与 pi-ai 实装兼容性（参考 packages/runtime/scripts/__tests__/gen-builtin-providers.test.ts）`)
      }
    }
  }
}

// ── S5 extensions pi 依赖 satisfies 声明（声明基准）──────────────────
{
  const extRoot = join(ROOT, 'extensions')
  let pkgFiles = []
  try {
    // extensions/<group>/<pkg>/package.json 三层结构，readdirSync 两层枚举（零外部依赖）
    for (const group of readdirSync(extRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      for (const pkgDir of readdirSync(join(extRoot, group.name), { withFileTypes: true })) {
        if (!pkgDir.isDirectory()) continue
        const f = join(extRoot, group.name, pkgDir.name, 'package.json')
        if (existsSync(f)) pkgFiles.push(f)
      }
    }
  } catch {
    pkgFiles = []
  }
  if (pkgFiles.length === 0) {
    fail(`S5 未找到任何 extensions package.json（${extRoot}）——恢复动作：确认 extensions/ 目录结构未被移动`)
  }
  let checked = 0
  let violations = []
  for (const file of pkgFiles) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      violations.push(`${file}: package.json 不可解析`)
      continue
    }
    const deps = { ...(pkg.peerDependencies ?? {}), ...(pkg.dependencies ?? {}) }
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith(`${PI_SCOPE}/`)) continue
      checked++
      const base = declaredVersion(name)
      if (!base) {
        violations.push(`${file}: ${name}@${range} —— 根 package.json 无该 pi 包声明基准（新 pi 包？先在根 devDependencies/overrides 声明）`)
        continue
      }
      const sat = satisfiesRange(range, base)
      if (sat === null) {
        violations.push(`${file}: ${name}@${range} —— range 形态无法解析（支持 * / ^ / ~ / >= / 精确版），人工核对后扩展 satisfiesRange`)
      } else if (!sat) {
        violations.push(`${file}: ${name}@${range} 不满足声明基准 ${name}=${base} —— 同步该 extension 的 pi 依赖 range`)
      }
    }
  }
  if (violations.length > 0) {
    for (const v of violations) fail(`S5 ${v}`)
    fail(`S5 汇总：${violations.length} 处不一致 / 共检查 ${checked} 条 pi 依赖声明——恢复动作：逐条同步 extensions package.json 后重跑 node scripts/check-pi-sync.mjs`)
  } else {
    ok(`S5 extensions pi 依赖均满足声明基准（${checked} 条 / ${pkgFiles.length} 包）`)
  }
}

// ── S6 KNOWN_PI_API_TYPES == pi-ai KnownApi 提取（实装基准）──────────
{
  if (piAiRoot.root) {
    const dtsPath = join(piAiRoot.root, 'dist', 'types.d.ts')
    if (!existsSync(dtsPath)) {
      fail(`S6 实装 pi-ai 的 types.d.ts 缺失: ${dtsPath}——恢复动作：确认 pnpm install 完整；若 pi-ai 改了类型文件布局，同步 check-pi-sync.mjs resolvePiAiRoot 的定位逻辑`)
    } else {
      const r = extractKnownApi(readFileSync(dtsPath, 'utf-8'))
      if (r.error) {
        fail(`S6 KnownApi 提取失败: ${r.error}——恢复动作：人工 diff ${dtsPath} 与 packages/shared/src/constants.ts 的 KNOWN_PI_API_TYPES，必要时同步两者与提取正则`)
      } else {
        // 从 shared 源码提取常量数组（避免 import TS；锚定 KNOWN_PI_API_TYPES 的 Set 初始化块）
        const constText = readFileSync(SHARED_CONSTANTS, 'utf-8')
        const cm = constText.match(/KNOWN_PI_API_TYPES[^[]*\[([\s\S]*?)\]/)
        if (!cm) {
          fail(`S6 packages/shared/src/constants.ts 中找不到 KNOWN_PI_API_TYPES 常量定义——恢复动作：确认常量未被改名/移动，同步 check-pi-sync.mjs 的提取正则`)
        } else {
          const local = [...cm[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
          const { extra, missing } = setDiff(local, r.values)
          if (extra.length === 0 && missing.length === 0) {
            ok(`S6 KNOWN_PI_API_TYPES 与实装 KnownApi 一致（${r.values.length} 值）`)
          } else {
            const parts = []
            if (extra.length > 0) parts.push(`常量多出: ${extra.join(', ')}`)
            if (missing.length > 0) parts.push(`常量缺失: ${missing.join(', ')}`)
            fail(
              `S6 KNOWN_PI_API_TYPES 与 pi-ai ${installedAiVersion ?? ''} KnownApi 漂移: ${parts.join('；')}——恢复动作：人工核对 ${dtsPath} 的 KnownApi 定义后同步 packages/shared/src/constants.ts（顺序保持与 KnownApi 一致），重跑 node scripts/check-pi-sync.mjs`,
            )
          }
        }
      }
    }
  }
}

// ── S7 实装 pi-tui == 声明（实装基准；check-pi-semantics PI_PKGS 三包缺口的补位）──
{
  const declared = declaredVersion(PI_TUI)
  if (!declared) {
    fail(`S7 根 package.json 无 ${PI_TUI} 声明基准——恢复动作：在 devDependencies（或 pnpm.overrides）声明后重跑`)
  } else {
    const installed = installedVersion(PI_TUI)
    if (installed === undefined) {
      fail(`S7 node_modules 缺 ${PI_TUI} 实装——恢复动作：仓库根 pnpm install 后重跑 node scripts/check-pi-sync.mjs`)
    } else if (installed !== declared) {
      fail(
        `S7 实装 ${PI_TUI}=${installed}, 声明=${declared}（实装与声明分裂）——恢复动作：同步根 package.json 的 ${PI_TUI} 声明与实装（pnpm install 重装）后重跑 node scripts/check-pi-sync.mjs`,
      )
    } else {
      ok(`S7 实装 pi-tui = ${installed} == 声明`)
    }
  }
}

// ── S8 dev binary 版本（声明基准，warn 级）────────────────────────────
{
  if (!existsSync(RESOURCES_PI_PKG)) {
    // CI / 未 prepare 的干净 checkout：binary 不在仓库内，静默跳过（矩阵注明 dev-only）
    ok('S8 resources/pi binary 不存在（CI 或未 prepare），跳过')
  } else {
    try {
      const pkg = JSON.parse(readFileSync(RESOURCES_PI_PKG, 'utf-8'))
      if (pkg.version !== declaredAgent) {
        warn(
          `S8 dev binary（resources/pi）版本 = ${pkg.version}, 声明 = ${declaredAgent} —— 仅警告不拦截：dev binary 走 workspace 缓存 symlink，可能有意保留多版本；发版前如需对齐执行 bash scripts/prepare-pi-resources.sh ${declaredAgent}`,
        )
      } else {
        ok(`S8 dev binary 版本 = ${pkg.version}`)
      }
    } catch (e) {
      warn(`S8 dev binary package.json 不可解析: ${e.message} —— 仅警告不拦截；如需对齐执行 bash scripts/prepare-pi-resources.sh ${declaredAgent}`)
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────
if (failed === 0) {
  console.log('✓ pi-sync 守卫通过（构建期派生锚点 8 项：声明基准 3 + 实装基准 4 + dev binary 1）')
  process.exit(0)
}
console.error('pi-sync 守卫未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）')
process.exit(1)
