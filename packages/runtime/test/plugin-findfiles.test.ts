import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { findFiles, MAX_FIND_FILES_RESULTS } from '../src/services/plugin-service/plugin-rpc-setup.js'

/**
 * 直测 SUT 导出的 findFiles（plugin-rpc-setup.ts，T10 提取后可直测——真实临时目录，
 * 无 mock；此前测试在文件内本地复制实现自测，SUT 改 ignore/上限/错误吞噬均不红）。
 *
 * findFiles 核心语义：
 * 1. 用 fast-glob 按模式搜索 cwd
 * 2. 忽略 node_modules / .git
 * 3. 返回绝对路径，截断到 MAX_FIND_FILES_RESULTS
 * 4. 任何错误吞噬为空数组
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-findfiles.test.ts
 */
describe('findFiles（plugin-rpc-setup SUT 直测，T10）', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findfiles-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('基本匹配：用 **/*.json 能返回匹配文件', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'b.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'hello')

    const results = await findFiles('**/*.json', tmpDir)
    expect(results).toHaveLength(2)
    expect(results.every(f => f.endsWith('.json'))).toBe(true)
  })

  it('ignore 排除：忽略 node_modules 和 .git 目录', async () => {
    // 正常文件
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'code')

    // node_modules 内的文件
    const nmDir = path.join(tmpDir, 'node_modules', 'pkg')
    fs.mkdirSync(nmDir, { recursive: true })
    fs.writeFileSync(path.join(nmDir, 'index.ts'), 'pkg')

    // .git 内的文件
    const gitDir = path.join(tmpDir, '.git', 'objects')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'data.ts'), 'git')

    const results = await findFiles('**/*.ts', tmpDir)
    const basenames = results.map(f => path.basename(f))
    expect(basenames).toContain('src.ts')
    expect(basenames).not.toContain('index.ts')
    expect(basenames).not.toContain('data.ts')
  })

  it('上限截断：超过 MAX_FIND_FILES_RESULTS 条时截断到上限', async () => {
    // 创建上限 +5 个文件
    for (let i = 0; i < MAX_FIND_FILES_RESULTS + 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `file-${i}.txt`), `${i}`)
    }

    const results = await findFiles('**/*.txt', tmpDir)
    expect(MAX_FIND_FILES_RESULTS).toBe(1000) // 上限常量语义（SUT 改上限此断言同步红）
    expect(results).toHaveLength(MAX_FIND_FILES_RESULTS)
    expect(results.every(f => f.endsWith('.txt'))).toBe(true)
  })

  it('cwd 边界：只搜给定 cwd 子树，返回以 cwd 为前缀的绝对路径', async () => {
    fs.writeFileSync(path.join(tmpDir, 'root.json'), '{}')
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir)
    fs.writeFileSync(path.join(subDir, 'inner.json'), '{}')

    // cwd 指向子目录：只命中子目录内文件（父级 root.json 不越界搜入）
    const results = await findFiles('**/*.json', subDir)
    expect(results).toHaveLength(1)
    expect(path.basename(results[0])).toBe('inner.json')
    expect(path.isAbsolute(results[0])).toBe(true)
    expect(results[0].startsWith(subDir)).toBe(true)
  })

  it('错误吞噬：glob 抛错（非法 pattern）返回空数组而非向外抛', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}')

    // fast-glob 对非字符串 pattern 抛 TypeError → findFiles 契约吞噬为 []
    const results = await findFiles(null as unknown as string, tmpDir)
    expect(results).toEqual([])
  })
})
