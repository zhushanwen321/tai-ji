#!/usr/bin/env node
/**
 * skill-data-dir.mjs —— skill 产物数据目录解析（全仓单一出口，impl-spec §2.2）。
 *
 * 用法：node scripts/skill-data-dir.mjs <kind> <repo_root>
 * 输出：stdout = 该 kind 的产物目录绝对路径；stderr = 诊断；退出码 0 = 成功 / 1 = 用法或解析错误。
 *
 * 目录布局：~/.agents/skill-data/<kind>/<project-slug>/
 * project-slug = <repo 目录名>-<sha256(realpath) 前 8 位>——realpath 归一（worktree
 * 符号链接与 macOS /var→/private/var 别名不产生不同 slug），sha256 段隔离同
 * 名不同路径的仓库，目录名段保持人可读。
 *
 * 消费方（.agents/skills/pr-cr-fix/scripts/coverage-gate.py / metrics-gate.py）：
 * 解析失败（本脚本缺失 / 非零退出 / 空输出）时降级只写旧 .review/ 目录，门禁判定不受影响；
 * 解析成功时新旧目录同内容双写。本脚本入 git 随分支传播，读方脚本（不入 git）按
 * 旧目录兼容窗口设计，删除/改输出格式前须先核对读方兼容性。
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

const [kind, repoRootArg] = process.argv.slice(2)

if (!kind || !repoRootArg || process.argv.slice(2).length !== 2) {
  console.error('用法：node scripts/skill-data-dir.mjs <kind> <repo_root>')
  process.exit(1)
}

let repoRoot
try {
  repoRoot = realpathSync(repoRootArg)
} catch (e) {
  console.error(`repo_root 无法解析为真实路径：${repoRootArg}（${e.message}）`)
  process.exit(1)
}

const repoName = repoRoot.split('/').pop() || 'repo'
const digest = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
process.stdout.write(join(homedir(), '.agents', 'skill-data', kind, `${repoName}-${digest}`))
