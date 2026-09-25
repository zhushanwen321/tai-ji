#!/usr/bin/env node
/**
 * chat store facet 双清单对账守卫（chat-ops-sync）。
 *
 * [HISTORICAL] 起因 2026-09-25（code-overdesign-audit 候选 6 / msg-pipeline-debloat
 * 设计 D5-4）：「组件禁做编排」边界登记两份——store.ts 的 ChatStoreOps Pick 字段清单
 * （类型面 SSOT）× taste-lint 规则 no-chat-ops-in-components 的 OPS_FIELDS 手写 Set
 * （lint 拦截面），靠「两处同步改」人工契约维护，实测漂移 13 项（lint 清单残留 5 个
 * 已退役方法 + 漏拦 8 个现役 ops——组件调这些写口不亮红，规则承诺的边界有洞），无任何
 * 机器信号，靠事后对抗审查才抓出。本脚本把「两处同步改」变成可机检的失败。
 *
 * 为什么是独立 check 脚本而不是 lint 规则 import 类型导出（设计 D5-4 权衡）：taste-lint
 * 规则是根目录 .mjs，无 TS import 能力；「导出字段名数组」路线需数组导出 + 同步断言 +
 * codegen 消费链三件，概念更多。
 *
 * 检查逻辑（TypeScript 编译器 API 语法级 AST 解析，同 check-doc-symbol-drift.mjs 惯例；
 * 两侧均机械提取，字段增删自动跟随，不写死字段清单）：
 *   1. store.ts：提取 `export type ChatStoreOps = Pick<ChatStoreInstance, 'a' | 'b' …>`
 *      的字符串字面量字段集
 *   2. taste-lint 规则：提取 `const OPS_FIELDS = new Set([…])` 的字符串字面量字段集
 *      （OPS_FIELDS 未导出，仅能从源文本提取）
 *   3. 双向差集：任一方向非空 → 红灯列差异集（哪侧多/少哪些字段），exit 1
 *
 * 退出码契约：0=双清单一致；1=存在漂移；2=守卫自身输入故障（文件缺失/结构不符合预期
 * 形态——守卫看不到清单了，恢复动作指向源文件，与「检查不通过」可区分）。
 *
 * 用法：node scripts/check-chat-ops-sync.mjs（全量对账，毫秒级，无需增量）。
 * import 消费导出纯函数不触发主流程（check-doc-symbol-drift.mjs 同款惯例）。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// fileURLToPath 而非 URL.pathname：Windows 上 pathname 返回 /D:/... 形态，resolve 叠加盘符成 D:\D:\（check-doc-symbol-drift.mjs 同款）
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 类型面 SSOT：ChatStoreOps Pick 字段清单所在文件与别名 */
const STORE_REL = 'packages/core/src/domain/chat/store.ts'
const FACET_TYPE_NAME = 'ChatStoreOps'
/** lint 拦截面：OPS_FIELDS 手写 Set 所在规则文件与常量名 */
const RULE_REL = 'taste-lint/rules/no-chat-ops-in-components.mjs'
const LINT_FIELD_CONST = 'OPS_FIELDS'

/** 读取对账源文件；缺失/不可读 = 守卫自身输入故障（exit 2，≠ 漂移 exit 1） */
function readSource(rel) {
  try {
    return readFileSync(path.join(PROJECT_ROOT, rel), 'utf-8')
  } catch {
    console.error(`[chat-ops-sync] 检查器配置故障：对账源文件不存在或不可读: ${rel}`)
    console.error(`恢复动作：确认 ${rel} 路径仍有效；文件已删除/改名时同步更新`)
    console.error(`scripts/check-chat-ops-sync.mjs 头部的 ${STORE_REL} / ${RULE_REL} 登记锚点。`)
    process.exit(2)
  }
}

/**
 * Pick<T, 'a' | 'b' …> 形态校验 + 第二类型参数的字面量收集。
 * 结构不符（非 Pick / 基底类型名不符 / 字面量混入计算键）返回 null——
 * 说明 facet 类型形态变了，守卫失去提取能力，按配置故障处置而非静默放行。
 */
function pickLiteralFields(typeNode, baseTypeName) {
  if (!ts.isTypeReferenceNode(typeNode) || typeNode.typeArguments?.length !== 2) return null
  const base = typeNode.typeArguments[0]
  if (!ts.isTypeReferenceNode(base) || base.typeName.text !== baseTypeName) return null
  const union = typeNode.typeArguments[1]
  const members = ts.isUnionTypeNode(union) ? union.types : [union]
  const fields = new Set()
  for (const m of members) {
    if (!ts.isLiteralTypeNode(m) || !ts.isStringLiteral(m.literal)) return null
    fields.add(m.literal.text)
  }
  return fields
}

/**
 * 从 store.ts 源文本提取 ChatStoreOps Pick 的字面量字段集。
 * @returns {Set<string>|null} null = 未找到别名或结构不符（配置故障）
 */
