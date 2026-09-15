/**
 * transport/api/domains 六域薄封装单测（chat / composer / config / extension / file / git）。
 *
 * 域函数 = 「command 原语 + reply 解包」或「events 订阅路由」的薄封装，本测试验证封装契约：
 * - RPC：type / payload 形状（含条件键省略，如 send 无 images 时不带 images 键）、超时取值
 *   （compact/bash 引用 shared 常量 + RENDERER_RPC_MARGIN_MS）、reply 字段解包返回
 * - 订阅：onGlobalType/on 的事件类型 + payload 解包 + sessionId 过滤守卫 + 取消函数透传
 *
 * mock 链路：request.command / events.on|onGlobalType / ws-client.send（extension.ui_response
 * fire-and-forget）。mock 路径相对测试文件解析（../../request = transport/api/request.ts），
 * 与 domains/*.ts 内部 import '../request' 解析到同一模块 ID 才能拦截。
 *
 * 运行：cd packages/core && npx vitest run src/transport/api/__tests__/domains.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCommand = vi.fn<(type: string, payload: unknown, timeoutMs?: number) => Promise<Record<string, unknown>>>()
vi.mock('../request', () => ({
  command: (type: string, payload: unknown, timeoutMs?: number) => mockCommand(type, payload, timeoutMs),
}))

/** events mock：捕获 handler 供测试手动派发消息（模拟 server-push） */
const mockOn = vi.fn<(sessionId: string, handler: (msg: unknown) => void) => () => void>()
const mockOnGlobalType = vi.fn<(type: string, handler: (msg: { payload: unknown }) => void) => () => void>()
vi.mock('../events', () => ({
  on: (sessionId: string, handler: (msg: unknown) => void) => mockOn(sessionId, handler),
  onGlobalType: (type: string, handler: (msg: { payload: unknown }) => void) => mockOnGlobalType(type, handler),
}))

const mockWsSend = vi.fn<(msg: unknown) => boolean>()
vi.mock('../../ws-client', () => ({
  send: (msg: unknown) => mockWsSend(msg),
}))

import * as chat from '../domains/chat'
import * as composer from '../domains/composer'
import * as config from '../domains/config'
import * as extension from '../domains/extension'
import * as file from '../domains/file'
import * as git from '../domains/git'
import * as model from '../domains/model'
import * as plugin from '../domains/plugin'
import * as preset from '../domains/preset'
import * as project from '../domains/project'
import * as quota from '../domains/quota'
import * as session from '../domains/session'
import * as settings from '../domains/settings'
import * as terminal from '../domains/terminal'
import * as usage from '../domains/usage'
import * as workspace from '../domains/workspace'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'

beforeEach(() => {
  vi.clearAllMocks()
  mockCommand.mockImplementation(async () => ({}))
})

