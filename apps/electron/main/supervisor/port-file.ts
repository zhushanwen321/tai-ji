/**
 * 端口文件持久化（多实例/dev 偏移用）。
 *
 * 职责单一：把 runtime 监听的端口写入 $TAIJI_AGENT_DATA_DIR/runtime.port。
 *
 * 这是 thin shell 文件——签名即设计，不深化骨架（methodology §1）。
 *
 * [HISTORICAL] 不变量：
 * - 路径动态推导：$TAIJI_AGENT_DATA_DIR ?? ~/.taiji（AGENTS.md 关键规则 #15：禁止写死绝对路径）
 * - 写失败不阻塞主流程（端口文件非关键，console.error 后继续）
 *
 * 依赖方向：port-file → node:fs + node:path + node:os
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDataDir } from '@taiji/shared/paths'

/**
 * 将端口写入 $TAIJI_AGENT_DATA_DIR/runtime.port。
 * 写失败仅记录错误，不抛出（端口文件非关键路径）。
 *
 * @param port runtime 监听端口
 */
export function writePortFile(port: number): void {
  try {
    const dataDir = getDataDir()
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, 'runtime.port'), String(port))
  // eslint-disable-next-line taste/no-silent-catch -- 端口文件非关键路径，写失败仅记录不阻塞
  } catch (err) {
    console.error('[runtime] Failed to write port file:', err)
  }
}
