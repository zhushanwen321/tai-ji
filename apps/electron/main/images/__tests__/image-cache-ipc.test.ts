/**
 * image-cache-ipc 单测（D6-⑨ / u7-memory-governance，IPC 两侧职责）。
 *
 * 形态对齐同族先例 logs/__tests__/renderer-log-handler.test.ts：electron mock 捕获
 * ipcMain.handle 的 handler，构造 invoke payload 直接调用断言。
 *
 * 覆盖：
 * - 正常写入路径：handler 委托 image-cache 服务落盘（真实 IO）并按序回传结果（written /
 *   cached 状态映射 + path/bytes 字段）
 * - sessionId 路径穿越载荷（../../etc / 绝对路径）：getImageCacheDir throw → 整批降级
 *   invalid 零抛错，盘上无越界写入
 * - 畸形 payload（null / 缺字段 / 空数组 / 类型错位）：isValidPayload 拒绝，返回空结果
 *   零抛错，且不触碰落盘服务
 * - quotaFull 形态映射：服务返回的 quota-full 批量结果原样透传（真实触发需 64MB 数据，
 *   此处替换服务实现注入结果形态——透传本身即 handler 的映射契约）
 * - 服务 throw（非穿越的 fs 异常）：整批降级 invalid（数量 = payload.images 数量）零抛错
 * - 传参契约：payload.images 逐图 toImage 宽校验映射（畸形元素归零值，不整批拒）后按序透传
 *
 * 运行池：guarded（vitest.config projects——真实文件 IO，挂全套 fs-guard；夹具
 * mkdtempSync(tmpdir) 自建自删，TAIJI_AGENT_DATA_DIR 指向用例级 tmp）。
 * 运行：cd apps/electron/main && npx vitest run images/__tests__/image-cache-ipc.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IMAGE_CACHE_WRITE } from '@taiji/shared'
import { getImageCacheRoot } from '@taiji/shared/paths'
import type { ImageCacheWriteResult } from '@taiji/shared'

// writeRef.current 非空时替换 writeImagesNewestFirst（quotaFull 形态注入 / throw 模拟 /
// 传参捕获），为空时透传真实实现（正常写入 / 路径穿越走真实 IO 链路）。
// vi.hoisted：mock 工厂惰性执行早于测试文件体，容器须与 vi.mock 同批提升。
const writeRef = vi.hoisted(() => ({
  current: undefined as ((...args: unknown[]) => unknown) | undefined,
}))

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

vi.mock('../image-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image-cache.js')>()
  return {
    ...actual,
    writeImagesNewestFirst: (...args: Parameters<typeof actual.writeImagesNewestFirst>) => {
      if (writeRef.current) return writeRef.current(...args)
      return actual.writeImagesNewestFirst(...args)
    },
  }
})

import { registerImageCacheHandlers } from '../image-cache-ipc.js'

/** 合法 payload 工厂（可覆写字段；images 元素可混入任意 raw 形态供宽校验用例使用）。 */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-ipc',
    images: [{ data: PNG_BASE64, mimeType: 'image/png' }],
    ...overrides,
  }
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const PNG_BASE64 = PNG_BYTES.toString('base64')

/** invoke event 桩（handler 不读 event，最小形态即可）。 */
function makeEvent() {
  return { sender: { id: 1 } }
}

