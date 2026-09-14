import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCommand } from '../tui/session-command.js'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

/**
 * /session-pick 命令（src/tui/session-command.ts）单测（MF-7：此前零测试）。
 *
 * 真实 tmpdir 造 session 文件（SessionManager.listAll 真跑不 mock，同 hash-provider 惯例），
 * fake ctx（select/notify/setEditorText vi.fn）。覆盖：
 * - getArgumentCompletions：listAll + uuid 过滤 + 空返 null
 * - handler select 流程：选中插入 `#完整 uuid`、取消不插入、零匹配 notify warning
 * - MF-2 回归：同 cwd 同预览同 age 桶（label 原样重复）→ 短 uuid 后缀消歧，选中第 2 条插第 2 条 uuid
 */

async function makeSession(
  dir: string,
  opts: {
    fileName: string
    id: string
    cwd?: string
    name?: string
    firstUserText?: string
  },
): Promise<void> {
  const header: Record<string, unknown> = {
    type: 'session',
    version: 3,
    id: opts.id,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
  if (opts.cwd) header.cwd = opts.cwd
  const lines: unknown[] = [header]
  if (opts.name) {
    lines.push({ type: 'session_info', id: opts.id + '-info', name: opts.name })
  }
  if (opts.firstUserText) {
    lines.push({
      type: 'message',
      id: opts.id + '-m1',
      timestamp: '2026-01-01T01:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
    })
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, opts.fileName), lines.map((o) => JSON.stringify(o)).join('\n') + '\n')
}

/** fake ExtensionCommandContext（仅 handler 用到的 ui 三件套）。 */
function makeFakeCtx(): {
  ctx: ExtensionCommandContext
  select: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  setEditorText: ReturnType<typeof vi.fn>
} {
  const select = vi.fn()
  const notify = vi.fn()
  const setEditorText = vi.fn()
  const ctx = { ui: { select, notify, setEditorText } } as unknown as ExtensionCommandContext
  return { ctx, select, notify, setEditorText }
}

describe('createSessionCommand - getArgumentCompletions', () => {
  let agentDir: string
  let cwdSessionDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'session-command-test-'))
    cwdSessionDir = join(agentDir, 'sessions', 'cwdA')
    await mkdir(cwdSessionDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('空参数 → recent 列表（value=完整 uuid 剥 #，label 含预览）', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
      cwd: '/demo',
      firstUserText: '修复登录 bug',
    })
    const cmd = createSessionCommand(() => cwdSessionDir)
    const items = await cmd.getArgumentCompletions('')
    expect(items).not.toBeNull()
    expect(items!.length).toBe(1)
    expect(items![0].value).toBe('019e6c96-0a0c-74b8-a73f-d1854d88e2a7') // 完整 uuid，无 #
    expect(items![0].label).toContain('修复登录 bug')
  })

  it('uuid 片段过滤（与 # 弹窗一致）', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
      cwd: '/demo',
    })
    await makeSession(cwdSessionDir, {
      fileName: 'b.jsonl',
      id: '019fffff-1111-2222-3333-444455556666',
      cwd: '/demo',
    })
    const cmd = createSessionCommand(() => cwdSessionDir)
    const items = await cmd.getArgumentCompletions('e6c9')
    expect(items).not.toBeNull()
    expect(items!.length).toBe(1)
    expect(items![0].value).toBe('019e6c96-0a0c-74b8-a73f-d1854d88e2a7')
  })

  it('无匹配 → null', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
      cwd: '/demo',
    })
    const cmd = createSessionCommand(() => cwdSessionDir)
    expect(await cmd.getArgumentCompletions('deadbeef')).toBeNull()
  })

  it('空 getCwdSessionDir → 秒回 null，不调 listAll（A1：无 live session 上下文不触发全盘分支）', async () => {
    // mock 拦断言用：guard 失效误调 listAll('') 时 pi 会走真实全盘扫描（实测 3488 项 / ~8s），
    // mock 掉保证失败态也是秒级红灯
    const listAllSpy = vi.spyOn(SessionManager, 'listAll').mockResolvedValue([])
    const cmd = createSessionCommand(() => '')
    expect(await cmd.getArgumentCompletions('')).toBeNull()
    expect(listAllSpy).not.toHaveBeenCalled()
    listAllSpy.mockRestore()
  })
})

