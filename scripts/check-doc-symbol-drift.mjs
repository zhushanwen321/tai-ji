#!/usr/bin/env node
/**
 * 文档-代码符号漂移守卫（doc-symbol-drift）。
 *
 * [HISTORICAL] 起因 2026-08-31：update 模块 13 个路径常量函数化（4f973590e）后，
 * 设计文档与 impl-plan 中 3 处旧常量引用（UPDATE_DIR / MANUAL_ASSET_DIR×2）悬空
 * 存活，无任何机器信号，靠事后对抗审查才抓出。本脚本把「文档引用已删除/改名符号」
 * 变成可机检的失败。
 *
 * 检查逻辑（TypeScript 编译器 API = tsserver 同源语义引擎，语法级 AST 解析，
 * 不起 LSP server、不做完整类型检查，单文档毫秒级）：
 *   1. 从映射源码模块收集合法符号表：命名导出（const/function/class/interface/
 *      type/enum + export {} specifier）+ export const 对象字面量的一层属性键
 *      （错误码族如 UPDATE_ERROR_MESSAGES 的键由此覆盖）
 *   2. 从映射设计文档提取反引号 span 内的符号候选：
 *      蛇形大写（≥2 段，如 UPDATE_DIR）+ get 前缀驼峰（如 getUpdateDir）
 *   3. 候选不在符号表且不在 env 前缀白名单（TAIJI_* / PI_*）→ 报 drift，exit 1
 *   4. [G5] staged 源码/测试文件（.ts/.vue/.mjs/.js 等）注释内 docs 引用存在性：
 *      Form A `docs/<path>` 仓库相对引用 + Form B `<文档名>.md` 裸文件名引用，
 *      目标不存在即拦截（staged 含 .md 删除时扩为全仓扫描——被删文档可能被任意
 *      源码注释引用，引用面无法局部化）。只扫注释（AST trivia，字符串/模板/
 *      正则字面量内的 docs/ 字样不进检查面），性能：日常只扫 staged 文件。
 *   5. 数据源登记锚点反向校验：`docs/architecture/data-source-registry.md` 行内
 *      声称「声明处 `@data-owner #N`」时，源码里必须真存在 `@data-owner #N` 注解。
 *      [2026-09-17] 起因：缓存治理批删掉缓存实现时，`@data-owner #20` 注解随实现
 *      体一起消失而登记表未同步（taste-lint 只查反向：注解→条目号存在），无任何
 *      机器信号；此检查把「登记表声称有注解」变成可机检的失败。注解采集走
 *      `git grep`（索引级，毫秒级），无 git 上下文时降级跳过。
 *
 * 书写约定：反引号 = 现行代码符号。历史性提及已删除/改名的符号（如描述事故成因）
 * 不带反引号——带反引号即按现状引用检查，这正是本守卫的判定口径。
 *
 * 映射表 DOC_MODULE_MAP 是显式登记（文档 → 权威源码模块）。新增设计文档时在
 * 此登记映射，未登记的文档不检查（宁缺勿滥，误报面收敛到声明过的对照对）。
 *
 * 用法：node scripts/check-doc-symbol-drift.mjs（符号/路径检查始终全量——触发面
 * 由 pre-commit 按路径控制，检查本身毫秒级无需增量；[G5] 注释 docs 引用检查读
 * git staged，无 staged 源码文件时零扫描。import 消费导出纯函数不触发主流程）
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// fileURLToPath 而非 URL.pathname：Windows 上 pathname 返回 /D:/... 形态，resolve 叠加盘符成 D:\D:\
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 文档 → 权威源码模块映射（新增设计文档在此登记）。
 * 值为目录（递归收 .ts，排除 __tests__/test）或精确文件。
 */
const DOC_MODULE_MAP = {
  'docs/architecture/zcode-session-db-isolation.md': ['packages/subagent-core/src/execution/engine', 'packages/zcode-subagent-cli/src', 'packages/shared/src/paths.ts', 'packages/runtime/src/infra/pi/pi-paths.ts', 'scripts/zcode-session-db-cleanup.mjs'],
  // replay port 设计（subagent 完成回收在新架构上的重放移植）：M1/M2 落点在
  // pi-subagent-cli，M3 落点在 subagent-core execution（watchdog 复用 settled-watchdog
  // 原语）；MAX_ATTEMPTS 引执行面、CANCEL_SETTLE_GRACE_MS 引协议面、DOC_MODULE_MAP 引守卫
  // 本体——按文档实际引用符号的所在模块逐条登记（宁准勿滥）。
  //
  // 引擎开发指南（docs/extensions/subagents/engine-development-guide.md）：登记蓝本 =
  // 该指南 §12 映射表——SDK 全 src（protocol 契约 + spawn/env/node-executor）、core 引擎
  // 子域（errors/engine-manifest/capability-gate/journal-wiring/session-view）+ path-encoding
  // （getSubagentSessionDir）、两引擎包（zcode constants/engine/session-channel/reader/parser、
  // pi constants/spawn-args）、shared constants（ENV_WHITELIST_PREFIXES）。非导出的模块内
  // const（PROBE_TIMEOUT_MS/DISPOSE_GRACE_MS/CAPABILITY_ENUMS/ENGINE_ICON_REGISTRY 等）不进
  // 守卫符号表，指南以粗体非反引号形态引用（书写约定见指南头部断言分级）。
  'docs/extensions/subagents/engine-development-guide.md': ['packages/subagent-engine-sdk/src', 'packages/subagent-core/src/execution/engine', 'packages/subagent-core/src/execution/assembly/path-encoding.ts', 'packages/zcode-subagent-cli/src', 'packages/pi-subagent-cli/src', 'packages/shared/src/constants.ts', 'packages/shared/src/paths.ts'],
}