describe('image-cache-ipc', () => {
  let tmpDir: string
  let savedDataDir: string | undefined

  beforeEach(() => {
    handlers.clear()
    writeRef.current = undefined
    tmpDir = mkdtempSync(join(tmpdir(), 'image-cache-ipc-test-'))
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 注册并取回 IMAGE_CACHE_WRITE 通道的已注册 handler。 */
  function registeredHandler(): (...args: unknown[]) => unknown {
    registerImageCacheHandlers()
    const fn = handlers.get(IMAGE_CACHE_WRITE)
    expect(fn, 'handler should be registered on the IMAGE_CACHE_WRITE channel').toBeTypeOf('function')
    return fn!
  }

  it('正常写入路径：委托 image-cache 服务真实落盘，按序回传 written/cached 结果', () => {
    const handler = registeredHandler()
    const first = handler(makeEvent(), makePayload()) as ImageCacheWriteResult
    expect(first.quotaFull).toBe(false)
    expect(first.results).toHaveLength(1)
    expect(first.results[0]!.status).toBe('written')
    expect(first.results[0]!.path!.startsWith(getImageCacheRoot(tmpDir))).toBe(true)
    expect(existsSync(first.results[0]!.path!)).toBe(true)
    // 落盘内容 = base64 解码原值（main 是落盘执行方，解码正确性由 handler 链路端到端保证）
    expect(readFileSync(first.results[0]!.path!)).toEqual(PNG_BYTES)
    expect(first.results[0]!.bytes).toBe(PNG_BYTES.length)

    // 同内容二次写入：hash 命中 → cached 透传（幂等语义经 IPC 面原样可见）
    const second = handler(makeEvent(), makePayload()) as ImageCacheWriteResult
    expect(second.results[0]!.status).toBe('cached')
    expect(second.results[0]!.path).toBe(first.results[0]!.path)
    expect(second.results[0]!.bytes).toBe(PNG_BYTES.length)
  })

  it('sessionId 路径穿越载荷（../../etc / 绝对路径）：整批降级 invalid 零抛错，盘上无越界写入', () => {
    const handler = registeredHandler()
    const twoImages = [PNG_BASE64, PNG_BASE64].map((data) => ({ data, mimeType: 'image/png' }))
    for (const evil of ['../../etc', '/etc/passwd']) {
      let result: unknown
      expect(
        () => {
          result = handler(makeEvent(), { sessionId: evil, images: twoImages })
        },
        `traversal sessionId "${evil}" must not throw out of the handler`,
      ).not.toThrow()
      // 整批降级：每图一个 invalid，不阻断消息流
      expect(result).toEqual({
        results: [
          { status: 'invalid' },
          { status: 'invalid' },
        ],
        quotaFull: false,
      })
    }
    // 无越界写入：payload 里的 ../etc 与 /etc 目标在数据目录内外均不存在
    expect(existsSync(join(tmpDir, 'etc'))).toBe(false)
    expect(existsSync(getImageCacheRoot(tmpDir))).toBe(false)
  })

  it('畸形 payload 零抛错：非对象 / 缺字段 / 空数组 / 类型错位一律拒绝且不触碰落盘服务', () => {
    const handler = registeredHandler()
    writeRef.current = vi.fn()
    const malformed: unknown[] = [
      null,
      undefined,
      'not-an-object',
      123,
      {},
      { sessionId: '' },
      { sessionId: 123, images: [{ data: 'x', mimeType: 'image/png' }] },
      { sessionId: 'sess-ok', images: [] },
      { sessionId: 'sess-ok' },
      { sessionId: 'sess-ok', images: 'not-an-array' },
    ]
    for (const payload of malformed) {
      let result: unknown
      expect(() => {
        result = handler(makeEvent(), payload)
      }).not.toThrow()
      expect(result, `payload ${JSON.stringify(payload)} should be rejected with empty result`).toEqual({
        results: [],
        quotaFull: false,
      })
    }
    expect(writeRef.current).not.toHaveBeenCalled()
  })

  it('quotaFull 形态映射：服务返回的 quota-full 批量结果原样透传给 renderer', () => {
    const handler = registeredHandler()
    const quotaResult: ImageCacheWriteResult = {
      results: [{ status: 'quota-full' }, { status: 'quota-full' }],
      quotaFull: true,
    }
    writeRef.current = vi.fn(() => quotaResult)
    const result = handler(makeEvent(), makePayload({ images: [PNG_BASE64, PNG_BASE64].map((data) => ({ data, mimeType: 'image/png' })) }))
    // 透传 = 映射契约：status 数组与 quotaFull 标志逐字段一致（超帽即停语义对 IPC 面可见）
    expect(result).toEqual(quotaResult)
    expect(writeRef.current).toHaveBeenCalledTimes(1)
  })

  it('服务 throw（非穿越 fs 异常）：整批降级 invalid（数量 = payload.images 数量）零抛错', () => {
    const handler = registeredHandler()
    writeRef.current = () => {
      throw new Error('EACCES: simulated fs failure')
    }
    const threeImages = [PNG_BASE64, PNG_BASE64, PNG_BASE64].map((data) => ({ data, mimeType: 'image/png' }))
    let result: unknown
    expect(() => {
      result = handler(makeEvent(), { sessionId: 'sess-ipc', images: threeImages })
    }).not.toThrow()
    expect(result).toEqual({
      results: [{ status: 'invalid' }, { status: 'invalid' }, { status: 'invalid' }],
      quotaFull: false,
    })
  })

  it('传参契约：payload.images 逐图 toImage 宽校验映射（畸形元素归零值不整批拒）后按序透传', () => {
    const handler = registeredHandler()
    writeRef.current = vi.fn(() => ({ results: [], quotaFull: false }))
    handler(makeEvent(), {
      sessionId: 'sess-args',
      images: [
        { data: PNG_BASE64, mimeType: 'image/png' },
        'not-an-object',
        { data: 123, mimeType: 'image/png' },
        { data: 'ok' },
      ],
    })
    // data/mimeType 各自独立判型：data 非字符串归空串，mimeType 字符串原样保留
    //（下游 locateImageCacheTarget 对零值元素判 invalid，宽校验不在此整批拒）
    expect(writeRef.current).toHaveBeenCalledWith('sess-args', [
      { data: PNG_BASE64, mimeType: 'image/png' },
      { data: '', mimeType: '' },
      { data: '', mimeType: 'image/png' },
      { data: 'ok', mimeType: '' },
    ])
  })
})
