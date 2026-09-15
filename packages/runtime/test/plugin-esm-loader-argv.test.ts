/**
 * MF-5: resolveEsmLoaderExecArgv fail-open 分支单元测试。
 *
 * 锁定 resolveEsmLoaderExecArgv 的行为契约：loader 缺失时 catch 后返回 undefined（不抛），
 * 使 runtime 启动不被 loader 缺失阻塞（fail-closed 由 fork 边界 MF-1 断言兜底）。
 * 若有人把 catch 改回 throw，本测试会红——防止「fail-open → runtime 崩溃」回归。
 *
 * 运行命令: npx vitest run test/plugin-esm-loader-argv.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock plugin-host.js：保留真实 PluginHost，仅 mock resolveAndValidateFile（按用例控制）
vi.mock('../src/services/plugin-service/plugin-host.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/plugin-service/plugin-host.js')>()
  return {
    ...actual,
    resolveAndValidateFile: vi.fn(),
  }
})

import { resolveEsmLoaderExecArgv, findTsxImportArg } from '../src/services/plugin-service/plugin-service.js'
import { resolveAndValidateFile } from '../src/services/plugin-service/plugin-host.js'

/** tsx 实测注入形态（Node 24 + tsx，pnpm 布局同理含 node_modules/tsx/） */
const REAL_TSX_EXEC_ARGV = [
  '--require', '/ws/node_modules/tsx/dist/preflight.cjs',
  '--import', 'file:///ws/node_modules/tsx/dist/loader.mjs',
]

describe('resolveEsmLoaderExecArgv (MF-5 fail-open branch)', () => {
  const originalExecArgv = process.execArgv

  beforeEach(() => {
    vi.mocked(resolveAndValidateFile).mockReset()
    // 固定为空 execArgv：本组用例锁定「无 tsx」基线，宿主环境 flags 不得渗入结果
    process.execArgv = []
  })

  afterEach(() => {
    process.execArgv = originalExecArgv
  })

  it('loader present: returns ["--import", <absolute path>]', () => {
    vi.mocked(resolveAndValidateFile).mockReturnValue('/abs/plugin-esm-loader.cjs')
    expect(resolveEsmLoaderExecArgv()).toEqual(['--import', '/abs/plugin-esm-loader.cjs'])
  })

  it('loader missing: catch 分支返回 undefined，不抛——runtime 启动不被 loader 缺失阻塞', () => {
    vi.mocked(resolveAndValidateFile).mockImplementation(() => {
      throw new Error('[plugin-host] Required file not found: plugin-esm-loader.cjs')
    })
    // MF-5 契约：resolver 层 fail-open（返回 undefined）。fail-closed 在 fork 边界（MF-1
    // PluginHostProcess.createProcess 的 SANDBOX_LOADER_MISSING 断言）兑现，故 resolver 不抛
    // 确保 PluginService 构造/runtime boot 不崩。锁定此契约，防止 catch 被改回 throw。
    expect(resolveEsmLoaderExecArgv()).toBeUndefined()
  })
})

describe('resolveEsmLoaderExecArgv tsx 透传（F1 dev sandbox fork 修复）', () => {
  const originalExecArgv = process.execArgv

  beforeEach(() => {
    vi.mocked(resolveAndValidateFile).mockReset()
    vi.mocked(resolveAndValidateFile).mockReturnValue('/abs/plugin-esm-loader.cjs')
  })

  afterEach(() => {
    process.execArgv = originalExecArgv
  })

  it('F1-1: 主进程 execArgv 含 tsx loader 时追加到末尾（esm-loader 在前，4 元素）', () => {
    process.execArgv = [...REAL_TSX_EXEC_ARGV]
    // esm-loader 必须在前：fork 边界 MF-1 断言 execArgv 含 --import（安全命门不破坏），
    // tsx 的 .js→.ts remap hook 追加在后（Node hooks 链后注册先调用，remap 后路径
    // 仍流经 esm-loader 沙箱边界检查）
    expect(resolveEsmLoaderExecArgv()).toEqual([
      '--import', '/abs/plugin-esm-loader.cjs',
      '--import', 'file:///ws/node_modules/tsx/dist/loader.mjs',
    ])
  })

  it('F1-2: 非 tsx 环境（空 execArgv / 其他 flags）不追加，保持 2 元素', () => {
    process.execArgv = []
    expect(resolveEsmLoaderExecArgv()).toEqual(['--import', '/abs/plugin-esm-loader.cjs'])

    // --import 指向非 tsx loader（如用户自己的 loader）不得误判为 tsx
    process.execArgv = ['--inspect', '--import', '/ws/my-custom-loader.mjs']
    expect(resolveEsmLoaderExecArgv()).toEqual(['--import', '/abs/plugin-esm-loader.cjs'])
  })

  it('F1-3: --import=<value> 等号形态同样识别', () => {
    process.execArgv = ['--import=file:///ws/node_modules/tsx/dist/loader.mjs']
    expect(resolveEsmLoaderExecArgv()).toEqual([
      '--import', '/abs/plugin-esm-loader.cjs',
      '--import', 'file:///ws/node_modules/tsx/dist/loader.mjs',
    ])
  })
})

describe('findTsxImportArg（F1 tsx 注入项提取）', () => {
  it('F1-4: 识别 --require/--import 混合数组中的 tsx --import 值', () => {
    expect(findTsxImportArg([...REAL_TSX_EXEC_ARGV])).toBe('file:///ws/node_modules/tsx/dist/loader.mjs')
  })

  it('F1-5: pnpm 布局（.pnpm/tsx@x.y.z/...）同样命中', () => {
    expect(findTsxImportArg(['--import', 'file:///ws/node_modules/.pnpm/tsx@4.19.2/node_modules/tsx/dist/loader.mjs']))
      .toBe('file:///ws/node_modules/.pnpm/tsx@4.19.2/node_modules/tsx/dist/loader.mjs')
  })

  it('F1-6: 无 --import、非 tsx 值、尾悬 --import 均返回 undefined', () => {
    expect(findTsxImportArg([])).toBeUndefined()
    expect(findTsxImportArg(['--import', '/ws/other-loader.mjs'])).toBeUndefined()
    // '--import' 是最后一个元素（无值可取）不得越界
    expect(findTsxImportArg(['--require', '/x.cjs', '--import'])).toBeUndefined()
  })
})
