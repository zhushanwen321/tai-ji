/**
 * PKCE 工具（OAuth 路径 B 自实现）。
 *
 * 参考 pi-ai dist/auth/oauth/pkce.js，但用 node:crypto 而非 Web Crypto：
 * runtime 是 Node 24，createHash 同步、无 globalThis.crypto 环境依赖，
 * 也不需要 async subtle 边界。
 */
import { createHash, randomBytes } from 'node:crypto'

/**
 * 生成 PKCE code_verifier：32 字节随机数 base64url 无 padding。
 * RFC 7636 §4.1 要求 verifier 43~128 字符，32 字节 → 43 字符恰在下界。
 */
export function generateVerifier(): string {
  // eslint-disable-next-line no-magic-numbers -- RFC 7636 §4.1：32 字节随机数 → 43 字符 verifier，恰在 43~128 下界
  return randomBytes(32).toString('base64url')
}

/**
 * 计算 PKCE code_challenge：base64url(SHA-256(verifier))，无 padding。
 * S256 方法是 OAuth 2.1 推荐默认，RFC 7636 §4.2。
 */
export async function generateChallenge(verifier: string): Promise<string> {
  return createHash('sha256').update(verifier).digest('base64url')
}
