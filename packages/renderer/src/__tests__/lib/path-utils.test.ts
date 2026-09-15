/**
 * 前端路径工具测试（mock 层；原 path-utils-improve.test.ts 已并入——同 SUT 补充用例，
 * U 编号各自从头无并存理由）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/path-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isAbsolutePath, resolvePreviewPath } from '@/lib/path-utils'

describe('isAbsolutePath', () => {
  it('U1: 识别 Unix 绝对路径', () => {
    expect(isAbsolutePath('/var/tmp/x.md')).toBe(true)
  })

  it('U2: 识别 Windows 盘符路径', () => {
    expect(isAbsolutePath('C:\\Users\\x.md')).toBe(true)
  })

  it('U3: 识别家目录路径', () => {
    expect(isAbsolutePath('~/x.md')).toBe(true)
  })

  it('U4: 相对路径返回 false', () => {
    expect(isAbsolutePath('src/x.md')).toBe(false)
  })
})

describe('resolvePreviewPath', () => {
  it('U5: 绝对路径在 cwd 内时返回相对路径', () => {
    const result = resolvePreviewPath('/project', '/project/src/main.ts')
    expect(result.absolute).toBe('/project/src/main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U6: 相对路径解析为绝对路径并返回相对路径', () => {
    const result = resolvePreviewPath('/project', 'src/main.ts')
    expect(result.absolute).toBe('/project/src/main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U7: 绝对路径在 cwd 外时 relative 为 null', () => {
    const result = resolvePreviewPath('/project', '/var/tmp/x.md')
    expect(result.absolute).toBe('/var/tmp/x.md')
    expect(result.relative).toBeNull()
  })
})

describe('Windows / ~ 路径补充（原 path-utils-improve.test.ts 并入）', () => {
  it('U-imp-1: C:\\project\\src\\main.ts under C:\\project → relative src/main.ts', () => {
    const result = resolvePreviewPath('C:\\project', 'C:\\project\\src\\main.ts')
    expect(result.absolute).toBe('C:\\project\\src\\main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U-imp-1b: Windows path with mixed separators → 归一化正斜杠', () => {
    const result = resolvePreviewPath('C:/project', 'C:\\project\\src\\main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U-imp-2: ~ path is absolute and relative is null', () => {
    expect(isAbsolutePath('~/Code/foo.md')).toBe(true)
    const result = resolvePreviewPath('/Users/me/project', '~/Code/foo.md')
    expect(result.absolute).toBe('~/Code/foo.md')
    expect(result.relative).toBeNull()
  })
})
