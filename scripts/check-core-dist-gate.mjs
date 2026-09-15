#!/usr/bin/env node
/**
 * check-core-dist-gate.mjs —— subagent-core dist 静态验证门（设计
 * docs/design/subagent-post-convergence-architecture.md §3.2 B-2「dist 静态验证门」
 * ①② 两项的脚本化落点，u-2c（3d01d3132）D9 closure）。
 *
 * 背景：u-2c 删除 `./*` 开发态通配后，对 dist 产物做过三项一次性人工核验（结论仅存
 * commit message）：①主 bundle × 4 子入口重叠 module = 恰 4 个纯常量/函数模块；
 * ②4 子入口导出面 src↔dist 符号一致（3+9+5+8=25）；③require smoke。人工核验不可
 * 复跑——未来新增子入口 / tsup 配置漂移无机器拦截。本脚本把 ①② 固化为可复跑静态门
 * （③已有 scripts/smoke-core-dist.mjs 承载，不重复）。
 *
 * 门① 重复 module 重叠扫描：解析 bundle 内 esbuild module 标记（行首
 * `// <module path>` 注释，非压缩输出的标准形态），求主 bundle × 各子入口 bundle 的
 * module 交集。交集 module 逐个做模块级可变状态文本启发式检查（§3.2 B-2 实测 7 处
 * 模块级可变状态——双 bundle 各持一份副本时 configureCore 只写主 bundle 副本，子入口
 * 侧恒 undefined 的分裂风险）：模块顶层 let/var 声明（非 for 循环内）、模块级
 * new Map(/new Set(。含可变状态的交集 module = FAIL；纯常量/函数 = PASS（警告列出
 * ——重叠即双份分发，纯度靠启发式背书，新增顶层 let 时会被本门拦下）。
 * 语义边界（如实登记）：「对象字面量被内部函数写入」形态文本不可判，不在硬信号内；
 * ESM 侧子入口经 chunk 共享（运行时同实例，无分裂），但 chunk 拆分形态由 tsup
 * splitting 决定，重叠监测对 ESM 同样保留（配置漂移翻回物理重复时仍被覆盖）。
 *
 * 门② 子入口导出面 src↔dist 符号比对：对 exports 的每条子入口（非 `.`、非通配），
 * 从 src 入口（exports import 条件）解析具名导出符号，与 dist 对应 .d.cts
 * （exports require.types）及同基 .d.ts 的导出符号集双向比对，差集非空 = FAIL。
 * `export * from` 无法文本枚举——按依赖闭包守卫同款 fail-closed 处理，直接 FAIL。
 *
 * 运行时机：subagent-core build 之后（本脚本只读，不自行 build——dist 缺失即 FAIL，
 * 提示先 `cd packages/subagent-core && pnpm build`）；pre-merge / release 管线可挂。
 * 调用：`node scripts/check-core-dist-gate.mjs`（任意 cwd，路径自 import.meta.url 推导）。
 * 全绿 exit 0；任一 FAIL exit 1。零第三方依赖（node:fs / node:path / node:url）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CORE_DIR = join(ROOT, 'packages', 'subagent-core')
const PKG_PATH = join(CORE_DIR, 'package.json')

// 纯函数导出面（scripts/__tests__/check-core-dist-gate.test.mjs 直挂单测——发布门禁
// 解析逻辑的边界行为必须有机器锁定，见 MF-2）。仅 CLI 直跑时执行下方 main()。
// gateTwo 额外接受 coreDir 注入（默认 CORE_DIR）——单测 fixture 落 tmpdir 用，CLI 不传。
export {
  stripComments,
  parseExportBlocks,
  collectBundleClosure,
  extractSrcExportNames,
  reportExportDrift,
  gateTwo,
}

let failures = 0
function fail(msg) {
  failures++
  console.error(`  ✗ ${msg}`)
}
function ok(msg) {
  console.log(`  ✓ ${msg}`)
}

// ---------- 文本工具 ----------

/**
 * 剥离 // 与块注释（保留字符串字面量）——启发式解析前置，避免注释里的语法样式
 * 误报。已知局限：模板串 ${} 内嵌引号会提前结束字符串状态（倾向误报而非漏报，
 * 与依赖闭包守卫的 fail-closed 取向一致）。
 */
