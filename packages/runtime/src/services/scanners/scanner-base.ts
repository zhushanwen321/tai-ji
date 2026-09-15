import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ScanSourceType } from '@taiji/shared'
// expandHome 的权威定义已收敛到 utils/path-utils.ts（R4）；re-export 供 scanner 调用方沿用。
export { expandHome } from '../../utils/path-utils.js'
import { expandHome } from '../../utils/path-utils.js'

/**
 * Walk every subdirectory under the given scan sources (D6/D21).
 *
 * Shared traversal skeleton for agent/skill scanners: expand ~, infer source
 * type, guard on existence + readdirSync, then yield each subdirectory that
 * passes the symlink-aware isDirectory guard. Per-domain logic (candidate file
 * discovery, frontmatter parsing, result shaping) stays inline in each scanner's
 * callback — only the ~20-line traversal boilerplate is shared here.
 *
 * `continue` semantics map to `return` from `onDir`: a callback returns early to
 * skip the current directory. Unreadable sources/dirs are skipped silently
 * (matches each scanner's original per-dir try/catch behavior); callback-side
 * errors are the callback's own responsibility.
 */
export function forEachScannedDir(
  sources: string[],
  onDir: (dirPath: string, entryName: string, sourceType: ScanSourceType) => void,
): void {
  for (const rawSource of sources) {
    const source = expandHome(rawSource)
    const sourceType = inferSourceType(rawSource)

    if (!existsSync(source)) continue
    let names: string[]
    try {
      names = readdirSync(source)
    } catch {
      continue
    }

    for (const name of names) {
      const dirPath = join(source, name)
      // statSync 跟随符号链接，正确处理 symlinked agent/skill 目录
      try {
        if (!statSync(dirPath).isDirectory()) continue
      } catch {
        continue
      }
      onDir(dirPath, name, sourceType)
    }
  }
}

// atomicWrite 已迁至跨层共享层 utils/fs-utils.ts（ADR 0035）：该函数被 infra 和
// services 共用，无业务语义，不属于任一业务层。scanner 自身用不到它。

/** Infer scan source type from the path's directory conventions. */
export function inferSourceType(path: string): ScanSourceType {
  // 用路径分隔符限定，避免 .pi-backup、.claude-old 等误判
  const sep = /[/\\]/
  // 检查路径中是否包含 /.<name>/ 或 \<name>\ 的目录段
  const segments = path.split(sep)
  for (const seg of segments) {
    // 匹配 .taiji 及其变体（如 .taiji-dev、.taiji-v2），但不匹配 .taijiator 等非预期名称
    if (seg === '.taiji' || seg.startsWith('.taiji-')) return 'pi'
    if (seg === '.pi') return 'pi'
    if (seg === '.claude') return 'claude'
    if (seg === '.agents') return 'agents'
  }
  return 'custom'
}
