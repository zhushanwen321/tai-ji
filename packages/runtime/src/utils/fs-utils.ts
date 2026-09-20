import { writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'

/**
 * Atomic file write (sync): write to a temp file first, then rename.
 * Prevents corrupt data if the process crashes mid-write.
 *
 * 归属：跨层共享叶子层 utils/（ADR 0004）。renameSync 在 POSIX/NTFS 上都是原子操作，
 * 被 infra（pi-provider-store/agent-crud/session-file-utils）和 services（config-service）共用，
 * 无业务语义，故放在所有业务层之下的 utils 而非任一业务层。
 *
 * tmp 失败清理（RT-3#9）：写/改名为目标路径失败时删除刚建的 tmp 再原样上抛——
 * rename 失败留 tmp 是永久垃圾（`.tmp_*` 不在任何回收家族内），且重试调用方拿到的
 * 错误语义不变。清理自身失败（极端：目录权限突变）只残留一个 tmp，吞掉不掩盖原错误。
 *
 * 默认 tmp 名含 pid+进程内序号（RT-3#9）：无 uniqueSuffix 时不再用固定 `.tmp`——
 * 多进程对同一 filePath 并发写时固定名互相踩踏（A 的 rename 携带 B 的半截内容）。
 * `.jsonl.tmp_<pid>_<seq>` 不以 `.jsonl` 结尾，session scanner 的后缀过滤天然排除。
 */

/** 进程内 tmp 序号：与 pid 组合保证同进程多次写、跨进程并发写的 tmp 名互不碰撞。 */
let tmpSeq = 0
function nextTmpSuffix(): string {
  tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER
  return `${process.pid}-${tmpSeq}`
}

function tmpPathOf(filePath: string, uniqueSuffix?: string): string {
  return `${filePath}.tmp_${uniqueSuffix ?? nextTmpSuffix()}`
}

export function atomicWrite(filePath: string, data: string, uniqueSuffix?: string): void {
  const tmpPath = tmpPathOf(filePath, uniqueSuffix)
  try {
    writeFileSync(tmpPath, data, 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (e) {
    try { unlinkSync(tmpPath) } catch { void 0 /* 清理失败不掩盖原错误 */ }
    throw e
  }
}

/**
 * Atomic file write (async): 非阻塞版 `atomicWrite`，供 async 上下文使用（D2）。
 *
 * plugin-storage / plugin-permission-storage 的写入在 async 函数内，用同步 `writeFileSync`
 * 会阻塞 event loop。本函数用 fs/promises 的 writeFile + rename 保持非阻塞，
 * 同时保留「先写 tmp 再 rename」的原子语义。
 *
 * tmp 失败清理与默认 pid+序号后缀语义与同步版一致（RT-3#9）。
 *
 * @param uniqueSuffix 可选的 tmp 文件后缀区分符。当同一 filePath 可能被并发写入时，
 *   各写入用不同 tmp 名（如 `Date.now()_random`）避免互相覆盖 tmp；留空则用 pid+序号。
 */
export async function atomicWriteAsync(filePath: string, data: string, uniqueSuffix?: string): Promise<void> {
  const tmpPath = tmpPathOf(filePath, uniqueSuffix)
  try {
    await writeFile(tmpPath, data, 'utf-8')
    await rename(tmpPath, filePath)
  } catch (e) {
    try { await unlink(tmpPath) } catch { void 0 /* 清理失败不掩盖原错误 */ }
    throw e
  }
}