/** 行注释跳过：consume 到行尾（不含换行符——\n 留给主循环作为普通字符输出）。 */
function skipLineComment(text, i) {
  while (i < text.length && text[i] !== '\n') i++
  return i
}

/** 块注释跳过：consume 整段（含闭合定界符；EOF 处未闭合时越过末尾，主循环随之结束）。 */
function skipBlockComment(text, i) {
  i += 2
  while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
  return i + 2
}

/**
 * 字符串字面量整段消费：从开引号扫到匹配闭引号（`\x` 转义跳两个字符；未闭合时
 * 保留到 EOF）。返回原文片段（逐字节原样，含引号与转义）与游标后继。
 */
function consumeString(text, i) {
  const quote = text[i]
  let j = i + 1
  while (j < text.length) {
    if (text[j] === '\\') j += 2
    else if (text[j] === quote) return { chunk: text.slice(i, j + 1), next: j + 1 }
    else j++
  }
  return { chunk: text.slice(i), next: text.length }
}

function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '"' || c === "'" || c === '`') {
      const consumed = consumeString(text, i)
      out += consumed.chunk
      i = consumed.next
      continue
    }
    if (c === '/' && next === '/') {
      i = skipLineComment(text, i)
      continue
    }
    if (c === '/' && next === '*') {
      i = skipBlockComment(text, i)
      continue
    }
    out += c
    i++
  }
  return out
}

// esbuild module 标记：行首 `// <module path>`（必须是注释本体——从原文提取，
// 不能用 stripComments 后的文本）。扩展名过滤排除普通单词注释。
const MODULE_MARKER_RE = /^\/\/ (\S+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))\s*$/gm

// bundle 内相对依赖说明符（ESM from / 副作用 import / 动态 import / CJS require）
// ——ESM 子入口经 chunk 复用 module，闭包必须沿 chunk import 展开
const RELATIVE_SPECIFIER_RES = [
  /\bfrom\s*["'](\.[^"']+)["']/g,
  /\bimport\s+["'](\.[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
]

/** bundle module 闭包：入口文件 + 递归相对 import 的 chunk 文件内全部 module 标记 */
function collectBundleClosure(entryAbs) {
  const markers = new Set()
  const seen = new Set()
  const queue = [entryAbs]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const raw = readFileSync(file, 'utf8')
    const stripped = stripComments(raw)
    MODULE_MARKER_RE.lastIndex = 0
    for (const m of raw.matchAll(MODULE_MARKER_RE)) markers.add(m[1])
    for (const re of RELATIVE_SPECIFIER_RES) {
      re.lastIndex = 0
      for (const m of stripped.matchAll(re)) {
        const target = resolvePath(dirname(file), m[1])
        if (!seen.has(target) && existsSync(target)) queue.push(target)
      }
    }
  }
  return markers
}

/**
 * 模块级可变状态文本启发式（门① 硬信号）。列 0 锚定 = 模块顶层（函数/循环体内
 * 声明必然缩进；for 行以 for 开头不命中 let/var 规则）。
 */
function findModuleLevelMutableState(srcAbs) {
  const stripped = stripComments(readFileSync(srcAbs, 'utf8'))
  const signals = []
  const lines = stripped.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^(?:export\s+)?(?:let|var)\s+[A-Za-z_$]/.test(line)) {
      signals.push({ lineNo: i + 1, code: line.trim(), signal: '模块顶层 let/var 声明（可变绑定）' })
    } else if (
      /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*[^;=]*=/.test(line) &&
      /new\s+(?:Map|Set)\s*[<(]/.test(line)
    ) {
      signals.push({ lineNo: i + 1, code: line.trim(), signal: '模块级 new Map/Set（可变容器）' })
    }
  }
  return signals
}

// ---------- 导出面符号提取 ----------

