import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUuid } from '../random-uuid'

// RFC 4122 v4：版本位（第三组首字符 = 4）、变体位（第四组首字符 = 8/9/a/b）
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('randomUuid', () => {
  it('原生 randomUUID 存在时走原生路径（不触发 fallback）', () => {
    const sentinel = 'native-uuid-sentinel'
    const getRandomValues = vi.fn()
    vi.stubGlobal('crypto', {
      randomUUID: () => sentinel,
      getRandomValues,
    })
    expect(randomUuid()).toBe(sentinel)
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  it('非 secure context 模拟（randomUUID undefined）：fallback 产出合法 uuid v4', () => {
    // LAN http 下 isSecureContext=false → crypto.randomUUID 为 undefined（Web API 仅
    // secure context 暴露），getRandomValues 无此限制——模拟形态 = 只保留 getRandomValues
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })
    expect(randomUuid()).toMatch(UUID_V4_RE)
  })

  it('fallback 版本位/变体位按 RFC 4122 置位（确定性字节探针：全 0 输入 → 00000000-0000-4000-8000-000000000000）', () => {
    // stub 不写入任何随机字节：new Uint8Array(16) 恒全 0，版本字节 0x00 → (0x00&0x0f)|0x40 = 0x40
    // （第三组 '4000'），变体字节 0x00 → (0x00&0x3f)|0x80 = 0x80（第四组 '8000'）
    vi.stubGlobal('crypto', {
      getRandomValues: (buf: Uint8Array) => buf,
    })
    expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('fallback 连续调用不重复', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })
    const a = randomUuid()
    const b = randomUuid()
    expect(a).not.toBe(b)
  })
})
