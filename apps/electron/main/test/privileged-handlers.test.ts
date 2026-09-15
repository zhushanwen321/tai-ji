/**
 * W7: pick-directory IPC handler 的 try/catch 风格一致性。
 *
 * 背景：同文件 open-external 有 try/catch + 返回 false 降级，pick-directory 没有，
 * 靠 ipcMain.handle 的 invoke rejection 兜底（renderer openDirDialog catch 接住）。
 * 不是 bug，但风格不一致，维护者易误判为「故意吞错」。
 *
 * 修复：pick-directory 补 try/catch，dialog 抛异常时返回 {canceled:true, path:null}，
 * 与 getFocusedWindow null 的降级 + open-external 风格对称。
 *
 * Mock 策略：vi.mock('electron') 注入 ipcMain.handle 捕获 handler、dialog 控制抛错/返回。
 *
 * 运行：cd apps/electron/main && npx vitest run test/privileged-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { BrowserWindow } from 'electron'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()
// dialog.showOpenDialog 可被测试替换：默认正常，测试 2 替换为 reject
const dialogMock = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/picked'] })),
}))
const shellMock = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {}),
  showItemInFolder: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})), // 默认有聚焦窗口
    fromWebContents: vi.fn(() => ({})),
  },
  dialog: dialogMock,
  shell: shellMock,
}))

import { registerPrivilegedHandlers } from '../gateway/privileged-handlers.js'

describe('W7: pick-directory IPC try/catch 一致性', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  it('dialog 正常返回选中目录 → handler 返回 {canceled:false, path}', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/my/repo'] })
    const pickDir = handlers.get('pick-directory')!
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: false, path: '/my/repo' })
  })

  it('dialog 抛异常 → handler 返回 {canceled:true, path:null} 不 reject', async () => {
    dialogMock.showOpenDialog.mockRejectedValueOnce(new Error('dialog crash'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pickDir = handlers.get('pick-directory')!
    // 不该抛（ipcMain.handle 的 rejection 兜底虽存在，但本修复要求 handler 自身降级）
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: true, path: null })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('用户取消 → handler 返回 {canceled:true, path:null}（既有降级回归防护）', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const pickDir = handlers.get('pick-directory')!
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: true, path: null })
  })

  it('传入存在的 defaultPath → dialog 用该路径作为初始位置', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickDir = handlers.get('pick-directory')!
    await pickDir({}, { defaultPath: process.cwd() })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: process.cwd() }),
    )
  })

  it('传入已删除的 defaultPath → 回退到 homedir（不回退到 Documents）', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickDir = handlers.get('pick-directory')!
    const ghostPath = '/this/path/definitely/does/not/exist/ghost-12345'
    await pickDir({}, { defaultPath: ghostPath })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: homedir() }),
    )
  })

  it('不传 defaultPath → 回退到 homedir', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickDir = handlers.get('pick-directory')!
    await pickDir({}, {})
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: homedir() }),
    )
  })
})

describe('pick-file IPC handler', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  it('dialog 正常返回选中文件 → handler 返回 {canceled:false, path}', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/my/file.png'] })
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: false, path: '/my/file.png' })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ properties: ['openFile'] }),
    )
  })

  it('dialog 抛异常 → handler 返回 {canceled:true, path:null} 不 reject', async () => {
    dialogMock.showOpenDialog.mockRejectedValueOnce(new Error('dialog crash'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: true, path: null })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('用户取消 → handler 返回 {canceled:true, path:null}', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: true, path: null })
  })

  it('传入 filters → dialog 收到 filters 且 properties 含 openFile', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked.png'] })
    const pickFile = handlers.get('pick-file')!
    const filters = [{ name: '图片', extensions: ['png', 'jpg'] }]
    await pickFile({}, { filters })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ properties: ['openFile'], filters }),
    )
  })

  it('传入存在的 defaultPath → dialog 用该路径作为初始位置', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickFile = handlers.get('pick-file')!
    await pickFile({}, { defaultPath: process.cwd() })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: process.cwd() }),
    )
  })

  it('传入已删除的 defaultPath → 回退到 homedir', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickFile = handlers.get('pick-file')!
    const ghostPath = '/this/path/definitely/does/not/exist/ghost-12345'
    await pickFile({}, { defaultPath: ghostPath })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: homedir() }),
    )
  })

  it('无聚焦窗口 → handler 返回 {canceled:true, path:null} 不调 dialog', async () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce(null)
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: true, path: null })
    expect(dialogMock.showOpenDialog).not.toHaveBeenCalled()
  })
})

describe('C2 reveal-in-folder IPC（trace MALFORMED 行「打开所在目录」）', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  it('绝对路径 → shell.showItemInFolder 放行并返回 true', async () => {
    const reveal = handlers.get('reveal-in-folder')!
    const result = await reveal({}, '/data/agent/sessions/s1.jsonl')
    expect(result).toBe(true)
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith('/data/agent/sessions/s1.jsonl')
  })

  it('相对路径 → 拒绝（返回 false）且不触 shell', async () => {
    const reveal = handlers.get('reveal-in-folder')!
    const result = await reveal({}, 'sessions/s1.jsonl')
    expect(result).toBe(false)
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled()
  })

  it('非 string 输入（IPC 边界无类型保障）→ 拒绝不抛', async () => {
    const reveal = handlers.get('reveal-in-folder')!
    expect(await reveal({}, undefined)).toBe(false)
    expect(await reveal({}, 42)).toBe(false)
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled()
  })

  it('shell 抛异常 → console.error 降级返回 false（open-external 同风格）', async () => {
    shellMock.showItemInFolder.mockImplementationOnce(() => {
      throw new Error('shell crash')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reveal = handlers.get('reveal-in-folder')!
      const result = await reveal({}, '/data/agent/sessions/s1.jsonl')
      expect(result).toBe(false)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})
