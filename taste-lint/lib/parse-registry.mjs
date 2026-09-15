/**
 * 登记表解析共享模块（data-source-governance W24：许可表来自登记表）。
 *
 * docs/architecture/data-source-registry.md 是 S1/R2/R3 共同依据的 SSOT（登记表表头
 * 声明 2「条目失真即护栏失真」）。本模块把「与登记表人工同步」升级为「运行时从登记表
 * 解析」：R3 的条目校验清单、R2 许可表的条目引用都从这里取——登记表条目变更（删条目/
 * 改号）后 lint 直接红，不再依赖人工同步。
 *
 * 解析口径：§1 主表行首列形如 `| #1 |` / `| P1 |`（§3 写点表行首是 `| 1. `、§4 例外表
 * 行首是 `| ① `，均不匹配，不会误收）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REGISTRY_RELPATH = join('docs', 'architecture', 'data-source-registry.md')

/** 仓库根（taste-lint/lib/ 的上两级；eslint 与 node --test 均从仓库布局内运行）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const REGISTRY_PATH = join(ROOT, REGISTRY_RELPATH)

/**
 * 解析登记表 markdown，返回条目编号集合（如 '#1'...'#12'、'P1'）。
 * 纯函数（测试直接喂文本变体），loadRegistryEntries 的解析核心。
 */
export function parseRegistryEntries(markdown) {
  const entries = new Set()
  for (const match of markdown.matchAll(/^\|\s*(#\d+|P\d+)\s*\|/gm)) {
    entries.add(match[1])
  }
  return entries
}

let cachedEntries = null

/**
 * 读登记表文件并解析（模块级缓存——lint 全程只读一次）。
 * 文件缺失/为空 = 护栏配置失真，fail loud（错误信息指向登记表路径）。
 */
export function loadRegistryEntries() {
  if (cachedEntries) return cachedEntries
  let markdown
  try {
    markdown = readFileSync(REGISTRY_PATH, 'utf8')
  } catch (err) {
    throw new Error(
      `[data-source-governance] 登记表不可读：${REGISTRY_PATH}（${err.message}）——` +
        '登记表是 R2/R3 许可表的 SSOT，缺失即护栏失效；恢复文件后重跑 lint。',
    )
  }
  const entries = parseRegistryEntries(markdown)
  if (entries.size === 0) {
    throw new Error(
      `[data-source-governance] 登记表解析出 0 条目：${REGISTRY_PATH}——` +
        '§1 主表格式变更会导致许可表联动失效，按登记表表头声明核对表格行首列格式。',
    )
  }
  cachedEntries = entries
  return entries
}

/**
 * 校验许可表条目引用全部在登记表内。
 * 返回失效引用数组（空 = 通过）；纯函数（测试喂构造的许可表 + 条目集）。
 */
export function findStaleEntries(permittedList, registryEntries) {
  const stale = []
  for (const item of permittedList) {
    for (const entry of item.entries) {
      if (!registryEntries.has(entry)) stale.push({ entry, suffix: item.suffix })
    }
  }
  return stale
}
