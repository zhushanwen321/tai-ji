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
 *   3. 候选不在符号表且不在 env 前缀白名单（XYZ_* / PI_*）→ 报 drift，exit 1
 *
 * 书写约定：反引号 = 现行代码符号。历史性提及已删除/改名的符号（如描述事故成因）
 * 不带反引号——带反引号即按现状引用检查，这正是本守卫的判定口径。
 *
 * 映射表 DOC_MODULE_MAP 是显式登记（文档 → 权威源码模块）。新增设计文档时在
 * 此登记映射，未登记的文档不检查（宁缺勿滥，误报面收敛到声明过的对照对）。
 *
 * 用法：node scripts/check-doc-symbol-drift.mjs（始终检查全部映射文档——触发面
 * 由 pre-commit 按路径控制，检查本身毫秒级无需增量）
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// fileURLToPath 而非 URL.pathname：Windows 上 pathname 返回 /D:/... 形态，resolve 叠加盘符成 D:\D:\
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 文档 → 权威源码模块映射（新增设计文档在此登记）。
 * 值为目录（递归收 .ts，排除 __tests__/test）或精确文件。
 */
const DOC_MODULE_MAP = {
  'docs/design/update-network-resilience.md': ['apps/electron/main/update', 'apps/electron/main/gateway/update-handlers.ts'],
  'docs/design/update-network-resilience.impl-plan.md': ['apps/electron/main/update', 'apps/electron/main/gateway/update-handlers.ts'],
  'docs/design/update-multi-source.md': ['apps/electron/main/update', 'apps/electron/main/gateway/update-handlers.ts', 'apps/electron/main/release-checker.ts', 'apps/electron/main/interfaces.ts'],
  'docs/design/update-multi-source.impl-plan.md': ['apps/electron/main/update', 'apps/electron/main/gateway/update-handlers.ts', 'apps/electron/main/release-checker.ts', 'apps/electron/main/interfaces.ts'],
  'docs/design/chat-stream-perf-architecture.md': ['packages/core/src/domain/chat', 'packages/core/src/domain/session', 'packages/renderer/src/composables/features/sidebar', 'packages/renderer/src/composables/features/trace'],
  'docs/design/chat-stream-perf-architecture.impl-plan.md': ['packages/core/src/domain/chat', 'packages/core/src/domain/session', 'packages/renderer/src/composables/features/sidebar', 'packages/renderer/src/composables/features/trace'],
  'docs/design/zcode-session-db-isolation.md': ['packages/subagent-core/src/execution/engine', 'packages/zcode-subagent-cli/src', 'packages/shared/src/paths.ts', 'packages/runtime/src/infra/pi/pi-paths.ts'],
  'docs/design/zcode-session-db-isolation.impl-plan.md': ['packages/subagent-core/src/execution/engine', 'packages/zcode-subagent-cli/src', 'packages/shared/src/paths.ts', 'packages/runtime/src/infra/pi/pi-paths.ts'],
  'docs/design/catalog-provider-field-authority.md': ['packages/runtime/src/services/provider-config-helper.ts', 'packages/runtime/src/services/provider-catalog.ts', 'packages/runtime/src/services/auth/provider-credential-resolver.ts', 'packages/runtime/src/infra/pi/pi-provider-store.ts', 'packages/core/src/domain/settings/use-provider-edit.ts', 'scripts/check-doc-symbol-drift.mjs'],
  'docs/design/catalog-provider-field-authority.impl-plan.md': ['packages/runtime/src/services/provider-config-helper.ts', 'packages/runtime/src/services/provider-catalog.ts', 'packages/runtime/src/services/auth/provider-credential-resolver.ts', 'packages/runtime/src/infra/pi/pi-provider-store.ts', 'packages/core/src/domain/settings/use-provider-edit.ts', 'scripts/check-doc-symbol-drift.mjs'],
  // replay port 设计（subagent 完成回收在新架构上的重放移植）：M1/M2 落点在
  // pi-subagent-cli，M3 落点在 subagent-core execution（watchdog 复用 settled-watchdog
  // 原语）；MAX_ATTEMPTS 引执行面、CANCEL_SETTLE_GRACE_MS 引协议面、DOC_MODULE_MAP 引守卫
  // 本体——按文档实际引用符号的所在模块逐条登记（宁准勿滥）。
  'docs/design/subagent-agent-end-recovery-replay.md': [
    'packages/pi-subagent-cli/src',
    'packages/subagent-core/src/execution',
    'packages/subagent-core/src/orchestration/execute-agent-call.ts',
    'packages/subagent-engine-sdk/src/protocol/engine-protocol.ts',
    'scripts/check-doc-symbol-drift.mjs',
  ],
}

/** 环境变量名白名单（非导出符号，文档合法引用）：项目（XYZ_/PI_）与运行平台（NODE_/ELECTRON_/ZCODE_）env 前缀 */
const ENV_NAME_ALLOW_RE = /^(XYZ_|PI_|NODE_|ELECTRON_|ZCODE_)[A-Z0-9_]+$/
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

function main() {
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

  const missingPaths = checkPathRefs()

  if (drifts.length > 0 || missingPaths.length > 0) {
    if (drifts.length > 0) {
      console.error(`[doc-symbol-drift] 发现 ${drifts.length} 个文档引用了源码中不存在的符号：`)
      for (const d of drifts) {
        console.error(`  ✗ ${d.doc}:${d.lines.join(',')}  \`${d.sym}\` 不在映射源码模块的导出表/对象键中`)
      }
    }
    if (missingPaths.length > 0) {
      console.error(`[doc-path-refs] 发现 ${missingPaths.length} 处文档引用的仓库路径不存在：`)
      for (const m of missingPaths) {
        console.error(`  ✗ ${m.doc}:${m.line}  \`${m.path}\` 文件不存在`)
      }
    }
    console.error('')
    console.error('恢复动作：该符号/路径已被删除或改名——同步修正文档（改用现行导出名/现路径或文字描述），')
    console.error('或在 scripts/check-doc-symbol-drift.mjs 登记：符号走 DOC_MODULE_MAP 映射，路径走 PATH_REF_EXEMPT（须附理由）。')
    process.exit(1)
  }
  console.log(`[doc-symbol-drift] OK：${Object.keys(DOC_MODULE_MAP).length} 个映射文档 × 源码导出表，零悬空符号；${collectPathRefDocs().length} 个活跃测试文档 × 路径存在性，零悬空引用`)
}

main()
