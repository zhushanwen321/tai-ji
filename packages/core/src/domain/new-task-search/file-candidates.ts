/**
 * FileNode → composer `#` 候选项的 DTO 映射（G16）。
 *
 * 来源：packages/renderer/src/lib/file-candidates.ts（strangler 逐域绞杀下沉，原样迁移）。
 *
 * 背景：file.search 返回 FileNode[]（{path, name, type:'dir'|'file', ...}，name 是 basename
 * 不带斜杠），但 CommandPopover 的 file 分支期望的候选项形状是 mock FILE_CANDIDATES 的
 * {id, name, kind:'目录'|'文件', path?}（中文 kind，目录 name 带尾随斜杠）。两套 DTO 不同构，
 * 直接喂会导致图标判定失效（CommandPopover 用 `f.kind === '目录' ? 'folder' : 'file'`）。
 *
 * 映射规则：
 * - id = path（FileNode.path 相对 cwd，唯一）
 * - name = 目录补尾随斜杠（'src' → 'src/'），文件保持 basename
 * - kind = 中文 '目录' / '文件'（对齐 CommandPopover 图标判定）
 * - path = FileNode.path（透传）
 * - type = FileNode.type（透传，供消费方按需区分）
 */
import type { FileNode } from '@taiji/shared'

/** composer `#` 候选项形状（与 mock FILE_CANDIDATES 同构，CommandPopover 消费） */
export interface FileCandidate {
  id: string
  name: string
  kind: string
  path?: string
  type?: 'dir' | 'file'
  /** 原始 basename（FileNode.name，纯文件名/目录名，不含路径）。
   *  排序匹配度基于此字段（非加工后的 name），保证 name=AGENTS.md 与 query=agents 的前缀匹配判定正确。 */
  basename?: string
}

/**
 * FileNode[] → FileCandidate[] 映射。
 *
 * name 策略（两行展示，主行用 basename）：
 * - 目录：basename 补尾随斜杠（如 `auth/`），完整路径由 CommandPopover 第二行（dirPath）展示。
 * - 文件：保持 basename（如 `token.ts`），父目录路径由第二行展示。
 *
 * 同名不同位置的文件/目录（src/utils/ vs tools/utils/）靠第二行父路径区分，
 * 主行 name 统一用 basename，视觉一致。
 * kind 用中文（目录/文件），对齐 CommandPopover 图标判定逻辑。
 */
export function toFileCandidates(nodes: FileNode[]): FileCandidate[] {
  return nodes.map((n) => ({
    id: n.path,
    name: n.type === 'dir' ? `${n.name}/` : n.name,
    kind: n.type === 'dir' ? '目录' : '文件',
    path: n.path,
    type: n.type,
    basename: n.name,
  }))
}
