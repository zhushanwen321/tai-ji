/**
 * useImageAttachment 单测 —— Cmd/Ctrl+V 图片粘贴的降级矩阵（W3：sessionId 透传）。
 *
 * 覆盖：
 * - TC1: 成功 → {kind:'badge', path, fileName, displayName}（mock writeSessionImage resolve）
 * - W3TC9: sessionId 透传到 writeSessionImage payload
 * - TC4: writeSessionImage reject → {kind:'text', text:'[图片粘贴失败]'} 降级
 * - TC5: writeSessionImage resolve(undefined)（非 electron）→ {kind:'text', text:'[图片粘贴：需桌面环境]'}
 * - 读 blob 失败 → {kind:'text', text:'[图片读取失败]'}
 *
 * [HISTORICAL] 曾有 metaKey=false → noop 分支（Ctrl+V 路径文本通路），onPaste 统一通路后移除。
 * [W3] writeTmpImage → writeSessionImage，handleImagePaste 加 sessionId 参数（landing 态 null）。
 *
 * mock 策略：vi.mock('@/lib/ipc') 替换 writeSessionImage 三态；FileReader 用 jsdom 原生实现。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useImageAttachment.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleImagePaste } from '@/composables/panel/useImageAttachment'

// writeImage 可被每个测试替换三态：resolve({path,name,id}) / resolve(undefined) / reject
const writeImageMock = vi.hoisted(() => vi.fn())
vi.mock('@/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/api')>()
  return { ...orig, session: { ...orig.session, writeImage: writeImageMock } }
})

/** 构造最小 PNG（8 字节签名 + IHDR 占位，足够 FileReader.readAsArrayBuffer 产出非空 base64） */
function makePngFile(): File {
  // PNG signature + fake IHDR chunk（内容不要求是合法 PNG，只要求能读成 ArrayBuffer 转 base64）
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
  ])
  return new File([bytes], 'image.png', { type: 'image/png' })
}

describe('useImageAttachment: handleImagePaste 降级矩阵', () => {
  beforeEach(() => {
    writeImageMock.mockReset()
  })

  it('TC1: writeSessionImage 成功（persisted=true）→ {kind:badge, ..., needsMigrate:false}', async () => {
    writeImageMock.mockResolvedValueOnce({ path: '/tmp/taiji-img-x.png', fileName: 'taiji-img-x.png', displayName: 'taiji-img-x.png', id: 'u1', persisted: true })
    const result = await handleImagePaste(makePngFile(), 'sess-1')
    expect(result).toEqual({ kind: 'badge', path: '/tmp/taiji-img-x.png', fileName: 'taiji-img-x.png', displayName: 'taiji-img-x.png', needsMigrate: false })
    // writeSessionImage 收到 base64 非空 + mimeType='image/png'
    expect(writeImageMock).toHaveBeenCalledTimes(1)
    const payload = writeImageMock.mock.calls[0][0]
    expect(payload.mimeType).toBe('image/png')
    expect(payload.base64.length).toBeGreaterThan(0)
  })

  it('W3TC9: sessionId 透传到 writeSessionImage payload', async () => {
    writeImageMock.mockResolvedValueOnce({ path: '/d/a.png', fileName: 'a.png', displayName: 'a.png', id: 'u1', persisted: true })
    await handleImagePaste(makePngFile(), 'sess-panel-9')
    expect(writeImageMock.mock.calls[0][0].sessionId).toBe('sess-panel-9')
  })

  it('sessionId=null（landing 态）→ payload.sessionId 为空字符串（IPC 内降级 tmpdir）+ needsMigrate=true', async () => {
    // persisted=false（落 tmpdir）→ needsMigrate=true（session 创建后需迁移到 attachments）
    writeImageMock.mockResolvedValueOnce({ path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png', id: 'u1', persisted: false })
    const result = await handleImagePaste(makePngFile(), null)
    expect(writeImageMock.mock.calls[0][0].sessionId).toBe('')
    expect(result).toEqual({ kind: 'badge', path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png', needsMigrate: true })
  })

  it('TC4: writeSessionImage reject → {kind:text, text:[图片粘贴失败]} 降级', async () => {
    writeImageMock.mockRejectedValueOnce(new Error('write failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await handleImagePaste(makePngFile(), 'sess-1')
    expect(result).toEqual({ kind: 'text', text: '[图片粘贴失败]' })
    errSpy.mockRestore()
  })

  it('TC5: writeSessionImage resolve(undefined)（非 electron）→ {kind:text, text:[图片粘贴：需桌面环境]}', async () => {
    writeImageMock.mockResolvedValueOnce(undefined)
    const result = await handleImagePaste(makePngFile(), 'sess-1')
    expect(result).toEqual({ kind: 'text', text: '[图片粘贴：需桌面环境]' })
  })

  it('读 blob 失败（FileReader.onerror）→ {kind:text, text:[图片读取失败]}', async () => {
    // 构造会触发 FileReader.onerror 的 blob：传入无效 Blob（readAsArrayBuffer 在某些实现下 onerror）
    // jsdom 的 FileReader 对空 ArrayBuffer 不会 onerror，这里用 spy 强制触发 error 事件
    const file = makePngFile()
    const orig = globalThis.FileReader
    class FailReader extends orig {
      override readAsArrayBuffer(_blob: Blob): void {
        // 模拟读取失败：异步派发 error
        setTimeout(() => {
          Object.defineProperty(this, 'error', { value: new Error('read fail'), configurable: true })
          this.dispatchEvent(new Event('error'))
        }, 0)
      }
    }
    globalThis.FileReader = FailReader as unknown as typeof FileReader
    try {
      const result = await handleImagePaste(file, 'sess-1')
      expect(result).toEqual({ kind: 'text', text: '[图片读取失败]' })
    } finally {
      globalThis.FileReader = orig
    }
  })
})