// ── chat 域 ────────────────────────────────────────────────────────────────
describe('chat 域 RPC 封装', () => {
  it('getHistory 解包 messages + [u4d] 窗口契约字段透传（[u6] legacy historyTruncated 退役）', async () => {
    mockCommand.mockResolvedValue({
      messages: [{ id: 'm1' }],
      truncated: true,
      loadedTurns: 20,
      totalTurnsEstimate: 42,
    })
    const r = await chat.getHistory('s1')
    expect(mockCommand).toHaveBeenCalledWith('session.history', { sessionId: 's1' }, RPC_BACKSTOP_TIMEOUT_MS)
    expect(r).toEqual({ messages: [{ id: 'm1' }], truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
  })

  it('[u6] getHistory 游标翻页：query 透传（cursor/limitTurns/maxBytes，缺省键不带）', async () => {
    mockCommand.mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    await chat.getHistory('s1', { cursor: 'entry-9' })
    expect(mockCommand).toHaveBeenLastCalledWith('session.history', { sessionId: 's1', cursor: 'entry-9' }, RPC_BACKSTOP_TIMEOUT_MS)
    await chat.getHistory('s1', { cursor: 'entry-9', limitTurns: 5, maxBytes: 1024 })
    expect(mockCommand).toHaveBeenLastCalledWith('session.history', { sessionId: 's1', cursor: 'entry-9', limitTurns: 5, maxBytes: 1024 }, RPC_BACKSTOP_TIMEOUT_MS)
    await chat.getHistory('s1')
    expect(mockCommand).toHaveBeenLastCalledWith('session.history', { sessionId: 's1' }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('send 无 images 时 payload 不带 images 键', async () => {
    await chat.send('s1', 'hi')
    const [type, payload] = mockCommand.mock.calls[0]
    expect(type).toBe('message.send')
    expect(payload).toEqual({ sessionId: 's1', content: 'hi' })
  })

  it('send 带 images 时透传 images 数组', async () => {
    const images = [{ data: 'abc', mimeType: 'image/png' }]
    await chat.send('s1', 'hi', images)
    expect(mockCommand.mock.calls[0][1]).toEqual({ sessionId: 's1', content: 'hi', images })
  })

  it('steer / followUp / abort 走对应 type', async () => {
    await chat.steer('s1', 't')
    expect(mockCommand.mock.calls[0]).toEqual(['message.steer', { sessionId: 's1', content: 't' }, RPC_BACKSTOP_TIMEOUT_MS])
    await chat.followUp('s1', 't')
    expect(mockCommand.mock.calls[1][0]).toBe('message.follow_up')
    await chat.abort('s1')
    expect(mockCommand.mock.calls[2]).toEqual(['message.abort', { sessionId: 's1' }, RPC_BACKSTOP_TIMEOUT_MS])
  })

  it('compact 超时 = COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS（校准链不变量）', async () => {
    await chat.compact('s1', 'instr')
    const [type, payload, timeout] = mockCommand.mock.calls[0]
    expect(type).toBe('session.compact')
    expect(payload).toEqual({ sessionId: 's1', customInstructions: 'instr' })
    expect(timeout).toBeGreaterThan(RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('bash：excludeFromContext 未传时不带该键，传了透传；超时用 BASH 档', async () => {
    await chat.bash('s1', 'ls')
    expect(mockCommand.mock.calls[0][1]).toEqual({ sessionId: 's1', command: 'ls' })
    await chat.bash('s1', 'ls', true)
    expect(mockCommand.mock.calls[1][1]).toEqual({ sessionId: 's1', command: 'ls', excludeFromContext: true })
    expect(mockCommand.mock.calls[1][2]).toBeGreaterThan(RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('abortBash 走 message.abortBash', async () => {
    await chat.abortBash('s1')
    expect(mockCommand.mock.calls[0][0]).toBe('message.abortBash')
  })

  it('streamSubscribe 经 events.on 注册并返回其取消函数', () => {
    const off = vi.fn()
    mockOn.mockReturnValue(off)
    const handler = vi.fn()

    const unsub = chat.streamSubscribe('s1', handler)

    expect(mockOn).toHaveBeenCalledWith('s1', expect.any(Function))
    // 派发一条消息 → handler 收到透传
    const registered = mockOn.mock.calls[0][1]
    const msg = { type: 'message.text_delta', payload: { text: 'x' } }
    registered(msg)
    expect(handler).toHaveBeenCalledWith(msg)
    expect(unsub).toBe(off)
  })
})

// ── composer 域 ────────────────────────────────────────────────────────────
describe('composer 域', () => {
  it('getFileCandidates 走 file.search 并解包 files', async () => {
    mockCommand.mockResolvedValue({ files: [{ path: 'a.ts' }] })
    const r = await composer.getFileCandidates('s1')
    expect(mockCommand).toHaveBeenCalledWith('file.search', { sessionId: 's1' }, RPC_BACKSTOP_TIMEOUT_MS)
    expect(r).toEqual([{ path: 'a.ts' }])
  })

  it('getMentionCandidates 已废弃：恒返回空数组（零 RPC）', async () => {
    await expect(composer.getMentionCandidates()).resolves.toEqual([])
    expect(mockCommand).not.toHaveBeenCalled()
  })
})

// ── file 域 ────────────────────────────────────────────────────────────────
describe('file 域', () => {
  it('tree / expand 解包 reply 字段', async () => {
    mockCommand.mockResolvedValueOnce({ tree: [{ path: 'src' }] })
    await expect(file.tree('s1')).resolves.toEqual([{ path: 'src' }])
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['file.tree', { sessionId: 's1' }])

    mockCommand.mockResolvedValueOnce({ children: [{ path: 'src/a.ts' }] })
    await expect(file.expand('s1', 'src')).resolves.toEqual([{ path: 'src/a.ts' }])
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['file.tree.expand', { sessionId: 's1', path: 'src' }])
  })

  it('read 带 sessionId 时透传；不带时（白名单模式）省略 sessionId 键', async () => {
    mockCommand.mockResolvedValue({ content: 'x', truncated: true })
    await expect(file.read('/abs/skill.md', 's1')).resolves.toEqual({ content: 'x', truncated: true })
    expect(mockCommand.mock.calls[0][1]).toEqual({ path: '/abs/skill.md', sessionId: 's1' })

    await file.read('/abs/skill.md')
    expect(mockCommand.mock.calls[1][1]).toEqual({ path: '/abs/skill.md' })
  })
})

// ── git 域 ─────────────────────────────────────────────────────────────────
describe('git 域', () => {
  it('status / getDiff 解包', async () => {
    mockCommand.mockResolvedValueOnce({ isRepo: true, changes: [] })
    await expect(git.status('s1')).resolves.toEqual({ isRepo: true, changes: [] })

    mockCommand.mockResolvedValueOnce({ patch: 'diff', binary: false })
    await expect(git.getDiff('s1', 'a.ts')).resolves.toEqual({ patch: 'diff', binary: false })
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['git.diff', { sessionId: 's1', path: 'a.ts' }])
  })

  it('stage / unstage 透传可选 filePaths；commit 空 message 归一为空串', async () => {
    await git.stage('s1', ['a.ts'])
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['git.stage', { sessionId: 's1', filePaths: ['a.ts'] }])
    await git.unstage('s1')
    expect(mockCommand.mock.calls[1][1]).toEqual({ sessionId: 's1', filePaths: undefined })
    await git.commit('s1')
    expect(mockCommand.mock.calls[2][1]).toEqual({ sessionId: 's1', message: '' })
  })

  it('checkout / checkoutByCwd / createBranch 走对应 type', async () => {
    await git.checkout('s1', 'dev')
    expect(mockCommand.mock.calls[0][0]).toBe('git.checkout')
    await git.checkoutByCwd('/repo', 'dev')
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['git.checkoutCwd', { cwd: '/repo', name: 'dev' }])
    await git.createBranch('s1', 'feat')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['git.createBranch', { sessionId: 's1', name: 'feat' }])
  })
})

// ── extension 域 ───────────────────────────────────────────────────────────
describe('extension 域 RPC 动作', () => {
  it('toggle/install/uninstall/upgrade/setAutoUpgrade 透传 payload', async () => {
    await extension.toggle('pkg-a', false)
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['extension.toggle', { name: 'pkg-a', enabled: false }])
    await extension.install('@scope/pkg')
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['extension.install', { source: '@scope/pkg' }])
    await extension.uninstall('pkg-a')
    expect(mockCommand.mock.calls[2][0]).toBe('extension.uninstall')
    await extension.upgrade('pkg-a')
    expect(mockCommand.mock.calls[3].slice(0, 2)).toEqual(['extension.upgrade', { name: 'pkg-a' }])
    await extension.setAutoUpgrade('pkg-a', true)
    expect(mockCommand.mock.calls[4].slice(0, 2)).toEqual(['extension.setAutoUpgrade', { name: 'pkg-a', autoUpgrade: true }])
  })

  it('installDir/installGit/finishInstall/cancelInstall 多步安装流', async () => {
    await extension.installDir('/tmp/dir')
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['extension.installDir', { path: '/tmp/dir' }])
    await extension.installGitRepository('https://git')
    expect(mockCommand.mock.calls[1][0]).toBe('extension.installGit')
    await extension.finishInstall('/tmp/t', ['cand'])
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['extension.finishInstall', { tempDir: '/tmp/t', selected: ['cand'] }])
    await extension.cancelInstall('/tmp/t')
    expect(mockCommand.mock.calls[3].slice(0, 2)).toEqual(['extension.cancelInstall', { tempDir: '/tmp/t' }])
  })

  it('fetchRecommended / scan 解包与零断言', async () => {
    mockCommand.mockResolvedValueOnce({ recommended: [{ id: 'r', installed: false }] })
    await expect(extension.fetchRecommended()).resolves.toEqual([{ id: 'r', installed: false }])
    mockCommand.mockResolvedValueOnce({})
    await expect(extension.scan()).resolves.toBeUndefined()
    expect(mockCommand.mock.calls[1][0]).toBe('extension.list')
  })

  it('getPendingRequests 按类型守卫过滤非法条目', async () => {
    mockCommand.mockResolvedValueOnce({
      requests: [
        { requestId: 'ok1', method: 'confirm', sessionId: 's1' },
        null,
        'bad',
        { requestId: 1, method: 'confirm' },
        { requestId: 'no-method' },
      ],
    })
    const r = await extension.getPendingRequests('s1')
    expect(r).toEqual([{ requestId: 'ok1', method: 'confirm', sessionId: 's1' }])
  })

  it('onExtensions 经 onGlobalType(config.extensions) 解包 extensions', () => {
    const off = vi.fn()
    mockOnGlobalType.mockReturnValue(off)
    const handler = vi.fn()

    const unsub = extension.onExtensions(handler)

    expect(mockOnGlobalType).toHaveBeenCalledWith('config.extensions', expect.any(Function))
    mockOnGlobalType.mock.calls[0][1]({ payload: { extensions: [{ name: 'x' }] } })
    expect(handler).toHaveBeenCalledWith([{ name: 'x' }])
    expect(unsub).toBe(off)
  })

  it('onUIRequest：命中本 session 的 ui_request 派发，异 session / 异 type 忽略', () => {
    mockOn.mockReturnValue(vi.fn())
    const handler = vi.fn()
    extension.onUIRequest('s1', handler)

    const registered = mockOn.mock.calls[0][1]
    const req = { sessionId: 's1', requestId: 'r1', method: 'confirm' }
    registered({ type: 'extension.ui_request', payload: req })
    expect(handler).toHaveBeenCalledWith(req)

    registered({ type: 'extension.ui_request', payload: { sessionId: 'other', requestId: 'r2', method: 'input' } })
    registered({ type: 'message.text_delta', payload: { sessionId: 's1' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('onUITimeout：命中派发 requestId，异 session 忽略', () => {
    mockOn.mockReturnValue(vi.fn())
    const handler = vi.fn()
    extension.onUITimeout('s1', handler)

    const registered = mockOn.mock.calls[0][1]
    registered({ type: 'extension.ui_timeout', payload: { sessionId: 's1', requestId: 'req-9' } })
    expect(handler).toHaveBeenCalledWith('req-9')
    registered({ type: 'extension.ui_timeout', payload: { sessionId: 'other', requestId: 'x' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('onNotify：解包 message/level，异 session / 异 type 忽略', () => {
    mockOn.mockReturnValue(vi.fn())
    const handler = vi.fn()
    extension.onNotify('s1', handler)

    const registered = mockOn.mock.calls[0][1]
    registered({ type: 'extension:notify', payload: { sessionId: 's1', message: 'hi', level: 'warn' } })
    expect(handler).toHaveBeenCalledWith({ message: 'hi', level: 'warn' })
    registered({ type: 'extension:notify', payload: { sessionId: 'other', message: 'x', level: 'info' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('sendExtensionUIResponse 经 ws send fire-and-forget', () => {
    mockWsSend.mockReturnValue(true)
    extension.sendExtensionUIResponse('s1', 'r1', 'select', 'opt-1')
    expect(mockWsSend).toHaveBeenCalledWith({
      type: 'extension.ui_response',
      payload: { sessionId: 's1', requestId: 'r1', method: 'select', result: 'opt-1' },
    })
  })
})

// ── model 域 ───────────────────────────────────────────────────────────────
describe('model 域', () => {
  it('onModels 经 onGlobalType(model.list) 解包 models', () => {
    const off = vi.fn()
    mockOnGlobalType.mockReturnValue(off)
    const handler = vi.fn()

    const unsub = model.onModels(handler)

    expect(mockOnGlobalType).toHaveBeenCalledWith('model.list', expect.any(Function))
    mockOnGlobalType.mock.calls[0][1]({ payload: { models: [{ id: 'm' }] } })
    expect(handler).toHaveBeenCalledWith([{ id: 'm' }])
    expect(unsub).toBe(off)
  })

  it('listModels 请求-响应兜底解包 models', async () => {
    mockCommand.mockResolvedValueOnce({ models: [{ id: 'm1' }] })
    await expect(model.listModels()).resolves.toEqual([{ id: 'm1' }])
    expect(mockCommand).toHaveBeenCalledWith('model.list', {}, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('switchModel 透传 sessionId/provider/modelId 并原样返回回执', async () => {
    const reply = { sessionId: 's1', provider: 'p', modelId: 'm' }
    mockCommand.mockResolvedValueOnce(reply)
    await expect(model.switchModel('s1', 'p' as never, 'm')).resolves.toEqual(reply)
    expect(mockCommand).toHaveBeenCalledWith('model.switch', { sessionId: 's1', provider: 'p', modelId: 'm' }, RPC_BACKSTOP_TIMEOUT_MS)
  })
})

// ── plugin 域 ──────────────────────────────────────────────────────────────
describe('plugin 域', () => {
  it('onPlugins 经 onGlobalType(config.plugins) 解包 plugins', () => {
    const off = vi.fn()
    mockOnGlobalType.mockReturnValue(off)
    const handler = vi.fn()

    const unsub = plugin.onPlugins(handler)

    expect(mockOnGlobalType).toHaveBeenCalledWith('config.plugins', expect.any(Function))
    mockOnGlobalType.mock.calls[0][1]({ payload: { plugins: [{ id: 'pl' }] } })
    expect(handler).toHaveBeenCalledWith([{ id: 'pl' }])
    expect(unsub).toBe(off)
  })

  it('approvePermissions / revokePermissions 透传并丢弃 reply', async () => {
    mockCommand.mockResolvedValue({ plugins: [] })
    await expect(plugin.approvePermissions('pl', ['fs.read'])).resolves.toBeUndefined()
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['plugin.approvePermissions', { pluginId: 'pl', permissions: ['fs.read'] }])
    await expect(plugin.revokePermissions('pl')).resolves.toBeUndefined()
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['plugin.revokePermissions', { pluginId: 'pl' }])
  })
})

// ── preset 域 ──────────────────────────────────────────────────────────────
describe('preset 域', () => {
  it('list / getDefault / setDefault 契约', async () => {
    mockCommand.mockResolvedValueOnce({ presets: [{ id: 'builtin:full' }] })
    await expect(preset.list()).resolves.toEqual([{ id: 'builtin:full' }])
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['preset.list', {}])

    mockCommand.mockResolvedValueOnce({ presetId: 'builtin:full' })
    await expect(preset.getDefault()).resolves.toBe('builtin:full')
    expect(mockCommand.mock.calls[1][0]).toBe('preset.getDefault')

    await preset.setDefault('custom-1')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['preset.setDefault', { presetId: 'custom-1' }])
  })

  it('create / update 解包 .preset；remove 为 ack', async () => {
    const p = { id: 'c1', name: 'C' } as never
    mockCommand.mockResolvedValueOnce({ preset: { id: 'c1', order: 1 } })
    await expect(preset.create(p)).resolves.toEqual({ id: 'c1', order: 1 })
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['preset.create', { preset: p }])

    mockCommand.mockResolvedValueOnce({ preset: { id: 'c1' } })
    await expect(preset.update(p)).resolves.toEqual({ id: 'c1' })
    expect(mockCommand.mock.calls[1][0]).toBe('preset.update')

    await preset.remove('c1')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['preset.delete', { presetId: 'c1' }])
  })
})

// ── project 域 ─────────────────────────────────────────────────────────────
describe('project 域', () => {
  it('load 全量拉取 / save 全量写入', async () => {
    const state = { projects: [{ id: 'pj' }] } as never
    mockCommand.mockResolvedValueOnce(state)
    await expect(project.load()).resolves.toEqual(state)
    expect(mockCommand).toHaveBeenCalledWith('project.load', {}, RPC_BACKSTOP_TIMEOUT_MS)

    await expect(project.save(state)).resolves.toBeUndefined()
    expect(mockCommand).toHaveBeenCalledWith('project.save', state, RPC_BACKSTOP_TIMEOUT_MS)
  })
})

// ── quota 域 ───────────────────────────────────────────────────────────────
describe('quota 域', () => {
  const RESULT = { data: { label: 'X' }, lastFetchAt: 123 }

  it('getCached / fetchQuota / refreshQuota 统一解包 QuotaResult', async () => {
    mockCommand.mockResolvedValueOnce({ ...RESULT, reason: 'cookie_expired' })
    await expect(quota.getCached('p')).resolves.toEqual({ ...RESULT, reason: 'cookie_expired' })
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['quota.getCached', { providerId: 'p' }])

    mockCommand.mockResolvedValueOnce({ data: null, lastFetchAt: null, reason: 'not_configured' })
    await expect(quota.fetchQuota('p')).resolves.toEqual({ data: null, lastFetchAt: null, reason: 'not_configured' })
    expect(mockCommand.mock.calls[1][0]).toBe('quota.fetch')

    mockCommand.mockResolvedValueOnce(RESULT)
    await expect(quota.refreshQuota('p')).resolves.toEqual({ ...RESULT, reason: undefined })
    expect(mockCommand.mock.calls[2][0]).toBe('quota.refresh')
  })

  it('configure 透传全量字段并解包 ok/error', async () => {
    mockCommand.mockResolvedValueOnce({ ok: true })
    await expect(
      quota.configure({ providerId: 'p', enabled: true, cookie: 'ck', fetcher: 'fetcher', apiKey: 'key', workspace: 'ws1' }),
    ).resolves.toEqual({ ok: true, error: undefined })
    expect(mockCommand.mock.calls[0][1]).toEqual({ providerId: 'p', enabled: true, cookie: 'ck', fetcher: 'fetcher', apiKey: 'key', workspace: 'ws1' })
  })
})

// ── session 域 ─────────────────────────────────────────────────────────────
describe('session 域 请求-响应', () => {
  it('list 解包 groups；create 可选键省略 + 透传', async () => {
    mockCommand.mockResolvedValueOnce({ groups: [{ cwd: '/a' }] })
    await expect(session.list()).resolves.toEqual([{ cwd: '/a' }])
    expect(mockCommand).toHaveBeenCalledWith('config.sessions', {}, RPC_BACKSTOP_TIMEOUT_MS)

    // 仅 cwd：其余可选键全部省略
    mockCommand.mockResolvedValueOnce({ session: { id: 's1' } })
    await expect(session.create('/a')).resolves.toEqual({ id: 's1' })
    expect(mockCommand.mock.calls[1][1]).toEqual({ cwd: '/a' })

    // 全量参数透传
    mockCommand.mockResolvedValueOnce({ session: { id: 's2' } })
    await session.create('/a', 'L', 'preset-1', 'pj', 'p/m', 'high')
    expect(mockCommand.mock.calls[2][1]).toEqual({ cwd: '/a', label: 'L', presetId: 'preset-1', projectId: 'pj', modelOverride: 'p/m', thinkingOverride: 'high' })
  })

  it('switchSession / restoreSession / forceQuit / fork', async () => {
    await session.switchSession('s1')
    expect(mockCommand.mock.calls[0][0]).toBe('session.switch')

    mockCommand.mockResolvedValueOnce({ session: { id: 's1' } })
    await expect(session.restoreSession('s1')).resolves.toEqual({ id: 's1' })
    expect(mockCommand.mock.calls[1][0]).toBe('session.restore')

    await session.forceQuit('s1')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['session.forceQuit', { sessionId: 's1' }])

    mockCommand.mockResolvedValueOnce({ session: { id: 's9' } })
    await expect(session.fork('s1', { piEntryId: 'e1', includeFrom: true, modelOverride: 'p/m' })).resolves.toEqual({ id: 's9' })
    expect(mockCommand.mock.calls[3][1]).toEqual({
      srcSessionId: 's1', fromPiEntryId: 'e1', fromMessageTimestamp: undefined, fromMessageRole: undefined,
      includeFrom: true, label: undefined, modelOverride: 'p/m', thinkingOverride: undefined,
    })
  })

  it('getCommands / getContext / rename / setProject / remove / removeByCwd', async () => {
    mockCommand.mockResolvedValue({ })
    await session.getCommands('s1')
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['session.getCommands', { sessionId: 's1' }])
    await session.getContext('s1')
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['session.getContext', { sessionId: 's1' }])
    await session.rename('s1', 'L')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['session.rename', { sessionId: 's1', name: 'L' }])
    await session.setProject('s1', 'pj')
    expect(mockCommand.mock.calls[3].slice(0, 2)).toEqual(['session.setProject', { sessionId: 's1', projectId: 'pj' }])
    await session.remove('s1')
    expect(mockCommand.mock.calls[4][0]).toBe('session.delete')
    await session.removeByCwd('/a')
    expect(mockCommand.mock.calls[5].slice(0, 2)).toEqual(['session.deleteByCwd', { cwd: '/a' }])
  })

  it('setThinkingLevel / getSubagents / getSubagentHistory / 引擎配置', async () => {
    mockCommand.mockResolvedValueOnce({ sessionId: 's1', level: 'max' })
    await expect(session.setThinkingLevel('s1', 'max')).resolves.toEqual({ sessionId: 's1', level: 'max' })
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['session.setThinkingLevel', { sessionId: 's1', level: 'max' }])

    mockCommand.mockResolvedValueOnce({ subagents: [{ id: 'sa' }] })
    await expect(session.getSubagents('s1')).resolves.toEqual([{ id: 'sa' }])
    expect(mockCommand.mock.calls[1][0]).toBe('session.getSubagents')

    mockCommand.mockResolvedValueOnce({ messages: [{ id: 'm' }] })
    await expect(session.getSubagentHistory('s1', 'sa')).resolves.toEqual([{ id: 'm' }])
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['session.getSubagentHistory', { sessionId: 's1', subagentId: 'sa' }])

    const eng = { engines: ['zcode'], defaultEngine: 'zcode' }
    mockCommand.mockResolvedValueOnce(eng)
    await expect(session.getSubagentEngineConfig()).resolves.toEqual(eng)
    expect(mockCommand.mock.calls[3][0]).toBe('session.getSubagentEngineConfig')

    mockCommand.mockResolvedValueOnce({ engineId: 'zcode' })
    await expect(session.setSubagentDefaultEngine('zcode')).resolves.toEqual({ engineId: 'zcode' })
    expect(mockCommand.mock.calls[4][0]).toBe('session.setSubagentDefaultEngine')
  })

  it('workflow 派生：getWorkflows / getAgentCallHistory / getAgentCallFilePath / workflowAction / subagentAction', async () => {
    mockCommand.mockResolvedValueOnce({ workflows: [{ runId: 'r1' }] })
    await expect(session.getWorkflows('s1')).resolves.toEqual([{ runId: 'r1' }])
    expect(mockCommand.mock.calls[0][0]).toBe('session.getWorkflows')

    mockCommand.mockResolvedValueOnce({ messages: [] })
    await session.getAgentCallHistory('s1', 'ac1')
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['session.getAgentCallHistory', { sessionId: 's1', agentCallSessionId: 'ac1' }])

    mockCommand.mockResolvedValueOnce({ filePath: '/p.jsonl' })
    await expect(session.getAgentCallFilePath('s1', 'ac1')).resolves.toBe('/p.jsonl')
    expect(mockCommand.mock.calls[2][0]).toBe('session.getAgentCallFilePath')

    await session.workflowAction('s1', 'pause', 'r1')
    expect(mockCommand.mock.calls[3].slice(0, 2)).toEqual(['session.workflowAction', { sessionId: 's1', action: 'pause', runId: 'r1' }])

    await session.subagentAction('s1', 'message', { subagentId: 'sa', text: 'hi' })
    expect(mockCommand.mock.calls[4][1]).toEqual({ sessionId: 's1', action: 'message', subagentId: 'sa', text: 'hi' })
  })

  it('handoff 用 660s 超时；abortHandoff 用 backstop', async () => {
    await session.handoff('s1', 'reply-1', { modelOverride: 'p/m' })
    expect(mockCommand.mock.calls[0]).toEqual(['session.handoff', {
      sessionId: 's1', reply: 'reply-1', modelOverride: 'p/m', thinkingOverride: undefined,
    }, 660_000])

    await session.abortHandoff('s1')
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['session.abortHandoff', { sessionId: 's1' }])
    expect(mockCommand.mock.calls[1][2]).toBe(RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('subscribe / unsubscribe', async () => {
    const sub = { snapshot: [], stateSnapshot: [], lastSeq: 7, gap: false }
    mockCommand.mockResolvedValueOnce(sub)
    await expect(session.subscribe('s1', 3)).resolves.toEqual(sub)
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['session.subscribe', { sessionId: 's1', fromSeq: 3 }])

    await session.unsubscribe('s1')
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['session.unsubscribe', { sessionId: 's1' }])
  })

  it('图片持久化与 segments sidecar 写', async () => {
    const imgPayload = { sessionId: 's1', base64: 'b64', mimeType: 'image/png', name: 'n.png' }
    const imgReply = { path: '/p', fileName: 'n.png', displayName: 'n.png', id: 'i1', persisted: true }
    mockCommand.mockResolvedValueOnce(imgReply)
    await expect(session.writeImage(imgPayload)).resolves.toEqual(imgReply)
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['session.writeImage', imgPayload])

    mockCommand.mockResolvedValueOnce({ path: '/p2' })
    await expect(session.migrateImage({ fromPath: '/f', sessionId: 's1', fileName: 'n.png' })).resolves.toEqual({ path: '/p2' })
    expect(mockCommand.mock.calls[1][0]).toBe('session.migrateImage')

    await expect(session.writeSegments({ sessionId: 's1', entry: { id: 'e' } as never })).resolves.toBeUndefined()
    expect(mockCommand.mock.calls[2][0]).toBe('session.writeSegments')
  })

  it('trace / system prompt / 导入', async () => {
    const traceReply = { source: 'rpc', entries: [] }
    mockCommand.mockResolvedValueOnce(traceReply)
    await expect(session.getTraceEntries('s1')).resolves.toEqual(traceReply)
    expect(mockCommand.mock.calls[0][0]).toBe('session.getTraceEntries')

    const promptReply = { prompt: 'sp' }
    mockCommand.mockResolvedValueOnce(promptReply)
    await expect(session.fetchCurrentSystemPrompt('s1')).resolves.toEqual(promptReply)
    expect(mockCommand.mock.calls[1][0]).toBe('session.fetchCurrentSystemPrompt')

    const candReply = { candidates: [] }
    mockCommand.mockResolvedValueOnce(candReply)
    await expect(session.importCandidates({ query: 'x' } as never)).resolves.toEqual(candReply)
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['session.importCandidates', { query: 'x' }])

    const impReply = { sessionId: 's2' }
    mockCommand.mockResolvedValueOnce(impReply)
    await expect(session.importSession({ sourcePath: '/s' } as never)).resolves.toEqual(impReply)
    expect(mockCommand.mock.calls[3].slice(0, 2)).toEqual(['session.import', { sourcePath: '/s' }])
  })
})

// ── settings 域（transport 转发 + worktree 等配置 RPC）────────────────────
describe('settings 域', () => {
  it('订阅与请求转发与源域同引用', () => {
    expect(settings.onProviders).toBe(config.onProviders)
    expect(settings.onSkills).toBe(config.onSkills)
    expect(settings.onAgents).toBe(config.onAgents)
    expect(settings.onExtensions).toBe(extension.onExtensions)
    expect(settings.onDefaults).toBe(config.onDefaults)
    expect(settings.listProviders).toBe(config.listProviders)
    expect(settings.setProvider).toBe(config.setProvider)
  })

  it('worktree 配置 get/set 走 config.* type', async () => {
    mockCommand.mockResolvedValue({ dir: '/wt' })
    await settings.setWorktreeRootDir('/wt')
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['config.setWorktreeRootDir', { dir: '/wt' }])
    await settings.getWorktreeRootDir()
    expect(mockCommand.mock.calls[1][0]).toBe('config.getWorktreeRootDir')

    await settings.setSetupScript('s.sh')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['config.setSetupScript', { script: 's.sh' }])
    await settings.getSetupScript()
    expect(mockCommand.mock.calls[3][0]).toBe('config.getSetupScript')

    await settings.setBareSetupScript('b.sh')
    expect(mockCommand.mock.calls[4][0]).toBe('config.setBareSetupScript')
    await settings.getBareSetupScript()
    expect(mockCommand.mock.calls[5][0]).toBe('config.getBareSetupScript')

    mockCommand.mockResolvedValue({ timeout: 60 })
    await settings.setWorktreeTimeout(60)
    expect(mockCommand.mock.calls[6].slice(0, 2)).toEqual(['config.setTimeout', { timeout: 60 }])
    await settings.getWorktreeTimeout()
    expect(mockCommand.mock.calls[7][0]).toBe('config.getTimeout')
  })

  it('行为配置：streamingIdleTimeout / defaultBaseBranch / autoRename / renameModel / renameMode', async () => {
    mockCommand.mockResolvedValue({ timeout: 1800 })
    await settings.setStreamingIdleTimeout(1800)
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['config.setStreamingIdleTimeout', { timeout: 1800 }])
    await settings.getStreamingIdleTimeout()
    expect(mockCommand.mock.calls[1][0]).toBe('config.getStreamingIdleTimeout')

    await settings.setDefaultBaseBranch('main')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['config.setDefaultBaseBranch', { baseBranch: 'main' }])
    await settings.getDefaultBaseBranch()
    expect(mockCommand.mock.calls[3][0]).toBe('config.getDefaultBaseBranch')

    await settings.setAutoRenameEnabled(true)
    expect(mockCommand.mock.calls[4].slice(0, 2)).toEqual(['config.setAutoRenameEnabled', { enabled: true }])
    await settings.getAutoRenameEnabled()
    expect(mockCommand.mock.calls[5][0]).toBe('config.getAutoRenameEnabled')

    await settings.setRenameModel('p/m')
    expect(mockCommand.mock.calls[6].slice(0, 2)).toEqual(['config.setRenameModel', { model: 'p/m' }])
    await settings.getRenameModel()
    expect(mockCommand.mock.calls[7][0]).toBe('config.getRenameModel')

    await settings.setRenameMode('first-prompt')
    expect(mockCommand.mock.calls[8].slice(0, 2)).toEqual(['config.setRenameMode', { mode: 'first-prompt' }])
    await settings.getRenameMode()
    expect(mockCommand.mock.calls[9][0]).toBe('config.getRenameMode')
  })

  it('smart-context 配置组', async () => {
    mockCommand.mockResolvedValue({ compactModel: '', thresholds: [] })
    await settings.getSmartContextConfig()
    expect(mockCommand.mock.calls[0][0]).toBe('config.getSmartContextConfig')

    await settings.setSmartContextEnabled(true)
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['config.setSmartContextEnabled', { enabled: true }])
    await settings.setSmartContextCompactModel('p/m')
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['config.setSmartContextCompactModel', { model: 'p/m' }])
    await settings.setSmartContextThresholds([1, 2, 3])
    expect(mockCommand.mock.calls[3].slice(0, 2)).toEqual(['config.setSmartContextThresholds', { thresholds: [1, 2, 3] }])
    await settings.setSmartContextExcludedModels(['p/m'])
    expect(mockCommand.mock.calls[4].slice(0, 2)).toEqual(['config.setSmartContextExcludedModels', { models: ['p/m'] }])
  })
})

