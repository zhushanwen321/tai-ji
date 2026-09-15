import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractHashFragment,
  formatAge,
  toCandidate,
  provideHashCandidates,
  createHashAutocompleteProvider,
  type AutocompleteCandidate,
} from '../tui/hash-provider.js'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import type { AutocompleteProvider } from '@earendil-works/pi-tui'

/**
 * TUI 层纯逻辑单测（design §3.3 D-3/D-4 + 2026-08-10 重构）。
 *
 * 测三层：
 * 1. extractHashFragment：# 片段提取 + token 边界
 * 2. toCandidate / formatAge：SessionInfo → 候选转换 + 单单位时间
 * 3. provideHashCandidates：端到端（真实 tmpdir 造 session 文件，SessionManager.listAll 真跑，不 mock）
 *
 * insertText 方案：完整 uuid（# + 36 字符），findSessions 子串匹配零碰撞。
 */

// ---- fixture helper（造真实 pi session 文件，让 listAll 真实解析）----

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
      message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
    })
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, opts.fileName), lines.map((o) => JSON.stringify(o)).join('\n') + '\n')
}

/** 造 SessionInfo 对象（toCandidate 纯函数测试用，不经 listAll）。 */
function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: '/fake/019e6c96.jsonl',
    id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
    cwd: '/demo',
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date('2026-01-01T00:00:00.000Z'),
    messageCount: 14,
    firstMessage: '修复登录 bug',
    allMessagesText: '',
    ...overrides,
  }
}

// ---- extractHashFragment ----

describe('extractHashFragment', () => {
  it('行首 # + hex 片段', () => {
    expect(extractHashFragment('#e6c96')).toBe('e6c96')
  })

  it('空片段（刚输入 #）', () => {
    expect(extractHashFragment('#')).toBe('')
  })

  it('# 前是空格（token 边界）→ 命中', () => {
    expect(extractHashFragment('see #e6c9')).toBe('e6c9')
  })

  it('# 前是单词字符（foo#bar）→ null（防 hashtag 误触发）', () => {
    expect(extractHashFragment('foo#bar')).toBeNull()
  })

  it('非 # 前缀（纯文本）→ null', () => {
    expect(extractHashFragment('hello world')).toBeNull()
  })

  it('/ 命令前缀 → null（委托命令 provider）', () => {
    expect(extractHashFragment('/session-pick')).toBeNull()
  })

  it('@ 文件前缀 → null（委托文件 provider）', () => {
    expect(extractHashFragment('@path/to')).toBeNull()
  })

  it('片段含连字符（完整 uuid 片段）', () => {
    expect(extractHashFragment('#019e6c96-aaaa')).toBe('019e6c96-aaaa')
  })

  it('# 后跟非 hex 字符（#hello）→ null（非 uuid 片段，委托下家 provider）', () => {
    expect(extractHashFragment('#hello')).toBeNull()
    expect(extractHashFragment('#bug')).toBeNull()
  })
})

// ---- formatAge（单单位，对齐 /resume formatSessionDate）----