/** 环境变量名白名单（非导出符号，文档合法引用）：项目（TAIJI_/PI_）与运行平台（NODE_/ELECTRON_/ZCODE_）env 前缀 */
const ENV_NAME_ALLOW_RE = /^(TAIJI_|PI_|NODE_|ELECTRON_|ZCODE_)[A-Z0-9_]+$/
/** undici errno 字符串族（文档描述错误分类的字符串字面量，非本项目符号） */
const ERRNO_STRING_ALLOW_RE = /^(UND_ERR_|E[A-Z]{3,})/
/** export 声明的 5 种节点类别（对应 ts.isFunctionDeclaration 等类型守卫） */
const EXPORTED_DECL_KINDS = ['FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration']

// ─── 第二检查：活跃测试/策略文档的引用路径存在性（R6）───────────────────
// [HISTORICAL] 2026-09-11 renderer 审计阶段 6（impl-plan §7 残余⑦）：DOC_MODULE_MAP
// 长期不覆盖 TEST-STRATEGY.md / docs/testing/，u01 删除搜索域测试文件后，回归基线表
// 指向已删文件数日无机器信号。符号漂移检查需要「文档 ↔ 模块」语义映射（维护成本高、
// 不宜全量登记）；路径存在性检查零映射成本，恰好覆盖该次全部真实案例。
// 书写约定与符号检查一致：反引号 = 现行引用。历史性提及已删除路径（描述事故/迁移史）
// 不带反引号或加入下方豁免表（须附理由）。

/** 检查范围：回归基线 SSOT + 测试手册目录（递归 .md） */
const PATH_REF_FILES = ['TEST-STRATEGY.md']
const PATH_REF_DIRS = ['docs/testing']

/** 反引号 span 内的仓库相对文件路径候选（必须带扩展名，防误伤命令行目录与散文）。
 *  左边界断言防中缀误配（`shared/src/x.ts` 匹配整段而非内部的 `src/x.ts`；
 *  `base-tool-enhance/src/x.ts` 同理）。 */
const REPO_PATH_RE = /(?<![\w@.\-/])(?:src|shared|packages|apps|scripts|e2e|docs|extensions)\/[\w@.\/-]+\.(?:ts|tsx|mts|cts|mjs|cjs|vue|json|sh|py|md)/g

/**
 * 路径级豁免（精确字面量）。每项必须附理由；路径对应文件重新存在时移除条目。
 * 禁止为「新文档里的悬空路径」加豁免——那走改写文档。
 */
const PATH_REF_EXEMPT = new Map([
  ['src/index.ts', '04/05 手册 testid 表中的示例节点路径（「path 如 README.md、src/index.ts」），非仓库文件引用'],
  ['src/new-feature.ts', '04 手册 testid 表中的示例节点路径（「新增文件 src/new-feature.ts」演示），非仓库文件引用'],
  ['packages/ai/src/providers/faux.ts', 'pi 上游仓（badlogic/pi-mono）路径参照，非本仓文件（12 号手册 §4 读者指引）'],
  ['packages/agent/src/harness/agent-harness.ts', 'pi 上游仓路径参照，非本仓文件（12 号手册 §4.2 读者指引）'],
  ['packages/agent/test/harness/agent-harness.test.ts', 'pi 上游仓路径参照，非本仓文件（12 号手册 §4.2 黄金参照）'],
  ['packages/coding-agent/src/modes/rpc/rpc-client.ts', 'pi 上游仓路径参照，非本仓文件（12 号手册 §4.3 读者指引）'],
  ['packages/coding-agent/src/modes/rpc/rpc-mode.ts', 'pi 上游仓路径参照，非本仓文件（12 号手册 §4.3 real-LLM gated 模式）'],
])

/** 文档路径 → 仓库实际位置：`src/` 是 renderer 包相对约定，`shared/` 是 shared 包相对约定，其余仓库根相对。
 *  span 内含 `cd packages/<pkg>` 时以该包为 `src/` 基准（运行命令场景，如 cd packages/ui）。 */
function resolveDocPath(p, span) {
  if (p.startsWith('src/')) {
    const cdMatch = span && /cd\s+(packages\/[\w-]+)/.exec(span)
    if (cdMatch) return path.join(PROJECT_ROOT, cdMatch[1], p)
    return path.join(PROJECT_ROOT, 'packages/renderer', p)
  }
  if (p.startsWith('shared/')) return path.join(PROJECT_ROOT, 'packages/shared', p.slice('shared/'.length))
  return path.join(PROJECT_ROOT, p)
}


// ─── 源码侧：收集合法符号表 ─────────────────────────────────────────