// ── terminal 域 ────────────────────────────────────────────────────────────
describe('terminal 域', () => {
  it('spawn/write/resize/kill/attach 五命令', async () => {
    mockCommand.mockResolvedValue({})
    const params = { sessionId: 's1', cwd: '/a' } as never
    await terminal.terminalApi.spawn(params)
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['terminal.spawn', params])
    await terminal.terminalApi.write('s1', 'ls\n')
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['terminal.write', { sessionId: 's1', data: 'ls\n' }])
    await terminal.terminalApi.resize('s1', 80, 24)
    expect(mockCommand.mock.calls[2].slice(0, 2)).toEqual(['terminal.resize', { sessionId: 's1', cols: 80, rows: 24 }])
    await terminal.terminalApi.kill('s1')
    expect(mockCommand.mock.calls[3].slice(0, 2)).toEqual(['terminal.kill', { sessionId: 's1' }])
    await terminal.terminalApi.attach('s1')
    expect(mockCommand.mock.calls[4].slice(0, 2)).toEqual(['terminal.attach', { sessionId: 's1' }])
  })
})

// ── usage 域 ───────────────────────────────────────────────────────────────
describe('usage 域', () => {
  it('getUsageStats 原样返回 reply', async () => {
    const reply = { rows: [], scannedAt: 1, sessionCount: 0, skippedLines: 0 }
    mockCommand.mockResolvedValueOnce(reply)
    await expect(usage.getUsageStats()).resolves.toEqual(reply)
    expect(mockCommand).toHaveBeenCalledWith('usage.getStats', {}, RPC_BACKSTOP_TIMEOUT_MS)
  })
})