describe('formatAge', () => {
  const now = new Date('2026-01-15T12:00:00Z').getTime()

  it('< 1 分钟 → now', () => {
    expect(formatAge(now - 30_000, now)).toBe('now')
  })

  it('< 1 小时 → XXm（2位补零）', () => {
    expect(formatAge(now - 5 * 60_000, now)).toBe('05m')
    expect(formatAge(now - 59 * 60_000, now)).toBe('59m')
  })

  it('< 1 天 → XXh', () => {
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('03h')
    expect(formatAge(now - 23 * 3_600_000, now)).toBe('23h')
  })

  it('< 7 天 → XXd', () => {
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('02d')
  })

  it('< 30 天 → XXw', () => {
    expect(formatAge(now - 14 * 86_400_000, now)).toBe('02w')
  })

  it('< 365 天 → XXM（月单位 M，单字符与分钟 m 区分）', () => {
    expect(formatAge(now - 60 * 86_400_000, now)).toBe('02M')
  })

  it('≥ 365 天 → XXy', () => {
    expect(formatAge(now - 400 * 86_400_000, now)).toBe('01y')
  })

  it('接收 Date 对象（SessionInfo.modified 是 Date）', () => {
    expect(formatAge(new Date(now - 2 * 3_600_000), now)).toBe('02h')
  })

  it('未来时间（时钟偏移）→ now', () => {
    expect(formatAge(now + 10_000, now)).toBe('now')
  })

  it('固定等宽：除 now 外都是 3 字符（XXu，2位数字+1位单位，design G4 对齐）', () => {
    // 各档位抽样，都应 3 字符
    expect(formatAge(now - 90 * 60_000, now)).toBe('01h') // 90分=1h，补零
    expect(formatAge(now - 5 * 60_000, now).length).toBe(3)
    expect(formatAge(now - 3 * 3_600_000, now).length).toBe(3)
    expect(formatAge(now - 2 * 86_400_000, now).length).toBe(3)
    expect(formatAge(now - 60 * 86_400_000, now).length).toBe(3)
    expect(formatAge(now - 400 * 86_400_000, now).length).toBe(3)
    expect(formatAge(now - 30_000, now)).toBe('now') // now 也是 3 字符
  })
})

// ---- toCandidate（SessionInfo → AutocompleteCandidate）----

describe('toCandidate', () => {
  it('insertText = # + 完整 sessionId（36 字符 uuid，design D-3）', () => {
    const c = toCandidate(makeSessionInfo())
    expect(c.insertText).toBe('#019e6c96-0a0c-74b8-a73f-d1854d88e2a7')
    // 完整 uuid = 36 字符，加 # 前缀 = 37
    expect(c.insertText).toHaveLength(37)
  })

  it('label = `${age} ${预览}`（时间最左 + 1 空格 + 预览；不设 description 触发满宽分支）', () => {
    const c = toCandidate(
      makeSessionInfo({ firstMessage: '修复登录 bug', messageCount: 14 }),
      new Date('2026-01-01T13:00:00Z').getTime(),
    )
    // modified=2026-01-01T00:00, now=13:00 → 13h
    expect(c.label).toBe('13h 修复登录 bug')
    // description 未设（undefined）——触发 SelectList 满宽 label 分支，绕过主列固定32
    expect(c.description).toBeUndefined()
  })

  it('有 name → label 放 name 不放 firstMessage（design G3）', () => {
    const c = toCandidate(
      makeSessionInfo({ name: 'my-session', firstMessage: '首条消息内容', messageCount: 5 }),
      new Date('2026-01-01T01:00:00Z').getTime(),
    )
    expect(c.label).toBe('01h my-session')
    expect(c.label).not.toContain('首条消息内容')
  })

  it('firstMessage 超长 → 截断到 PREVIEW_MAX（避免传超大字符串给 pi-tui）', () => {
    const longText = 'X'.repeat(500)
    const c = toCandidate(makeSessionInfo({ firstMessage: longText }), new Date('2026-01-01T01:00:00Z').getTime())
    // label = age(3) + 空格(1) + 截断text(100+…)
    expect(c.label).toMatch(/^01h X{100}…$/)
  })

  it('label 不含 uuid、不含 count（用户反馈：不显示 uuid、不显示 count）', () => {
    const c = toCandidate(makeSessionInfo({ messageCount: 999 }))
    expect(c.label).not.toContain('019e6c96')
    expect(c.label).not.toContain('999')
  })

  it('firstMessage 含换行/控制符 → 清洗为单空格（避免破坏 SelectList 单行渲染）', () => {
    const c = toCandidate(makeSessionInfo({ firstMessage: '第一行\n第二行\t缩进' }))
    expect(c.label).not.toContain('\n')
    expect(c.label).not.toContain('\t')
    expect(c.label).toContain('第一行 第二行 缩进')
  })

  it('无 name 且无 firstMessage → 标 (无预览)', () => {
    const c = toCandidate(makeSessionInfo({ name: undefined, firstMessage: '' }))
    expect(c.label).toContain('(无预览)')
  })
})

