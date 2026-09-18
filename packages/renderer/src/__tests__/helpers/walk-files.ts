/**
 * 递归遍历目录收集文件路径（测试用静态扫描基建）。
 *
 * renderer 测试内多份同型递归遍历（locale-sync / key-existence / reduced-motion-guard /
 * landing 唯一挂载点等）的共享实现——差异只在参数：扩展名过滤 / 跳过目录 / 是否收集目录，
 * 非真差异。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export function walkFiles(
  dir: string,
  opts: { extensions?: readonly string[]; skipDirs?: readonly string[]; withDirs?: boolean } = {},
): string[] {
  const { extensions, skipDirs = [], withDirs = false } = opts
  const out: string[] = []

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue
        if (withDirs) out.push(full)
        walk(full)
      } else if (extensions === undefined || extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(full)
      }
    }
  }

  walk(dir)
  return out
}