/** 递归收集目录下 .ts（排除测试目录与 .d.ts） */
function collectTsFiles(absDir) {
  const out = []
  for (const name of readdirSync(absDir)) {
    const full = path.join(absDir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'test' || name === 'node_modules' || name === 'dist') continue
      out.push(...collectTsFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 从单个 .ts 的 AST 提取符号。检查语义是「存在性」而非「可导入性」：
 * - 命名导出（export const/function/class/interface/type/enum 的名字）
 * - export { a, b as c } 的导出名
 * - 模块级 const/let 声明（含非 export——文档引用私有常量名描述机制不算漂移）
 * - export const OBJ = { KEY: ...} 的一层属性键（错误码族覆盖）
 */
function extractExportedSymbols(sourceFile) {
  const symbols = new Set()
  const objKeys = new Set()

  // 模块级 const/let/var（export 与否均收：存在性检查）
  function collectVariableStatement(node) {
    if (!(ts.isVariableStatement(node) && node.parent === sourceFile)) return
    const isExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        symbols.add(decl.name.text)
        // 一层属性键：export const MESSAGES = { CODE: ... } → CODE 合法
        if (isExport && ts.isObjectLiteralExpression(decl.initializer)) {
          for (const prop of decl.initializer.properties) {
            if (ts.isPropertyAssignment(prop)) {
              if (ts.isIdentifier(prop.name)) objKeys.add(prop.name.text)
              else if (ts.isStringLiteral(prop.name)) objKeys.add(prop.name.text)
            }
          }
        }
      }
    }
  }

  // export function/class/interface/type/enum
  function collectExportedDeclaration(node) {
    for (const kind of EXPORTED_DECL_KINDS) {
      const fn = ts[`is${kind}`]
      if (fn && fn(node) && node.name && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        symbols.add(node.name.text)
        // interface/class 成员名同样合法（文档引用接口方法签名属常态，如 IReleaseChecker.getRateLimitedUntil）
        if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
          for (const member of node.members) {
            const memberName = member.name
            if (memberName && (ts.isIdentifier(memberName) || ts.isStringLiteral(memberName))) {
              symbols.add(memberName.text)
            }
          }
        }
      }
    }
  }

  // export { a, b as c }
  function collectNamedExports(node) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        symbols.add((el.propertyName ?? el.name).text)
      }
    }
  }

  function visit(node) {
    collectVariableStatement(node)
    collectExportedDeclaration(node)
    collectNamedExports(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { symbols, objKeys }
}

/** 汇总一组源码路径的合法符号表 */
function buildSymbolTable(modulePaths) {
  const exported = new Set()
  const objKeys = new Set()
  const files = []
  for (const p of modulePaths) {
    const abs = path.join(PROJECT_ROOT, p)
    if (statSync(abs).isDirectory()) files.push(...collectTsFiles(abs))
    else files.push(abs)
  }
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf-8'), ts.ScriptTarget.Latest, true)
    const { symbols, objKeys: keys } = extractExportedSymbols(sf)
    for (const s of symbols) exported.add(s)
    for (const k of keys) objKeys.add(k)
  }
  return { exported, objKeys, fileCount: files.length }
}

// ─── 文档侧：提取反引号符号候选 ─────────────────────────────────────

const SCREAMING_SNAKE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
// get 前缀驼峰只认「紧跟 (」的函数调用形态——`update:getPreloaded` 这类 IPC channel
// 名/属性名无括号，不是符号引用，不检查
const GET_CAMEL_CALL_RE = /\b(get[A-Z][A-Za-z0-9]*)\(/g

/**
 * 从 md 文本提取符号候选。
 * @returns {Map<string, number[]>} 符号 → 出现行号列表（1-based）
 */
function extractDocCandidates(mdText) {
  const candidates = new Map()
  const lines = mdText.split('\n')
  const add = (sym, line) => {
    if (!candidates.has(sym)) candidates.set(sym, [])
    candidates.get(sym).push(line)
  }
  // 逐行扫反引号 span（跨行 span 不支持——设计文档惯例单行内闭合）
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      for (const sm of m[1].matchAll(SCREAMING_SNAKE_RE)) add(sm[0], i + 1)
      for (const gm of m[1].matchAll(GET_CAMEL_CALL_RE)) add(gm[1], i + 1)
    }
  })
  return candidates
}

// ─── 主流程 ─────────────────────────────────────────────────────────

/** 收集路径检查域的文档（明列文件 + 目录递归 .md） */
function collectPathRefDocs() {
  const docs = []
  for (const rel of PATH_REF_FILES) docs.push(rel)
  for (const dirRel of PATH_REF_DIRS) {
    const absDir = path.join(PROJECT_ROOT, dirRel)
    try {
      const walk = (abs) => {
        for (const name of readdirSync(abs)) {
          const full = path.join(abs, name)
          if (statSync(full).isDirectory()) {
            if (name === 'node_modules') continue
            walk(full)
          } else if (name.endsWith('.md')) {
            docs.push(path.relative(PROJECT_ROOT, full))
          }
        }
      }
      walk(absDir)
    } catch {
      // 目录不存在：映射随之调整，不算错误
    }
  }
  return docs
}

