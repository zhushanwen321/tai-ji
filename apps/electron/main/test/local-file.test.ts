// local-file.test.ts —— electron-main-test C07 簇合并产物（round5-G）。
// 共同被测业务模块：`utils/local-file-prefixes.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - test/local-file-protocol.test.ts（9 用例，skip 0）
//   - test/local-file-servable.test.ts（17 用例，skip 0）

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expandLocalFilePath } from '../utils/path'
import { buildLocalFileFetchUrl, probeLocalFileServable, probeLocalFileUrlPathname, resolveLocalFilePath, type LocalFileServableResult } from '../utils/local-file-prefixes'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

// ======== 来源：local-file-protocol.test.ts ========
describe("local-file-protocol", () => {
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
});

// ======== 来源：local-file-servable.test.ts ========
describe("local-file-servable", () => {
  let root: string
  let allowedDir: string
  let outsideDir: string

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'taiji-local-file-servable-'))
    allowedDir = path.join(root, 'allowed')
    outsideDir = path.join(root, 'outside')
    mkdirSync(allowedDir)
    mkdirSync(outsideDir)
    mkdirSync(path.join(allowedDir, 'sub'))
    writeFileSync(path.join(allowedDir, 'page.html'), '<html></html>')
    writeFileSync(path.join(allowedDir, 'data.txt'), 'hello')
    writeFileSync(path.join(allowedDir, 'weird%20x.html'), '<html></html>')
    writeFileSync(path.join(allowedDir, 'hash#1.html'), '<html></html>')
    writeFileSync(path.join(allowedDir, 'space name.html'), '<html></html>')
    writeFileSync(path.join(outsideDir, 'secret.html'), '<html></html>')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** renderer 侧拼 local-file URL 的路径段编码形态（D4 编码规格）——与 packages/ui
 *  src/features/chat/html-preview-path.ts 的 `encodeLocalFilePath` 同构（v16 随抽屉渲染态
 *  退役自 renderer 迁入 ui 包）：剥冗余前导 `/` 后规范化为单个前导 `/`，逐段
 *  encodeURIComponent。这是真实 URL 入口形态（镜像实现会漏掉 `~` → `/~` 的前导 `/`，
 *  正是 U10 分叉的成因）。 */
  const toUrlPathname = (raw: string): string =>
    '/' +
    raw
      .replace(/^\/+/, '')

      .split('/')

      .map(encodeURIComponent)

      .join('/')

  /** 白名单 = 允许目录 + home（home 供 `~` 形态用例；只读探测，无写入） */
  const prefixes = (): string[] => [allowedDir + path.sep, homedir() + path.sep]

  type EdgeCase = {
    name: string
    raw: string
    servable: boolean
    reason?: LocalFileServableResult['reason']
  }

  function edgeCases(): EdgeCase[] {
    return [
      { name: '白名单内存在文件', raw: path.join(allowedDir, 'page.html'), servable: true },
      { name: '白名单内不存在文件', raw: path.join(allowedDir, 'nope.html'), servable: false, reason: 'not_found' },
      { name: '白名单内是目录', raw: path.join(allowedDir, 'sub'), servable: false, reason: 'is_dir' },
      { name: '白名单根本身（精确成员）', raw: allowedDir, servable: false, reason: 'is_dir' },
      { name: '白名单外存在文件', raw: path.join(outsideDir, 'secret.html'), servable: false, reason: 'out_of_whitelist' },
      { name: '白名单外不存在文件', raw: path.join(root, 'ghost.html'), servable: false, reason: 'out_of_whitelist' },
      { name: '.. 穿越回白名单内', raw: `${allowedDir}/sub/../page.html`, servable: true },
      { name: '.. 穿越到白名单外', raw: `${allowedDir}/../outside/secret.html`, servable: false, reason: 'out_of_whitelist' },
      { name: '// 冗余斜杠', raw: `${allowedDir}//page.html`, servable: true },
      { name: '% 字面文件名', raw: path.join(allowedDir, 'weird%20x.html'), servable: true },
      { name: '# 文件名', raw: path.join(allowedDir, 'hash#1.html'), servable: true },
      { name: '空格文件名', raw: path.join(allowedDir, 'space name.html'), servable: true },
      { name: '~ home 根（展开后为目录）', raw: '~', servable: false, reason: 'is_dir' },
      { name: '~/不存在（展开后落 home 下）', raw: '~/taiji-servable-probe-nonexistent-4f3a', servable: false, reason: 'not_found' },
    ]
  }

  describe('servable 谓词：两条入口判定一致 + 边缘形态', () => {
    it('同一路径集合经 servable 入口与协议 handler 入口判定一致（含边缘形态全集）', () => {
      for (const c of edgeCases()) {
        const direct = probeLocalFileServable(c.raw, prefixes())
        const viaUrl = probeLocalFileUrlPathname(toUrlPathname(c.raw), prefixes())
        expect(
          { servable: direct.servable, reason: direct.reason, size: direct.size },
          `入口不一致: ${c.name}`,
        ).toEqual({ servable: viaUrl.servable, reason: viaUrl.reason, size: viaUrl.size })
      }
    })

    it('每条边缘形态的判定与预期一致（两入口各断言一次）', () => {
      for (const c of edgeCases()) {
        const direct = probeLocalFileServable(c.raw, prefixes())
        expect({ servable: direct.servable, reason: direct.reason }, c.name).toEqual({
          servable: c.servable,
          reason: c.reason,
        })
        const viaUrl = probeLocalFileUrlPathname(toUrlPathname(c.raw), prefixes())
        expect({ servable: viaUrl.servable, reason: viaUrl.reason }, `${c.name}（URL 入口）`).toEqual({
          servable: c.servable,
          reason: c.reason,
        })
      }
    })

    it('servable 命中时返回文件字节数（卡片大小显示的数据源）', () => {
      const r = probeLocalFileServable(path.join(allowedDir, 'data.txt'), prefixes())
      expect(r).toMatchObject({ servable: true, size: 5 })
    })

    it('含 % / # / 空格的文件名经 URL 段编码往返后判定不变', () => {
      for (const name of ['weird%20x.html', 'hash#1.html', 'space name.html']) {
        const raw = path.join(allowedDir, name)
        expect(probeLocalFileServable(raw, prefixes()), name).toMatchObject({ servable: true })
        expect(
          probeLocalFileUrlPathname(toUrlPathname(raw), prefixes()),
          `${name}（URL 入口）`,
        ).toMatchObject({ servable: true })
      }
    })

    it('非法 % 序列的解码失败回退原文（不抛异常，落白名单短路）', () => {
      const prefixesOnly = [allowedDir + path.sep]
      expect(() => probeLocalFileUrlPathname('/tmp/%zz', prefixesOnly)).not.toThrow()
      expect(probeLocalFileUrlPathname('/tmp/%zz', prefixesOnly)).toMatchObject({
        servable: false,
        reason: 'out_of_whitelist',
      })
    })
  })

  describe('servable 谓词：URL 入口 `~` 形态与 IPC 入口同判定（U10 / D4 子决策②）', () => {
    // 白名单形态取自 computeLocalFilePrefixes：用户内容子目录是 home 下的具名子目录
    // （不是 home 根本身）。用注入 stat 桩避免触真实 home（测试禁写真实数据/用户目录）。
    const docsPrefix = [path.join(homedir(), 'Documents') + path.sep]
    const docsFile = path.join(homedir(), 'Documents', 'x.html')
    const statStub = {
      statSync: (p: string) => (p === docsFile ? { isDirectory: () => false, size: 12 } : undefined),
    }

    it('白名单内 `~/Documents/x.html`：URL 入口（/~/...）与 IPC 入口同判可服务', () => {
      const viaIpc = probeLocalFileServable('~/Documents/x.html', docsPrefix, statStub)
      const viaUrl = probeLocalFileUrlPathname(toUrlPathname('~/Documents/x.html'), docsPrefix, statStub)
      expect(viaUrl.resolvedPath).toBe(docsFile)
      expect({ servable: viaUrl.servable, reason: viaUrl.reason, size: viaUrl.size }).toEqual({
        servable: viaIpc.servable,
        reason: viaIpc.reason,
        size: viaIpc.size,
      })
      expect(viaUrl).toMatchObject({ servable: true, size: 12 })
    })

    it('非白名单目录 `~/secret/x.html`：两入口同判 out_of_whitelist（不触 fs）', () => {
      const touched: string[] = []
      const spy = {
        statSync: (p: string) => {
          touched.push(p)
          return undefined
        },
      }
      const viaIpc = probeLocalFileServable('~/secret/x.html', docsPrefix, spy)
      const viaUrl = probeLocalFileUrlPathname(toUrlPathname('~/secret/x.html'), docsPrefix, spy)
      expect(viaUrl).toMatchObject({ servable: false, reason: 'out_of_whitelist' })
      expect({ servable: viaUrl.servable, reason: viaUrl.reason }).toEqual({
        servable: viaIpc.servable,
        reason: viaIpc.reason,
      })
      expect(touched).toEqual([])
    })

    it('含空格 / % / # 的 `~` 形态文件名经 URL 段编码往返后仍与 IPC 入口一致', () => {
      for (const name of ['x.html', 'my report.html', 'weird%20x.html', 'hash#1.html']) {
        const raw = `~/Documents/${name}`
        const expected = path.join(homedir(), 'Documents', name)
        const statForName = {
          statSync: (p: string) => (p === expected ? { isDirectory: () => false, size: 7 } : undefined),
        }
        const viaIpc = probeLocalFileServable(raw, docsPrefix, statForName)
        const viaUrl = probeLocalFileUrlPathname(toUrlPathname(raw), docsPrefix, statForName)
        expect(viaUrl.resolvedPath, name).toBe(expected)
        expect(
          { servable: viaUrl.servable, reason: viaUrl.reason, size: viaUrl.size },
          `${name}（URL 入口）`,
        ).toEqual({ servable: viaIpc.servable, reason: viaIpc.reason, size: viaIpc.size })
        expect(viaUrl, name).toMatchObject({ servable: true, size: 7 })
      }
    })
  })

  describe('servable 谓词：检查顺序（白名单先行短路）', () => {
    it('越界路径不触 fs——越界不存在与越界存在返回同形 out_of_whitelist', () => {
      const touched: string[] = []
      const spy = {
        statSync: (p: string) => {
          touched.push(p)
          return undefined
        },
      }
      const prefixesOnly = [allowedDir + path.sep]
      const outsideMissing = probeLocalFileServable(path.join(root, 'ghost.html'), prefixesOnly, spy)
      const outsideExisting = probeLocalFileServable(path.join(outsideDir, 'secret.html'), prefixesOnly, spy)
      expect(outsideMissing).toMatchObject({ servable: false, reason: 'out_of_whitelist' })
      expect(outsideExisting).toMatchObject({ servable: false, reason: 'out_of_whitelist' })
      expect(touched).toEqual([])
    })

    it('URL 入口 %2e%2e 编码遍历在规范化后越界短路（同样不触 fs）', () => {
      const touched: string[] = []
      const spy = {
        statSync: (p: string) => {
          touched.push(p)
          return undefined
        },
      }
      const r = probeLocalFileUrlPathname(
        `${allowedDir}/%2e%2e/outside/secret.html`,
        [allowedDir + path.sep],
        spy,
      )
      expect(r).toMatchObject({ servable: false, reason: 'out_of_whitelist' })
      expect(touched).toEqual([])
    })

    it('白名单内路径才进入 fs 面（存在性 → 目录性），越界零调用作对照', () => {
      const touched: string[] = []
      const r = probeLocalFileServable(path.join(allowedDir, 'data.txt'), [allowedDir + path.sep], {
        statSync: (p: string) => {
          touched.push(p)
          return { isDirectory: () => false, size: 5 }
        },
      })
      expect(r).toMatchObject({ servable: true, size: 5 })
      expect(touched).toEqual([path.join(allowedDir, 'data.txt')])
    })

    it('白名单内目录经注入切面命中 is_dir（存在性 → 目录性两段都有覆盖）', () => {
      const r = probeLocalFileServable(path.join(allowedDir, 'sub'), [allowedDir + path.sep], {
        statSync: () => ({ isDirectory: () => true, size: 0 }),
      })
      expect(r).toMatchObject({ servable: false, reason: 'is_dir' })
    })
  })

  describe('探测异常旁路（onError）：非 ENOENT 真异常与「不存在」可辨', () => {
    it('EACCES 真异常经 onError 可见且就地映射为 not_found（reason 枚举不扩）', () => {
      const seen: Array<{ filePath: string; message: string }> = []
      const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      const target = path.join(allowedDir, 'data.txt')
      const r = probeLocalFileServable(target, [allowedDir + path.sep], {
        statSync: () => {
          throw eacces
        },
        onError: (err, filePath) => {
          seen.push({ filePath, message: err instanceof Error ? err.message : String(err) })
        },
      })
      expect(r).toMatchObject({ servable: false, reason: 'not_found' })
      expect(seen).toEqual([{ filePath: target, message: 'EACCES: permission denied' }])
    })

    it('越界短路仍不触 fs——异常路径不会被探测（onError 零调用）', () => {
      const seen: string[] = []
      const r = probeLocalFileServable(path.join(outsideDir, 'secret.html'), [allowedDir + path.sep], {
        statSync: () => {
          throw new Error('EACCES: permission denied')
        },
        onError: (_err, filePath) => seen.push(filePath),
      })
      expect(r).toMatchObject({ servable: false, reason: 'out_of_whitelist' })
      expect(seen).toEqual([])
    })

    it('未注入 onError 时异常仍不向调用方抛出（缺省静默降级语义保持）', () => {
      expect(() =>
        probeLocalFileServable(path.join(allowedDir, 'data.txt'), [allowedDir + path.sep], {
          statSync: () => {
            throw new Error('EIO: i/o error')
          },
        }),
      ).not.toThrow()
    })
  })

  describe('规范化管线：~ 展开与 path.resolve', () => {
    it('~ 展开为 home 根、~/x 展开为 home 下 x', () => {
      expect(resolveLocalFilePath('~')).toBe(path.resolve(homedir()))
      expect(resolveLocalFilePath('~/x.html')).toBe(path.resolve(path.join(homedir(), 'x.html')))
    })

    it('绝对路径不被 ~ 分支影响（原样 resolve）', () => {
      expect(resolveLocalFilePath('/tmp/a/../b.html')).toBe('/tmp/b.html')
    })
  })
});
