import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSessionRead, type SessionReadParams } from '../tool-handler.js'
import { extractFinalAssistantText } from '../result-action.js'

/**
 * U6 result action 测试（design subagent-sync-collect §3.1.3 + impl-plan U6）。
 *
 * 覆盖（任务验收用例清单）：
 * 1. 单 id 取回正文与预期一致（sa-id manifest 反查，同源语义：无包装纯正文）
 * 2. 批量 ≤10（3 id，头行 + 分隔 + 顺序保持）
 * 3. 批量 >10 拒绝（文案含上限 10）
 * 4. limit 截断 + 尾提示（默认 8000 + 显式 limit）
 * 5. 不存在 id 报错（sa-id / uuid 片段两路）
 * 6. 空 assistant 报错（文件无 assistant 消息）
 * 7. 文件尚未 flush 报错（manifest 有、sessionFile 不存在——pi 延迟写入）
 *
 * 红线：vitest；fixture 全部 mkdtemp(tmpdir) 自建自删，零真实数据目录触碰。
 * extractFinalAssistantText 纯函数白盒：同源重建规则锁定（与 record.result 逐字节
 * 一致的前置，A4 取回门）。
 */

// ---- fixture 工具（合成 subagent session，同 tool-handler.test.ts makeFixtureSubagent 结构）----

const SLUG = '--demo-cwd--'

interface SubagentFixture {
  saId: string
  realId: string
  /** header + user 任务之后追加的 entries（assistant 消息等） */
  entries?: unknown[]
  /** false = 只写 manifest 不写 session 文件（模拟 pi 延迟写入未 flush / GC） */
  sessionFileExists?: boolean
}

function assistantEntry(id: string, content: unknown): unknown {
  return {
    type: 'message',
    id,
    parentId: 'p',
    message: { role: 'assistant', content },
  }
}

async function makeSubagent(dir: string, f: SubagentFixture): Promise<string> {
  const sessionFile = join(dir, 'subagents', SLUG, 'sessions', `${f.realId}.jsonl`)
  if (f.sessionFileExists !== false) {
    await mkdir(join(dir, 'subagents', SLUG, 'sessions'), { recursive: true })
    const header = JSON.stringify({ type: 'session', id: f.realId, cwd: '/demo' })
    const task = JSON.stringify({
      type: 'message',
      id: `${f.realId}-u1`,
      parentId: f.realId,
      message: { role: 'user', content: [{ type: 'text', text: 'do the task' }] },
    })
    const lines = [header, task, ...(f.entries ?? []).map((e) => JSON.stringify(e))]
    await writeFile(sessionFile, lines.join('\n') + '\n')
  }
  const recordsDir = join(dir, 'subagents', SLUG, 'records')
  await mkdir(recordsDir, { recursive: true })
  await writeFile(
    join(recordsDir, `${f.saId}.json`),
    JSON.stringify({
      id: f.saId,
      rootSessionId: 'root-session-1',
      agentName: 'explorer',
      sessionFile,
    }),
  )
  return sessionFile
}

// ---- extractFinalAssistantText 纯函数白盒（同源重建规则） ----

describe('extractFinalAssistantText（同源语义白盒）', () => {
  it('message 内多 text 块无分隔拼接（text_delta 直累积同构）；thinking/toolCall 排除', () => {
    const text = extractFinalAssistantText([
      assistantEntry('a1', [
        { type: 'thinking', thinking: 'should not appear' },
        { type: 'text', text: 'AB' },
        { type: 'text', text: 'CD' },
        { type: 'toolCall', toolCallId: 'tc1', name: 'bash' },
      ]),
    ])
    expect(text).toBe('ABCD')
  })

  it('跨 assistant message 非空过滤 join("\\n\\n")（getFullText 同构）；字符串 content 直取', () => {
    const text = extractFinalAssistantText([
      assistantEntry('a1', [{ type: 'text', text: 'first' }]),
      assistantEntry('a2', []), // 空 content → 过滤
      assistantEntry('a3', 'plain string content'), // 字符串形态
    ])
    expect(text).toBe('first\n\nplain string content')
  })

  it('只取最后一条 user message 之后的 assistant 文本（多轮 session 对齐最终一轮）', () => {
    const text = extractFinalAssistantText([
      assistantEntry('r1', [{ type: 'text', text: 'round one' }]),
      { type: 'message', id: 'u2', parentId: 'x', message: { role: 'user', content: [{ type: 'text', text: 'next round' }] } },
      assistantEntry('r2', [{ type: 'text', text: 'round two' }]),
    ])
    expect(text).toBe('round two')
  })

  it('无 user message 时计入全部 assistant（防御形态）', () => {
    const text = extractFinalAssistantText([
      assistantEntry('a1', [{ type: 'text', text: 'solo' }]),
    ])
    expect(text).toBe('solo')
  })

  it('空 entries → 空串（空 assistant 报错路径的判定基础）', () => {
    expect(extractFinalAssistantText([])).toBe('')
  })
})

