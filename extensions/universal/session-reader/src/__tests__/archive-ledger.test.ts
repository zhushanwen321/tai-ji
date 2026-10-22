import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import {
  parseArchiveLedgerText,
  scanArchiveLedgers,
  formatArchivedText,
  formatArchivedDisambiguation,
  resolveArchiveDir,
  type ArchiveLedgerEntry,
} from '../discovery/archive-ledger.js'
import { resolveSessionRoots } from '../discovery/roots.js'
import { handleSessionRead } from '../tool-handler.js'
import { FIX_E6 } from './fixtures.js'

/**
 * [session-archive D7] session-reader 归档根感知测试：簿记收集器（收 .archive.json
 * 不收 .jsonl / 字段解析）+ 第五根「存在才纳入」+ 归档态返回形态（头部标注 /
 * 摘要 turns / 尾注 / staging 占位）+ 无匹配路径回归。
 *
 * 全部用例数据 = mkdtemp 自建自删的最小归档目录（不触真实数据目录，测试防线纪律）。
 */

/** 真实形态的 cwd 编码目录名（encodeCwd：`--` 开头 `--` 结尾） */
const SLUG = '--Users-foo--'

/** 第二归档条目 id（多命中消歧用，合法 uuid 形态） */
const SID2 = '0aaaaaaa-bbbb-7ccc-dddd-0000000000a2'

/** 完整 archived 簿记样本（D3 schema 全字段；overrides 覆盖单测变化点）。 */
function archivedLedger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: FIX_E6,
    name: 'v0.10 renderer 重构',
    originalFile: '2026-10-19T10-00-00_abc.jsonl',
    cwd: '/Users/foo/proj',
    archivedAt: '2026-10-19T12:00:00.000Z',
    rawBytes: 1000,
    compressedBytes: 200,
    codec: 'zstd-3',
    status: 'archived',
    sha256: 'deadbeef',
    summary: {
      turns: [
        { user: 'v0.10 的 renderer 重构开始，先出分层方案。', agent: '六层分层：Shell / Workspace。' },
        { user: '', agent: null },
      ],
    },
    ...overrides,
  }
}