// ── workspace 域 ───────────────────────────────────────────────────────────
describe('workspace 域', () => {
  it('listRecent / record 解包 records', async () => {
    mockCommand.mockResolvedValueOnce({ records: [{ cwd: '/a' }] })
    await expect(workspace.listRecent()).resolves.toEqual([{ cwd: '/a' }])
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['workspace.listRecent', {}])

    mockCommand.mockResolvedValueOnce({ records: [{ cwd: '/b' }] })
    await expect(workspace.record('/b')).resolves.toEqual([{ cwd: '/b' }])
    expect(mockCommand.mock.calls[1].slice(0, 2)).toEqual(['workspace.record', { cwd: '/b' }])
  })

  it('detect 三态透传；detectBare 映射 isBare', async () => {
    const bareReply = { mode: 'bare-workspace', wsRoot: '/ws', barePath: '/bare', repoRoot: '', defaultBranch: 'main' }
    mockCommand.mockResolvedValueOnce(bareReply)
    await expect(workspace.detect('/ws/proj')).resolves.toEqual(bareReply)
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['workspace.detect', { cwd: '/ws/proj' }])

    mockCommand.mockResolvedValueOnce(bareReply)
    await expect(workspace.detectBare('/ws/proj')).resolves.toEqual({ isBare: true, wsRoot: '/ws', barePath: '/bare' })

    mockCommand.mockResolvedValueOnce({ mode: 'plain-repo', wsRoot: '', barePath: '', repoRoot: '/r', defaultBranch: 'main' })
    await expect(workspace.detectBare('/r')).resolves.toMatchObject({ isBare: false })
  })
})

