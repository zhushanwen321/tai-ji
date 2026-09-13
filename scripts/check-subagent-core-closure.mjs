#!/usr/bin/env node
/**
 * check-subagent-core-closure.mjs —— subagent-core 依赖闭包守卫（D9-①）+ 检查点 5 断言。
 *
 * 背景：packages/subagent-core（@zhushanwen/subagent-core）是跨宿主共享的引擎中立
 * 执行层，设计红线 = 依赖闭包不含 pi SDK 与宿主专属依赖（否则 zcode 宿主被拖入
 * pi 依赖树，双宿主统一实现的目标失效）。人工 review 守不住漂移（设计 §2.3 实证），
 * 本脚本机器化该判据（docs/architecture/subagent-core-package-extraction.md §3.3 D9-①）。
 *
 * 检查项：
 * 0. 版本双源一致性（残留风险 11 闭合）：src/index.ts 的 CORE_PACKAGE_VERSION 与
 *    package.json version 两处字面量必须相等——手动同步漂移在 pre-commit/CI 拦截，
 *    不等发布现场（smoke 门仅断言非空，不比对）。
 * 1. package.json：dependencies + peerDependencies + optionalDependencies 不含
 *    禁用依赖（@earendil-works/* 前缀通配 + 四个宿主专属包精确/子路径匹配）。
 *    optionalDependencies 同样进入发布物运行时闭包（npm 会安装），与 deps/peers
 *    同判据，不扫 = 换段绕过。
 * 2. 源码 import 闭包：C/src 全量非测试源码（.ts/.mts/.cts/.js/.mjs/.cjs，
 *    .d.ts/.d.mts/.d.cts 声明文件豁免）的 import/export-from/动态 import/
 *    require 说明符不含禁用依赖。扫描面为可达闭包的超集（全量已发布源码；
 *    传递闭包经相对 import 的真实展开由检查项 3 的 worker 子图承载）。
 *    非测试源码中类型 import 同样违规——dist d.ts 会引用 pi 类型，npm 消费者
 *    （zsw 纯 CJS 无 TS loader）的 TS 编译面被拖入 pi SDK。
 *    __tests__/ 豁免：测试 type-only import 在编译期擦除、不进 dist、vitest 由
 *    workspace devDeps 解析，不构成发布物运行时闭包（mocks/ + vitest.config.ts
 *    alias 同理）。
 * 3. 检查点 5：worker 入口模块的 import 子图不含 core/host-services 与
 *    core/notify-ports（worker 内零宿主服务，设计 §5 检查点 5）。worker 入口
 *    集合（读码确认）：① workflows/ 全部脚本——worker 线程内经
 *    require(workerData.scriptPath) 或 SCRIPT_DIR 相对 require 加载
 *    （orchestration/worker-host.ts eval:true + worker-script-builder.ts 生成
 *    内联源码）；② worker-script-builder.ts 内联 worker 模板源码
 *    （new Worker(code, { eval: true }) 的执行体，字符串字面量承载）。
 *    orchestration/launcher.ts 是主线程编排（agent-call 经 postMessage 回主线程，
 *    AgentRunner 在主线程），不在 worker 闭包内。
 *
 * 扫描形态：原文 + 定向模式（同 check-extension-dependencies.mjs 的一层路径残留
 * 扫描），不做 JS/TS 词法化——正则字面量（实证 src/orchestration/script-lint.ts:531
 * /['"]/ 形态）会让简化 lexer 状态错乱漏报（fail-open），原文扫描宁可误报注释里的
 * import 语法样式（fail-closed，修注释即可），不漏真实违规。
 *
 * 零第三方依赖（node:fs/node:path/node:module）。退出码：0 = 通过；1 = 违规。
 *
 * 自测模式 --self-test（残留风险 10 闭合）：以子进程跑脚本本体，双探针（D9-①
 * import 闭包 + 检查点 5 worker 子图）各自注入违规源码 → 断言转红（exit 1 且
 * stderr 指名违规定位）→ 移除 → 断言复绿（exit 0），把 V6-①「守卫有牙」证据
 * 固化为可随时复现的命令。要求当前基线干净——基线本身红时复绿段诚实失败，不绕过。
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CORE_DIR = join(ROOT, 'packages', 'subagent-core')
const SRC_DIR = join(CORE_DIR, 'src')
const WORKFLOWS_DIR = join(CORE_DIR, 'workflows')
const PKG_FILE = join(CORE_DIR, 'package.json')

// D9-① 禁用依赖：pi SDK（前缀通配）+ 宿主专属包（精确匹配）
const BANNED_PREFIXES = ['@earendil-works/']
const BANNED_EXACT = new Set([
  '@zhushanwen/pi-extension-logger',
  '@zhushanwen/pi-pending-notifications',
  '@xyz-agent/session-delivery',
  '@zhushanwen/pi-file-lock',
])
// 精确项双口径：裸名精确相等 或 子路径 import（如 ".../pi-extension-logger/sub"）。
// 只匹配裸名时，子路径说明符绕过精确匹配——包根被 ban 则其任意子路径导出同 ban。
const isBanned = (spec) =>
  BANNED_PREFIXES.some((p) => spec.startsWith(p)) ||
  [...BANNED_EXACT].some((b) => spec === b || spec.startsWith(`${b}/`))

// 检查点 5：worker 内禁止到达的宿主服务模块（相对 src/ 的路径）
const HOST_SERVICE_MODULES = ['core/host-services.ts', 'core/notify-ports.ts']

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}
const rel = (p) => p.slice(ROOT.length + 1).split(sep).join('/')

// import/require 说明符提取模式（原文应用）
const FROM_SPEC_RE = /\bfrom\s*["']([^"']+)["']/g // import ... from / export ... from
const IMPORT_SPEC_RE = /\bimport\s*["']([^"']+)["']/g // side-effect import
const DYNAMIC_SPEC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g // dynamic import
const REQUIRE_SPEC_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g // cjs require
function extractSpecs(text, patterns) {
  const specs = []
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) specs.push(m[1])
  }
  return specs
}
const isNodeBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec)

// ── 自测模式 --self-test（见头注；黑盒跑子进程，不复用本模块顶层检查） ──────────
if (process.argv.includes('--self-test')) {
  const { spawnSync } = await import('node:child_process')
  const selfPath = fileURLToPath(import.meta.url)
  const runGuard = () => spawnSync(process.execPath, [selfPath], { encoding: 'utf-8' })
  // 双探针对应 V6-① 原始验证的两面：① D9-① import 闭包（命中检查项 2）；
  // ② 检查点 5 worker 子图（命中 3a——workflows 脚本 require 触达 src/）。
  const PHASES = [
    {
      label: 'D9-① import 闭包',
      probe: join(SRC_DIR, '__closure_selftest_probe__.mjs'),
      content: 'import "@earendil-works/pi-coding-agent"\n',
      redPattern: /__closure_selftest_probe__/,
    },
    {
      label: '检查点 5 worker 子图',
      probe: join(WORKFLOWS_DIR, '__cp5_selftest_probe__.cjs'),
      content: 'require("../src/core/host-services.ts")\n',
      redPattern: /host-services/,
    },
  ]
  let allOk = true
  for (const { label, probe, content, redPattern } of PHASES) {
    try {
      writeFileSync(probe, content)
      const red = runGuard()
      const redHit = red.status === 1 && redPattern.test(red.stderr ?? '')
      console.log(`  ${redHit ? '✓' : '✗'} [${label}] 注入探针 → 转红（exit ${red.status}${redHit ? '，stderr 指名违规定位' : '，未指名——守卫可能无牙'}）`)
      if (!redHit) {
        allOk = false
        console.error((red.stderr ?? '').split('\n').filter(Boolean).slice(0, 5).join('\n'))
      }
    } finally {
      rmSync(probe, { force: true })
    }
  }
  const green = runGuard()
  const greenOk = green.status === 0
  console.log(`  ${greenOk ? '✓' : '✗'} 移除双探针 → 复绿（exit ${green.status}${greenOk ? '' : '——基线不干净或守卫误报'}）`)
  if (!greenOk) {
    allOk = false
    console.error((green.stderr ?? '').split('\n').filter(Boolean).slice(0, 5).join('\n'))
  }
  if (!allOk) {
    console.error('subagent-core 闭包守卫自测未通过（注入不转红 / 移除不复绿——扫描面或 fail 链路断裂）')
    process.exit(1)
  }
  console.log('✓ 闭包守卫自测通过（D9-① 与检查点 5 双探针注入-转红-移除-复绿，V6-① 有牙证据固化为可复现命令）')
  process.exit(0)
}

// ── 0+1. package.json：版本双源一致性 + 禁用依赖 ───────────────
let pkg
try {
  pkg = JSON.parse(readFileSync(PKG_FILE, 'utf-8'))
} catch (e) {
  console.error(`  ✗ packages/subagent-core/package.json 解析失败: ${e.message}`)
  process.exit(1)
}

// 0. 版本双源一致性（残留风险 11 闭合，见头注检查项 0）：CORE_PACKAGE_VERSION 与
//    package.json version 两处字面量必须相等，手动同步漂移在此拦截而非发布现场。
const INDEX_TS = join(SRC_DIR, 'index.ts')
if (!existsSync(INDEX_TS)) {
  fail('找不到 src/index.ts（CORE_PACKAGE_VERSION 锚点文件被移动？请同步本守卫路径）')
} else {
  const vMatches = [...readFileSync(INDEX_TS, 'utf-8').matchAll(/export const CORE_PACKAGE_VERSION = "([^"]+)"/g)]
  if (vMatches.length === 0) {
    fail('src/index.ts 缺少 CORE_PACKAGE_VERSION 导出字面量（版本双源断言锚点丢失）')
  } else if (vMatches.length > 1) {
    fail(`src/index.ts CORE_PACKAGE_VERSION 声明出现 ${vMatches.length} 处（复制残留？锚点必须唯一——多声明会静默漏拦真实漂移）`)
  } else if (vMatches[0][1] !== pkg.version) {
    fail(`版本双源漂移: src/index.ts CORE_PACKAGE_VERSION = "${vMatches[0][1]}" ≠ package.json version = "${pkg.version}"（两处字面量须同步修改）`)
  }
}
let declaredDepCount = 0
for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[section] ?? {})) {
    declaredDepCount += 1
    if (isBanned(name)) {
      fail(`package.json ${section} 含禁用依赖: ${name}（pi SDK / 宿主专属依赖不得进入 subagent-core 闭包）`)
    }
  }
}

// ── 2. 源码 import 闭包（非测试源码全量扫描，扩展名见头注释检查项 2） ──────────
// 已发布源码的 TS/JS 全形态扩展名都在扫描面（.mts/.cts/.js/.mjs/.cjs 漏扫 =
// 换扩展名绕过）；声明文件（.d.ts/.d.mts/.d.cts）豁免——不承载可执行 import，
// 且其内容随实现文件进入检查项 2 的类型违规判据（非测试 type import 同样违规）。
const SRC_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']
const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts']
const isSrcFile = (name) =>
  SRC_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
  !DECLARATION_SUFFIXES.some((suffix) => name.endsWith(suffix))

function* walkSrc(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue // 豁免理由见头注释检查项 2
      yield* walkSrc(p)
    } else if (isSrcFile(entry.name)) {
      yield p
    }
  }
}
const SRC_SPEC_PATTERNS = [FROM_SPEC_RE, IMPORT_SPEC_RE, DYNAMIC_SPEC_RE, REQUIRE_SPEC_RE]
let srcFileCount = 0
let srcSpecCount = 0
for (const file of walkSrc(SRC_DIR)) {
  const specs = extractSpecs(readFileSync(file, 'utf-8'), SRC_SPEC_PATTERNS)
    .filter((s) => !s.startsWith('.'))
  srcFileCount += 1
  srcSpecCount += specs.length
  for (const spec of specs) {
    if (isBanned(spec)) {
      fail(`源码 import 闭包违规: ${rel(file)} import "${spec}"（类型 import 同样违规——dist d.ts 会引用 pi 类型）`)
    }
  }
}

// ── 3. 检查点 5：worker 入口 import 子图零宿主服务 ──────────────────
// 3a. workflows/ 脚本闭包。CJS 资产只扫 require()/import() 调用形态（不带 from
//     模式——散文 "parsed from "x"" 会误报）。可静态解析的形态：
//     - 字面量 require("spec")
//     - SCRIPT_DIR + "/y" 拼接（D1 scriptPath 目录锚定契约，SCRIPT_DIR =
//       dirname(workerData.scriptPath) = 顶层入口脚本目录）
//     - require(require("path").dirname(workerData.scriptPath) + "/y") 同义拼接
//     相对目标在 workflows/ 内递归展开；其余 require(<表达式>) 无法静态展开
//     → fail-closed（无法证明 = 不通过）。
const workerRoots = []
for (const name of readdirSync(WORKFLOWS_DIR)) {
  if (name.endsWith('.js') || name.endsWith('.cjs')) workerRoots.push(join(WORKFLOWS_DIR, name))
}
const SCRIPT_DIR_CONCAT_RE =
  /require\s*\(\s*SCRIPT_DIR\s*\+\s*["']([^"']+)["']\s*\)/g
const SCRIPT_PATH_DIRNAME_CONCAT_RE =
  /require\s*\(\s*require\s*\(\s*["']path["']\s*\)\s*\.\s*dirname\s*\(\s*workerData\s*\.\s*scriptPath\s*\)\s*\+\s*["']([^"']+)["']\s*\)/g
const LEFTOVER_CONCAT_RE =
  /require\s*\(\s*(?:SCRIPT_DIR|require\s*\(\s*["']path["']\s*\)\s*\.\s*dirname\s*\(\s*workerData\s*\.\s*scriptPath\s*\))\s*\+\s*["'][^"']*["']\s*\)/g

function checkWorkerTarget(target, fromFile, seen, rootDir) {
  if (!existsSync(target) || !statSync(target).isFile()) {
    fail(`worker 入口子图引用不可解析目标: ${target}（from ${rel(fromFile)}）`)
    return
  }
  const norm = target.split(sep).join('/')
  if (norm.startsWith(SRC_DIR.split(sep).join('/'))) {
    const srcRel = target.slice(SRC_DIR.length + 1).split(sep).join('/')
    if (HOST_SERVICE_MODULES.includes(srcRel)) {
      fail(`检查点 5 违规: worker 入口子图到达宿主服务模块 src/${srcRel}（worker 内零宿主服务——AgentRunner 在主线程，见设计 §5 检查点 5）`)
    } else {
      fail(`worker 入口子图到达 src/ 源码: src/${srcRel}（workflow 资产必须自包含——builtin staged 布局无 src/）`)
    }
    return
  }
  if (/\.(js|cjs|mjs)$/.test(target.split(sep).pop() ?? '')) {
    scanWorkerClosure(target, rootDir, seen)
  }
}

function scanWorkerClosure(file, rootDir, seen) {
  const key = resolve(file)
  if (seen.has(key)) return
  seen.add(key)
  const text = readFileSync(file, 'utf-8')
  // ① 拼接形态展开（目标以 "/" 开头，join 到入口脚本目录下）
  for (const re of [SCRIPT_DIR_CONCAT_RE, SCRIPT_PATH_DIRNAME_CONCAT_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      checkWorkerTarget(join(rootDir, m[1]), file, seen, rootDir)
    }
  }
  // ② 字面量说明符：node 内置是叶子；相对路径在 worker 资产内展开；
  //    裸名包违规（staged 布局无 node_modules，且禁宿主服务）
  for (const spec of extractSpecs(text, [REQUIRE_SPEC_RE, DYNAMIC_SPEC_RE])) {
    if (isNodeBuiltin(spec)) continue
    if (spec.startsWith('.')) {
      checkWorkerTarget(resolve(dirname(file), spec), file, seen, rootDir)
      continue
    }
    fail(`worker 入口子图违规: ${rel(file)} require/import "${spec}"（workflow 脚本只能用 node 内置与 scriptPath 目录锚定相对 require）`)
  }
  // ③ fail-closed：残余 require(<非字面量>) 无法静态展开
  const normalized = text.replace(LEFTOVER_CONCAT_RE, ' ')
  const leftover = /\brequire\s*\(\s*[^"')\s]/g
  while (leftover.exec(normalized) !== null) {
    fail(`worker 入口子图含无法静态解析的 require(...)（${rel(file)}）——闭包守卫无法证明 worker 零宿主服务，请改为字面量或 SCRIPT_DIR 拼接形态`)
  }
}
for (const root of workerRoots) {
  scanWorkerClosure(root, dirname(root), new Set())
}

// 3b. worker-script-builder.ts：eval:true 内联模板的承载文件。
//     模板源码在字符串字面量里，在 worker 线程执行——其 require 面只允许 node
//     内置，且禁止任何 host-services / notify-ports / 禁用依赖引用。该文件自身
//     的真实 import（主线程、type-only）不在 call-form 扫描面，不误报。
//     [已知局限（前瞻性登记，当前零实例）] ① FROM_HOST_RE 只拦「指向
//     host-services/notify-ports 的 from-import」——模板内其他裸 from-import
//     不拦，与上方 require 面的 fail-closed 口径不一致；② 本条正则作用于全文、
//     不区分模板字面量区段与主线程代码，worker-script-builder.ts 主线程侧未来
//     若合法 import core/host-services 会误报。修复方向（模板字面量区段提取 +
//     node 内置放行后的裸名 fail-closed）留待真实用例出现时实施。
const WSB_REL = 'src/orchestration/worker-script-builder.ts'
const wsbFile = join(CORE_DIR, WSB_REL)
if (existsSync(wsbFile)) {
  const text = readFileSync(wsbFile, 'utf-8')
  for (const spec of extractSpecs(text, [REQUIRE_SPEC_RE, DYNAMIC_SPEC_RE])) {
    const low = spec.toLowerCase()
    if (isNodeBuiltin(spec)) continue
    if (isBanned(spec) || low.includes('host-services') || low.includes('notify-ports')) {
      fail(`检查点 5 违规: ${WSB_REL} 内联 worker 模板引用 "${spec}"（模板字符串在 worker 线程执行，零宿主服务）`)
    } else {
      fail(`检查点 5 违规: ${WSB_REL} 内联 worker 模板 require "${spec}"（模板只能用 node 内置）`)
    }
  }
  const FROM_HOST_RE = /\bfrom\s*["'][^"']*(?:host-services|notify-ports)/gi
  if (FROM_HOST_RE.test(text)) {
    fail(`检查点 5 违规: ${WSB_REL} 出现指向 host-services/notify-ports 的 import（内联模板零宿主服务）`)
  }
} else {
  fail(`找不到 ${WSB_REL}（worker 模板承载文件被移动？请同步本守卫的检查点 5 路径）`)
}

// ── 汇总 ────────────────────────────────────────────────────────────
if (failed === 0) {
  console.log(
    `✓ subagent-core 依赖闭包干净（package.json deps+peers ${declaredDepCount} 项 · ` +
      `源码 ${srcFileCount} 文件 ${srcSpecCount} 个包级 import · ` +
      `worker 入口 ${workerRoots.length} 脚本 + 内联模板，检查点 5 断言通过）`,
  )
  process.exit(0)
}
console.error('subagent-core 依赖闭包守卫未通过（D9-①），修复上方 ✗ 明细后重跑')
process.exit(1)