/** 路径存在性检查：返回悬空引用列表 */
function checkPathRefs() {
  const missing = []
  for (const docRel of collectPathRefDocs()) {
    let mdText
    try {
      mdText = readFileSync(path.join(PROJECT_ROOT, docRel), 'utf-8')
    } catch {
      continue
    }
    const lines = mdText.split('\n')
    lines.forEach((line, i) => {
      for (const span of line.matchAll(/`([^`\n]+)`/g)) {
        for (const m of span[1].matchAll(REPO_PATH_RE)) {
          const p = m[0].replace(/\.+$/, '')
          if (p.includes('*')) continue
          if (PATH_REF_EXEMPT.has(p)) continue
          if (!existsSync(resolveDocPath(p, span[1]))) {
            missing.push({ doc: docRel, line: i + 1, path: p })
          }
        }
      }
    })
  }
  return missing
}

// ─── 第三检查：源码注释内 docs 引用存在性（G5）───────────────────────────
// [G5] 起因 2026-09-17：源码注释引用已删除设计文档（panel-view-derivation 族等）
// 悬空存活无任何机器信号，与第二检查拦的「文档引用不存在路径」方向相反：这里是
// 「源码引用不存在文档」。判定口径（按误报面校准）：
//   1. Form A `docs/<path>` 相对引用——目标（文件或目录）不存在即悬空；
//   2. Form B 裸 `<文档名>.md` 引用——须同行含 docs 叙述语境词（FORM_B_CONTEXT_RE）
//      才视为文档引用（裸 .md 文件名大量出现于运行时产物描述：诊断 zip 的
//      summary.md、workflow runDir 的 aggregated.md，均为运行时生成物非引用），
//      目标名字在 git ls-files '*.md'（index 语义）中不存在即悬空；
//   3. 同行含历史性提及标注（HISTORICAL_MENTION_RE：已删/已废弃/git 可追溯等）
//      豁免——书写约定允许注释显式标注的已删除文档历史叙述，未标注的照拦；
//   4. 路径跨行书写不判：行尾连字符断字（本行是断字路径前半段）与本行命中名
//      前文以连字符结尾（本行是断字路径尾部续行，如 xxx-collect-and- ⏎
//      reaper-sink.md）——单行均无法解析完整目标。
// 性能：日常只扫 staged 源码文件；staged 含 .md 删除时全仓扫描（被删文档可能被
// 任意源码注释引用，引用面无法局部化）。
// 豁免登记：注释里历史性提及已删除文档但未带标注、且确需保留的，在
// COMMENT_DOC_REF_EXEMPT 登记（文件路径::引用字面量 + 理由）；禁止为「新代码里
// 的悬空引用」加豁免——那走改注释。

/** 第三检查扫描的源码/测试扩展名（TS parser 可解析 + .vue 特判分流） */
const COMMENT_REF_SRC_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.vue'])

/** 全仓扫描（staged 含 .md 删除时触发）按目录名剪枝：依赖/产物/本地档案，无注释检查语义 */
const FULL_SCAN_PRUNE_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results', 'playwright-report', '.taiji-harness', 'resources'])

/** Form A：docs/ 仓库相对引用。左边界断言防 URL 中缀误配（github.com/docs/x），
 *  与第二检查 REPO_PATH_RE 同口径。 */
const DOCS_PATH_RE = /(?<![\w@.\-/])docs\/[\w@.\/-]+/g
/** Form B：裸 .md 文件名引用。不含 /（含路径前缀的非 docs 引用如 packages/x/README.md
 *  不属 docs 引用面，不检查）；左边界同 Form A。 */
const MD_NAME_RE = /(?<![\w@.\-/])[\w@.-]+\.md\b/g
/** 历史性提及标注（同一行出现即豁免）：仓库书写约定允许注释叙述已删除文档的
 *  历史（描述事故/迁移史须显式标注「已删除/已废弃 + git 可追溯」），未标注的
 *  悬空引用照拦。 */
const HISTORICAL_MENTION_RE = /(已删|已废弃|已移除|git 可追溯|历史)/
/** Form B 上下文门（同一行须含 docs 叙述语境词才视为文档引用）：裸 .md 文件名
 *  大量出现于运行时产物描述（诊断 zip 的 summary.md、workflow runDir 的
 *  aggregated.md 等——运行时生成物，非 docs 引用），无语境词不检查。 */
const FORM_B_CONTEXT_RE = /(设计|权威|指南|手册|规范|文档|参见|详见|依据|方案|§)/

/**
 * 文件级豁免（key = `<staged相对路径>::<引用字面量>`，value = 理由；`*::` 前缀 =
 * 全文件生效，用于文件无关的合法引用如上游仓文档参照）。
 * 与 PATH_REF_EXEMPT 同纪律但 key 带文件——同一悬空文档名在 A 文件是合法历史
 * 叙述、在 B 文件是真漂移的场景互不误伤。引用改写/目标重建后移除条目。
 */
const COMMENT_DOC_REF_EXEMPT = new Map([
  // ['<文件相对路径>::<引用字面量>', '理由：为何保留对该已删除文档的历史性提及'],
  ['*::docs/rpc.md', 'pi 上游仓（badlogic/pi-mono）协议文档 docs/rpc.md 参照，非本仓文件（同 PATH_REF_EXEMPT 的 pi 上游先例）'],
  ['packages/renderer/src/__tests__/composables/markdown-filepath.test.ts::docs/My', 'markdown 链接解析测试叙述中的空格切断反例（docs/My Document.md），非仓库路径引用'],
  ['apps/electron/main/diagnostics/export-diagnostic-bundle.ts::summary.md', '运行时生成物文件名（诊断 zip 内置 summary.md，代码自身生成），非 docs 引用'],
])

/**
 * JS/TS 注释区间收集：TS parser AST trivia（leading + trailing comment ranges，
 * 按 pos 去重——同一注释会同时出现在祖先节点与后继节点的 trivia 起点）。
 * 用 parser 而非裸 scanner：正则 vs 除号歧义由 parser 上下文解决，正则字面量内
 * 的 `//` 不会伪注释化（`const re = /a\/\/b/` 不产生假注释吞掉行尾真注释）。
 * @returns {Array<[number, number]>} [start, end] 原文偏移区间
 */
export function extractJsCommentRanges(text) {
  const sourceFile = ts.createSourceFile('comment-scan.ts', text, ts.ScriptTarget.Latest, false)
  const seen = new Set()
  const ranges = []
  const collect = (pos) => {
    for (const r of [
      ...(ts.getLeadingCommentRanges(text, pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, pos) ?? []),
    ]) {
      if (seen.has(r.pos)) continue
      seen.add(r.pos)
      ranges.push([r.pos, r.end])
    }
  }
  const visit = (node) => {
    collect(node.pos)
    ts.forEachChild(node, visit)
    collect(node.end)
  }
  visit(sourceFile)
  // EOF 前的文件尾注释挂在 endOfFileToken 的 trivia 上，forEachChild 不保证走到
  collect(sourceFile.endOfFileToken.pos)
  return ranges
}

/**
 * .vue 注释区间：script 块内容走 JS/TS parser（偏移平移回原文坐标），模板区走
 * HTML 注释正则（Vue 模板注释只有 <!-- --> 形态）。
 */
export function extractVueCommentRanges(text) {
  const ranges = []
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const offset = m.index + m[0].indexOf(m[1])
    for (const [s, e] of extractJsCommentRanges(m[1])) ranges.push([offset + s, offset + e])
  }
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
    ranges.push([m.index, m.index + m[0].length])
  }
  return ranges
}

/**
 * 从注释文本提取 docs 引用候选。Form A 先提取并记录 span，Form B 跳过落在
 * Form A span 内的命中（`docs/<目录>/<文件>.md` 只按 Form A 判定一次）。
 * @returns {Array<{kind: 'docs-path'|'md-name', target: string, raw: string, offset: number}>}
 */
export function extractDocRefsInComment(commentText) {
  const refs = []
  const pathSpans = []
  for (const m of commentText.matchAll(DOCS_PATH_RE)) {
    // 尾部标点收敛：`docs/<文件>.md.` 尾点与 `docs/<目录>/` 尾斜杠统一去除
    const p = m[0].replace(/\.+$/, '').replace(/\/+$/, '')
    if (!p || p === 'docs') continue
    pathSpans.push([m.index, m.index + m[0].length])
    refs.push({ kind: 'docs-path', target: p, raw: m[0], offset: m.index })
  }
  for (const m of commentText.matchAll(MD_NAME_RE)) {
    if (pathSpans.some(([s, e]) => m.index >= s && m.index < e)) continue
    refs.push({ kind: 'md-name', target: m[0], raw: m[0], offset: m.index })
  }
  return refs
}

/**
 * Form B 裸 .md 文件名的合法名字集：git ls-files '*.md'（读 index——提交预览语义：
 * staged 删除的文档名字即失效，文档删除提交当场暴露引用悬空；staged 新增即时合法）。
 * git 不可用时回退 docs/ 递归 + 仓库根一级（降级覆盖，.agents 等非 docs 树收不进）。
 */
export function buildDocsMdNameIndex() {
  const names = new Set()
  const res = spawnSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: PROJECT_ROOT, encoding: 'utf-8' })
  if (res.status === 0 && typeof res.stdout === 'string') {
    for (const f of res.stdout.split('\0')) {
      if (f) names.add(path.basename(f))
    }
    return names
  }
  const walk = (abs) => {
    let entries
    try { entries = readdirSync(abs) } catch { return }
    for (const name of entries) {
      const full = path.join(abs, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (name === 'node_modules') continue
        walk(full)
      } else if (name.endsWith('.md')) {
        names.add(name)
      }
    }
  }
  walk(path.join(PROJECT_ROOT, 'docs'))
  for (const name of readdirSync(PROJECT_ROOT)) {
    if (name.endsWith('.md')) names.add(name)
  }
  return names
}