/** 写一份归档簿记（archive/<slug>/<base>.archive.json），返回其绝对路径。 */
async function writeLedger(
  agentDir: string,
  base: string,
  ledger: Record<string, unknown>,
  slug = SLUG,
): Promise<string> {
  const dir = join(agentDir, 'archive', slug)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${base}.archive.json`)
  await writeFile(path, JSON.stringify(ledger), 'utf8')
  return path
}

/** 写 .jsonl fixture（父目录不存在自建），默认合法 session header。 */
async function writeJsonl(path: string, content = '{"type":"session","id":"x"}\n'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** 归档条目（渲染/消歧单测的直造形态，绕过 fs）。 */
function entry(overrides: Partial<ArchiveLedgerEntry> = {}): ArchiveLedgerEntry {
  return {
    ledgerPath: '/tmp/agent/archive/--Users-foo--/a.archive.json',
    sessionId: FIX_E6,
    name: 'v0.10 renderer 重构',
    status: 'archived',
    summary: [
      { user: '先出分层方案。', agent: '六层分层。' },
      { user: '', agent: null },
    ],
    archivedAt: '2026-10-19T12:00:00.000Z',
    mtime: 1_000,
    ...overrides,
  }
}

// ============================================================
// 簿记解析（parseArchiveLedgerText：字段解析 / 非法整条拒收）
// ============================================================

describe('parseArchiveLedgerText（D3 消费子集）', () => {
  it('合法 archived 簿记解析全部消费字段', () => {
    const parsed = parseArchiveLedgerText(JSON.stringify(archivedLedger()))
    expect(parsed).toBeDefined()
    expect(parsed!.sessionId).toBe(FIX_E6)
    expect(parsed!.name).toBe('v0.10 renderer 重构')
    expect(parsed!.status).toBe('archived')
    expect(parsed!.summary).toEqual([
      { user: 'v0.10 的 renderer 重构开始，先出分层方案。', agent: '六层分层：Shell / Workspace。' },
      { user: '', agent: null },
    ])
    expect(parsed!.cwd).toBe('/Users/foo/proj')
    expect(parsed!.archivedAt).toBe('2026-10-19T12:00:00.000Z')
  })

  it('staging 簿记：summary null + name 缺省可选', () => {
    const parsed = parseArchiveLedgerText(
      JSON.stringify(archivedLedger({ status: 'staging', summary: null, name: undefined })),
    )
    expect(parsed).toBeDefined()
    expect(parsed!.status).toBe('staging')
    expect(parsed!.summary).toBeNull()
    expect(parsed!.name).toBeUndefined()
  })

  it('非法形态整条拒收（undefined）：坏 JSON / 缺 sessionId / id 形态非法 / status 词表外 / summary 结构非法', () => {
    expect(parseArchiveLedgerText('{not json')).toBeUndefined()
    expect(parseArchiveLedgerText(JSON.stringify({ status: 'archived', summary: null }))).toBeUndefined()
    // btw 虚拟 id 冒号形态（禁 `:`）拒收
    expect(
      parseArchiveLedgerText(JSON.stringify(archivedLedger({ sessionId: 'btw:0aaa' }))),
    ).toBeUndefined()
    expect(
      parseArchiveLedgerText(JSON.stringify(archivedLedger({ status: 'restoring' }))),
    ).toBeUndefined()
    // summary 非 null 非 { turns } / turns 元素 agent 类型非法
    expect(
      parseArchiveLedgerText(JSON.stringify(archivedLedger({ summary: { turns: 'x' } }))),
    ).toBeUndefined()
    expect(
      parseArchiveLedgerText(
        JSON.stringify(
          archivedLedger({ summary: { turns: [{ user: 'u', agent: 42 }] } }),
        ),
      ),
    ).toBeUndefined()
  })
})

// ============================================================
// 簿记收集器（scanArchiveLedgers：收 .archive.json 不收 .jsonl）
// ============================================================

describe('scanArchiveLedgers（D7 独立收集契约）', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = join(await mkdtemp(join(tmpdir(), 'archive-scan-')), 'agent')
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('收 archive/<encodeCwd>/ 下 .archive.json 并解析字段（含 mtime）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    const entries = await scanArchiveLedgers(resolveArchiveDir(agentDir))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.sessionId).toBe(FIX_E6)
    expect(entries[0]!.status).toBe('archived')
    expect(entries[0]!.ledgerPath.endsWith(join('archive', SLUG, 'a.archive.json'))).toBe(true)
    expect(entries[0]!.mtime).toBeGreaterThan(0)
  })

  it('不收 .jsonl：staging 明文主文件不进收集（硬契约——收了会被当在场 session）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger({ status: 'staging', summary: null }))
    // staging 期归档目录内的明文主文件 + 压缩体
    await writeJsonl(join(agentDir, 'archive', SLUG, '2026-10-19T10-00-00_abc.jsonl'))
    await writeJsonl(join(agentDir, 'archive', SLUG, '2026-10-19T10-00-00_abc.jsonl.zst'), 'x')
    const entries = await scanArchiveLedgers(resolveArchiveDir(agentDir))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ledgerPath.endsWith('.archive.json')).toBe(true)
  })

  it('.restoring 后缀簿记不收（恢复中，D9 不在列表）', async () => {
    const path = await writeLedger(agentDir, 'a', archivedLedger())
    const restoringPath = path.replace(/\.archive\.json$/, '.restoring')
    await writeFile(restoringPath, JSON.stringify(archivedLedger()), 'utf8')
    const entries = await scanArchiveLedgers(resolveArchiveDir(agentDir))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ledgerPath).toBe(path)
  })

  it('assets 子目录不递归（附件区无簿记，只耗 IO）；深层簿记照收', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    await mkdir(join(agentDir, 'archive', SLUG, 'assets', FIX_E6, 'attachments'), { recursive: true })
    await writeFile(
      join(agentDir, 'archive', SLUG, 'assets', FIX_E6, 'attachments', 'img.png'),
      'x',
    )
    const entries = await scanArchiveLedgers(resolveArchiveDir(agentDir))
    expect(entries).toHaveLength(1)
  })

  it('坏簿记跳过不中断（坏 JSON / 词表外 status 的条目丢弃，其余照收）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    await writeLedger(agentDir, 'b', archivedLedger({ sessionId: SID2, status: 'bogus' }))
    const dir = join(agentDir, 'archive', SLUG)
    await writeFile(join(dir, 'c.archive.json'), '{broken', 'utf8')
    const entries = await scanArchiveLedgers(resolveArchiveDir(agentDir))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.sessionId).toBe(FIX_E6)
  })

  it('归档根不存在 → 空数组不抛错', async () => {
    await expect(scanArchiveLedgers(resolveArchiveDir(agentDir))).resolves.toEqual([])
  })
})

// ============================================================
// roots 第五根（存在才纳入 + 收集契约分流）
// ============================================================

describe('resolveSessionRoots 第五根 archive（存在才纳入）', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = join(await mkdtemp(join(tmpdir(), 'archive-roots-')), 'agent')
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('archive 目录不存在 → 根不进返回（现有四根行为零变化，无归档目录环境回归锚）', async () => {
    const roots = await resolveSessionRoots({ agentDir })
    expect(roots.map((r) => r.kind)).toEqual(['default', 'legacy', 'subagent'])
    expect(roots.some((r) => r.kind === 'archive')).toBe(false)
  })

  it('archive 目录存在 → 第五根纳入：fileCount = 簿记数、files 恒空（不收 .jsonl）、archiveEntries 在场', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    await writeLedger(agentDir, 'b', archivedLedger({ sessionId: SID2, name: '另一个' }))
    // staging 明文 .jsonl 不影响 fileCount（不收）
    await writeJsonl(join(agentDir, 'archive', SLUG, 'plain.jsonl'))

    const roots = await resolveSessionRoots({ agentDir })
    expect(roots.map((r) => r.kind)).toEqual(['default', 'legacy', 'subagent', 'archive'])
    const archive = roots.find((r) => r.kind === 'archive')!
    expect(archive.path).toBe(resolveArchiveDir(agentDir))
    expect(archive.exists).toBe(true)
    expect(archive.source).toBe('main')
    expect(archive.files).toEqual([])
    expect(archive.fileCount).toBe(2)
    expect(archive.archiveEntries).toHaveLength(2)
    expect(typeof archive.scanMs).toBe('number')
  })

  it('doctor 渲染：archive 根行计数措辞为「N 归档单元」', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    const r = await handleSessionRead({ action: 'doctor' }, { agentDir })
    const text = r.content[0]!.text
    expect(text).toContain('[archive]')
    expect(text).toContain('1 归档单元')
  })

  it('同 realpath 去重：更高优先级根与归档目录同路径时 archive 根 dedupedInto，不重复成根', async () => {
    // live 信号直接指向归档目录（basename 非 encodeCwd 形态 → 取自身，字面同路径
    // realpath 必同）；优先级 live > archive，归档根不实扫簿记、标注归属——与普通根
    // realpath 去重同构（§7B 要点 4）。回归锚：archive 分支漏 kept 检查时本用例红
    //（out 出现两条同路径实扫根，且 byRealPath 被 archive 覆盖致 dedupedInto 失效）
    await writeLedger(agentDir, 'a', archivedLedger())
    const archiveDir = resolveArchiveDir(agentDir)

    const roots = await resolveSessionRoots({ agentDir, liveSessionDir: archiveDir })
    expect(roots.map((r) => r.kind)).toEqual(['live', 'default', 'legacy', 'subagent', 'archive'])
    const archive = roots.find((r) => r.kind === 'archive')!
    expect(archive.path).toBe(archiveDir)
    expect(archive.dedupedInto).toBe('live')
    // 被去重根不产生扫描统计，簿记收集未执行（与普通根去重同构）
    expect(archive.fileCount).toBeUndefined()
    expect(archive.scanMs).toBeUndefined()
    expect(archive.archiveEntries).toBeUndefined()
    // 同路径全列表只保留一个实扫根（= 更高优先级的 live），簿记不重复计数
    const scannedAtSamePath = roots.filter(
      (r) => r.path === archiveDir && r.dedupedInto === undefined,
    )
    expect(scannedAtSamePath).toHaveLength(1)
    expect(scannedAtSamePath[0]!.kind).toBe('live')
  })
})

// ============================================================
// 归档态返回形态（handleSessionRead 集成：D7 硬契约）
// ============================================================

describe('归档态返回形态（片段命中归档回退）', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = join(await mkdtemp(join(tmpdir(), 'archive-read-')), 'agent')
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('名称片段命中归档：头部标注 + 摘要 turns + 尾注恢复指引（§5.1 agent 引用样例形态）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    const r = await handleSessionRead(
      { action: 'outline', session: 'renderer 重构' },
      { agentDir },
    )
    const text = r.content[0]!.text
    expect(text).toContain('[session-reader] session: v0.10 renderer 重构')
    expect(text).toContain('状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要')
    expect(text).toContain('── turn 1 ──')
    expect(text).toContain('user: v0.10 的 renderer 重构开始，先出分层方案。')
    expect(text).toContain('assistant (摘要): 六层分层：Shell / Workspace。')
    expect(text).toContain('注: 如需完整历史，请让用户在归档列表中恢复该会话。')
    // details 程序化标记：archived: true + 簿记条目
    const d = r.details as { archived: boolean; entry: { sessionId: string } }
    expect(d.archived).toBe(true)
    expect(d.entry.sessionId).toBe(FIX_E6)
  })

  it('摘要占位规则：agent null → 无文本占位；user 空串 → 图片/附件占位', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    const r = await handleSessionRead({ action: 'outline', session: 'renderer' }, { agentDir })
    const text = r.content[0]!.text
    expect(text).toContain('── turn 2 ──')
    expect(text).toContain('user: [图片/附件消息]')
    expect(text).toContain('assistant (摘要): （此 turn 以工具调用结束，无文本回复）')
  })

  it('staging 态（summary null）：头部 staging 标注 + 「摘要生成中」+ 名称/id 元数据', async () => {
    await writeLedger(agentDir, 'a', archivedLedger({ status: 'staging', summary: null }))
    const r = await handleSessionRead({ action: 'outline', session: 'renderer' }, { agentDir })
    const text = r.content[0]!.text
    expect(text).toContain('状态: 已归档 (staging) — 摘要生成中，请稍后再查')
    expect(text).toContain(`（id: ${FIX_E6}）`)
    expect(text).toContain('注: 如需完整历史，请让用户在归档列表中恢复该会话。')
    expect(text).not.toContain('── turn')
  })

  it('sessionId 片段与归一化形态命中（大写/去连字符）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    const byFragment = await handleSessionRead({ action: 'detail', session: 'e6c96', turns: 'T000-T001' }, { agentDir })
    expect(byFragment.content[0]!.text).toContain('已归档 (archived)')
    const byNorm = await handleSessionRead(
      { action: 'outline', session: FIX_E6.replace(/-/g, '').toUpperCase() },
      { agentDir },
    )
    expect(byNorm.content[0]!.text).toContain('已归档 (archived)')
  })

  it('staging 明文 .jsonl 不被直读：同 id 明文在归档目录内仍返回归档形态（不读压缩体/明文）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    await writeJsonl(
      join(agentDir, 'archive', SLUG, `${FIX_E6}.jsonl`),
      `{"type":"session","id":"${FIX_E6}"}\n`,
    )
    const r = await handleSessionRead({ action: 'outline', session: 'e6c96' }, { agentDir })
    expect(r.content[0]!.text).toContain('已归档 (archived)')
  })

  it('多归档命中 → 归档消歧列表（列候选 + 👉，不抛错）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    await writeLedger(
      agentDir,
      'b',
      archivedLedger({ sessionId: SID2, name: 'v0.11 renderer 重构' }),
    )
    const r = await handleSessionRead({ action: 'outline', session: 'renderer' }, { agentDir })
    const text = r.content[0]!.text
    expect(text).toContain('多个归档 session 匹配 "renderer"')
    expect(text).toContain(`v0.10 renderer 重构（id: ${FIX_E6}`)
    expect(text).toContain(`v0.11 renderer 重构（id: ${SID2}`)
    expect(text).toContain('👉')
  })

  it('在场优先：同片段在场 session 命中时返回在场内容，不走归档回退', async () => {
    await writeJsonl(
      join(agentDir, 'sessions', SLUG, `${FIX_E6}.jsonl`),
      `{"type":"session","id":"${FIX_E6}"}\n`,
    )
    await writeLedger(agentDir, 'a', archivedLedger({ name: 'e6c96 主题' }))
    const r = await handleSessionRead({ action: 'outline', session: 'e6c96' }, { agentDir })
    expect(r.details).not.toHaveProperty('archived')
    expect(r.content[0]!.text).not.toContain('已归档')
  })

  it('result action 命中归档：统一归档态摘要（批量链路的单 id 形态）', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    const r = await handleSessionRead({ action: 'result', session: 'renderer' }, { agentDir })
    expect(r.content[0]!.text).toContain('已归档 (archived)')
    expect((r.details as { archived: boolean }).archived).toBe(true)
  })

  it('无匹配路径回归：无 archive 目录 + 在场零命中 → F1 照旧（无归档提示行、无 [archive] 根行）', async () => {
    await expect(
      handleSessionRead({ action: 'outline', session: 'zzz-nope' }, { agentDir }),
    ).rejects.toThrow('无匹配 session')
    await expect(
      handleSessionRead({ action: 'outline', session: 'zzz-nope' }, { agentDir }),
    ).rejects.toThrow(/自检（发现层，只陈述事实）：/)
  })

  it('F1 归档指引（条件行）：归档根存在且簿记非空 → find 零匹配文案含「目标可能已归档」', async () => {
    await writeLedger(agentDir, 'a', archivedLedger())
    const r = await handleSessionRead({ action: 'find', query: 'zzz-nope' }, { agentDir })
    const text = r.content[0]!.text
    expect(text).toContain('无匹配 session')
    expect(text).toContain('目标可能已归档')
    expect(text).toContain('[archive]')
  })

  it('F1 归档指引不出现：归档根存在但簿记为空（空目录）', async () => {
    await mkdir(join(agentDir, 'archive', SLUG), { recursive: true })
    const r = await handleSessionRead({ action: 'find', query: 'zzz-nope' }, { agentDir })
    expect(r.content[0]!.text).not.toContain('目标可能已归档')
  })
})

// ============================================================
// 归档态渲染纯函数（formatArchivedText / formatArchivedDisambiguation 直测）
// ============================================================

describe('formatArchivedText（两态渲染纯函数）', () => {
  it('无 name 时头行回退 sessionId', () => {
    const text = formatArchivedText(entry({ name: undefined }))
    expect(text).toContain(`[session-reader] session: ${FIX_E6}`)
  })

  it('archived 态无摘要 turns（summary 空数组）只出头部与尾注', () => {
    const text = formatArchivedText(entry({ summary: [] }))
    expect(text).toContain('已归档 (archived)')
    expect(text).not.toContain('── turn')
    expect(text).toContain('注: 如需完整历史')
  })
})

describe('formatArchivedDisambiguation（多命中消歧）', () => {
  it('按 mtime 倒序列候选并携带归档时间', () => {
    const text = formatArchivedDisambiguation('q', [
      entry({ mtime: 1, name: '旧条目' }),
      entry({ mtime: 2, sessionId: SID2, name: '新条目' }),
    ])
    const newIdx = text.indexOf('新条目')
    const oldIdx = text.indexOf('旧条目')
    expect(newIdx).toBeGreaterThan(-1)
    expect(oldIdx).toBeGreaterThan(newIdx)
    expect(text).toContain(`id: ${SID2}`)
    expect(text).toContain('归档于 2026-10-19T12:00:00.000Z')
  })
})