// ── config 域 ──────────────────────────────────────────────────────────────
describe('config 域 请求-响应', () => {
  it('provider 相关：listProviders 解包 + scopedModels 透传', async () => {
    mockCommand.mockResolvedValueOnce({ providers: [{ id: 'p' }], scopedModels: ['m1'] })
    await expect(config.listProviders()).resolves.toEqual({ providers: [{ id: 'p' }], scopedModels: ['m1'] })

    mockCommand.mockResolvedValueOnce({ refreshed: ['a'], failed: [{ providerId: 'b', reason: 'x' }] })
    await expect(config.refreshProviderCatalogs()).resolves.toEqual({ refreshed: ['a'], failed: [{ providerId: 'b', reason: 'x' }] })

    mockCommand.mockResolvedValueOnce({ providers: [{ id: 'p' }] })
    await expect(config.listProviders()).resolves.toEqual({ providers: [{ id: 'p' }], scopedModels: undefined })
  })

  it('skill/agent 扫描与检测：解包数组', async () => {
    mockCommand.mockResolvedValueOnce({ skills: [{ id: 'sk' }] })
    await expect(config.scanSkills(['/dir'])).resolves.toEqual([{ id: 'sk' }])
    mockCommand.mockResolvedValueOnce({ skills: [{ id: 'g' }] })
    await expect(config.getGlobalSkills()).resolves.toEqual([{ id: 'g' }])
    mockCommand.mockResolvedValueOnce({ skills: [{ id: 'pj' }] })
    await expect(config.getProjectSkills('/cwd')).resolves.toEqual([{ id: 'pj' }])
    mockCommand.mockResolvedValueOnce({ skills: [{ id: 'ss' }] })
    await expect(config.scanSessionSkills('/cwd')).resolves.toEqual([{ id: 'ss' }])
    mockCommand.mockResolvedValueOnce({ agents: [{ id: 'ag' }] })
    await expect(config.scanAgents(['/dir'])).resolves.toEqual([{ id: 'ag' }])
    mockCommand.mockResolvedValueOnce({ sources: [{ source: 'claude' }] })
    await expect(config.detectSources()).resolves.toEqual([{ source: 'claude' }])
  })

  it('内置模板与导入：listBuiltinProviders / preview / apply', async () => {
    mockCommand.mockResolvedValueOnce({ providers: [{ id: 'b' }] })
    await expect(config.listBuiltinProviders()).resolves.toEqual([{ id: 'b' }])

    const errReply = { error: { code: 'parse', message: 'bad' } }
    mockCommand.mockResolvedValueOnce(errReply)
    await expect(config.previewImportProviders('claude')).resolves.toEqual(errReply)

    const okReply = { result: { imported: 2 } }
    mockCommand.mockResolvedValueOnce(okReply)
    await expect(config.applyImportProviders('imp-1', ['a'])).resolves.toEqual(okReply)
  })

  it('discoverModels 原样透传 req', async () => {
    mockCommand.mockResolvedValueOnce({ models: [], success: false, error: 'e' })
    const r = await config.discoverModels({ baseUrl: 'https://x', apiKey: 'k' })
    expect(mockCommand.mock.calls[0].slice(0, 2)).toEqual(['config.discoverModels', { baseUrl: 'https://x', apiKey: 'k' }])
    expect(r).toEqual({ models: [], success: false, error: 'e' })
  })

  it('system prompt / terminal / retry 配置：get/set + corrupted 缺省 false', async () => {
    mockCommand.mockResolvedValueOnce({ config: { enabled: true } })
    await expect(config.getSystemPrompt()).resolves.toEqual({ config: { enabled: true }, corrupted: false })
    mockCommand.mockResolvedValueOnce({ config: { enabled: false }, corrupted: true })
    await expect(config.setSystemPrompt({ enabled: false } as never)).resolves.toEqual({ config: { enabled: false }, corrupted: true })

    mockCommand.mockResolvedValueOnce({ config: { shell: 'zsh' } })
    await expect(config.getTerminalConfig()).resolves.toEqual({ config: { shell: 'zsh' }, corrupted: false })
    mockCommand.mockResolvedValueOnce({ config: { shell: 'zsh' }, corrupted: true })
    await expect(config.setTerminalConfig({ shell: 'zsh' } as never)).resolves.toEqual({ config: { shell: 'zsh' }, corrupted: true })

    const retry = { config: { maxRetries: 3 }, configured: true }
    mockCommand.mockResolvedValueOnce(retry)
    await expect(config.getRetryConfig()).resolves.toEqual(retry)
    mockCommand.mockResolvedValueOnce(retry)
    await expect(config.setRetryConfig({ maxRetries: 3 } as never)).resolves.toEqual(retry)
  })

  it('OAuth：login/cancel/logout/hasOAuth/checkEnvVars', async () => {
    mockCommand.mockResolvedValueOnce({ started: true })
    await expect(config.oauthLogin('p')).resolves.toEqual({ started: true })
    mockCommand.mockResolvedValueOnce({ cancelled: false })
    await expect(config.oauthCancel('p')).resolves.toEqual({ cancelled: false })
    mockCommand.mockResolvedValueOnce({ ok: true })
    await expect(config.oauthLogout('p')).resolves.toEqual({ ok: true })
    mockCommand.mockResolvedValueOnce({ hasOAuth: true })
    await expect(config.hasOAuth('p')).resolves.toBe(true)
    mockCommand.mockResolvedValueOnce({ results: { K: true } })
    await expect(config.checkEnvVars(['K'])).resolves.toEqual({ K: true })
  })
})