// ---- provideHashCandidates（端到端，真实 tmpdir，listAll 真跑不 mock）----
// fixture：agentDir/sessions/<cwdA|cwdB>/ 结构（模拟真实 pi 布局）。
// listAll(cwdSessionDir) 扫单 cwd；insertText 始终完整 uuid（findSessions 子串匹配零碰撞）。

describe('provideHashCandidates', () => {
  let agentDir: string
  let cwdSessionDir: string
  let otherCwdDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'hash-test-'))
    cwdSessionDir = join(agentDir, 'sessions', 'cwdA')
    otherCwdDir = join(agentDir, 'sessions', 'cwdB')
    await mkdir(cwdSessionDir, { recursive: true })
    await mkdir(otherCwdDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('非 # 输入 → null（委托下家 provider）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7', cwd: '/demo' })
    const result = await provideHashCandidates('hello world', cwdSessionDir)
    expect(result).toBeNull()
  })

  it('# 空片段 → recent 候选（当前目录全部 session），insertText 完整 uuid', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7', cwd: '/demo' })
    await makeSession(cwdSessionDir, { fileName: 'b.jsonl', id: '019fffff-1111-2222-3333-444455556666', cwd: '/demo' })
    const result = await provideHashCandidates('#', cwdSessionDir)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(2)
    // insertText 完整 uuid（# + 36 字符 = 37）
    expect(result!.every((c) => c.insertText.length === 37 && c.insertText.startsWith('#'))).toBe(true)
  })

  it('#e6c9 片段 → id 子串过滤', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7',
      cwd: '/demo',
      firstUserText: '修复登录 bug',
    })
    await makeSession(cwdSessionDir, {
      fileName: 'b.jsonl',
      id: '019fffff-1111-2222-3333-444455556666',
      cwd: '/demo',
      firstUserText: '无关内容',
    })
    const result = await provideHashCandidates('#e6c9', cwdSessionDir)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(1)
    expect(result![0].insertText).toBe('#019e6c96-0a0c-74b8-a73f-d1854d88e2a7')
    // label = age+预览（不含 uuid、不含 count）；description 未设
    expect(result![0].label).not.toContain('019e6c96')
    expect(result![0].label).toContain('修复登录 bug')
    expect(result![0].description).toBeUndefined()
  })

  it('insertText 格式 #完整 uuid（8-4-4-4-12）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7', cwd: '/demo' })
    const result = await provideHashCandidates('#019e', cwdSessionDir)
    expect(result).not.toBeNull()
    const c = result![0] as AutocompleteCandidate
    expect(c.insertText).toMatch(/^#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(c.insertText).toBe('#019e6c96-0a0c-74b8-a73f-d1854d88e2a7')
  })

  it('# 片段无匹配 → 空数组（不抛）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7', cwd: '/demo' })
    const result = await provideHashCandidates('#deadbeef', cwdSessionDir)
    expect(result).not.toBeNull()
    expect(result).toEqual([])
  })

  it('limit 限制返回数量', async () => {
    for (let i = 0; i < 5; i++) {
      await makeSession(cwdSessionDir, {
        fileName: `f${i}.jsonl`,
        id: `019e6c9${i}-0000-0000-0000-00000000000${i}`,
        cwd: '/demo',
      })
    }
    const result = await provideHashCandidates('#019e6c9', cwdSessionDir, { limit: 2 })
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(2)
  })

  it('空 cwdSessionDir → 返回空数组，不调 listAll（避免全盘扫描卡死）', async () => {
    const result = await provideHashCandidates('#abc', '')
    expect(result).toEqual([])
  })

  it('visible 只扫当前 cwd 目录（design G1）', async () => {
    // cwdA（当前）有 1 个
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-0a0c-74b8-a73f-d1854d88e2a7', cwd: '/demo' })
    // otherCwdDir（其他 cwd）放一个不同前缀的，listAll(cwdA) 不扫它
    await makeSession(otherCwdDir, { fileName: 'other.jsonl', id: '019fffff-1111-2222-3333-444455556666', cwd: '/other' })
    const result = await provideHashCandidates('#', cwdSessionDir)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(1)
    expect(result![0].insertText).toBe('#019e6c96-0a0c-74b8-a73f-d1854d88e2a7')
  })

  it('有 name 的 session → label 含 name 不含 firstMessage（design G3）', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'named.jsonl',
      id: '019fffff-1111-2222-3333-444455556666',
      cwd: '/demo',
      name: 'my-named-session',
      firstUserText: '首条消息内容',
    })
    const result = await provideHashCandidates('#019f', cwdSessionDir)
    expect(result!).toHaveLength(1)
    expect(result![0].label).toContain('my-named-session')
    expect(result![0].label).not.toContain('首条消息内容')
  })
})

