#!/usr/bin/env node
/**
 * 跨进程契约字面量多侧对账守卫（cross-process-literals）。
 *
 * 两组契约串的定义点分属互相不可 import 的包（runtime ↔ pi extension ↔ 桌面
 * plugin 各为独立进程/独立构建单元），编译期拦截不可行，多侧手抄仅靠注释纪律
 * 同步，无任何机器信号——本脚本把「多侧同步改」变成可机检的失败：
 *   - 'taiji.client-msg-id'：pi session custom entry，承载 userEntryId → clientUuid
 *     映射（runtime entry-tree-builder / revoke-orchestrator × msg-id-mapper 扩展）
 *   - 'taiji:revoked'：LabelEntry 撤回信号，runtime 侧以 custom entry 补记失效，
 *     agent-ext 与 scheduler-manager 插件消费
 *
 * 检查逻辑（TypeScript 编译器 API 语法级 AST 解析，同 check-chat-ops-sync.mjs
 * 惯例）：对每个登记文件提取代码字符串字面量集合（模板串无插值形态同算；注释
 * 不是字面量不算），断言含登记串。采用「含串」断言而非「提取定义点比等值」：
 * 登记侧形态异构（const 声明 / 内联实参），含串断言对全部形态成立，且跨包不可
 * import 保证每侧必须本地出现该串——定义点改值、改写形态、删除任一即红，
 * 注释残留旧串不构成误放行（注释不进字面量集合）。
 *
 * 退出码契约：0=全部登记侧同串；1=存在漂移（明细列出缺串文件）；2=守卫自身
 * 输入故障（登记文件缺失/不可读——守卫看不到定义点了，恢复动作指向登记表，
 * 与「检查不通过」可区分）。
 *
 * 用法：node scripts/check-cross-process-literals.mjs（全量对账，毫秒级，无需
 * 增量）。import 消费导出纯函数不触发主流程（check-chat-ops-sync.mjs 同款惯例）。
 * 新增跨进程契约串（第三组及以上）时在 GROUPS 登记串值与全部生产定义点文件。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// fileURLToPath 而非 URL.pathname：Windows 上 pathname 返回 /D:/... 形态，resolve 叠加盘符成 D:\D:\（check-doc-symbol-drift.mjs 同款）
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 跨进程契约串登记表：literal 串值必须逐字出现在每个 files 条目的代码字符串
 * 字面量中（不含注释）。串值或文件集变更 = 契约面变更，须与本表同 commit。
 */
const GROUPS = [
  {
    literal: 'taiji.client-msg-id',
    files: [
      'packages/runtime/src/infra/pi/entry-tree-builder.ts',
      'packages/runtime/src/services/session/revoke-orchestrator.ts',
      'extensions/taiji/msg-id-mapper/src/index.ts',
    ],
  },
  {
    literal: 'taiji:revoked',
    files: [
      'packages/runtime/src/services/session/revoke-orchestrator.ts',
      'extensions/taiji/agent-ext/src/index.ts',
      'resources/plugins/scheduler-manager/index.ts',
    ],
  },
]

/** 读取登记文件；缺失/不可读 = 守卫自身输入故障（exit 2，≠ 漂移 exit 1） */
function readSource(rel) {
  try {
    return readFileSync(path.join(PROJECT_ROOT, rel), 'utf-8')
  } catch {
    console.error(`[cross-process-literals] 检查器配置故障：登记文件不存在或不可读: ${rel}`)
    console.error(`恢复动作：确认 ${rel} 路径仍有效；文件已删除/改名时同步更新`)
    console.error(`scripts/check-cross-process-literals.mjs 头部 GROUPS 登记表。`)
    process.exit(2)
  }
}

/**
 * 源文本 → 代码字符串字面量值集合（含无插值模板串；注释不算）。
 * @param {string} sourceText
 * @param {string} rel 仅用于 AST 源文件标注
 * @returns {Set<string>}
 */
export function extractStringLiterals(sourceText, rel) {
  const sf = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true)
  const literals = new Set()
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return literals
}

/** 主流程：逐组逐文件断言含串，漂移明细全部列完后统一 exit 1（不首错即停） */
function main() {
  const drifts = []
  for (const group of GROUPS) {
    for (const rel of group.files) {
      const literals = extractStringLiterals(readSource(rel), rel)
      if (!literals.has(group.literal)) {
        drifts.push({ literal: group.literal, rel })
      }
    }
  }
  if (drifts.length > 0) {
    console.error(`[cross-process-literals] 跨进程契约字面量漂移 ${drifts.length} 处：`)
    for (const d of drifts) {
      console.error(`  ✗ "${d.literal}" 未出现在 ${d.rel} 的代码字符串字面量中（注释残留不算）`)
    }
    console.error('')
    console.error(`恢复动作：该串为跨进程契约（各侧不可互相 import，只能同串手抄），`)
    console.error(`以脚本头部 GROUPS 登记表为清单，把列出的文件同步回登记串值；确属契约`)
    console.error(`串本身变更时，同步更新全部登记侧与本登记表并同 commit 提交。`)
    process.exit(1)
  }
  const groupSummary = GROUPS.map((g) => `"${g.literal}"×${g.files.length} 侧`).join('、')
  console.log(`[cross-process-literals] OK：${groupSummary}，全部登记侧同串`)
}

// 缺省 CLI 形态（不依赖 cwd）；import 消费导出纯函数时不触发主流程
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main()
}
