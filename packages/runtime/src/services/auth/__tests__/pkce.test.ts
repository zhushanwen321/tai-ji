/**
 * PKCE 工具单测（OAuth 路径 B 自实现）。
 *
 * 覆盖：verifier 为 32 字节 base64url 无 padding（RFC 7636 §4.1 要求 43~128 字符）、
 * challenge 与手工 SHA-256 计算一致、两次生成随机不同。
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { generateVerifier, generateChallenge } from '../pkce.js'

describe('pkce', () => {
  it('verifier 是 32 字节 base64url 无 padding（43 字符，字符集受限）', () => {
    const verifier = generateVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('challenge 与手工 SHA-256 base64url 一致', async () => {
    const verifier = 'test-verifier-0123456789abcdefghijklmnopqrstuvw'
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(await generateChallenge(verifier)).toBe(expected)
  })

  it('两次生成的 verifier 随机不同', () => {
    expect(generateVerifier()).not.toBe(generateVerifier())
  })

  it('challenge 无 padding（不以 = 结尾）', async () => {
    const challenge = await generateChallenge(generateVerifier())
    expect(challenge.endsWith('=')).toBe(false)
  })
})