/** 全仓源码文件收集（staged 含 .md 删除时用；剪枝 FULL_SCAN_PRUNE_DIRS） */
function collectAllSourceFiles() {
  const out = []
  const walk = (abs, rel) => {
    let entries
    try { entries = readdirSync(abs) } catch { return }
    for (const name of entries.sort()) {
      if (FULL_SCAN_PRUNE_DIRS.has(name)) continue
      const full = path.join(abs, name)
      const relChild = rel ? `${rel}/${name}` : name
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full, relChild)
      else if (COMMENT_REF_SRC_EXTS.has(path.extname(name))) out.push({ rel: relChild, abs: full })
    }
  }
  walk(PROJECT_ROOT, '')
  return out
}

/** 行号（1-based）：text 在 offset 处的行 = baseLine + offset 之前的换行数 */
function lineAt(text, offset, baseLine) {
  return baseLine + text.slice(0, offset).split('\n').length - 1
}

/**
 * 单条引用的跳过判据（返回原因文案）或 null（需继续做存在性判定）。
 * 五个条件的短路顺序 = 原内联顺序，调用方须先做 seenPerFile 去重。
 */
function skipReason({ ref, lineText, precedingText, rel, exempt }) {
  // 行尾连字符断字：路径跨行书写（换行续行），单行无法解析目标，不判悬空
  if (ref.raw.endsWith('-')) return '行尾断字'
  // 换行续行碎片：引用名前文（剥行首装饰与空白）以连字符结尾——本行命中的是
  // 上一行断字路径的尾部（如 xxx-collect-and- ⏎ reaper-sink.md），非完整引用
  if (precedingText.replace(/[\s*]+$/, '').endsWith('-')) return '续行碎片'
  // 历史性提及豁免：同一行显式标注「已删除/已废弃/git 可追溯」等（书写约定）
  if (HISTORICAL_MENTION_RE.test(lineText)) return '历史性提及'
  // Form B 上下文门：无 docs 叙述语境词的裸 .md 文件名是运行时产物描述，不检查
  if (ref.kind === 'md-name' && !FORM_B_CONTEXT_RE.test(lineText)) return 'Form B 无语境'
  if (exempt.has(`${rel}::${ref.target}`) || exempt.has(`*::${ref.target}`)) return '豁免表'
  return null
}