describe('createSessionCommand - handler select 流程', () => {
  let agentDir: string
  let cwdSessionDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'session-command-handler-'))
    cwdSessionDir = join(agentDir, 'sessions', 'cwdA')
    await mkdir(cwdSessionDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('选中 label → setEditorText(#完整 uuid + 尾随空格)（value 语义保持完整 uuid）', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
      cwd: '/demo',
      firstUserText: '修复登录 bug',
    })
    const cmd = createSessionCommand(() => cwdSessionDir)
    const { ctx, select, setEditorText } = makeFakeCtx()
    select.mockImplementation(async (_title: string, options: string[]) => options[0])
    await cmd.handler('', ctx)
    expect(select).toHaveBeenCalledTimes(1)
    expect(setEditorText).toHaveBeenCalledWith('#019e6c96-0a0c-74b8-a73f-d1854d88e2a7 ')
  })

  it('取消（select 返回 undefined）→ 不插入', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
      cwd: '/demo',
    })
    const cmd = createSessionCommand(() => cwdSessionDir)
    const { ctx, select, setEditorText } = makeFakeCtx()
    select.mockResolvedValue(undefined)
    await cmd.handler('', ctx)
    expect(select).toHaveBeenCalledTimes(1)
    expect(setEditorText).not.toHaveBeenCalled()
  })

  it('零匹配 → notify warning，不调 select', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
      cwd: '/demo',
    })
    const cmd = createSessionCommand(() => cwdSessionDir)
    const { ctx, select, notify, setEditorText } = makeFakeCtx()
    await cmd.handler('deadbeef', ctx)
    expect(notify).toHaveBeenCalledWith('未找到匹配的 session。', 'warning')
    expect(select).not.toHaveBeenCalled()
    expect(setEditorText).not.toHaveBeenCalled()
  })

  it('空 getCwdSessionDir → 按零匹配 notify，不调 listAll（A1：handler 侧同款空串 guard）', async () => {
    const listAllSpy = vi.spyOn(SessionManager, 'listAll').mockResolvedValue([])
    const cmd = createSessionCommand(() => '')
    const { ctx, select, notify, setEditorText } = makeFakeCtx()
    await cmd.handler('', ctx)
    expect(notify).toHaveBeenCalledWith('未找到匹配的 session。', 'warning')
    expect(select).not.toHaveBeenCalled()
    expect(setEditorText).not.toHaveBeenCalled()
    expect(listAllSpy).not.toHaveBeenCalled()
    listAllSpy.mockRestore()
  })

  it('MF-2 回归：同 cwd 同预览同 age 桶 → label 带短 uuid 后缀消歧，选第 2 条插第 2 条 uuid', async () => {
    // 两 session：相同首消息 + 相同 timestamp（同 age 桶）→ toCandidate label 完全相同
    const ID1 = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'
    const ID2 = '019fffff-1111-2222-3333-444455556666'
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: ID1, cwd: '/demo', firstUserText: '相同的首条消息' })
    await makeSession(cwdSessionDir, { fileName: 'b.jsonl', id: ID2, cwd: '/demo', firstUserText: '相同的首条消息' })

    const cmd = createSessionCommand(() => cwdSessionDir)
    const { ctx, select, setEditorText } = makeFakeCtx()
    // 用户选第 2 条（label 数组下标 1）
    select.mockImplementation(async (_title: string, options: string[]) => options[1])
    await cmd.handler('', ctx)

    // select 收到的 labels 必须两两不同（uuid 后缀消歧生效）
    const labelsArg = select.mock.calls[0][1] as string[]
    expect(labelsArg.length).toBe(2)
    expect(new Set(labelsArg).size).toBe(2)
    // 插入的是第 2 条 session 的完整 uuid（旧实现 indexOf(label) 会错插第 1 条）；尾随空格与 applyCompletion spacer 语义一致（S-2）
    expect(setEditorText).toHaveBeenCalledWith(`#${ID2} `)
  })
})
