#!/usr/bin/env node
/**
 * check-publish-surface.mjs —— packages/ 方向 npm 发布面一致性守卫
 * （约束 C-proc-11，设计 docs/architecture/npm-publish-surface-guard.md）。
 *
 * 背景：npm 对 files 白名单里磁盘上不存在的条目静默跳过——白名单承诺与构建产出
 * 之间零反馈。subagent-core 0.4.0/0.5.1 tarball 缺 dist.bundle（files 声明了该档，
 * 但发布流程不构建它）即此缺口的事故形态。
 *
 * 动态发现：扫 packages/ 下 private !== true 且 files 含 dist 前缀目录条目的包
 * （当前 6 包：@xyz-agent/extension-protocol / @xyz-agent/session-delivery /
 * @zhushanwen/subagent-core / @zhushanwen/subagent-engine-sdk /
 * @zhushanwen/pi-subagent-cli / @zhushanwen/zcode-subagent-cli；
 * 未来新增 dist 发布包自动纳入守卫面）。
 *
 * 检查项（设计 D5，双向闭合「files ↔ 产物」两个漂移方向）：
 * 1. 幽灵条目（幽灵声明方向）：files 每个条目磁盘存在且非空——判定信号以磁盘
 *    stat 为准而非字符串尾斜杠（磁盘是目录 → 须至少含 1 文件；是文件 → 须存在
 *    且非零字节；glob 条目 → 须至少命中 1 文件）。npm 排除语义条目（`!` 前缀）
 *    是「从 tarball 扣掉」的规则、非存在性承诺，不参与幽灵检查与体积估算。
 * 2. 自包含探针（存在 dist.bundle 命名约定目录的包）：静态扫描
 *    dist.bundle/index.cjs 的全部 require 说明符，三步判定顺序钉死（设计 D3，
 *    顺序即防呆——fs/promises 内建子路径必须先于含 / 分流被 PASS）：
 *    ① isBuiltin（覆盖裸名 / node: 前缀 / 内建子路径三形态）
 *    ② 相对路径（./ ../ 开头）
 *    ③ 裸包名形态红（指向 tsup noExternal）；子路径形态须命中豁免清单（fail-closed）
 * 3. 产物目录反向覆盖（漏声明方向）：包目录下磁盘存在的顶层 dist* 目录必须被
 *    files 至少一个条目覆盖（目录条目或同名精确条目，允许无尾斜杠形态）。
 *
 * 体积估算 warning（不红，设计 D7 机器回显）：files 条目磁盘求和超 5MB 输出
 * warning，提示触发 D7 重审——重审触发不靠发布者人眼看 npm pack 输出。
 *
 * 运行时机：dist 类包构建之后（干净 checkout 上产物缺失即红——刻意不挂
 * pre-commit，设计 D2：dist 产物被 gitignore，与 extensions 方向不对称）。
 * 调用：`node scripts/check-publish-surface.mjs`（任意 cwd，路径自 import.meta.url
 * 推导）。全绿 exit 0（可有 notice/warning）；任一红 exit 1。零第三方依赖。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// 纯函数 + rootDir 注入导出面（scripts/__tests__/check-publish-surface.test.mjs
// 用 tmpdir fixture 驱动，不依赖真实仓库状态）。仅 CLI 直跑时执行下方 main()。
export {
  discoverGuardedPackages,
  checkGhostEntries,
  checkSelfContained,
  checkReverseCoverage,
  estimateFilesSize,
  runGuard,
}

/** 体积 warning 阈值（设计 D7：单版 tarball 总体积 > 5MB 触发重审） */
const SIZE_WARN_BYTES = 5 * 1024 * 1024

/**
 * 检查项 2 的子路径豁免清单（设计 D3：fail-closed，未命中即红）。
 * 成因：ajv 被 vendor 进 bundle 后，其 codegen 生成验证函数源码时写入的字符串
 * 字面量（scopeValue 的 code 属性）——进程内执行走 ref 注入、不发生真实 require，
 * 运行时自包含成立。产物实测 4 处，形态统一为 require("ajv/dist/runtime/<x>").default。
 * expectedCount 与 formAnchor 是防漏报锚点：命中超预期（同前缀混入真实 require）
 * 或形态失配即红；少于预期输出 notice 提示复核登记（vendor 版本变化的良性漂移）。
 */
const SUBPATH_EXEMPTIONS = [
  { prefix: 'ajv/dist/runtime/', expectedCount: 4, formAnchor: '.default' },
]

/** require 说明符提取（兼容单/双引号；共享 g 正则，重入前须重置 lastIndex） */
const REQUIRE_RE = /require\s*\(\s*["']([^"']+)["']\s*\)/g

