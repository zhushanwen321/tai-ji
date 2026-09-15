/**
 * Mock file domain —— 与 real api/domains/file 同接口（VITE_MOCK=true 时由 api/index 注入）。
 *
 * 行为（D7 工程默认）：返回内存 fixture（最小文件树结构），不走 transport。
 * reload 即重置。供 E2E / mock 开发模式使用。
 *
 * [E2E 数据自洽] MOCK_TREE/MOCK_EXPAND 的路径与 mock/git.ts fixtureGitStatus 对齐，
 * 使 E2E 能验证角标渲染（git overlay per-path 挂载）。
 *
 * ignore 策略：与 real FileService 一致——始终返回 ignored 节点并标 ignored=true，
 * 前端按 showIgnored 开关做本地 computed 过滤。
 */
import type { FileNode } from '@taiji/shared'

/** mock 延迟（与 mock/index TIMING.ack 一致量级；setMockTiming 单入口同步注入，默认值不变） */
const TIMING = { ack: 40 }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 测试钩子通道（double-underscore 对齐 mock/index __clearTimers 约定）：
 * 由 index.ts 的 setMockTiming/resetMockTiming 编排调用，测试不直接调（单入口）。
 */
export function __setMockFileAck(ms: number): void {
  TIMING.ack = ms
}

/**
 * mock 文件树 fixture（顶层 + 一级子）。
 * 路径与 mock/git.ts fixtureGitStatus 对齐，让 E2E 角标（M/A/D/U）可见：
 * - src/new-feature.ts (A)、src/existing.ts (M)、src/dirty.ts (M)、src/old-file.ts (D)
 * - src/conflict.ts (U)、README.md (R)、untracked.log (untracked→A)
 */
const MOCK_TREE: FileNode[] = [
  {
    path: 'src',
    name: 'src',
    type: 'dir',
    children: [
      { path: 'src/new-feature.ts', name: 'new-feature.ts', type: 'file', size: 120 },
      { path: 'src/existing.ts', name: 'existing.ts', type: 'file', size: 80 },
      { path: 'src/dirty.ts', name: 'dirty.ts', type: 'file', size: 60 },
      { path: 'src/old-file.ts', name: 'old-file.ts', type: 'file', size: 40 },
      { path: 'src/conflict.ts', name: 'conflict.ts', type: 'file', size: 90 },
      { path: 'src/utils', name: 'utils', type: 'dir' },
      { path: 'src/index.ts', name: 'index.ts', type: 'file', size: 100 },
    ],
  },
  { path: 'README.md', name: 'README.md', type: 'file', size: 500 },
  { path: 'untracked.log', name: 'untracked.log', type: 'file', size: 30 },
  { path: 'package.json', name: 'package.json', type: 'file', size: 200 },
]

/** mock 被忽略的文件 fixture（始终返回并标 ignored=true，前端按 showIgnored 开关过滤） */
const MOCK_IGNORED: FileNode[] = [
  { path: 'node_modules', name: 'node_modules', type: 'dir' },
  { path: 'dist', name: 'dist', type: 'dir' },
  { path: '.env', name: '.env', type: 'file', size: 80 },
]

/** mock 展开目录的子节点 fixture（E2E-2 展开验证） */
const MOCK_EXPAND: Record<string, FileNode[]> = {
  'src/utils': [
    { path: 'src/utils/format.ts', name: 'format.ts', type: 'file', size: 50 },
    { path: 'src/utils/helpers.ts', name: 'helpers.ts', type: 'file', size: 70 },
  ],
}

/** 深拷贝节点（避免外部突变污染 fixture） */
function cloneNode(n: FileNode): FileNode {
  return { ...n, children: n.children?.map(cloneNode) }
}

export const file = {
  async tree(_sessionId: string): Promise<FileNode[]> {
    await sleep(TIMING.ack)
    const nodes = MOCK_TREE.map(cloneNode)
    // 始终追加 ignored 节点并标 ignored=true（与 real FileService 契约一致，灰斜体渲染 / 本地过滤）
    for (const ig of MOCK_IGNORED) {
      nodes.push({ ...ig, ignored: true })
    }
    return nodes
  },

  async expand(_sessionId: string, path: string): Promise<FileNode[]> {
    await sleep(TIMING.ack)
    return (MOCK_EXPAND[path] ?? []).map(cloneNode)
  },

  /**
   * 读文件内容（UC-6 前置）。
   * 有 sessionId → 文件树预览（cwd 内），按 path 返回模拟内容（含 <script> 用于 XSS 断言 T6.10）
   * 无 sessionId → BC-3 白名单（skill 预览）
   */
  async read(path: string, _sessionId?: string): Promise<{ content: string; truncated: boolean }> {
    await sleep(TIMING.ack)
    // E2E T6.10 XSS 断言：含 <script> 的内容应被转义不执行（DetailPane 禁 v-html）
    if (path.includes('xss') || path.includes('script')) {
      return { content: '<script>alert("xss")</script>\nconst x = 1', truncated: false }
    }
    // 按 path 返回差异化内容（E2E 可断言不同文件显示不同内容）
    const ext = path.split('.').pop() ?? ''
    if (ext === 'ts') return { content: `// ${path}\nexport function main(): void {\n  console.log('hello')\n}\n`, truncated: false }
    if (ext === 'json') return { content: `{\n  "name": "sample",\n  "version": "1.0.0"\n}\n`, truncated: false }
    if (ext === 'md') return { content: `# ${path}\n\nSample markdown content.\n`, truncated: false }
    return { content: `// mock content for ${path}`, truncated: false }
  },
}