export function extractFacetOpsFields(sourceText) {
  const sf = ts.createSourceFile(STORE_REL, sourceText, ts.ScriptTarget.Latest, true)
  let fields = null
  const visit = (node) => {
    if (fields === null && ts.isTypeAliasDeclaration(node) && node.name.text === FACET_TYPE_NAME) {
      fields = pickLiteralFields(node.type, 'ChatStoreInstance')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return fields
}

/**
 * 从 taste-lint 规则源文本提取 const OPS_FIELDS = new Set([…]) 的字符串字面量字段集
 * （OPS_FIELDS 未导出，仅能从源文本机械提取）。数组出现非字符串字面量元素（展开、
 * 计算成员等）按结构不符返回 null——守卫失去提取能力时显形，不静默放行。
 * @returns {Set<string>|null} null = 未找到常量或结构不符（配置故障）
 */
export function extractLintOpsFields(sourceText) {
  const sf = ts.createSourceFile(RULE_REL, sourceText, ts.ScriptTarget.Latest, true)
  let fields = null
  // 遍历形状与 extractFacetOpsFields 同构：判定+解析不短路 return，末尾无条件
  // 下钻——SourceFile 本身不是 VariableStatement，短路形态会让首调用即返回、
  // 整棵树从未遍历（首跑实测踩坑）
  const visit = (node) => {
    if (fields === null && ts.isVariableStatement(node) && node.parent === sf) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== LINT_FIELD_CONST) continue
        const init = decl.initializer
        if (!init || !ts.isNewExpression(init)) continue
        if (!ts.isIdentifier(init.expression) || init.expression.text !== 'Set') continue
        const arr = init.arguments?.[0]
        if (!arr || !ts.isArrayLiteralExpression(arr)) continue
        const collected = new Set()
        let wellFormed = true
        for (const el of arr.elements) {
          if (!ts.isStringLiteral(el)) {
            wellFormed = false
            break
          }
          collected.add(el.text)
        }
        if (wellFormed) fields = collected
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return fields
}

/** 配置故障报告（提取失败时）：退出码 2，恢复动作指向源文件 */
function reportExtractorFailure(target, rel) {
  console.error(`[chat-ops-sync] 检查器配置故障：无法从 ${rel} 提取 ${target} 字段清单`)
  console.error('（别名/常量不存在，或结构不再符合守卫假设的提取形态——Pick<ChatStoreInstance, …> / new Set([…字符串字面量])）。')
  console.error(`恢复动作：确认 ${target} 形态后更新 scripts/check-chat-ops-sync.mjs 的提取逻辑。`)
  process.exit(2)
}

/** 漂移报告（退出码 1）：哪侧多/少哪些字段，逐项列出 */
function reportDrift(facetFields, lintFields) {
  const ghost = [...lintFields].filter((f) => !facetFields.has(f)).sort()
  const missing = [...facetFields].filter((f) => !lintFields.has(f)).sort()
  if (ghost.length === 0 && missing.length === 0) return false
  console.error(`[chat-ops-sync] facet 双清单漂移 ${ghost.length + missing.length} 项（SSOT = ${STORE_REL} 的 ${FACET_TYPE_NAME}）：`)
  if (ghost.length > 0) {
    console.error(`  ✗ 幽灵项 ${ghost.length} 个（${LINT_FIELD_CONST} 有、${FACET_TYPE_NAME} 无——已退役方法残留于 lint 清单）：`)
    for (const f of ghost) console.error(`      - ${f}`)
  }
  if (missing.length > 0) {
    console.error(`  ✗ 漏拦项 ${missing.length} 个（${FACET_TYPE_NAME} 有、${LINT_FIELD_CONST} 无——现役 ops 字段组件调用不亮红）：`)
    for (const f of missing) console.error(`      - ${f}`)
  }
  console.error('')
  console.error(`恢复动作：以 ${STORE_REL} 的 ${FACET_TYPE_NAME} 为唯一清单，同步 ${RULE_REL}`)
  console.error(`的 ${LINT_FIELD_CONST}（幽灵删除、漏拦补入），两清单字段集须完全一致。`)
  return true
}

function main() {
  const facetFields = extractFacetOpsFields(readSource(STORE_REL))
  if (facetFields === null || facetFields.size === 0) reportExtractorFailure(FACET_TYPE_NAME, STORE_REL)
  const lintFields = extractLintOpsFields(readSource(RULE_REL))
  if (lintFields === null || lintFields.size === 0) reportExtractorFailure(LINT_FIELD_CONST, RULE_REL)
  if (reportDrift(facetFields, lintFields)) process.exit(1)
  console.log(`[chat-ops-sync] OK：${FACET_TYPE_NAME} ${facetFields.size} 字段 × ${LINT_FIELD_CONST} ${lintFields.size} 字段，零漂移`)
}

// 缺省 CLI 形态（不依赖 cwd）；import 消费导出纯函数时不触发主流程
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main()
}