// ---------- 磁盘工具 ----------

/** 递归收集目录下全部文件路径（照 check-extension-files.mjs 惯例） */
function listDirFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out
}

/**
 * glob 条目 → 正则（minimatch 语义：globstar（`**` 路径段）可匹配零层目录，
 * 单个 `*` 不跨目录段）。语义与 check-extension-files.mjs 的 inWhitelist 同源，
 * 实现改为分段转换：原脚本的链式 replace 会对前一步已插入的 globstar 正则片段
 * 二次替换其中的 `*`，使无目录前缀的 globstar 形态（如顶层 `**` 加斜杠通配 .js）
 * 退化为只匹配单层前缀——本守卫的 files 条目会出现该形态，故按声称语义正确实现
 * （分段转换杜绝二次改写）。
 */
function globToRegExp(glob) {
  const segs = glob.split('/')
  let out = '^'
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const isLast = i === segs.length - 1
    if (seg === '**') out += isLast ? '.*' : '(?:[^/]+/)*'
    else {
      out += seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
      if (!isLast) out += '/'
    }
  }
  return new RegExp(`${out}$`)
}

// ---------- 动态发现（设计 D5） ----------

/**
 * 扫 packages/ 下的 dist 发布包：private !== true 且 files 含 dist 前缀目录条目
 * （含 / 的条目取第一段判断前缀——"dist.bundle/" → "dist.bundle"；无 / 的条目
 * 整体判断——"dist"）。files 无 dist 条目的 TS 源直发包（pi-* extension 形态）
 * 不纳入——它们的声明都是 git 内源文件，不存在本缺口。
 */
function discoverGuardedPackages(packagesDir) {
  const found = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgFile = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(pkgFile)) continue
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))
    if (pkg.private === true) continue
    const files = Array.isArray(pkg.files) ? pkg.files.filter((f) => typeof f === 'string') : []
    const hasDistEntry = files.some((f) => {
      const first = f.includes('/') ? f.split('/')[0] : f
      return first.startsWith('dist')
    })
    if (hasDistEntry) found.push({ name: pkg.name ?? entry.name, dir: dirname(pkgFile), files })
  }
  return found
}

// ---------- 检查项 1：幽灵条目（幽灵声明方向） ----------

/**
 * files 每个条目磁盘存在且非空。判定信号以磁盘 stat 为准而非字符串尾斜杠：
 * 磁盘是目录 → 递归须至少含 1 文件（npm pack 对空目录同样静默跳过）；是文件 →
 * 须存在且非零字节；含 glob 字符 → 须至少命中 1 文件。
 * 恢复指引按条目形态分流（fixFor）：dist 前缀产物档 → 补构建命令；纯文件条目
 * → 补文件或删条目二选一（非构建产物进不了 workflow 构建段）。
 * 返回 problem 消息数组（多行：定性 + 恢复指引，行首 ✗ 包名前缀由 runGuard 拼）。
 */
function checkGhostEntries(pkgDir, files, pkgName) {
  const problems = []
  // 首段判 dist 前缀与 discoverGuardedPackages 同规则（含 / 取第一段，glob 条目
  // 如 "dist/**/*.cjs" 首段同为 "dist"）；README.md / LICENSE 等纯文件条目指到
  // workflow 构建段会失准——它们不是构建产物。
  const fixFor = (entry) => {
    const first = entry.includes('/') ? entry.split('/')[0] : entry
    return first.startsWith('dist')
      ? `  修复：在 .github/workflows/ 的 release-npm.yml / release-npm-dev.yml / ci.yml\n  三处构建段（ci.yml 段名 Build dist packages）为该档补齐构建命令\n  （pnpm --filter ${pkgName} run <script>）后重推 tag`
      : `  修复：该条目非构建产物——补文件（如 README.md）或从 files 删条目，二选一`
  }
  for (const entry of files) {
    // npm files 官方排除语义（"!path"）：排除规则声明的是「从 tarball 里扣掉」，
    // 不是文件存在性承诺——磁盘上无需存在对应路径，不参与幽灵检查（体积估算
    // 同理跳过：无法从 include 求和里正确扣除排除面，跳过 = 保守高估，warning
    // 方向安全）。
    if (entry.startsWith('!')) continue
    if (entry.includes('*')) {
      const re = globToRegExp(entry)
      const hit = listDirFiles(pkgDir).some((abs) => re.test(relative(pkgDir, abs)))
      if (!hit) {
        problems.push(`files 白名单 glob 条目 "${entry}" 未命中任何文件（幽灵条目）\n${fixFor(entry)}`)
      }
      continue
    }
    const abs = join(pkgDir, entry)
    if (!existsSync(abs)) {
      problems.push(`files 白名单条目 "${entry}" 在磁盘上不存在（幽灵条目）\n${fixFor(entry)}`)
      continue
    }
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (listDirFiles(abs).length === 0) {
        problems.push(`files 白名单条目 "${entry}" 在磁盘上是空目录（幽灵条目——npm pack 对空目录静默跳过）\n${fixFor(entry)}`)
      }
    } else if (st.isFile()) {
      if (st.size === 0) {
        problems.push(`files 白名单条目 "${entry}" 在磁盘上是零字节文件（幽灵条目）\n${fixFor(entry)}`)
      }
    } else {
      problems.push(`files 白名单条目 "${entry}" 磁盘形态异常（非文件非目录——无法验证非空）\n${fixFor(entry)}`)
    }
  }
  return problems
}

