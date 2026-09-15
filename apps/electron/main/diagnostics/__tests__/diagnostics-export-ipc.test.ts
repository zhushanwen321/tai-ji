/**
 * diagnostics-export-ipc 单测（crash-forensics-and-watchdog §3.3 D6，验收 A3/A4）。
 *
 * 覆盖：
 * - A3 成功路径：handler 返回 status='exported' + 产物路径（文件真实落盘）
 * - A3 失败路径：打包失败归一 status='error' + 具体 errno（不 reject，零 rejection 面
 *   对齐 log-retention-ipc 先例）；对话框桩抛错归一 EDIALOG；用户取消返回 canceled
 * - A4 知情文案：exported 结果 summary.privacyNotice 携带 shared 常量
 * - 注册幂等：重复注册不重复 handle（防 Electron「second handler」炸启动）
 *
 * electron mock 捕获 ipcMain.handle（对齐 log-retention-ipc.test.ts 形态）；main-logger
 * mock 掉（镜像日志会污染夹具目录）。打包主体走真实实现（fs-guard 生效中，夹具全部
 * mkdtemp tmpdir 自建自删）。注册幂等依赖模块级 registered 标志——全文件只注册一次
 * （beforeAll），对话框行为经外层可变桩切换，不做多次注册。
 * 运行：cd apps/electron/main && npx vitest run diagnostics/__tests__/diagnostics-export-ipc.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  dialog: {},
  BrowserWindow: {},
  app: { getVersion: () => '0.0.0-test' },
}))

// main-logger mock：镜像日志落盘会写夹具目录，stub 掉保持内容确定性
vi.mock('../../logs/main-logger.js', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { registerDiagnosticsExportHandler } from '../diagnostics-export-ipc.js'
import { DIAGNOSTICS_EXPORT_BUNDLE, DIAGNOSTIC_EXPORT_PRIVACY_NOTICE } from '@taiji/shared'
import type { DiagnosticExportBundleResult } from '@taiji/shared'

describe('diagnostics-export-ipc（diagnostics:export-bundle）', () => {
  let tmpDir: string
  let savedDataDir: string | undefined
  let saveResult: { canceled: boolean; filePath?: string }
  let dialogShouldThrow = false

  beforeAll(() => {
    // 模块级 registered 标志：全文件单次注册；对话框行为经外层可变桩切换（见上文件头）
    registerDiagnosticsExportHandler({
      showSaveDialog: async (options) => {
        void options
        if (dialogShouldThrow) throw new Error('dialog crashed')
        return saveResult
      },
      appVersion: () => '0.9.16-test',
    })
  })

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'diag-export-ipc-test-'))
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
    saveResult = { canceled: true }
    dialogShouldThrow = false
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function invoke(payload?: unknown): Promise<DiagnosticExportBundleResult> {
    const handler = handlers.get(DIAGNOSTICS_EXPORT_BUNDLE)
    expect(handler, 'handler 应已注册到 diagnostics:export-bundle 通道').toBeDefined()
    return handler!(undefined, payload) as Promise<DiagnosticExportBundleResult>
  }

  function seedJournal(): void {
    const crashesDir = join(tmpDir, 'logs', 'crashes')
    mkdirSync(crashesDir, { recursive: true })
    writeFileSync(
      join(crashesDir, 'runtime.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), layer: 'runtime', event: 'reload' })}\n`,
    )
  }

  it('A3 成功路径：返回 exported + 产物路径，zip 真实落盘且携带知情文案（A4）', async () => {
    seedJournal()
    const outPath = join(tmpDir, 'diag.zip')
    saveResult = { canceled: false, filePath: outPath }

    const result = await invoke({ defaultPath: tmpDir })

    expect(result.status).toBe('exported')
    if (result.status !== 'exported') return
    expect(result.path).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)
    expect(result.entryNames).toContain('summary.md')
    expect(result.summary.appVersion).toBe('0.9.16-test')
    expect(result.summary.privacyNotice).toBe(DIAGNOSTIC_EXPORT_PRIVACY_NOTICE)
  })

  it('A3 用户取消保存对话框：返回 canceled，不落任何文件', async () => {
    saveResult = { canceled: true }
    const result = await invoke()
    expect(result).toEqual({ status: 'canceled' })
    expect(existsSync(join(tmpDir, 'diag.zip'))).toBe(false)
  })

  it('A3 失败路径：保存位置目录不存在 → error 三态 + 具体 errno（不 reject）', async () => {
    seedJournal()
    saveResult = { canceled: false, filePath: join(tmpDir, 'no-such-dir', 'diag.zip') }

    const result = await invoke()

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.code).toBe('ENOENT')
  })

  it('A3 失败路径（对话框桩抛错）：归一 EDIALOG 错误三态（零 rejection 面）', async () => {
    dialogShouldThrow = true
    const result = await invoke()
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.code).toBe('EDIALOG')
  })

  it('注册幂等：重复调用 registerDiagnosticsExportHandler 不重复 handle', () => {
    registerDiagnosticsExportHandler()
    registerDiagnosticsExportHandler()
    expect([...handlers.keys()].filter((c) => c === DIAGNOSTICS_EXPORT_BUNDLE)).toHaveLength(1)
  })
})