/**
 * 对给定源码文件集扫描注释内 docs 引用，返回悬空违规列表。
 * @param {Array<{rel: string, abs: string}>} files
 * @param {Set<string>} docsMdNames Form B 合法名字集
 * @param {Map<string, string>} exempt 豁免表（缺省 = COMMENT_DOC_REF_EXEMPT；测试注入用）
 */
export function checkCommentDocRefs(files, docsMdNames, exempt = COMMENT_DOC_REF_EXEMPT) {
  const violations = []
  for (const { rel, abs } of files) {
    let text
    try { text = readFileSync(abs, 'utf-8') } catch { continue }
    const ranges = rel.endsWith('.vue') ? extractVueCommentRanges(text) : extractJsCommentRanges(text)
    const seenPerFile = new Set()
    for (const [s, e] of ranges) {
      const commentText = text.slice(s, e)
      const startLine = lineAt(text, s, 1)
      for (const ref of extractDocRefsInComment(commentText)) {
        const precedingText = commentText.slice(0, ref.offset)
        const line = lineAt(commentText, ref.offset, startLine)
        const key = `${line}\u0000${ref.kind}\u0000${ref.target}`
        if (seenPerFile.has(key)) continue
        seenPerFile.add(key)
        const lineText = (precedingText.split('\n').pop() + commentText.slice(ref.offset).split('\n')[0]).trim()
        if (skipReason({ ref, lineText, precedingText, rel, exempt }) !== null) continue
        const exists = ref.kind === 'docs-path'
          ? existsSync(path.join(PROJECT_ROOT, ref.target))
          : docsMdNames.has(ref.target)
        if (!exists) {
          violations.push({ file: rel, line, kind: ref.kind, target: ref.target, snippet: lineText.slice(0, 120) })
        }
      }
    }
  }
  return violations
}

/** staged 文件清单（指定 diff-filter）；git 不可用返回 null（无 git 上下文时跳过本检查面） */
function gitStagedFiles(diffFilter) {
  const res = spawnSync('git', ['diff', '--cached', '--name-only', '-z', `--diff-filter=${diffFilter}`], { cwd: PROJECT_ROOT, encoding: 'utf-8' })
  if (res.status !== 0 || typeof res.stdout !== 'string') return null
  return res.stdout.split('\0').filter(Boolean)
}

/**
 * 第三检查入口：staged 源码/测试文件注释扫描；staged 含 .md 删除时扩为全仓
 * （被删文档可能被任意源码注释引用，引用面无法局部化）。
 */
function checkStagedCommentDocRefs() {
  const staged = gitStagedFiles('ACMR')
  const deleted = gitStagedFiles('D')
  if (staged === null || deleted === null) return { available: false }
  const stagedSrc = staged.filter((f) => COMMENT_REF_SRC_EXTS.has(path.extname(f)))
  const deletedMd = deleted.filter((f) => f.endsWith('.md'))
  const fullScan = deletedMd.length > 0
  const files = fullScan
    ? collectAllSourceFiles()
    : stagedSrc.map((rel) => ({ rel, abs: path.join(PROJECT_ROOT, rel) }))
  return {
    available: true,
    fullScan,
    deletedMd,
    fileCount: files.length,
    violations: checkCommentDocRefs(files, buildDocsMdNameIndex()),
  }
}