// ---- result action 黑盒（fixture：sa-id manifest 反查主路径） ----

describe('result action（U6）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-reader-result-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('1. 单 id：返回纯正文（无包装），details 带元数据（sessionId=header 真实 id）', async () => {
    const realId = '019e6c96-dddd-eeee-ffff-000000000001'
    await makeSubagent(dir, {
      saId: 'sa-one',
      realId,
      entries: [
        assistantEntry(`${realId}-a1`, [
          { type: 'thinking', thinking: 'quiet thinking' },
          { type: 'text', text: 'FINAL RESULT' },
          { type: 'toolCall', toolCallId: 'tc1', name: 'read' },
        ]),
        {
          type: 'message',
          id: `${realId}-t1`,
          parentId: `${realId}-a1`,
          message: { role: 'toolResult', content: [{ type: 'text', text: 'file body' }], toolName: 'read', toolCallId: 'tc1' },
        },
        assistantEntry(`${realId}-a2`, [{ type: 'text', text: 'second part' }]),
      ],
    })
    const r = await handleSessionRead({ action: 'result', session: 'sa-one' }, { agentDir: dir })
    // 与 record.result 同源：全部 assistant 正文非空过滤 '\n\n' join，无任何包装
    expect(r.content[0]?.text).toBe('FINAL RESULT\n\nsecond part')
    const d = r.details as {
      session: string
      sessionId: string
      sessionFile: string
      totalChars: number
      truncated: boolean
    }
    expect(d.session).toBe('sa-one')
    expect(d.sessionId).toBe(realId) // header 真实 id，非 sa- 占位
    expect(d.sessionFile).toContain(realId)
    expect(d.totalChars).toBe('FINAL RESULT\n\nsecond part'.length)
    expect(d.truncated).toBe(false)
  })

  it('2. 批量 ≤10：3 id 各带头行与正文，"---" 分隔，顺序与输入一致', async () => {
    const ids = [
      { saId: 'sa-b1', realId: '019e6c96-0000-0000-0000-000000000b01', text: 'alpha result' },
      { saId: 'sa-b2', realId: '019e6c96-0000-0000-0000-000000000b02', text: 'beta result' },
      { saId: 'sa-b3', realId: '019e6c96-0000-0000-0000-000000000b03', text: 'gamma result' },
    ]
    for (const f of ids) {
      await makeSubagent(dir, {
        saId: f.saId,
        realId: f.realId,
        entries: [assistantEntry(`${f.realId}-a1`, [{ type: 'text', text: f.text }])],
      })
    }
    const r = await handleSessionRead(
      { action: 'result', session: 'sa-b1,sa-b2,sa-b3' },
      { agentDir: dir },
    )
    const text = r.content[0]?.text ?? ''
    expect(text).toContain('[1/3] sa-b1')
    expect(text).toContain('[2/3] sa-b2')
    expect(text).toContain('[3/3] sa-b3')
    expect(text).toContain('alpha result')
    expect(text).toContain('beta result')
    expect(text).toContain('gamma result')
    // 顺序保持：alpha 头行位于 beta 头行之前
    expect(text.indexOf('[1/3]')).toBeLessThan(text.indexOf('[2/3]'))
    expect(text.indexOf('[2/3]')).toBeLessThan(text.indexOf('[3/3]'))
    // 条目分隔（与批通知同款）
    expect(text).toContain('\n\n---\n\n')
    const d = r.details as { count: number; items: Array<{ session: string; truncated: boolean }> }
    expect(d.count).toBe(3)
    expect(d.items.map((i) => i.session)).toEqual(['sa-b1', 'sa-b2', 'sa-b3'])
    expect(d.items.every((i) => !i.truncated)).toBe(true)
  })

  it('3. 批量 >10：11 id 拒绝，报错含上限 10 与分批指引（解析先于 fs，无需 fixture）', async () => {
    const list = Array.from({ length: 11 }, (_, i) => `sa-x${i}`).join(',')
    await expect(
      handleSessionRead({ action: 'result', session: list }, { agentDir: dir }),
    ).rejects.toThrow(/最多 10 个/)
    try {
      await handleSessionRead({ action: 'result', session: list }, { agentDir: dir })
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('11')
      expect(msg).toContain('👉')
    }
  })

  it('4. limit 默认 8000：8001 字符正文截断到 8000 + 尾提示（读原文件指引）', async () => {
    const realId = '019e6c96-0000-0000-0000-000000000c01'
    const longText = 'x'.repeat(8001)
    const sessionFile = await makeSubagent(dir, {
      saId: 'sa-long',
      realId,
      entries: [assistantEntry(`${realId}-a1`, [{ type: 'text', text: longText }])],
    })
    const r = await handleSessionRead({ action: 'result', session: 'sa-long' }, { agentDir: dir })
    const text = r.content[0]?.text ?? ''
    // 截断到 8000：第 8001 个 x 不在正文，但提示行给出计数
    expect(text.startsWith('x'.repeat(8000))).toBe(true)
    expect(text).not.toBe(longText)
    expect(text).toContain('[truncated 8000 of 8001 chars')
    expect(text).toContain(`read ${sessionFile}`)
    expect(text).toContain('session_read { action:"detail", session:"sa-long" }')
    const d = r.details as { totalChars: number; truncated: boolean; sessionFile: string }
    expect(d.totalChars).toBe(8001)
    expect(d.truncated).toBe(true)
    expect(d.sessionFile).toBe(sessionFile)
  })

  it('5. 显式 limit：5 字符截断 + 提示；limit 恰等长度不截断；非法 limit 报错', async () => {
    const realId = '019e6c96-0000-0000-0000-000000000c02'
    await makeSubagent(dir, {
      saId: 'sa-lim',
      realId,
      entries: [assistantEntry(`${realId}-a1`, [{ type: 'text', text: 'abcdefghij' }])],
    })
    const cut = await handleSessionRead(
      { action: 'result', session: 'sa-lim', limit: 5 },
      { agentDir: dir },
    )
    expect(cut.content[0]?.text).toBe(
      'abcde\n\n[truncated 5 of 10 chars — full text: read ' +
        `${join(dir, 'subagents', SLUG, 'sessions', `${realId}.jsonl`)}` +
        ', or session_read { action:"detail", session:"sa-lim" }]',
    )
    const exact = await handleSessionRead(
      { action: 'result', session: 'sa-lim', limit: 10 },
      { agentDir: dir },
    )
    expect(exact.content[0]?.text).toBe('abcdefghij')
    const d = exact.details as { truncated: boolean }
    expect(d.truncated).toBe(false)
    for (const bad of [0, -1, Number.NaN]) {
      await expect(
        handleSessionRead({ action: 'result', session: 'sa-lim', limit: bad }, { agentDir: dir }),
      ).rejects.toThrow(/limit.*无效/)
    }
  })

  it('6. 不存在 id：sa-id 无 manifest → 无匹配 record；uuid 片段零匹配 → 无匹配 session', async () => {
    await expect(
      handleSessionRead({ action: 'result', session: 'sa-nonexist-9999' }, { agentDir: dir }),
    ).rejects.toThrow(/无匹配 record/)
    try {
      await handleSessionRead({ action: 'result', session: 'sa-nonexist-9999' }, { agentDir: dir })
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('👉')
      expect(msg).toContain('family')
    }
    await expect(
      handleSessionRead({ action: 'result', session: 'zzz-nonexistent-9q8x2' }, { agentDir: dir }),
    ).rejects.toThrow(/无匹配 session/)
  })

  it('7. 文件尚未 flush：manifest 有、sessionFile 不存在 → 明确报错（GC/未写入）', async () => {
    await makeSubagent(dir, {
      saId: 'sa-flush',
      realId: '019e6c96-0000-0000-0000-000000000e01',
      sessionFileExists: false,
    })
    await expect(
      handleSessionRead({ action: 'result', session: 'sa-flush' }, { agentDir: dir }),
    ).rejects.toThrow(/session 文件不存在/)
    try {
      await handleSessionRead({ action: 'result', session: 'sa-flush' }, { agentDir: dir })
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('未写入')
      expect(msg).toContain('👉')
    }
  })

  it('8. 空 assistant：文件只有 header + user 任务 → 尚无 assistant 输出报错', async () => {
    await makeSubagent(dir, {
      saId: 'sa-empty',
      realId: '019e6c96-0000-0000-0000-000000000a01',
    })
    await expect(
      handleSessionRead({ action: 'result', session: 'sa-empty' }, { agentDir: dir }),
    ).rejects.toThrow(/尚无 assistant 输出/)
    try {
      await handleSessionRead({ action: 'result', session: 'sa-empty' }, { agentDir: dir })
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('sa-empty')
      expect(msg).toContain('👉')
    }
  })

  it('9. 参数防御：缺 session / 空条目（尾逗号）均报错', async () => {
    await expect(
      handleSessionRead({ action: 'result' } as SessionReadParams, { agentDir: dir }),
    ).rejects.toThrow(/需要参数 "session"/)
    await expect(
      handleSessionRead({ action: 'result', session: 'sa-a,' }, { agentDir: dir }),
    ).rejects.toThrow(/空条目/)
  })

  it('10. 未知 action 报错文案含 result（11 action 全列举，含 doctor）', async () => {
    await expect(
      handleSessionRead(
        { action: 'bogus' } as unknown as SessionReadParams,
        { agentDir: dir },
      ),
    ).rejects.toThrow(/find\/family\/outline\/expand\/detail\/search\/export\/extract\/workflow\/result\/doctor/)
  })
})
