/**
 * Mock git domain —— 与 @/api/domains/git 同接口签名（Wave 1a 创建 real 侧后由 api/index 接线）。
 *
 * 返回固定 GitStatusResult fixture（覆盖 GitZone 四态：clean/staged/dirty/conflict 的数据源），
 * 让 GitZone 在 mock 模式下可验证渲染，无需真实 git 仓库。
 *
 * 依赖方向：仅依赖 shared 类型 + mock TIMING/sleep（与 mock/index.ts 同构）。不 import transport。
 */
import type { GitStatusResult } from '@taiji/shared'

/** 流式时序（ms）—— 与 mock/index.ts TIMING 对齐，保持 mock 节奏一致；
 *  setMockTiming 单入口同步注入（ack 同族），默认值不变 */
const TIMING = {
  ack: 40,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 测试钩子通道（double-underscore 对齐 mock/index __clearTimers 约定）：
 * 由 index.ts 的 setMockTiming/resetMockTiming 编排调用，测试不直接调（单入口）。
 */
export function __setMockGitAck(ms: number): void {
  TIMING.ack = ms
}

/**
 * 固定 GitStatusResult fixture（覆盖 GitFileStatus 全部 status 枚举 + GitZone 四态）。
 *
 * files 设计（xyCode 双列：X=staged，Y=unstaged）：
 * - 'A '  staged add        → 计入 stagedCount
 * - 'M '  staged modified   → 计入 stagedCount
 * - ' M'  unstaged modified → 计入 unstagedCount
 * - ' D'  unstaged delete   → 计入 unstagedCount
 * - 'UU'  both modified     → unmerged（冲突，hasConflict=true）
 * - 'R '  staged rename     → 计入 stagedCount
 * - '??'  untracked         → 计入 unstagedCount
 *
 * 派生：stagedCount=3（A /M /R ），unstagedCount=3（ M/ D/??），hasConflict=true（UU）。
 * stats 为 git diff --numstat 聚合（+42/-7）。
 *
 * [W2] files[].additions/deletions 对齐 GitFileStatus 新契约（git diff --numstat HEAD per-file）：
 * - added/modified/renamed/deleted（tracked 改动）有 numstat
 * - untracked（??）无 numstat → undefined，前端降级显文件大小（FileNode.size）
 * - unmerged（UU）无 numstat → undefined，前端不显行数
 */
export const fixtureGitStatus: GitStatusResult = {
  sessionId: '',
  isRepo: true,
  branch: 'main',
  stagedCount: 3,
  unstagedCount: 3,
  stats: { add: 42, del: 7 },
  hasConflict: true,
  files: [
    { path: 'src/new-feature.ts', xyCode: 'A ', status: 'added', additions: 30 },
    { path: 'src/existing.ts', xyCode: 'M ', status: 'modified', additions: 12, deletions: 3 },
    { path: 'src/dirty.ts', xyCode: ' M', status: 'modified', additions: 8, deletions: 5 },
    { path: 'src/old-file.ts', xyCode: ' D', status: 'deleted', deletions: 40 },
    { path: 'src/conflict.ts', xyCode: 'UU', status: 'unmerged' },
    { path: 'README.md', xyCode: 'R ', status: 'renamed', additions: 5, deletions: 2 },
    // untracked 无 numstat → undefined，前端降级显 ~size（FileNode.size）
    { path: 'untracked.log', xyCode: '??', status: 'untracked' },
  ],
}

/**
 * Mock git domain。status 返回 fixture 深拷贝（注入 sessionId）；
 * stage/unstage/commit 仅 ack（mock 不模拟真实 git 写操作，D7 不模拟失败）。
 *
 * Wave 1a 创建 api/domains/git.ts（real）后，api/index.ts 加：
 *   export const git = isMock ? mockApi.git : realGit
 */
export const git = {
  async status(sessionId: string): Promise<GitStatusResult> {
    await sleep(TIMING.ack)
    return { ...fixtureGitStatus, sessionId, files: fixtureGitStatus.files.map((f) => ({ ...f })) }
  },
  /**
   * 单文件 diff patch（#5，UC-6 点文件预览）。与 real api/domains/git.getDiff 同接口。
   * mock：按 path 返回固定 patch（fixtureGitStatus 中标 modified/added/deleted 的文件），
   * 含 <script> 的 path 用于 T6.10 XSS 断言。非改动文件 / untracked → 空 patch。
   *
   * 注意 untracked 必须返回空 patch——与真实 runtime 行为一致（`git diff -- <untracked>`
   * 无输出）。否则会掩盖 useDetailPane 的「diff 空 → 降级 preview」逻辑。
   */
  async getDiff(_sessionId: string, path: string): Promise<{ patch: string; binary: boolean }> {
    await sleep(TIMING.ack)
    // T6.10 XSS：含 script 的 diff 内容应被转义（DetailPane 禁 v-html）
    if (path.includes('xss') || path.includes('script')) {
      return { patch: `diff --git a/${path} b/${path}\n+<script>alert(1)</script>`, binary: false }
    }
    // fixtureGitStatus 中的改动文件 → 返回模拟 patch（untracked 除外：git diff 对 untracked 无输出）
    const changed = fixtureGitStatus.files.find((f) => f.path === path)
    if (changed && changed.status !== 'untracked') {
      return {
        patch: `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,5 @@\n line1\n+new line\n line2\n+added line`,
        binary: false,
      }
    }
    // 非改动文件 / untracked / binary 模拟
    if (path.endsWith('.png') || path.endsWith('.jpg')) {
      return { patch: '', binary: true }
    }
    return { patch: '', binary: false }
  },
  async stage(_sessionId: string, _filePaths?: string[]): Promise<void> {
    await sleep(TIMING.ack)
  },
  async unstage(_sessionId: string, _filePaths?: string[]): Promise<void> {
    await sleep(TIMING.ack)
  },
  async commit(_sessionId: string, _message?: string): Promise<void> {
    await sleep(TIMING.ack)
  },
  // 与 real api/domains/git.ts 同构：切换分支（#6）。mock 仅 ack，不模拟真实 checkout/dirty 冲突
  async checkout(_sessionId: string, _name: string): Promise<void> {
    await sleep(TIMING.ack)
  },
  // 与 real api/domains/git.ts 同构：cwd-based checkout（landing 态无 session，plain-repo 切分支）
  async checkoutByCwd(_cwd: string, _name: string): Promise<void> {
    await sleep(TIMING.ack)
  },
  // 与 real api/domains/git.ts 同构：创建并检出分支（#7）。mock 仅 ack，不模拟分支名/已存在失败
  async createBranch(_sessionId: string, _name: string): Promise<void> {
    await sleep(TIMING.ack)
  },
}