describe('config 域 动作-ack', () => {
  it('目录与 provider/skill/agent 写操作走对应 type', async () => {
    await config.setSkillDirs([])
    expect(mockCommand.mock.calls[0][0]).toBe('config.setSkillDirs')
    await config.setAgentDirs([])
    expect(mockCommand.mock.calls[1][0]).toBe('config.setAgentDirs')
    await config.setExtensionDirs([])
    expect(mockCommand.mock.calls[2][0]).toBe('config.setExtensionDirs')
    await config.setProvider('p1' as never, {} as never)
    expect(mockCommand.mock.calls[3][0]).toBe('config.setProvider')
    await config.setDefaultModel('p1' as never, 'm')
    expect(mockCommand.mock.calls[4].slice(0, 2)).toEqual(['config.setDefaultModel', { provider: 'p1', modelId: 'm' }])
    await config.deleteProvider('p1' as never)
    expect(mockCommand.mock.calls[5][0]).toBe('config.deleteProvider')
    await config.toggleProviderEnabled('p1' as never, true)
    expect(mockCommand.mock.calls[6][0]).toBe('config.toggleProviderEnabled')
    await config.removeProviderByKind('p1' as never, 'catalog')
    expect(mockCommand.mock.calls[7][0]).toBe('config.removeProviderByKind')
    await config.setSkill({ id: 'sk' } as never)
    expect(mockCommand.mock.calls[8][0]).toBe('config.setSkill')
    await config.deleteSkill('sk')
    expect(mockCommand.mock.calls[9][0]).toBe('config.deleteSkill')
    await config.setAgent({ id: 'ag' } as never)
    expect(mockCommand.mock.calls[10][0]).toBe('config.setAgent')
    await config.deleteAgent('ag')
    expect(mockCommand.mock.calls[11][0]).toBe('config.deleteAgent')
  })

  it('setScopedModels 解包规范化结果', async () => {
    mockCommand.mockResolvedValueOnce({ scopedModels: ['a', 'b'] })
    await expect(config.setScopedModels(['a', 'b'])).resolves.toEqual(['a', 'b'])
  })
})

