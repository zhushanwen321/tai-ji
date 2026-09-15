/**
 * IFileExecutor port（code-architecture §3，#2 D-008）。
 *
 * 🔒 三层架构：services 定义 port，infra/fs-executor.ts 实现（node:fs/promises）。
 * FileService 经此 port 访问 fs，不直接 import node:fs（AC-2 grep 验证：services 层无 node:fs 引用）。
 *
 * Port 决策（D-008，Local-substitutable）：fs 有内存替身（测试 mock）→ port
 * （2 adapter：FsExecutor 生产 + in-memory 测试 = 真 seam）。
 * 范式与 IGitExecutor（services/ports/git-executor.ts）对称。
 */
/**
 * infra readdir 返回的薄结构，FileService 编排时映射成 FileNode（@taiji/shared）。
 * type 限定 'dir' | 'file'（与 FileNodeType 对齐，此处独立声明避免 port 依赖 shared 类型）。
 */
export interface FsEntry {
  name: string
  type: 'dir' | 'file'
  /** 文件大小（字节，仅 file 有意义；dir entry 可省略，由 FileService 按需取） */
  size?: number
}

/**
 * listDir 选项（D7-3，05-scan-caching §3.3）。
 * withSize 默认 true（文件树路径保持 size——FileTreeRow untracked `~size` 降级显示依赖）；
 * searchFiles 传 false：非 symlink 的 file entry 免 per-file stat（size 缺省 undefined，
 * searchFiles 结果无 size 消费方，语义无损）。
 */
export interface ListDirOptions {
  withSize?: boolean
}

/**
 * fs 访问 port。
 *
 * 实现约束（infra/fs-executor.ts）：
 * - listDir **单层 readdir**（不递归，depth=1 编排在 FileService）。
 *   dir entry 不取 size（undefined），file entry 取 size（性能优化，NFR）。
 * - 超时机制（Promise.race，④NFR K-2：node:fs/promises 无内建超时）：超时 reject Error，
 *   FileService catch 后转 FileError('timeout')。
 * - symlink 目录（④NFR K-3）：readdir 对符号链接判 isSymbolicLink()，
 *   遇 ELOOP/EACCES catch 后跳过该 entry（不 follow 成环）。
 * - EACCES → reject Error(code='EACCES')，FileService 转 FileError('permission_denied')。
 */
export interface IFileExecutor {
  /**
   * 列目录单层子（不递归）。超时/EACCES → reject Error。
   * opts.withSize=false（D7-3）：非 symlink 的 file entry 免 per-file stat，size 缺省；
   * symlink entry 仍 stat（坏 symlink ELOOP/ENOENT 跳过的语义与 withSize=true 一致）。
   * 成员一致性口径（审查修正）：常规情形成员一致；stat 失败竞态（readdir 与 stat 间隙
   * 文件被删）下 withSize=false 更宽容——收录 readdir 时刻存在的文件，withSize=true
   * 会因 stat ENOENT 跳过。searchFiles 结果集成员仅在此竞态窗口可能不同。
   */
  listDir(path: string, opts?: ListDirOptions): Promise<FsEntry[]>
  /**
   * 取文件/目录 stat。
   * mtimeMs（D7-1 matcher 缓存键成分）：node:fs Stats.mtimeMs 透传，FileService 用作
   * .gitignore 编译结果的文件身份戳（mtime/size 变化 → 缓存 miss 重读重编译）。
   */
  stat(path: string): Promise<{ type: 'dir' | 'file'; size: number; mtimeMs: number }>
  /** 读文件内容（utf-8）。 */
  readFile(path: string): Promise<string>
}
