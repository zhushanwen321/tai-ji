import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expandLocalFilePath } from '../utils/path'
import { buildLocalFileFetchUrl } from '../utils/local-file-prefixes'

describe('local-file protocol path expansion', () => {
  it('E1: expands ~ prefix to homedir', () => {
    const result = expandLocalFilePath('~/Code/foo.png')
    expect(result).toBe(`${homedir()}/Code/foo.png`)
  })

  it('E1b: leaves absolute paths unchanged', () => {
    const result = expandLocalFilePath('/var/tmp/foo.png')
    expect(result).toBe('/var/tmp/foo.png')
  })
})

/**
 * handler 取文件 URL 的编码规格（chat-html-support §6.4 D4「路径编码规格」/ §11 检查点 4）。
 *
 * 预检产出的是**解码后的明文路径**，handler 必须重新按 file URL 规则编码才能交 net.fetch——
 * 裸拼 `file://${resolvedPath}` 会让 `#`/`?` 被 URL 解析吞成 fragment/query、字面 `%` 被错
 * 解码，取到另一个（或不存在的）文件：预检报 servable=true、iframe 却落 404 错误文档。
 */
describe('handler 取文件 URL：路径编码（D4 编码规格 / 检查点 4）', () => {
  const cases: Array<[string, string, string]> = [
    ['# 文件名（裸拼吞成 fragment）', '/tmp/dir/report#1.html', 'file:///tmp/dir/report%231.html'],
    ['? 文件名（裸拼吞成 query）', '/tmp/dir/a?b.html', 'file:///tmp/dir/a%3Fb.html'],
    ['字面 % 文件名（裸拼错解码到另一路径）', '/tmp/dir/weird%20x.html', 'file:///tmp/dir/weird%2520x.html'],
    ['空格文件名', '/tmp/dir/space name.html', 'file:///tmp/dir/space%20name.html'],
    ['中文文件名', '/tmp/dir/报告.html', 'file:///tmp/dir/%E6%8A%A5%E5%91%8A.html'],
    ['常规文件名（回归）', '/tmp/dir/plain.html', 'file:///tmp/dir/plain.html'],
  ]
  it.each(cases)('%s：编码为 file URL 且取文件端解回原路径', (_name, absPath, expectedHref) => {
    const url = buildLocalFileFetchUrl(absPath)
    expect(url).toBe(expectedHref)
    // 取文件端（net.fetch 的 file:// 解析同 fileURLToPath 语义）解出的必须是原路径
    expect(fileURLToPath(url)).toBe(absPath)
  })

  it('裸拼对照：`file://${path}` 在上述形态上解出另一路径（本缺陷的成因锁）', () => {
    const breaking: Array<[string, string]> = [
      ['/tmp/dir/report#1.html', '/tmp/dir/report'],
      ['/tmp/dir/a?b.html', '/tmp/dir/a'],
      ['/tmp/dir/weird%20x.html', '/tmp/dir/weird x.html'],
    ]
    for (const [absPath, misresolved] of breaking) {
      expect(fileURLToPath(`file://${absPath}`)).toBe(misresolved)
      expect(fileURLToPath(buildLocalFileFetchUrl(absPath))).toBe(absPath)
    }
  })
})
