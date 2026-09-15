/**
 * 文件哈希工具（无网络依赖的纯函数模块）。
 *
 * 从 download-asset.ts 抽出 hashFileSha256，使纯逻辑层（preloaded-update）
 * 不必反向依赖「带网络 + undici ProxyAgent 副作用」的下载模块（download-asset），
 * 收敛「文件完整性校验」与「下载执行」的职责边界（见 review S#13）。
 *
 * 本模块只依赖 node:crypto + node:fs，无任何网络/代理代码。
 *
 * 依赖方向：hash → node:crypto/fs（无项目内依赖，叶子模块）
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * 计算文件 sha256 hex（流式读取，避免大文件一次性进内存）。
 *
 * @param filePath 待校验文件的绝对路径
 * @returns sha256 hex 字符串（小写）
 */
export async function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}