// ---------- 检查项 2：自包含探针（设计 D3 三步判定） ----------

/**
 * 静态扫描自包含档入口的全部 require 说明符。三步判定顺序钉死：
 * ① isBuiltin——覆盖裸名（fs）/ node: 前缀（node:fs）/ 内建子路径（fs/promises、
 *    node:fs/promises）三形态，命中即 PASS（不进豁免检查）；
 * ② 相对路径（./ ../ 开头）PASS；
 * ③ 剩余按是否含 / 分流——裸包名形态红（tsup external 残留的真实形态，指向
 *    bundleConfig.noExternal）；子路径形态须命中豁免清单才 PASS，未命中红。
 *
 * @param {string} entryFile 自包含档入口绝对路径（dist.bundle/index.cjs）
 * @param {string} entryRel 报错用相对形态标签
 * @param {string} pkgRel 报错用包目录相对路径（noExternal 修复指引定位 tsup.config.ts）
 */
function checkSelfContained(entryFile, entryRel = 'dist.bundle/index.cjs', pkgRel = 'packages/subagent-core') {
  const problems = []
  const notices = []
  if (!existsSync(entryFile)) {
    problems.push(`自包含档入口 ${entryRel} 不存在——探针无对象（fail-closed）`)
    return { problems, notices }
  }
  const src = readFileSync(entryFile, 'utf-8')
  const exemptions = SUBPATH_EXEMPTIONS.map((e) => ({ ...e, hits: 0, formMismatch: [] }))
  REQUIRE_RE.lastIndex = 0
  let m
  while ((m = REQUIRE_RE.exec(src))) {
    const spec = m[1]
    if (isBuiltin(spec)) continue
    if (spec.startsWith('./') || spec.startsWith('../')) continue
    if (!spec.includes('/')) {
      problems.push(
        [
          `自包含档 ${entryRel} 含外部依赖 require("${spec}")`,
          `  ——自包含档必须内联全部运行时依赖（vendoring 宿主无 node_modules 解析面）`,
          `  修复：核对 ${pkgRel}/tsup.config.ts bundleConfig.noExternal 后重新构建`,
        ].join('\n'),
      )
      continue
    }
    const ex = exemptions.find((e) => spec.startsWith(e.prefix))
    if (!ex) {
      problems.push(
        [
          `自包含档 ${entryRel} 含子路径外部说明符 require("${spec}")——未命中豁免清单（fail-closed）`,
          `  处置：先分析形态——真实外部残留则修 ${pkgRel}/tsup.config.ts bundleConfig.noExternal；`,
          `  确认为 vendor codegen 字符串字面量（进程内不真实 require）则进 SUBPATH_EXEMPTIONS 并注明成因`,
        ].join('\n'),
      )
      continue
    }
    ex.hits++
    const after = src.slice(m.index + m[0].length)
    if (!/^\s*\.default/.test(after)) ex.formMismatch.push(spec)
  }
  for (const ex of exemptions) {
    if (ex.formMismatch.length > 0) {
      problems.push(
        `豁免条目 "${ex.prefix}*" 形态锚点失配：命中处 require(...) 后未紧跟 "${ex.formAnchor}"（${ex.formMismatch.join(', ')}）——疑似非 codegen 字面量形态，按 fail-closed 复核豁免登记`,
      )
    }
    if (ex.hits > ex.expectedCount) {
      problems.push(
        `豁免条目 "${ex.prefix}*" 命中 ${ex.hits} 处 > 预期计数 ${ex.expectedCount}——同前缀混入真实 require 调用？（前缀过宽被滥用的漏报面，复核豁免登记）`,
      )
    } else if (ex.hits < ex.expectedCount) {
      notices.push(`豁免条目 "${ex.prefix}*" 命中 ${ex.hits} 处 < 预期计数 ${ex.expectedCount}——豁免登记疑似过时，ajv 升级后请复核预期计数`)
    }
  }
  return { problems, notices }
}