/**
 * 解析全部 `export { ... }` 块（可多行、含 `type X` 前缀与 `X as Y` 重命名）。
 * 解析不了的 part 记入 problems（fail-closed：宁可报错人工看，不静默漏符号）。
 */
// export 块单项形态：标识符/default + 可选 as 重命名（重命名后符号才是导出面）
const EXPORT_PART_RE = /^([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*|default))?$/

/** 花括号配对扫描：从 open 起找 depth 归零的闭合 }（未闭合返回 -1） */
function findBlockClose(text, open) {
  let depth = 0
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}' && --depth === 0) return j
  }
  return -1
}

/** 单个导出项入集：剥 type 前缀 + as 重命名；无法解析记 problems（不静默漏符号） */
function addExportPart(rawPart, names, problems, where) {
  let part = rawPart.trim()
  if (part === '') return
  if (part.startsWith('type ')) part = part.slice(5).trim()
  const asMatch = EXPORT_PART_RE.exec(part)
  if (!asMatch) {
    problems.push(`${where}: export 块内无法解析的导出项「${part}」——文本解析失败`)
    return
  }
  names.add(asMatch[2] ?? asMatch[1])
}

function parseExportBlocks(text, problems, where) {
  const names = new Set()
  for (const m of text.matchAll(/^export\s*\{/gm)) {
    const open = text.indexOf('{', m.index)
    const close = findBlockClose(text, open)
    if (close < 0) {
      problems.push(`${where}: export { } 花括号未闭合——文本解析失败`)
      continue
    }
    for (const rawPart of text.slice(open + 1, close).split(',')) {
      addExportPart(rawPart, names, problems, where)
    }
  }
  return names
}

/** src TS 文件具名导出符号（声明形态 + export {} 块 + default） */
function extractSrcExportNames(tsRaw, where) {
  const t = stripComments(tsRaw)
  const problems = []
  const names = parseExportBlocks(t, problems, where)
  const declRe =
    /^export\s+(?:(?:declare|async|abstract)\s+)*(?:const|let|var|function\s*\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const m of t.matchAll(declRe)) names.add(m[1])
  if (/^export\s+default\b/m.test(t)) names.add('default')
  for (const m of t.matchAll(/^export\s+\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\b/gm)) {
    if (m[1]) names.add(m[1])
    else problems.push(`${where}: src 出现裸 export * from（重导出面无法文本枚举）——请展开为显式具名导出`)
  }
  return { names, problems }
}

/** dist 声明文件（.d.ts/.d.cts）导出符号 */
function extractDtsExportNames(dtsRaw, where) {
  const t = stripComments(dtsRaw)
  const problems = []
  const names = parseExportBlocks(t, problems, where)
  const declRe =
    /^export\s+(?:(?:declare|abstract)\s+)*(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const m of t.matchAll(declRe)) names.add(m[1])
  if (/^export\s+default\b/m.test(t)) names.add('default')
  for (const m of t.matchAll(/^export\s+\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\b/gm)) {
    if (m[1]) names.add(m[1])
    else problems.push(`${where}: d.ts 出现裸 export * from（导出面无法文本枚举）`)
  }
  return { names, problems }
}

function diffSets(a, b) {
  return [...a].filter((x) => !b.has(x)).sort()
}

// ---------- 入口发现（package.json exports 驱动，不写死清单）----------

/** 读 package.json 并做 exports 形态门禁（异常即 exit 1——形态坏了后续无意义） */
function loadPkg() {
  if (!existsSync(PKG_PATH)) {
    console.error(`✗ 未找到 ${PKG_PATH}——脚本须位于 <repo>/scripts/ 下运行`)
    process.exit(1)
  }
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  if (pkg.exports === null || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)) {
    console.error('✗ packages/subagent-core/package.json exports 形态异常（非对象）——D4/D5 契约漂移？')
    process.exit(1)
  }
  return pkg
}

