/**
 * 文件路径/basename 反查工具（w6 从 renderer lib/file-basename.ts 迁入 ui）。
 *
 * 用途：markdown 路径识别白名单（design.md 裸 basename、src/foo.ts 含/路径）
 * → 点击时按 basename/path 反查完整 FileNode。
 *
 * 纯函数，零 renderer 依赖（仅 @taiji/shared FileNode 类型）。
 */
import type { FileNode } from '@taiji/shared'

/** 从全量 FileNode[] 收集指定 basename 的所有匹配（type==='file'）。 */
export function findByBasename(nodes: FileNode[], basename: string): FileNode[] {
  return nodes.filter((n) => n.type === 'file' && n.name === basename)
}

/** 扁平化 FileNode[] 为 basename Set，供 markdown env.localFiles 用。 */
export function collectBasenames(nodes: FileNode[]): Set<string> {
  const set = new Set<string>()
  const walk = (ns: FileNode[]): void => {
    for (const n of ns) {
      if (n.type === 'file') set.add(n.name)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return set
}

/** 扁平化 FileNode[] 为 path Set，供 markdown env.filePaths 用（含/路径识别白名单）。 */
export function collectFilePaths(nodes: FileNode[]): Set<string> {
  const set = new Set<string>()
  const walk = (ns: FileNode[]): void => {
    for (const n of ns) {
      if (n.type === 'file') set.add(n.path)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return set
}