// ---- createHashAutocompleteProvider（wrapper 层，MF-8：此前零测试）----
// fake current provider + fake signal，断言委托/不委托/早退；applyCompletion 前缀替换手术。

const FULL_UUID = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'

function makeFakeCurrent(): {
  current: AutocompleteProvider
  getSuggestions: ReturnType<typeof vi.fn>
  applyCompletion: ReturnType<typeof vi.fn>
} {
  const getSuggestions = vi.fn()
  const applyCompletion = vi.fn()
  const current = {
    getSuggestions,
    applyCompletion,
  } as unknown as AutocompleteProvider
  return { current, getSuggestions, applyCompletion }
}

function makeOptions(): { signal: AbortSignal; force?: boolean } {
  return { signal: new AbortController().signal }
}

describe('createHashAutocompleteProvider - getSuggestions', () => {
  let agentDir: string
  let cwdSessionDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'hash-provider-wrapper-'))
    cwdSessionDir = join(agentDir, 'sessions', 'cwdA')
    await mkdir(cwdSessionDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('signal.aborted → 早退返 null，不调 current、不做 IO', async () => {
    const { current, getSuggestions } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => cwdSessionDir, current)
    const aborted = new AbortController()
    aborted.abort()
    const result = await provider.getSuggestions(['hello #e6c9'], 0, 11, {
      signal: aborted.signal,
    })
    expect(result).toBeNull()
    expect(getSuggestions).not.toHaveBeenCalled()
  })

  it('非 # 前缀 → 显式委托 current.getSuggestions（同参数透传）', async () => {
    const { current, getSuggestions } = makeFakeCurrent()
    getSuggestions.mockResolvedValue(null)
    const provider = createHashAutocompleteProvider(() => cwdSessionDir, current)
    const options = makeOptions()
    const lines = ['@path/to/fi']
    const result = await provider.getSuggestions(lines, 0, 12, options)
    expect(result).toBeNull()
    expect(getSuggestions).toHaveBeenCalledTimes(1)
    expect(getSuggestions.mock.calls[0]).toEqual([lines, 0, 12, options])
  })

  it('# 前缀有匹配 → 返回 items + prefix=#fragment，不委托 current', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: FULL_UUID,
      cwd: '/demo',
      firstUserText: '修复登录 bug',
    })
    const { current, getSuggestions } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => cwdSessionDir, current)
    const result = await provider.getSuggestions(['hello #e6c9'], 0, 11, makeOptions())
    expect(result).not.toBeNull()
    expect(result!.prefix).toBe('#e6c9')
    expect(result!.items).toHaveLength(1)
    expect(result!.items[0].value).toBe(`#${FULL_UUID}`) // 完整 uuid insertText
    expect(result!.items[0].label).toContain('修复登录 bug')
    expect(getSuggestions).not.toHaveBeenCalled()
  })

  it('# 前缀无匹配 → return null 且不委托 current（避免 current 把 #xxx 当路径返回文件建议）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: FULL_UUID, cwd: '/demo' })
    const { current, getSuggestions } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => cwdSessionDir, current)
    const result = await provider.getSuggestions(['see #deadbeef'], 0, 13, makeOptions())
    expect(result).toBeNull()
    expect(getSuggestions).not.toHaveBeenCalled()
  })

  it('空 cwdSessionDir → # 前缀返 null（不调 listAll 全盘分支，防卡死）', async () => {
    const { current, getSuggestions } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => '', current)
    const result = await provider.getSuggestions(['#'], 0, 1, makeOptions())
    expect(result).toBeNull()
    expect(getSuggestions).not.toHaveBeenCalled()
  })
})