/** 主 bundle 双格式定位（require.default 契约校验 + ESM 同基探测） */
function locateMainBundles(pkg) {
  const mainCjsRel = pkg.exports['.']?.require?.default
  if (typeof mainCjsRel !== 'string' || !mainCjsRel.startsWith('./dist/')) {
    console.error('✗ exports["."].require.default 缺失或不指向 ./dist/（D4 双形态契约漂移）——核对 package.json')
    process.exit(1)
  }
  const mainCjsAbs = join(CORE_DIR, mainCjsRel)
  if (!existsSync(mainCjsAbs)) {
    fail(`主 bundle 缺失: ${mainCjsRel}——先 cd packages/subagent-core && pnpm build`)
    return null
  }
  const mainEsmRel = mainCjsRel.replace(/\.cjs$/, '.js')
  return { mainCjsRel, mainCjsAbs, mainEsmRel, hasMainEsm: existsSync(join(CORE_DIR, mainEsmRel)) }
}

/** 逐子入口校验 exports 契约并收集 bundle/src 绝对路径（gate1Fatal 任一为 true 即整门跳过） */
function collectSubentries(pkg) {
  const subentries = []
  let fatal = false
  // 子入口 = exports 中除 "." 与通配外的全部条目——新增子入口自动纳入两门监测
  for (const key of Object.keys(pkg.exports).filter((k) => k !== '.' && !k.includes('*'))) {
    const e = pkg.exports[key]
    const cjsRel = e?.require?.default
    const srcRel = e?.import?.types ?? e?.import?.default
    if (typeof cjsRel !== 'string' || !cjsRel.startsWith('./dist/') || !cjsRel.endsWith('.cjs')) {
      fail(`${key}: exports require.default 缺失或非 ./dist/*.cjs——D4 双形态契约漂移`)
      fatal = true
      continue
    }
    if (typeof srcRel !== 'string' || !srcRel.startsWith('./src/')) {
      fail(`${key}: exports import 条件缺失或非 ./src/ 路径——无法定位 src 入口`)
      fatal = true
      continue
    }
    const cjsAbs = join(CORE_DIR, cjsRel)
    if (!existsSync(cjsAbs)) {
      fail(`${key}: dist bundle 缺失: ${cjsRel}——先 cd packages/subagent-core && pnpm build`)
      fatal = true
      continue
    }
    subentries.push({ key, cjsRel, cjsAbs, srcRel, esmAbs: join(CORE_DIR, cjsRel.replace(/\.cjs$/, '.js')) })
  }
  return { subentries, fatal }
}

/** 单个重叠 module 的模块级可变状态检查（含定位失败的人工核验提示路径） */
function checkOverlapModule(mod, where) {
  const modAbs = resolvePath(CORE_DIR, mod)
  if (!existsSync(modAbs)) {
    // 非 src/ 前缀的外部依赖 marker（如 workspace 依赖）可能定位失败——显式列出
    // 人工核验，不静默也不武断 FAIL
    console.log(`  ⚠ ${mod}（${where.join('、')}）：源文件无法定位（${modAbs}）——人工核验该重叠 module 的模块级状态`)
    return
  }
  const signals = findModuleLevelMutableState(modAbs)
  if (signals.length > 0) {
    fail(
      `${mod}（${where.join('、')}）含模块级可变状态——双 bundle 各持一份副本会状态分裂` +
        `（修复范式：globalThis[Symbol.for] 持有，见设计 §3.2 B-2 / host-services.ts 先例）：` +
        signals.map((s) => `L${s.lineNo} ${s.signal}「${s.code}」`).join('；'),
    )
  } else {
    // 警告列出（设计 §3.2 B-2 ③静态门语义：纯常量/函数的重叠是受控现状，但保持可见）
    console.log(`  ⚠ ${mod}（${where.join('、')}）：重叠分发，文本启发式未发现模块级可变状态（纯常量/函数）`)
  }
}