// ---------- 检查项 3：产物目录反向覆盖（漏声明方向） ----------

/**
 * 包目录下磁盘存在的顶层 dist* 目录必须被 files 至少一个条目覆盖（目录条目
 * "dist.worker/" 或同名精确条目 "dist"——归一化尾斜杠后全等判定）。glob 条目
 * 不视为目录覆盖（设计 D5 只认目录条目 / 同名精确条目——fail-closed）。
 */
function checkReverseCoverage(pkgDir, files) {
  const problems = []
  for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dist')) continue
    const covered = files.some((f) => {
      if (f.includes('*')) return false
      return (f.endsWith('/') ? f.slice(0, -1) : f) === entry.name
    })
    if (!covered) {
      problems.push(
        [
          `产物目录 "${entry.name}/" 存在但未被 files 白名单覆盖`,
          `  ——未声明的产物不进 tarball（npm pack 静默跳过），消费方拿到的包缺该产物`,
          `  修复：发布产物则在 package.json files 补条目；非发布用途的构建目录改名（不得用 dist 前缀，见 C-proc-11）`,
        ].join('\n'),
      )
    }
  }
  return problems
}

// ---------- 体积估算（设计 D7 机器回显，不红） ----------

/** files 条目磁盘求和（目录递归 / glob 匹配 / 精确文件；幽灵条目自然跳过） */
function estimateFilesSize(pkgDir, files) {
  let total = 0
  for (const f of files) {
    if (f.startsWith('!')) continue // npm 排除语义条目：不参与求和（同 checkGhostEntries 注释）
    if (f.includes('*')) {
      const re = globToRegExp(f)
      for (const file of listDirFiles(pkgDir)) {
        if (re.test(relative(pkgDir, file))) total += statSync(file).size
      }
      continue
    }
    const abs = join(pkgDir, f)
    if (!existsSync(abs)) continue
    const st = statSync(abs)
    if (st.isFile()) total += st.size
    else if (st.isDirectory()) for (const file of listDirFiles(abs)) total += statSync(file).size
  }
  return total
}

// ---------- 聚合 ----------

/**
 * 全链路守卫（rootDir 可注入——单测 fixture 落 tmpdir 用，CLI 默认真实仓库根）。
 * 返回 { guarded, failures, notices, warnings }：failures 非空 = 红（exit 1 语义）；
 * notices / warnings 不影响绿。
 */
function runGuard(rootDir) {
  const failures = []
  const notices = []
  const warnings = []
  const guarded = discoverGuardedPackages(join(rootDir, 'packages'))
  for (const pkg of guarded) {
    const label = `✗ ${pkg.name}: `
    const pkgRel = relative(rootDir, pkg.dir)
    for (const p of checkGhostEntries(pkg.dir, pkg.files, pkg.name)) failures.push(label + p)
    for (const p of checkReverseCoverage(pkg.dir, pkg.files)) failures.push(label + p)
    const bundleDir = join(pkg.dir, 'dist.bundle')
    if (existsSync(bundleDir) && statSync(bundleDir).isDirectory()) {
      const { problems, notices: probeNotices } = checkSelfContained(
        join(bundleDir, 'index.cjs'),
        'dist.bundle/index.cjs',
        pkgRel,
      )
      for (const p of problems) failures.push(label + p)
      notices.push(...probeNotices)
    }
    const bytes = estimateFilesSize(pkg.dir, pkg.files)
    if (bytes > SIZE_WARN_BYTES) {
      warnings.push(
        `${pkg.name}: files 条目磁盘求和 ${(bytes / 1024 / 1024).toFixed(2)}MB 超 5MB——触发设计 D7 重审（重审双档发布形态，docs/architecture/npm-publish-surface-guard.md §3.3 D7）`,
      )
    }
  }
  return { guarded, failures, notices, warnings }
}

// main()：CLI 直跑才执行（vitest import 纯函数导出时不触发扫描/exit）
function main() {
  const { guarded, failures, notices, warnings } = runGuard(ROOT)
  for (const w of warnings) console.log(`  ⚠ ${w}`)
  for (const n of notices) console.log(`  ℹ ${n}`)
  if (failures.length > 0) {
    for (const f of failures) console.error(f)
    console.error(
      `✗ 发布面一致性未通过（${guarded.length} 个 dist 发布包扫描，${failures.length} 处红）——按上方修复指引处理后重跑 node scripts/check-publish-surface.mjs`,
    )
    process.exit(1)
  }
  console.log(`✓ 发布面一致（${guarded.length} 个 dist 发布包：幽灵条目 / 产物目录反向覆盖 / 自包含探针 全绿）`)
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href
if (isMain) main()