describe('createHashAutocompleteProvider - applyCompletion', () => {
  it('前缀替换手术：光标前保留 + item.value + 光标后保留，行尾自动补空格，cursor 前移', () => {
    const { current, applyCompletion } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => '', current)
    const lines = ['hello #e6c9']
    // 'hello ' = 6 字符，'#e6c9' = 5 字符 → cursor 在 11
    const out = provider.applyCompletion(lines, 0, 11, { value: `#${FULL_UUID}`, label: 'x' }, '#e6c9')
    // 行尾选中：补一个尾随空格，用户直接打字即产生间隔
    expect(out.lines[0]).toBe(`hello #${FULL_UUID} `)
    expect(out.cursorLine).toBe(0)
    // cursor 停在补的空格之后
    expect(out.cursorCol).toBe(6 + `#${FULL_UUID}`.length + 1)
  })

  it('光标后有内容且已以空白开头：替换只影响 # 片段区间，不重复补空格', () => {
    const { current } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => '', current)
    const lines = ['before #e6c9 after']
    // 'before ' = 7，'#e6c9' = 5 → cursor 12，尾部 ' after' 保留
    const out = provider.applyCompletion(lines, 0, 12, { value: `#${FULL_UUID}`, label: 'x' }, '#e6c9')
    expect(out.lines[0]).toBe(`before #${FULL_UUID} after`)
    expect(out.cursorCol).toBe(7 + `#${FULL_UUID}`.length)
  })

  it('光标后紧贴非空白内容：补一个空格与后续内容隔开', () => {
    const { current } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => '', current)
    const lines = ['before #e6c9after']
    // 'before ' = 7，'#e6c9' = 5 → cursor 12，尾部 'after' 紧贴
    const out = provider.applyCompletion(lines, 0, 12, { value: `#${FULL_UUID}`, label: 'x' }, '#e6c9')
    expect(out.lines[0]).toBe(`before #${FULL_UUID} after`)
    expect(out.cursorCol).toBe(7 + `#${FULL_UUID}`.length + 1)
  })

  it('CJK 多字节内容：按 JS 字符串长度（code unit）计算区间与 cursor，不切坏字符', () => {
    const { current } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => '', current)
    const lines = ['你好 #e6c9']
    // '你好 ' = 3 个 code unit，'#e6c9' = 5 → cursor 8
    const out = provider.applyCompletion(lines, 0, 8, { value: `#${FULL_UUID}`, label: 'x' }, '#e6c9')
    expect(out.lines[0]).toBe(`你好 #${FULL_UUID} `)
    expect(out.cursorCol).toBe(3 + `#${FULL_UUID}`.length + 1)
    // 替换后无孤立代理对（CJK 未被切半）
    expect(out.lines[0].length).toBe(3 + `#${FULL_UUID}`.length + 1)
  })

  it('非本 provider 的 item（value 不以 # 开头）→ 委托 current.applyCompletion', () => {
    const { current, applyCompletion } = makeFakeCurrent()
    const provider = createHashAutocompleteProvider(() => '', current)
    const lines = ['@file.txt']
    applyCompletion.mockReturnValue({ lines, cursorLine: 0, cursorCol: 5 })
    const out = provider.applyCompletion(lines, 0, 5, { value: '/path/file.txt', label: 'file' }, '@file.txt')
    expect(applyCompletion).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ lines, cursorLine: 0, cursorCol: 5 })
  })
})