/** 采集 DOC_MODULE_MAP 映射文档中引用了源码导出表/对象键不存在的符号的条目 */
function collectSymbolDrifts() {
  const drifts = []
  for (const [docRel, modulePaths] of Object.entries(DOC_MODULE_MAP)) {
    const docAbs = path.join(PROJECT_ROOT, docRel)
    let mdText
    try {
      mdText = readFileSync(docAbs, 'utf-8')
    } catch {
      // 文档被删除/改名：映射随之更新，不算 drift
      continue
    }
    const { exported, objKeys, fileCount } = buildSymbolTable(modulePaths)
    const candidates = extractDocCandidates(mdText)
    for (const [sym, lineNos] of candidates) {
      if (exported.has(sym) || objKeys.has(sym)) continue
      if (ENV_NAME_ALLOW_RE.test(sym) || ERRNO_STRING_ALLOW_RE.test(sym)) continue
      drifts.push({ doc: docRel, sym, lines: lineNos, moduleCount: fileCount })
    }
  }
  return drifts
}

/**
 * 三层违规报告（符号 / 路径 / 注释）：有违规即 exit 1（pre-commit/CI 只吃退出码与
 * stderr 文本），无违规直接返回由调用方出 OK 行；三段前缀与「恢复动作：」footer 逐字保留。
 */
/** 报告段 1：符号漂移（无违规返回 false） */
function reportSymbolDrifts(drifts) {
  if (drifts.length === 0) return false
  console.error(`[doc-symbol-drift] 发现 ${drifts.length} 个文档引用了源码中不存在的符号：`)
  for (const d of drifts) {
    console.error(`  ✗ ${d.doc}:${d.lines.join(',')}  \`${d.sym}\` 不在映射源码模块的导出表/对象键中`)
  }
  return true
}

/** 报告段 2：文档路径引用（无违规返回 false） */
function reportMissingPaths(missingPaths) {
  if (missingPaths.length === 0) return false
  console.error(`[doc-path-refs] 发现 ${missingPaths.length} 处文档引用的仓库路径不存在：`)
  for (const m of missingPaths) {
    console.error(`  ✗ ${m.doc}:${m.line}  \`${m.path}\` 文件不存在`)
  }
  return true
}

/** 报告段 3：注释 docs 引用（自带 footer；无违规返回 false） */
function reportCommentRefs(commentScan) {
  const violations = commentScan.available ? commentScan.violations : []
  if (violations.length === 0) return false
  const mode = commentScan.fullScan ? '全仓扫描（staged 含 .md 删除）' : 'staged 扫描'
  console.error(`[doc-comment-refs] 发现 ${violations.length} 处源码注释引用了不存在的 docs 文档（${mode}，扫描 ${commentScan.fileCount} 个源码文件）：`)
  for (const v of violations) {
    console.error(`  ✗ ${v.file}:${v.line}  \`${v.target}\` 不存在`)
    console.error(`    注释引文：${v.snippet}`)
  }
  console.error('')
  console.error('恢复动作：更新引用指向现行文档，或删除悬空叙述；历史性提及已删除文档确需保留的，')
  console.error('在 scripts/check-doc-symbol-drift.mjs 的 COMMENT_DOC_REF_EXEMPT 登记（文件路径::引用字面量 + 理由）。')
  return true
}

/** 报告段 4：数据源登记锚点（两个子段各自带 footer；无违规返回 false） */
function reportDataOwnerAnchors(dataOwner) {
  const ownerMissing = dataOwner.available ? dataOwner.missing : []
  const ownerUnknown = dataOwner.available ? (dataOwner.unknown ?? []) : []
  if (ownerMissing.length > 0) {
    console.error(`[data-owner-anchor] 发现 ${ownerMissing.length} 处登记表声称「声明处 \`@data-owner\`」但源码中零命中：`)
    for (const m of ownerMissing) {
      console.error(`  ✗ ${DATA_OWNER_REGISTRY_REL}:${m.line}  声称 \`@data-owner ${m.entry}\` 存活，但源码里找不到该注解`)
    }
    console.error('')
    console.error('恢复动作：在现行 owner 实现处补回 `@data-owner <条目号>` 注解，或同步修正登记表该行的')
    console.error('「声明处」叙述（注解随实现体删除时，登记表须同批更新——2026-09-17 缓存治理 #20 事故形态）。')
  }
  if (ownerUnknown.length > 0) {
    console.error(`[data-owner-anchor] 发现 ${ownerUnknown.length} 个源码注解引用的条目号不在登记表内：`)
    console.error(`  ✗ ${ownerUnknown.join(', ')}`)
    console.error('')
    console.error('恢复动作：先在 docs/architecture/data-source-registry.md 登记对应条目（或改用既有条目号）。')
  }
  return ownerMissing.length > 0 || ownerUnknown.length > 0
}

/**
 * 四段违规报告编排：任一段有违规则全量打印（各段自带内部 footer），最后统一 footer
 * + exit 1（pre-commit/CI 只吃退出码与 stderr 文本）。段顺序与文案逐字保留。
 */
function reportFailures({ drifts, missingPaths, commentScan, dataOwner }) {
  const anyPrinted = [
    reportSymbolDrifts(drifts),
    reportMissingPaths(missingPaths),
    reportCommentRefs(commentScan),
    reportDataOwnerAnchors(dataOwner),
  ].some(Boolean)
  if (!anyPrinted) return
  console.error('')
  console.error('恢复动作：该符号/路径已被删除或改名——同步修正文档（改用现行导出名/现路径或文字描述），')
  console.error('或在 scripts/check-doc-symbol-drift.mjs 登记：符号走 DOC_MODULE_MAP 映射，路径走 PATH_REF_EXEMPT（须附理由）。')
  process.exit(1)
}

