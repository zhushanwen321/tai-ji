import { writeFileSync, renameSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'

/**
 * Atomic file write (sync): write to a temp file first, then rename.
 * Prevents corrupt data if the process crashes mid-write.
 *
 * 归属：跨层共享叶子层 utils/（ADR 0004）。renameSync 在 POSIX/NTFS 上都是原子操作，
 * 被 infra（pi-provider-store/agent-crud/session-file-utils）和 services（config-service）共用，
 * 无业务语义，故放在所有业务层之下的 utils 而非任一业务层。
 */
export function atomicWrite(filePath: string, data: string, uniqueSuffix?: string): void {
  const tmpPath = uniqueSuffix ? `${filePath}.tmp_${uniqueSuffix}` : `${filePath}.tmp`
  writeFileSync(tmpPath, data, 'utf-8')
  renameSync(tmpPath, filePath)
}

/**
 * Atomic file write (async): 非阻塞版 `atomicWrite`，供 async 上下文使用（D2）。
 *
 * plugin-storage / plugin-permission-storage 的写入在 async 函数内，用同步 `writeFileSync`
 * 会阻塞 event loop。本函数用 fs/promises 的 writeFile + rename 保持非阻塞，
 * 同时保留「先写 tmp 再 rename」的原子语义。
 *
 * @param uniqueSuffix 可选的 tmp 文件后缀区分符。当同一 filePath 可能被并发写入时，
 *   各写入用不同 tmp 名（如 `Date.now()_random`）避免互相覆盖 tmp；留空则用固定 `.tmp`。
 */
export async function atomicWriteAsync(filePath: string, data: string, uniqueSuffix?: string): Promise<void> {
  const tmpPath = uniqueSuffix ? `${filePath}.tmp_${uniqueSuffix}` : `${filePath}.tmp`
  await writeFile(tmpPath, data, 'utf-8')
  await rename(tmpPath, filePath)
}
