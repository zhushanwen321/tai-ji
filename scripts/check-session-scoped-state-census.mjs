#!/usr/bin/env node
/**
 * useSessionScopedState 全仓调用点 census 守卫（独立脚本）。
 *
 * 扫描设施迁自 packages/core/src/foundation/use-session-scoped-state.test.ts 的
 * 「C-1 census 静态锁」describe 块（该测试后续改为薄包装消费本脚本）。锁的目标：
 * per-session 状态 composable（ADR-0049 useSessionScopedState 工厂）的调用入口边界——
 * 清单外出现新调用点（新文件，或已有文件内新增）即红，审阅其 scope 上下文
 * （守卫后无 scope 误调用零运行时信号，观测损失已登记，入口静态锁是唯一防线）。
 *
 * 匹配口径（与原 C-1 测试逐字一致，改动即破坏计数兼容）：
 * - 调用点模式 = /useSessionScopedState\s*[<(]/（裸括号 + 泛型双形态，含空白变体；
 *   import 引用不命中）；计数用 g 变体（同行多调用不漏计）。
 * - 工厂定义行（`function useSessionScopedState`）不算调用点。
 * - 扫描范围 = 全仓非测试 .ts/.tsx/.vue；剪枝 node_modules/dist/build/coverage/
 *   test-results 与点前缀目录、__tests__ 目录、.spec./.test. 后缀文件。
 *
 * 退出码契约：0=合规（census 与快照逐文件一致）；3=census 与快照不符（新增/消失/
 * 计数变化，输出 diff）；1=脚本自身异常（仓库根缺失等）。
 *
 * 快照修正流程：有意新增/迁移/删除调用点后重跑本脚本，按输出 diff 更新下方
 * CENSUS_SNAPSHOT（逐文件清单而非总数——防「+1 处新调用 +1 处删除」净额抵消漏检），
 * 并在 commit message 说明变更理由。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CALL_PATTERN = /useSessionScopedState\s*[<(]/
// 计数专用全局变体（g 标志的 lastIndex 状态会让重复 .test 结果翻转，只用于 match）
const CALL_PATTERN_G = new RegExp(CALL_PATTERN.source, 'g')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results'])

/**
 * 实测快照（来源：console-noise-triage §2 前提 3 census + C-1 实施期复测，两期口径
 * 一致；13 个文件各 1 处非测试调用点，含模块级 2 处 drawer/control.ts 与
 * useSessionTrace.ts）。复核方式：`node scripts/check-session-scoped-state-census.mjs`
 * 干跑，按输出与下表逐文件对账；计数不符即 exit 3。
 */
const CENSUS_SNAPSHOT = {
  'packages/core/src/domain/drawer/control.ts': 1,
  'packages/dom-core/src/composer/input/history.ts': 1,
  'packages/renderer/src/components/panel/MessageStream.vue': 1,
  'packages/renderer/src/components/panel/BtwPanel.vue': 1,
  'packages/renderer/src/components/panel/tray/TrayNativePanel.vue': 1,
  'packages/renderer/src/composables/features/file-tree/useGitStatus.ts': 1,
  'packages/renderer/src/composables/features/model/useContextUsage.ts': 1,
  'packages/renderer/src/composables/features/model/useGenStats.ts': 1,
  'packages/renderer/src/composables/features/sidebar/useBackgroundTasks.ts': 1,
  'packages/renderer/src/composables/features/trace/useSessionTrace.ts': 1,
  'packages/renderer/src/composables/panel/composer-shell.ts': 1,
  'packages/renderer/src/composables/panel/useBtwTabData.ts': 1,
  'packages/renderer/src/composables/panel/useSkillNoticeStream.ts': 1,
  'packages/renderer/src/stores/plan-store.ts': 1,
  'packages/ui/src/extension-host/dialog-request-queue.ts': 1,
}

/** 收集全仓非测试源码（.ts/.tsx/.vue）中的工厂调用点：{ 仓库相对路径: 调用次数 }。
 *  不可读目录 stderr 告警后跳过（降级显形，不计入违规判定）。 */
export function collectCallSites() {
  const out = {}
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      console.error(`[census] 目录不可读，跳过: ${dir}（${e.code ?? e.message}）`)
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(ts|tsx|vue)$/.test(entry.name)) continue
      if (/\.(spec|test)\.(ts|tsx|vue)$/.test(entry.name)) continue // 测试文件
      if (abs.includes(`${path.sep}__tests__${path.sep}`)) continue
      const lines = readFileSync(abs, 'utf8').split('\n')
      let count = 0
      for (const line of lines) {
        if (!CALL_PATTERN.test(line)) continue
        // 工厂定义行非调用点（`export function useSessionScopedState<T>(` 同样命中锁模式）
        if (line.includes('function useSessionScopedState')) continue
        count += (line.match(CALL_PATTERN_G) ?? []).length
      }
      if (count > 0) out[path.relative(REPO_ROOT, abs)] = count
    }
  }
  walk(REPO_ROOT)
  return out
}

/**
 * census 与快照对账（纯函数）：返回 null（一致）或 diff 描述列表。
 * @returns {string[] | null}
 */
export function compareCensusToSnapshot(actual) {
  const diffs = []
  for (const [file, count] of Object.entries(actual)) {
    if (!(file in CENSUS_SNAPSHOT)) diffs.push(`  + 新增调用点: ${file} (${count} 处)`)
    else if (CENSUS_SNAPSHOT[file] !== count) diffs.push(`  ~ 计数变化: ${file} 快照 ${CENSUS_SNAPSHOT[file]} → 实际 ${count}`)
  }
  for (const [file, count] of Object.entries(CENSUS_SNAPSHOT)) {
    if (!(file in actual)) diffs.push(`  - 消失调用点: ${file} (快照 ${count} 处)`)
  }
  return diffs.length > 0 ? diffs : null
}

function main() {
  if (!statSync(REPO_ROOT).isDirectory()) {
    console.error(`[census] 仓库根不存在: ${REPO_ROOT}`)
    process.exit(1)
  }
  const actual = collectCallSites()
  const total = Object.values(actual).reduce((a, b) => a + b, 0)
  const snapshotTotal = Object.values(CENSUS_SNAPSHOT).reduce((a, b) => a + b, 0)
  console.log(`[census] useSessionScopedState 调用点 census：实际 ${Object.keys(actual).length} 文件 / ${total} 处（快照 ${Object.keys(CENSUS_SNAPSHOT).length} 文件 / ${snapshotTotal} 处）`)
  for (const file of Object.keys(actual).sort()) {
    console.log(`  ${actual[file]}  ${file}`)
  }
  const diffs = compareCensusToSnapshot(actual)
  if (diffs) {
    console.error('[census] census 与快照不符（清单外新调用点即红——先审阅其 scope 上下文是否满足 ADR-0049 分区范式；有意变更则按脚本头注释更新 CENSUS_SNAPSHOT）：')
    for (const d of diffs) console.error(d)
    process.exit(3)
  }
  process.exit(0)
}

// 缺省 CLI 形态；import 消费导出纯函数（vitest 薄包装）不触发主流程
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main()
}