/** 零违规收尾行（注释面扫描模式随 staged 上下文变化） */
function reportOk(commentScan, dataOwner) {
  const commentPart = commentScan.available
    ? `注释 docs 引用（${commentScan.fullScan ? '全仓' : 'staged'} ${commentScan.fileCount} 文件）零悬空`
    : '注释 docs 引用（无 git staged 上下文，跳过）'
  const ownerPart = dataOwner.available
    ? `数据源登记锚点（${dataOwner.claims.length} 条「声明处」声明 × 源码 ${dataOwner.annotationCount} 个注解）零悬空`
    : '数据源登记锚点（无 git 上下文，跳过）'
  console.log(`[doc-symbol-drift] OK：${Object.keys(DOC_MODULE_MAP).length} 个映射文档 × 源码导出表，零悬空符号；${collectPathRefDocs().length} 个活跃测试文档 × 路径存在性，零悬空引用；${commentPart}；${ownerPart}`)
}

// ── 检查面 5：数据源登记锚点反向校验（登记表 → 源码注解）──────────────────
// [2026-09-17] 起因：缓存治理批删掉缓存实现时 `@data-owner #20` 注解随实现体消失，
// 登记表却仍声称「声明处 `@data-owner #20` 注解」——taste-lint 的 require-data-owner-
// annotation 只查反向（注解 → 条目号存在），此方向无机器信号。
const DATA_OWNER_REGISTRY_REL = 'docs/architecture/data-source-registry.md'
/** 登记表行内「声明处 `@data-owner #N`」声明（带行号定位）。 */
const DATA_OWNER_CLAIM_RE = /声明处\s*`?@data-owner\s+(#[0-9]+)/g
/** 源码注解形态：`@data-owner #N`（taste:allow-no-data-owner 豁免族不在此面）。 */
const DATA_OWNER_ANNOTATION_RE = /@data-owner[ \t]+(#[0-9]+)/g

/** 纯函数：从登记表文本提取「声明处 @data-owner #N」声明（含行号）。 */
export function extractDataOwnerClaims(mdText) {
  const claims = []
  for (const [i, line] of mdText.split('\n').entries()) {
    DATA_OWNER_CLAIM_RE.lastIndex = 0
    let m
    while ((m = DATA_OWNER_CLAIM_RE.exec(line)) !== null) claims.push({ entry: m[1], line: i + 1 })
  }
  return claims
}

/** 纯函数：从源码文本提取实际注解条目号集合。 */
export function extractDataOwnerAnnotations(text) {
  const out = new Set()
  const re = new RegExp(DATA_OWNER_ANNOTATION_RE.source, 'g')
  let m
  while ((m = re.exec(text)) !== null) out.add(m[1])
  return out
}

/** git grep 采集全仓注解（索引级毫秒级；无 git 上下文降级 available:false）。 */
function collectDataOwnerAnnotations() {
  const res = spawnSync(
    'git',
    ['grep', '-h', '-o', '-E', '@data-owner[[:space:]]+#[0-9]+', '--', 'packages', 'apps', 'extensions'],
    { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (res.status === 1) return { available: true, entries: new Set() } // 有 git、零命中
  if (res.status !== 0 || typeof res.stdout !== 'string') return { available: false, entries: new Set() }
  const entries = new Set()
  for (const m of res.stdout.matchAll(new RegExp(DATA_OWNER_ANNOTATION_RE.source, 'g'))) entries.add(m[1])
  return { available: true, entries }
}

/** 检查面 5：双向锁定—登记表声称的注解必须真在（且注解引用的条目号必须在登记表）。 */
function checkDataOwnerAnchors() {
  const docAbs = path.join(PROJECT_ROOT, DATA_OWNER_REGISTRY_REL)
  if (!existsSync(docAbs)) return { available: false, claims: [], missing: [], unknown: [], annotationCount: 0 }
  const docText = readFileSync(docAbs, 'utf-8')
  const claims = extractDataOwnerClaims(docText)
  const registryEntries = new Set()
  for (const m of docText.matchAll(/^\|\s*(#[0-9]+)\s*\|/gm)) registryEntries.add(m[1])
  const { available, entries } = collectDataOwnerAnnotations()
  return {
    available,
    claims,
    missing: claims.filter((c) => !entries.has(c.entry)),
    unknown: [...entries].filter((e) => !registryEntries.has(e)),
    annotationCount: entries.size,
  }
}

function main() {
  const drifts = collectSymbolDrifts()
  const missingPaths = checkPathRefs()
  const commentScan = checkStagedCommentDocRefs()
  const dataOwner = checkDataOwnerAnchors()
  reportFailures({ drifts, missingPaths, commentScan, dataOwner })
  reportOk(commentScan, dataOwner)
}

// 缺省 CLI 形态：全量符号/路径检查 + staged 注释 docs 引用检查（不依赖 cwd）。
// import 消费导出纯函数时不触发主流程（check-ci-vitest-targets.mjs 同款惯例）。
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main()
}
