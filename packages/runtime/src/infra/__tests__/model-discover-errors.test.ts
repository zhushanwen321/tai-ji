/**
 * 模型发现错误分类测试（code-harden RT-7#9）。
 *
 * 覆盖：
 * - ModelService.discoverModelsFromApi：infra 错误 → 结构化 ModelDiscoveryError 的
 *   code/中文文案（超时 TIMEOUT / 429 RATE_LIMITED 单列，UNKNOWN 带中文前缀不裸传英文串）
 * - ModelApiDiscoverer：非 2xx 响应体回显截断 200 字（照 connection-tester 形态）
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/infra/__tests__/model-discover-errors.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ModelService, ModelDiscoveryError } from '../../services/model-service.js'
import type { IModelSource } from '../../services/ports/model.js'
import { ModelApiDiscoverer } from '../model-api-discoverer.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 抛指定错误的 modelSource 替身（discoverFromApi 契约：失败 throw 原始错误）。 */
function makeSourceThrow(err: unknown): IModelSource {
  return {
    async discoverFromApi() {
      throw err
    },
  }
}

async function classify(err: unknown): Promise<ModelDiscoveryError> {
  const svc = new ModelService(makeSourceThrow(err))
  try {
    await svc.discoverModelsFromApi('https://api.example.com')
    throw new Error('expected discoverModelsFromApi to throw')
  } catch (e) {
    if (e instanceof ModelDiscoveryError) return e
    throw e
  }
}

describe('RT-7#9：discover 错误分类（超时 / 429 单列 code）', () => {
  it('AbortSignal.timeout 的 TimeoutError → TIMEOUT + 中文文案（原落 UNKNOWN 英文直传）', async () => {
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const err = await classify(timeoutErr)
    expect(err.code).toBe('TIMEOUT')
    expect(err.message).toContain('请求超时')
  })

  it('message 带 aborted due to timeout 的普通 Error → TIMEOUT（message 锚兜底）', async () => {
    const err = await classify(new Error('This operation was aborted due to timeout'))
    expect(err.code).toBe('TIMEOUT')
  })

  it('429（discoverer message 前缀锚）→ RATE_LIMITED + 中文文案', async () => {
    const err = await classify(new Error('API 返回 429: Too Many Requests'))
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.message).toContain('429')
  })

  it('JSON 解析失败（SyntaxError）→ UNKNOWN 但带中文前缀（英文技术串不裸传 UI）', async () => {
    const err = await classify(new SyntaxError('Unexpected token < in JSON at position 0'))
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toContain('发现失败：')
    expect(err.message).toContain('Unexpected token')
  })

  it('既有分类保持：ByteString → INVALID_AUTH_CHARS；fetch failed → UNREACHABLE', async () => {
    expect((await classify(new Error("Failed to construct 'Request': ByteString"))).code).toBe('INVALID_AUTH_CHARS')
    expect((await classify(new TypeError('fetch failed'))).code).toBe('UNREACHABLE')
  })
})

describe('RT-7#9：discoverer 非 2xx 响应体截断', () => {
  it('429 长 body → 错误 message 中 body 截断 ≤ 200 字（单行压缩）', async () => {
    const longBody = '<html>' + 'x'.repeat(5000) + '</html>'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(longBody, { status: 429 })))

    const discoverer = new ModelApiDiscoverer()
    const err: unknown = await discoverer.discoverFromApi('https://api.example.com').then(
      () => new Error('expected throw'),
      (e: unknown) => e,
    )
    const message = err instanceof Error ? err.message : String(err)
    expect(message).toMatch(/^API 返回 429: <html>x+$/)
    // 前缀「API 返回 429: 」+ 截断 200 字 → 总长 ≤ ~215；5000 字原文必然被截
    expect(message.length).toBeLessThanOrEqual(215)
    expect(message).not.toContain('</html>')
  })

  it('错误 body 为空 → 回退 statusText（既有行为保持）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500, statusText: 'Internal Server Error' })))
    const discoverer = new ModelApiDiscoverer()
    await expect(discoverer.discoverFromApi('https://api.example.com')).rejects.toThrowError(
      'API 返回 500: Internal Server Error',
    )
  })
})