/** 门①：重复 module 重叠扫描（主 bundle × 子入口 bundle，CJS + ESM） */
function gateOne(bundles, subentries) {
  console.log('[门①] 重复 module 重叠扫描（主 bundle × 子入口 bundle，CJS + ESM）')
  if (bundles === null) return
  const mainCjsMarkers = collectBundleClosure(bundles.mainCjsAbs)
  const mainEsmMarkers = bundles.hasMainEsm
    ? collectBundleClosure(join(CORE_DIR, bundles.mainEsmRel))
    : null
  if (!bundles.hasMainEsm) {
    console.log(`  ⚠ 主 ESM bundle 缺失（${bundles.mainEsmRel}）——ESM 侧重叠扫描跳过（CJS 侧仍执行）`)
  }
  console.log(
    `  主 bundle CJS module 数: ${mainCjsMarkers.size}（${bundles.mainCjsRel}）` +
      (mainEsmMarkers ? ` / ESM: ${mainEsmMarkers.size}（${bundles.mainEsmRel}，含 chunk）` : ''),
  )

  // module → 出现在哪些 (子入口 × 格式) 交集（含主侧闭包来源明细）
  const overlap = new Map()
  for (const sub of subentries) {
    const subCjs = collectBundleClosure(sub.cjsAbs)
    const subEsm = existsSync(sub.esmAbs) ? collectBundleClosure(sub.esmAbs) : null
    const report = (set, fmt) => {
      const hits = [...set].filter((m) => mainCjsMarkers.has(m) || (mainEsmMarkers?.has(m) ?? false))
      for (const mod of hits) {
        const entry = overlap.get(mod) ?? []
        entry.push(`${sub.key}(${fmt})`)
        overlap.set(mod, entry)
      }
      return hits.length
    }
    const cjsCount = report(subCjs, 'cjs')
    const esmCount = subEsm ? report(subEsm, 'esm') : null
    console.log(
      `  ${sub.key}: CJS 交集 ${cjsCount} module` +
        (esmCount === null ? '（ESM bundle 缺失，跳过）' : ` / ESM 交集 ${esmCount} module`),
    )
  }

  if (overlap.size === 0) {
    ok('主 × 子入口重叠 module = 0（零重复分发）')
    return
  }
  console.log(`  重叠 module 并集 ${overlap.size} 个，逐 module 检查模块级可变状态：`)
  const before = failures
  for (const [mod, where] of [...overlap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    checkOverlapModule(mod, where)
  }
  if (failures === before) {
    ok(`重叠 module ${overlap.size} 个均无模块级可变状态（上方警告清单为受控现状登记）`)
  }
}

/** 单条差异的四向比对结果输出（drift 时输出仅差集非空方向） */
function reportExportDrift(sub, dctsRel, dtsRel, src, dcts, dts) {
  const onlyInSrcDcts = diffSets(src.names, dcts.names)
  const onlyInDistDcts = diffSets(dcts.names, src.names)
  const onlyInSrcDts = diffSets(src.names, dts.names)
  const onlyInDistDts = diffSets(dts.names, src.names)
  const drift =
    onlyInSrcDcts.length > 0 || onlyInDistDcts.length > 0 || onlyInSrcDts.length > 0 || onlyInDistDts.length > 0
  if (!drift) {
    ok(
      `${sub.key}: src ${src.names.size} 符号 ↔ ${dctsRel.split('/').pop()} ${dcts.names.size} / ${dtsRel.split('/').pop()} ${dts.names.size}，双向零漂移`,
    )
    return
  }
  if (onlyInSrcDcts.length > 0) fail(`${sub.key}: 仅 src 有、${dctsRel} 缺: ${onlyInSrcDcts.join(', ')}`)
  if (onlyInDistDcts.length > 0) fail(`${sub.key}: 仅 ${dctsRel} 有、src 缺: ${onlyInDistDcts.join(', ')}`)
  if (onlyInSrcDts.length > 0) fail(`${sub.key}: 仅 src 有、${dtsRel} 缺: ${onlyInSrcDts.join(', ')}`)
  if (onlyInDistDts.length > 0) fail(`${sub.key}: 仅 ${dtsRel} 有、src 缺: ${onlyInDistDts.join(', ')}`)
  console.error(`    排查：tsup dts 配置漂移或 src 导出面变更未重建——cd packages/subagent-core && pnpm build 后重跑`)
}

/** 单子入口三向产物定位（src / .d.cts / .d.ts），任一缺失即 fail 并返回 null */
function locateSubentryFaces(pkg, sub, coreDir) {
  const srcAbs = join(coreDir, sub.srcRel)
  if (!existsSync(srcAbs)) {
    fail(`${sub.key}: src 入口缺失 ${sub.srcRel}——exports 与 src 目录漂移`)
    return null
  }
  const dctsRel = pkg.exports[sub.key]?.require?.types
  if (typeof dctsRel !== 'string' || !dctsRel.endsWith('.d.cts')) {
    fail(`${sub.key}: exports require.types 缺失或非 .d.cts（D4 双形态契约漂移）——核对 package.json`)
    return null
  }
  const dctsAbs = join(coreDir, dctsRel)
  const dtsRel = dctsRel.replace(/\.d\.cts$/, '.d.ts')
  const dtsAbs = join(coreDir, dtsRel)
  if (!existsSync(dctsAbs)) {
    fail(`${sub.key}: dist 声明产物缺失 ${dctsRel}（exports 声明了但 tsup 未产出——核对 tsup.config.ts dts 输出）`)
    return null
  }
  if (!existsSync(dtsAbs)) {
    fail(`${sub.key}: dist 声明产物缺失 ${dtsRel}（import 条件消费面断裂——核对 tsup.config.ts dts 输出）`)
    return null
  }
  return { srcAbs, dctsRel, dctsAbs, dtsRel, dtsAbs }
}

/** 单子入口导出面比对：三向符号提取 → 解析 problems 优先 fail → 四向差集报告 */
function checkSubentryFace(pkg, sub, coreDir) {
  const faces = locateSubentryFaces(pkg, sub, coreDir)
  if (faces === null) return
  const src = extractSrcExportNames(readFileSync(faces.srcAbs, 'utf8'), `${sub.key} src`)
  const dcts = extractDtsExportNames(readFileSync(faces.dctsAbs, 'utf8'), `${sub.key} ${faces.dctsRel}`)
  const dts = extractDtsExportNames(readFileSync(faces.dtsAbs, 'utf8'), `${sub.key} ${faces.dtsRel}`)
  const problems = [...src.problems, ...dcts.problems, ...dts.problems]
  if (problems.length > 0) {
    for (const p of problems) fail(p)
    return
  }
  reportExportDrift(sub, faces.dctsRel, faces.dtsRel, src, dcts, dts)
}

/** 门②：子入口导出面 src↔dist 符号比对（.d.cts + .d.ts 双格式，双向差集） */
function gateTwo(pkg, subentries, coreDir = CORE_DIR) {
  console.log('[门②] 子入口导出面 src↔dist 符号比对（.d.cts + .d.ts 双格式，双向差集）')
  if (subentries.length === 0) {
    console.log('  ⚠ exports 无子入口条目——门②空转（新增子入口自动纳入监测）')
    return
  }
  for (const sub of subentries) checkSubentryFace(pkg, sub, coreDir)
}

// main()：CLI 直跑才执行（vitest import 纯函数导出时不触发门禁扫描/exit）
function main() {
  const pkg = loadPkg()
  const bundles = locateMainBundles(pkg)
  const { subentries, fatal } = collectSubentries(pkg)
  if (!fatal) gateOne(bundles, subentries)
  gateTwo(pkg, subentries)
  // ---------- 汇总 ----------

if (failures === 0) {
  console.log('✓ subagent-core dist 静态门通过（重叠 module 纯度 + 导出面零漂移）')
  process.exit(0)
}
console.error(`✗ subagent-core dist 静态门失败：${failures} 项 FAIL（上方 ✗ 行）`)
console.error('  排查顺序：① cd packages/subagent-core && pnpm build 后重跑；② 核对 tsup.config.ts 多入口与 package.json exports 一致；③ 重叠 module 可变状态按 globalThis[Symbol.for] 范式迁移（设计 §3.2 B-2）')
process.exit(1)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href
if (isMain) main()
