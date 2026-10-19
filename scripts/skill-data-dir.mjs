#!/usr/bin/env node
/**
 * skill-data-dir.mjs — 技能工作流产物目录的单一解析出口（impl-spec §2.2，设计 design.md §3.1）。
 *
 * CLI 用法：
 *   node scripts/skill-data-dir.mjs <segment> [projectRoot]
 *   - segment ∈ tech-design | dev-flow | review-fix-loop | dev-merge | pr-review
 *   - projectRoot 缺省 = realpath(process.cwd())
 *   - stdout 输出 skillDataDir 绝对路径（单行）
 *   - realpath 解析失败（路径不存在）→ exit 1 报错，不静默回退
 *   - SKILL_DATA_DIR env 非空时作为根替代 ~/.agents/skill-data（仅 node 直跑域适用：
 *     gate 脚本链、手工验证。该 env 不入 ENV_WHITELIST_PREFIXES，runtime→pi 子进程链
 *     会剥除，extension 内置循环收不到，不为此扩白名单——design.md §3.1）
 *
 * mjs import 用法（同进程零成本，impl-spec §2.2）：
 *   import { skillDataDir, projectSlug } from "./skill-data-dir.mjs"
 *
 * 消费方（.agents/skills/pr-cr-fix/scripts/coverage-gate.py / metrics-gate.py）：
 * 解析失败（本脚本缺失 / 非零退出 / 空输出）时降级只写旧 .review/ 目录，门禁判定不受影响；
 * 解析成功时新旧目录同内容双写。本脚本入 git 随分支传播，读方脚本（不入 git）按
 * 旧目录兼容窗口设计，删除/改输出格式前须先核对读方兼容性。
 *
 * slug 算法（design.md §3.1 全域唯一，固定测试向量 impl-spec §3）：
 *   规范化 realpath()（解析 symlink、消尾斜杠、消 ..）
 *   slug = basename(realpath) + "-" + sha256(realpath) 前 8 位十六进制小写
 */

import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** 合法段名（design.md §4 段名对照的封闭集合；typo 段名 fail-fast 防数据散落不同 slug 目录） */
export const SEGMENTS = ['tech-design', 'dev-flow', 'review-fix-loop', 'dev-merge', 'pr-review']

/** 数据根：SKILL_DATA_DIR env 非空替代，否则 HOME 下动态推导（禁写死绝对路径） */
export function skillDataRoot() {
  return process.env.SKILL_DATA_DIR || `${homedir()}/.agents/skill-data`
}

/** projectRoot 绝对路径 → slug。realpath 解析失败抛错（调用方报错，不静默）。 */
export function projectSlug(projectRoot) {
  const real = realpathSync(projectRoot)
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 8)
  return `${basename(real)}-${hash}`
}

/** (segment, projectRoot) → `<root>/<segment>/<slug>` 绝对路径 */
export function skillDataDir(segment, projectRoot = process.cwd()) {
  if (!SEGMENTS.includes(segment)) {
    throw new Error(`未知 segment "${segment}"。合法段：${SEGMENTS.join(' | ')}（design.md §4 段名对照）`)
  }
  return `${skillDataRoot()}/${segment}/${projectSlug(projectRoot)}`
}

function main(argv) {
  const [segment, projectRoot] = argv
  if (!segment) {
    console.error('用法：node scripts/skill-data-dir.mjs <segment> [projectRoot]')
    console.error(`合法 segment：${SEGMENTS.join(' | ')}；projectRoot 缺省 = 当前目录`)
    process.exit(2)
  }
  try {
    console.log(skillDataDir(segment, projectRoot ?? process.cwd()))
  } catch (e) {
    console.error(`ERROR: projectRoot 解析失败（${projectRoot ?? 'cwd'}）：${e.message}`)
    console.error('恢复：确认目录真实存在后重跑（realpath 要求路径存在，解析失败不静默回退）')
    process.exit(1)
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isMain) main(process.argv.slice(2))
