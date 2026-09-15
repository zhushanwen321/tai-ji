/**
 * FsExecutor —— IFileExecutor port 的 infra 适配器（code-architecture §3，#2）。
 *
 * 🔒 三层架构：infra 层实现 services/ports/file-executor.ts 的 IFileExecutor port。
 * 真引 node:fs/promises（Tier 2 证伪：编译器对依赖声明验签，SDK 没装/没方法/签名变 → tsc 报错）。
 *
 * 实现要点（④NFR K-2/K-3）：
 * - 超时（K-2）：每个操作用 Promise.race 包装，超时 reject `new Error('timeout')`。
 *   node:fs/promises 无内建超时（不可复用 git-executor 的 execFileSync timeout）。
 * - symlink 目录（K-3）：listDir 用 readdir({ withFileTypes:true }) 拿 Dirent，
 *   对 isSymbolicLink() 的 entry 单独 stat 判定；遇 ELOOP（符号链接成环 a→b→a）/EACCES
 *   catch 后跳过该 entry（不 follow 成环）。
 * - EACCES：readdir/stat/readFile 的权限错误以 Error(code='EACCES') reject，
 *   FileService catch 后转 FileError('permission_denied')。
 * - 性能：dir entry 不取 size（undefined），file entry 取 size（listDir 内批量 readdir 后逐个 stat）；
 *   withSize=false 时非 symlink 的 file entry 免 stat（D7-3，searchFiles 快路径）。
 */
import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IFileExecutor, FsEntry, ListDirOptions } from '../services/ports/file-executor.js'

/** 单次 fs 操作超时（ms），NFR ④K-2。listDir/stat/readFile 共用。 */
const FS_TIMEOUT_MS = 10_000

export class FsExecutor implements IFileExecutor {
  constructor() {}

  /**
   * 单层 readdir（不递归）。用 withFileTypes 拿 Dirent，避免 N+1 lstat。
   * file entry 补 size（stat），dir entry 不取 size（undefined，性能优化）。
   * symlink 目录（K-3）：单独 stat 判定，ELOOP/EACCES catch 后跳过。
   * withSize=false（D7-3）：非 symlink 的 file entry 免 per-file stat 直接收录（size 缺省）；
   * symlink 例外仍走 stat——坏 symlink（ELOOP/ENOENT）跳过的现状语义保持。
   * 成员一致性口径（审查修正）：常规情形成员一致；stat 失败竞态（readdir 与 stat 间隙
   * 文件被删）下 withSize=false 更宽容——收录 readdir 时刻存在的文件，withSize=true 会因
   * stat ENOENT 跳过该 entry。唯一稳定差异是 file entry 缺 size 字段。
   */
  async listDir(path: string, opts?: ListDirOptions): Promise<FsEntry[]> {
    const withSize = opts?.withSize ?? true
    const dirents = await this.withTimeout(() => readdir(path, { withFileTypes: true }), 'listDir')
    const entries: FsEntry[] = []
    for (const d of dirents) {
      const type = d.isDirectory() ? 'dir' : 'file'
      if (type === 'dir') {
        // dir entry：不取 size（性能优化）；symlink 指向目录的 Dirent.isDirectory() 为 false
        // （不 follow），故不会成环——此处对真目录直接收录。
        entries.push({ name: d.name, type: 'dir' })
      } else if (!withSize && !d.isSymbolicLink()) {
        // 免 stat 收录（D7-3）：readdir 时刻存在的文件直接进结果——stat 失败竞态
        //（readdir 与 stat 间隙被删）下比 withSize=true 更宽容（后者 stat ENOENT 跳过）
        entries.push({ name: d.name, type: 'file' })
      } else {
        // file entry：取 size。对符号链接文件，stat（默认 follow）遇 ELOOP/EACCES → 跳过（K-3）。
        try {
          const s = await this.withTimeout(() => stat(join(path, d.name)), 'listDir.stat')
          entries.push({ name: d.name, type: 'file', size: s.size })
        } catch (e: unknown) {
          // 隔离单条 entry 的失败（符号链接成环 ELOOP / 无权限 EACCES / 文件刚被删 ENOENT），
          // 不阻断整次 listDir——其余 entry 仍要返回。记日志便于诊断为何某文件「消失」。
          console.warn(`[fs-executor] listDir.stat skipped entry "${d.name}":`, e)
          continue
        }
      }
    }
    return entries
  }

  /** stat 单个路径（默认 follow symlink）。type 取 isDirectory() 判定 dir/file；mtimeMs 供 D7-1 matcher 缓存键。 */
  async stat(path: string): Promise<{ type: 'dir' | 'file'; size: number; mtimeMs: number }> {
    const s = await this.withTimeout(() => stat(path), 'stat')
    return { type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtimeMs: s.mtimeMs }
  }

  /** 读文件内容（utf-8）。ENOENT → reject（FileService 转 not_found）；EACCES → reject。 */
  async readFile(path: string): Promise<string> {
    return this.withTimeout(() => readFile(path, 'utf8'), 'readFile')
  }

  /**
   * 超时包装（NFR ④K-2）：Promise.race(op vs 定时器)。
   * 超时 reject `new Error('timeout')`，FileService catch 后（按 instanceof / message）转 FileError('timeout')。
   * op 内的 EACCES/ENOENT 等原生错误透传（保留 Error.code），由 FileService 按需分类。
   */
  private withTimeout<T>(op: () => Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), FS_TIMEOUT_MS)
    })
    return Promise.race([op(), timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
}