describe('config 域 订阅（onGlobalType 通道）', () => {
  it('onProviders / onSkills / onAgents / onDefaults 解包 payload', () => {
    const subs: Array<[string, (msg: { payload: unknown }) => void]> = []
    mockOnGlobalType.mockImplementation((type, handler) => {
      subs.push([type, handler])
      return vi.fn()
    })
    const onProviders = vi.fn(); config.onProviders(onProviders)
    const onSkills = vi.fn(); config.onSkills(onSkills)
    const onAgents = vi.fn(); config.onAgents(onAgents)
    const onDefaults = vi.fn(); config.onDefaults(onDefaults)

    const byType = Object.fromEntries(subs)
    byType['config.providers']({ payload: { providers: [1], scopedModels: ['m'] } })
    expect(onProviders).toHaveBeenCalledWith([1], ['m'])
    byType['config.skills']({ payload: { skills: [2] } })
    expect(onSkills).toHaveBeenCalledWith([2])
    byType['config.agents']({ payload: { agents: [3] } })
    expect(onAgents).toHaveBeenCalledWith([3])
    byType['config.defaults']({ payload: { defaultModel: 'dm' } })
    expect(onDefaults).toHaveBeenCalledWith('dm')
  })

  it('onDefaultsWithSource / onSkillDirs / onAgentDirs / onExtensionDirs', () => {
    const subs: Array<[string, (msg: { payload: unknown }) => void]> = []
    mockOnGlobalType.mockImplementation((type, handler) => {
      subs.push([type, handler])
      return vi.fn()
    })
    const h1 = vi.fn(); config.onDefaultsWithSource(h1)
    const h2 = vi.fn(); config.onSkillDirs(h2)
    const h3 = vi.fn(); config.onAgentDirs(h3)
    const h4 = vi.fn(); config.onExtensionDirs(h4)

    const byType = Object.fromEntries(subs)
    byType['config.defaults']({ payload: { defaultModel: 'dm', source: 'provider-updated' } })
    expect(h1).toHaveBeenCalledWith({ defaultModel: 'dm', source: 'provider-updated' })
    byType['config.skillDirs']({ payload: { dirs: ['d1'] } })
    expect(h2).toHaveBeenCalledWith(['d1'])
    byType['config.agentDirs']({ payload: { dirs: ['d2'] } })
    expect(h3).toHaveBeenCalledWith(['d2'])
    byType['config.extensionDirs']({ payload: { dirs: ['d3'] } })
    expect(h4).toHaveBeenCalledWith(['d3'])
  })

  it('onSkillCacheInvalidated / onSystemPrompt / onTerminalConfig / onRetryConfig', () => {
    const subs: Array<[string, (msg: { payload: unknown }) => void]> = []
    mockOnGlobalType.mockImplementation((type, handler) => {
      subs.push([type, handler])
      return vi.fn()
    })
    const hInv = vi.fn(); config.onSkillCacheInvalidated(hInv)
    const hSp = vi.fn(); config.onSystemPrompt(hSp)
    const hTc = vi.fn(); config.onTerminalConfig(hTc)
    const hRc = vi.fn(); config.onRetryConfig(hRc)

    const byType = Object.fromEntries(subs)
    byType['config.skillCacheInvalidated']({ payload: { scope: 'project', cwd: '/c' } })
    expect(hInv).toHaveBeenCalledWith({ scope: 'project', cwd: '/c' })
    byType['config.systemPrompt']({ payload: { config: { enabled: true } } })
    expect(hSp).toHaveBeenCalledWith({ enabled: true }, false)
    byType['config.terminalConfig']({ payload: { config: { shell: 'zsh' }, corrupted: true } })
    expect(hTc).toHaveBeenCalledWith({ shell: 'zsh' }, true)
    byType['config.retryConfig']({ payload: { config: { maxRetries: 1 }, configured: false } })
    expect(hRc).toHaveBeenCalledWith({ config: { maxRetries: 1 }, configured: false })
  })

  it('OAuth 事件订阅：auth.deviceCode / authUrl / success / error', () => {
    const subs: Array<[string, (msg: { payload: unknown }) => void]> = []
    mockOnGlobalType.mockImplementation((type, handler) => {
      subs.push([type, handler])
      return vi.fn()
    })
    const h1 = vi.fn(); config.onAuthDeviceCode(h1)
    const h2 = vi.fn(); config.onAuthAuthUrl(h2)
    const h3 = vi.fn(); config.onAuthSuccess(h3)
    const h4 = vi.fn(); config.onAuthError(h4)

    const byType = Object.fromEntries(subs)
    byType['auth.deviceCode']({ payload: { userCode: '123' } })
    expect(h1).toHaveBeenCalledWith({ userCode: '123' })
    byType['auth.authUrl']({ payload: { url: 'u' } })
    expect(h2).toHaveBeenCalledWith({ url: 'u' })
    byType['auth.success']({ payload: { providerId: 'p' } })
    expect(h3).toHaveBeenCalledWith({ providerId: 'p' })
    byType['auth.error']({ payload: { error: 'expired' } })
    expect(h4).toHaveBeenCalledWith({ error: 'expired' })
  })
})
