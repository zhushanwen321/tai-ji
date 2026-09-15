/**
 * FsExecutor.listDir withSize 参数化测试（D7-3，05-scan-caching §3.3 / plan W25）。
 *
 * 覆盖：
 * - 默认（无 opts / withSize=true）：file entry 逐个 stat 取 size，dir entry 不 stat（现状行为）
 * - withSize=false（searchFiles 快路径）：非 symlink 的 file entry 免 per-file stat，size 缺省
 * - withSize=false 的 symlink 例外：仍走 stat——坏 symlink（ELOOP/ENOENT）跳过的现状语义
 *   保持，保证 searchFiles 结果集成员与 withSize=true 严格一致（唯一差异是 size 字段缺省）
 *
 * mock 策略：vi.mock('node:fs/promises')（FsExecutor 真 import 该模块），
 * Dirent 用 { name, isDirectory, isSymbolicLink } 鸭子形状模拟。
 *
 * 运行：cd packages/runtime && npx vitest run test/fs-executor-listdir.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}))

import { readdir, stat } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import type { NonSharedBuffer } from 'node:buffer'
import { FsExecutor } from '../src/infra/fs-executor.js'

const readdirMock = vi.mocked(readdir)
const statMock = vi.mocked(stat)

/**
 * Dirent 鸭子形状 mock（FsExecutor 只用 name/isDirectory/isSymbolicLink）。
 * as unknown as Dirent<NonSharedBuffer>：mock 形状缺 Dirent 其余方法（isFile/isBlockDevice
 * 等），类型断言到 readdir({ withFileTypes:true }) 的精确返回元素类型——运行时只消费
 * 上述三个成员，行为与真 Dirent 等价。
 */
function dirent(name: string, type: 'dir' | 'file', symlink = false): Dirent<NonSharedBuffer> {
  return {
    name,
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => symlink,
  } as unknown as Dirent<NonSharedBuffer>
}

/** stat 结果鸭子形状（FsExecutor 只用 size）。 */
function statResult(size: number): Stats {
  return { size } as unknown as Stats
}

beforeEach(() => {
  vi.clearAllMocks()
  // 坏 symlink 跳过路径有 console.warn，压掉保持测试输出干净
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('FsExecutor.listDir withSize 参数化 (D7-3)', () => {
  it('默认（无 opts）：file entry 逐个 stat 取 size，dir entry 不 stat（现状行为不变）', async () => {
    readdirMock.mockResolvedValue([dirent('a.txt', 'file'), dirent('src', 'dir'), dirent('b.md', 'file')])
    statMock.mockResolvedValue(statResult(42))

    const entries = await new FsExecutor().listDir('/repo')

    expect(entries).toEqual([
      { name: 'a.txt', type: 'file', size: 42 },
      { name: 'src', type: 'dir' },
      { name: 'b.md', type: 'file', size: 42 },
    ])
    expect(statMock).toHaveBeenCalledTimes(2)
    expect(statMock).toHaveBeenCalledWith('/repo/a.txt')
    expect(statMock).toHaveBeenCalledWith('/repo/b.md')
  })

  it('withSize=false：非 symlink 的 file entry 免 stat（零 stat 调用），size 缺省', async () => {
    readdirMock.mockResolvedValue([dirent('a.txt', 'file'), dirent('src', 'dir'), dirent('b.md', 'file')])

    const entries = await new FsExecutor().listDir('/repo', { withSize: false })

    expect(entries).toEqual([
      { name: 'a.txt', type: 'file' },
      { name: 'src', type: 'dir' },
      { name: 'b.md', type: 'file' },
    ])
    expect(statMock).not.toHaveBeenCalled()
  })

  it('withSize=false：symlink entry 仍 stat——好 symlink 收录（带 size），坏 symlink（ELOOP）跳过', async () => {
    readdirMock.mockResolvedValue([
      dirent('good.lnk', 'file', true),
      dirent('bad.lnk', 'file', true),
      dirent('plain.txt', 'file', false),
    ])
    statMock.mockImplementation(async (p) => {
      if (String(p).endsWith('bad.lnk')) {
        throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
      }
      return statResult(7)
    })

    const entries = await new FsExecutor().listDir('/repo', { withSize: false })

    // bad.lnk 被跳过——与 withSize=true 的坏 symlink 跳过语义严格一致（结果集成员不变）
    expect(entries).toEqual([
      { name: 'good.lnk', type: 'file', size: 7 },
      { name: 'plain.txt', type: 'file' },
    ])
    // 仅两个 symlink entry 触发 stat（plain.txt 免）
    expect(statMock).toHaveBeenCalledTimes(2)
    expect(statMock).toHaveBeenCalledWith('/repo/good.lnk')
    expect(statMock).toHaveBeenCalledWith('/repo/bad.lnk')
  })

  it('withSize=true 显式：与默认一致（file entry 带 size）', async () => {
    readdirMock.mockResolvedValue([dirent('a.txt', 'file')])
    statMock.mockResolvedValue(statResult(9))

    const entries = await new FsExecutor().listDir('/repo', { withSize: true })

    expect(entries).toEqual([{ name: 'a.txt', type: 'file', size: 9 }])
    expect(statMock).toHaveBeenCalledTimes(1)
  })
})
