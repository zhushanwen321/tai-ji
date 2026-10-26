// roots-merged.test.ts —— session-reader C03 簇合并产物（round5-G）。
// 共同被测业务模块：`src/discovery/roots.ts`。mock 相容：单侧 mock node:os——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/archive-ledger.test.ts（27 用例，skip 0）
//   - src/__tests__/find.test.ts（34 用例，skip 0）
//   - src/__tests__/result.test.ts（15 用例，skip 0）
//   - src/__tests__/tool-handler.test.ts（117 用例，skip 0）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir, homedir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { parseArchiveLedgerText, scanArchiveLedgers, formatArchivedText, formatArchivedDisambiguation, resolveArchiveDir, type ArchiveLedgerEntry } from '../discovery/archive-ledger.js'
import { resolveSessionRoots, resolveStoreSubagentSessionsDir, resolveStoreSubagentRecordsDir, resolveSessionStoreRoot } from '../discovery/roots.js'
import { handleSessionRead, type SessionReadParams, METADATA_CACHE_TTL_MS, type SessionReadSignals } from '../tool-handler.js'
import { FIX_E6 } from './fixtures.js'
import { findSessions, type SessionMetadataProvider } from '../discovery/find.js'
import { extractFinalAssistantText } from '../result-action.js'
import { existsSync } from 'node:fs'
import { setPiHandle } from '@zhushanwen/pi-extension-logger'
import { type DoctorDetails } from '../doctor.js'
import { levenshtein } from '../no-match.js'
import { MULTI_SEARCH_MAX_SESSIONS, SEARCH_SCAN_BYTE_BUDGET, searchAcrossSessions } from '../search-across.js'
import { renderExtractItems } from '../extract.js'

// fs-guard：TC6 的「~ 前缀展开」语义需要 homedir，但真实 homedir 根在白名单外（禁止向用户
// 主目录散落文件）。vi.mock 把 homedir 指到用例内 mkdtemp 的 tmp；fakeHome 未注入时回落真实值。
const homeState = vi.hoisted(() => ({ fakeHome: undefined as string | undefined }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => homeState.fakeHome ?? actual.homedir() }
})

// ======== 来源：archive-ledger.test.ts ========
describe("archive-ledger", () => {
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
});

// ======== 来源：find.test.ts ========
describe("find", () => {
  /**
 * 建一个假 session 文件：首行 header（type=session，含 id/cwd/parentSession），
 * 可选第二条 user message（用于名称关键词匹配 + firstMessagePreview）。返回绝对路径。
 */
  async function makeSession(
    dir: string,
    opts: {
      name: string
      id: string
      cwd?: string
      parentSession?: string
      firstUserText?: string
    },
  ): Promise<string> {
    const header: Record<string, unknown> = {
      type: 'session',
      id: opts.id,
      timestamp: '2026-01-01T00:00:00.000Z',
    }
    if (opts.cwd) header.cwd = opts.cwd
    if (opts.parentSession) header.parentSession = opts.parentSession
    const lines = [JSON.stringify(header)]
    if (opts.firstUserText) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: opts.id + '-m1',
          message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
        }),
      )
    }
    await mkdir(dir, { recursive: true })
    const path = join(dir, opts.name)
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  /**
 * 建 records manifest（U5 fixture）。manifest 由终态 finalize 或 sync 批落标出口写入
 * records/<sa-id>.json（创建时不写），sessionFile 指向 alive subagent session 的绝对路径
 * （find 用 extractSessionIdFromFilename 从该路径提取 sessionId 建索引）。
 */
  async function makeRecordManifest(
    recordsDir: string,
    opts: {
      id: string
      rootSessionId: string
      sessionFile: string
      agentName?: string
      task?: string
      slug?: string
      model?: string
      status?: string
    },
  ): Promise<void> {
    const m: Record<string, unknown> = {
      id: opts.id,
      rootSessionId: opts.rootSessionId,
      sessionFile: opts.sessionFile,
    }
    if (opts.agentName !== undefined) m.agentName = opts.agentName
    if (opts.task !== undefined) m.task = opts.task
    if (opts.slug !== undefined) m.slug = opts.slug
    if (opts.model !== undefined) m.model = opts.model
    if (opts.status !== undefined) m.status = opts.status
    await mkdir(recordsDir, { recursive: true })
    await writeFile(join(recordsDir, `${opts.id}.json`), JSON.stringify(m))
  }

  /**
 * 建 subagent session 文件（header + 可选首消息 + 可选尾行 identity）。返回绝对路径。
 *
 * 文件名用 `<ts>_<sessionId>.jsonl` 格式（满足 extractSessionIdFromFilename）。传 rootSessionId
 * 时追加尾行 subagent-identity custom entry（P-fallback fixture 用）；不传则只有 header（manifest 主 fixture 用）。
 */
  async function makeSubagentSession(
    dir: string,
    opts: {
      name: string
      id: string
      cwd?: string
      rootSessionId?: string
      slug?: string
      task?: string
      agent?: string
      firstUserText?: string
    },
  ): Promise<string> {
    const header: Record<string, unknown> = {
      type: 'session',
      id: opts.id,
      timestamp: '2026-01-01T00:00:00.000Z',
    }
    if (opts.cwd) header.cwd = opts.cwd
    const lines: string[] = [JSON.stringify(header)]
    if (opts.firstUserText) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: opts.id + '-m1',
          message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
        }),
      )
    }
    if (opts.rootSessionId !== undefined) {
      const data: Record<string, unknown> = {
        id: 'sa-' + opts.id,
        agent: opts.agent ?? 'worker',
        mode: 'background',
        task: opts.task ?? '',
        slug: opts.slug ?? '',
        startedAt: Date.now(),
        rootSessionId: opts.rootSessionId,
        depth: 1,
      }
      lines.push(
        JSON.stringify({ type: 'custom', id: opts.id, customType: 'subagent-identity', data }),
      )
    }
    await mkdir(dir, { recursive: true })
    const path = join(dir, opts.name)
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  describe('findSessions', () => {
    let root: string
    let agentDir: string
    let slugDir: string
    /**
   * subagent fixture 目录（[session-store-layout-inversion] 新布局存储树
   * `<root>/<rootSessionId>/subagents/sessions/`，resolveSessionRoots [subagent] 根
   * 定向扫描路径；分区键取 FIX_SID，生产同源推导函数落盘）。
   */
    let saDir: string

    let recordsDir: string

    /** 存储树分区 sid fixture（合法 pi sid 形态）。 */
    const FIX_SID = '0aaaaaaa-bbbb-7ccc-dddd-0000000000f1'

    beforeEach(async () => {
      // 生产拓扑复刻（布局 B）：agentDir = <dataDir>/agent
      root = await mkdtemp(join(tmpdir(), 'find-test-'))
      agentDir = join(root, 'agent')
      slugDir = join(agentDir, 'sessions', '--Users-demo--')
      saDir = resolveStoreSubagentSessionsDir(agentDir, FIX_SID)
      recordsDir = resolveStoreSubagentRecordsDir(agentDir, FIX_SID)
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('uuid 片段匹配正确的 session（sessionId 含 query）', async () => {
      await makeSession(slugDir, { name: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
      await makeSession(slugDir, { name: 'b.jsonl', id: '019fffff-cccc-dddd', cwd: '/demo' })

      const { matches } = await findSessions('e6c96', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('019e6c96-aaaa-bbbb')
    })

    it('uuid 片段匹配：文件路径含 query（query 出现在文件名）', async () => {
      // sessionId 不含 query，但文件名含 → path.includes(query) 命中
      await makeSession(slugDir, { name: '2026-special-name.jsonl', id: 'sid-no-query', cwd: '/demo' })
      const { matches } = await findSessions('special', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('sid-no-query')
    })

    it('fileName 填完整绝对路径，mtime/sizeBytes/cwd 为真实值', async () => {
      const path = await makeSession(slugDir, { name: 'a.jsonl', id: 'sid-fullpath', cwd: '/demo' })
      const { matches } = await findSessions('sid-fullpath', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe(path)
      expect(matches[0].mtime).toBeGreaterThan(0)
      expect(matches[0].sizeBytes).toBeGreaterThan(0)
      expect(matches[0].cwd).toBe('/demo')
    })

    it('cwd 过滤：只留 header.cwd === opts.cwd 的', async () => {
      await makeSession(slugDir, { name: 'a.jsonl', id: 'aaa-shared', cwd: '/proj-a' })
      await makeSession(slugDir, { name: 'b.jsonl', id: 'bbb-shared', cwd: '/proj-b' })

      // query 'shared' 同时命中两个 id，cwd 过滤后只留 /proj-a
      const { matches } = await findSessions('shared', agentDir, { cwd: '/proj-a' })
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('aaa-shared')
      expect(matches[0].cwd).toBe('/proj-a')
    })

    it('缺 cwd 的 header 进候选集（谓词不统一负面锚，design §4 负面行为验证）', async () => {
      // header 行只有 id（无 cwd/timestamp）：runtime 导入侧「id+cwd 非空」严谓词会拒收，
      // reader 宽谓词（仅要求 type==='session' ∧ id 为 string）必须照常收录——基座化
      // （readFirstJsonlLine 改指 session-core）不得顺手统一谓词，本用例即机器锚。
      const headerPath = join(slugDir, 'no-cwd.jsonl')
      await mkdir(slugDir, { recursive: true })
      await writeFile(headerPath, JSON.stringify({ type: 'session', id: '019e0001-no-cwd' }) + '\n')
      await makeSession(slugDir, { name: 'with-cwd.jsonl', id: '019e0002-with-cwd', cwd: '/demo' })

      // find 结果：缺 cwd header 命中，cwd 归一化为空串（buildCandidate 的 header.cwd ?? ''）
      const { matches } = await findSessions('no-cwd', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('019e0001-no-cwd')
      expect(matches[0].cwd).toBe('')

      // 候选枚举（recent 路径枚举全部候选）：缺 cwd header 未被候选集排除
      const recent = await findSessions('recent', agentDir)
      expect(recent.matches.map((m) => m.sessionId).sort()).toEqual([
        '019e0001-no-cwd',
        '019e0002-with-cwd',
      ])
    })

    it('limit 截断：truncated 标记正确', async () => {
      // 5 个文件 id 都含 "common"，uuid 片段 "common" 全匹配
      for (let i = 0; i < 5; i++) {
        await makeSession(slugDir, { name: `f${i}.jsonl`, id: `common-${i}`, cwd: '/demo' })
      }
      const { matches, truncated } = await findSessions('common', agentDir, { limit: 2 })
      expect(matches).toHaveLength(2)
      expect(truncated).toBe(true)

      // limit >= 总数时 truncated=false
      const all = await findSessions('common', agentDir, { limit: 10 })
      expect(all.matches).toHaveLength(5)
      expect(all.truncated).toBe(false)
    })

    it("query='recent' 按 mtime 倒序", async () => {
      const paths: string[] = []
      for (let i = 0; i < 3; i++) {
        paths.push(await makeSession(slugDir, { name: `r${i}.jsonl`, id: `recent-${i}`, cwd: '/demo' }))
      }
      // 设递增 mtime：r0 最旧，r2 最新
      const base = Math.floor(Date.now() / 1000)
      await utimes(paths[0], base, base)
      await utimes(paths[1], base + 100, base + 100)
      await utimes(paths[2], base + 200, base + 200)

      const { matches } = await findSessions('recent', agentDir)
      expect(matches).toHaveLength(3)
      expect(matches[0].sessionId).toBe('recent-2') // mtime 最大排前
      expect(matches[1].sessionId).toBe('recent-1')
      expect(matches[2].sessionId).toBe('recent-0')
    })

    it("recent 也尊重 cwd 过滤", async () => {
      await makeSession(slugDir, { name: 'a.jsonl', id: 'r-a', cwd: '/proj-a' })
      await makeSession(slugDir, { name: 'b.jsonl', id: 'r-b', cwd: '/proj-b' })

      const { matches } = await findSessions('recent', agentDir, { cwd: '/proj-a' })
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('r-a')
    })

    it('名称关键词匹配：uuid 无匹配时读首消息预览含 query', async () => {
      // query 'plugin' 含 p/l/u/g/i/n（p/l/u 非十六进制）→ 非 uuid 特征，走首消息 fallback
      await makeSession(slugDir, {
        name: 'a.jsonl',
        id: 'kw-aaaa',
        cwd: '/demo',
        firstUserText: '重构插件架构 plugin architecture review',
      })
      await makeSession(slugDir, {
        name: 'b.jsonl',
        id: 'kw-bbbb',
        cwd: '/demo',
        firstUserText: '完全无关的内容 unrelated content',
      })

      const { matches } = await findSessions('plugin', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('kw-aaaa')
      expect(matches[0].firstMessagePreview).toContain('plugin')
    })

    it('无匹配返回 { matches: [], truncated: false }', async () => {
      await makeSession(slugDir, { name: 'a.jsonl', id: '019abcd', cwd: '/demo' })
      // query 非 uuid 特征（z 非十六进制），走首消息 fallback 仍无匹配
      const result = await findSessions('zzznotexist', agentDir)
      expect(result).toEqual({ matches: [], truncated: false })
    })

    it('uuid 片段命中路径的 firstMessagePreview 补读（命中时未读首消息，第 5 步补）', async () => {
      // uuid 片段直接命中 → 不走关键词层（preview 未读），最终结果仍应补读出首消息预览
      await makeSession(slugDir, {
        name: 'a.jsonl',
        id: '019cafe0-aaaa-bbbb',
        cwd: '/demo',
        firstUserText: 'uuid 命中后补读的预览文本',
      })
      const { matches } = await findSessions('019cafe0', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('019cafe0-aaaa-bbbb')
      expect(matches[0].firstMessagePreview).toBe('uuid 命中后补读的预览文本')
    })

    it('firstMessagePreview 截断到 80 字符', async () => {
      const longText = 'X'.repeat(200)
      await makeSession(slugDir, {
        name: 'a.jsonl',
        id: 'prev-len',
        cwd: '/demo',
        firstUserText: longText,
      })
      const { matches } = await findSessions('prev-len', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].firstMessagePreview).toBeDefined()
      expect(matches[0].firstMessagePreview!.length).toBeLessThanOrEqual(80)
    })

    it('纯十六进制 query 无 uuid 匹配时不走首消息 fallback（uuid 特征短路）', async () => {
      // 'deadbeef' 全十六进制 → uuid 特征；sessionId 不含、首消息也不会含 → matched=[]
      await makeSession(slugDir, {
        name: 'a.jsonl',
        id: '019aaaa',
        cwd: '/demo',
        firstUserText: 'deadbeef 出现在首消息里也不该匹配',
      })
      const result = await findSessions('deadbeef', agentDir)
      expect(result.matches).toEqual([])
      expect(result.truncated).toBe(false)
    })

    it('缺省合并：main + subagent 候选都返回，source 标记正确（DM1）', async () => {
      await makeSession(slugDir, { name: 'm.jsonl', id: 'main-shared', cwd: '/demo' })
      await makeSession(saDir, { name: 's.jsonl', id: 'sub-shared', cwd: '/demo' })

      const { matches } = await findSessions('shared', agentDir)
      expect(matches).toHaveLength(2)
      // source 必填标记（DM1）+ 集合为 {main, subagent}
      const sources = matches.map((m) => m.source).sort()
      expect(sources).toEqual(['main', 'subagent'])
      // fileName 指向各自目录
      const mainHit = matches.find((m) => m.source === 'main')!
      const subHit = matches.find((m) => m.source === 'subagent')!
      expect(mainHit.sessionId).toBe('main-shared')
      expect(mainHit.fileName).not.toContain('subagents')
      expect(subHit.sessionId).toBe('sub-shared')
      expect(subHit.fileName).toContain('subagents')
    })

    it("source:'main' 只含 main 候选（subagent 被过滤）", async () => {
      await makeSession(slugDir, { name: 'm.jsonl', id: 'main-shared', cwd: '/demo' })
      await makeSession(saDir, { name: 's.jsonl', id: 'sub-shared', cwd: '/demo' })

      const { matches } = await findSessions('shared', agentDir, { source: 'main' })
      expect(matches).toHaveLength(1)
      expect(matches[0].source).toBe('main')
      expect(matches[0].sessionId).toBe('main-shared')
    })

    it("source:'subagent' 只含 subagent 候选（main 被过滤）", async () => {
      await makeSession(slugDir, { name: 'm.jsonl', id: 'main-shared', cwd: '/demo' })
      await makeSession(saDir, { name: 's.jsonl', id: 'sub-shared', cwd: '/demo' })

      const { matches } = await findSessions('shared', agentDir, { source: 'subagent' })
      expect(matches).toHaveLength(1)
      expect(matches[0].source).toBe('subagent')
      expect(matches[0].sessionId).toBe('sub-shared')
      expect(matches[0].fileName).toContain('subagents')
    })

    it('D6 单新根锚定：旧布局 <agentDir>/subagents 造 subagent 会话 → find 不发现（存量不可见）', async () => {
      await makeSession(slugDir, { name: 'm.jsonl', id: 'main-shared', cwd: '/demo' })
      // 旧布局存量原位保留（D6 裁决：不迁移、不再读写）
      const legacyDir = join(agentDir, 'subagents', '--Users-demo--', 'sessions')
      await makeSession(legacyDir, { name: 's-legacy.jsonl', id: 'sub-legacy', cwd: '/demo' })

      const { matches } = await findSessions('shared', agentDir)
      expect(matches.map((m) => m.sessionId)).toEqual(['main-shared'])
    })

    it('存储树分区目录名（= rootSessionId）不把根会话 id 的完整 id 查询吸成伪 multi', async () => {
      // 新布局路径 `<root>/<rootSessionId>/subagents/sessions/<subId>.jsonl` 含根会话 id——
      // 完整 id 查询若走路径子串匹配会同时命中 subagent 候选（伪 multi 消歧）。
      // 精确等值短路：完整 id 直查恒精确命中（find.ts [session-store-layout-inversion]）。
      const rootId = '0aaaaaaa-bbbb-7ccc-dddd-0000000000q1'
      const subId = '0aaaaaaa-bbbb-7ccc-dddd-0000000000q2'
      await makeSession(slugDir, { name: `${rootId}.jsonl`, id: rootId, cwd: '/demo' })
      await makeSession(resolveStoreSubagentSessionsDir(agentDir, rootId), {
        name: `${subId}.jsonl`,
        id: subId,
        cwd: '/demo',
      })

      // 完整 id：精确等值直返，不被 subagent 路径里的分区 id 误吸
      const exact = await findSessions(rootId, agentDir)
      expect(exact.matches.map((m) => m.sessionId)).toEqual([rootId])
      // 真片段查询：路径维度命中仍然保留（按路径片段定位文件的能力不回退）
      const fragment = await findSessions('0000000000q', agentDir)
      expect(fragment.matches.map((m) => m.sessionId).sort()).toEqual([rootId, subId].sort())
    })

    it("recent 也尊重 source 过滤（含不传 source 时两侧按 mtime 混合倒序）", async () => {
      const mainPath = await makeSession(slugDir, { name: 'm.jsonl', id: 'r-main', cwd: '/demo' })
      const subPath = await makeSession(saDir, { name: 's.jsonl', id: 'r-sub', cwd: '/demo' })
      // subagent mtime 更新
      const base = Math.floor(Date.now() / 1000)
      await utimes(mainPath, base, base)
      await utimes(subPath, base + 100, base + 100)

      // source:'main' → 只 main 侧，subagent 被过滤
      const mainOnly = await findSessions('recent', agentDir, { source: 'main' })
      expect(mainOnly.matches).toHaveLength(1)
      expect(mainOnly.matches[0].source).toBe('main')
      expect(mainOnly.matches[0].sessionId).toBe('r-main')

      // 不传 source → 两侧合并按 mtime 倒序（subagent 更新排前）
      const merged = await findSessions('recent', agentDir)
      expect(merged.matches).toHaveLength(2)
      expect(merged.matches[0].sessionId).toBe('r-sub')
      expect(merged.matches[0].source).toBe('subagent')
      expect(merged.matches[1].sessionId).toBe('r-main')
      expect(merged.matches[1].source).toBe('main')
    })

    // ============================================================
    // U5：subagent task/slug/agentName 匹配（manifest 索引 + P-fallback identity 回退）
    // ============================================================
    describe('U5 task/slug/agentName 匹配', () => {
      it('TC-u5-find-task：manifest.task 含 query 入选（main 首消息不含 query 不入选）', async () => {
        const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000001'
        const subPath = await makeSubagentSession(saDir, {
          name: `1234567890_${subId}.jsonl`,
          id: subId,
          cwd: '/demo',
        })
        await makeRecordManifest(recordsDir, {
          id: `sa-${subId}`,
          rootSessionId: 'root-1',
          sessionFile: subPath,
          task: '调研 codex CLI 的功能',
        })
        // main 首消息不含 codex → 关键词层不命中
        await makeSession(slugDir, {
          name: 'main.jsonl',
          id: 'main-no-task-match',
          cwd: '/demo',
          firstUserText: '完全无关的对话内容',
        })

        const { matches } = await findSessions('codex', agentDir)
        expect(matches).toHaveLength(1)
        expect(matches[0].source).toBe('subagent')
        expect(matches[0].sessionId).toBe(subId)
      })

      it('TC-u5-find-slug：manifest.slug 子串命中入选', async () => {
        const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000002'
        const subPath = await makeSubagentSession(saDir, {
          name: `1234567890_${subId}.jsonl`,
          id: subId,
          cwd: '/demo',
        })
        await makeRecordManifest(recordsDir, {
          id: `sa-${subId}`,
          rootSessionId: 'root-2',
          sessionFile: subPath,
          slug: 'codex-ask-user-research',
          task: '其他不含 ask-user 的任务文本',
        })

        const { matches } = await findSessions('ask-user', agentDir)
        expect(matches).toHaveLength(1)
        expect(matches[0].source).toBe('subagent')
        expect(matches[0].sessionId).toBe(subId)
      })

      it('TC-u5-find-agentname：manifest.agentName 命中入选', async () => {
        const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000003'
        const subPath = await makeSubagentSession(saDir, {
          name: `1234567890_${subId}.jsonl`,
          id: subId,
          cwd: '/demo',
        })
        await makeRecordManifest(recordsDir, {
          id: `sa-${subId}`,
          rootSessionId: 'root-3',
          sessionFile: subPath,
          agentName: 'explorer',
          task: '不含 explorer 的任务',
          slug: '不含-explorer-的-slug',
        })

        const { matches } = await findSessions('explorer', agentDir)
        expect(matches).toHaveLength(1)
        expect(matches[0].source).toBe('subagent')
        expect(matches[0].sessionId).toBe(subId)
      })

      it('TC-u5-find-source-task-combo：source:subagent 过滤 + task 匹配正交（与 m0 U1 source 过滤组合）', async () => {
        // main：首消息含 codex，但 source:'subagent' 在文件列表层排除 sessions/ 目录（不扫 main）
        await makeSession(slugDir, {
          name: 'main.jsonl',
          id: 'main-with-codex',
          cwd: '/demo',
          firstUserText: '讨论 codex 工具的使用',
        })
        // subagent：task 含 codex
        const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000004'
        const subPath = await makeSubagentSession(saDir, {
          name: `1234567890_${subId}.jsonl`,
          id: subId,
          cwd: '/demo',
        })
        await makeRecordManifest(recordsDir, {
          id: `sa-${subId}`,
          rootSessionId: 'root-4',
          sessionFile: subPath,
          task: '用 codex 完成任务',
        })

        const { matches } = await findSessions('codex', agentDir, { source: 'subagent' })
        expect(matches.length).toBeGreaterThanOrEqual(1)
        expect(matches.every((m) => m.source === 'subagent')).toBe(true)
        expect(matches.some((m) => m.sessionId === subId)).toBe(true)
        // main 被 source 过滤排除（文件列表层不扫 sessions/）
        expect(matches.some((m) => m.source === 'main')).toBe(false)
      })

      it('TC-u5-find-pfallback：无 manifest，读尾行 identity.task 回退匹配（场景 A）', async () => {
        // subagent：无 manifest（P-fallback），但 session 文件尾行 identity.task 含 'resolve-bug'
        const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000005'
        await makeSubagentSession(saDir, {
          name: `1234567890_${subId}.jsonl`,
          id: subId,
          cwd: '/demo',
          rootSessionId: 'root-5',
          task: '修复 resolve-bug 这个问题',
          slug: 'fix',
          agent: 'worker',
        })

        const { matches } = await findSessions('resolve', agentDir)
        expect(matches).toHaveLength(1)
        expect(matches[0].source).toBe('subagent')
        expect(matches[0].sessionId).toBe(subId)
      })

      it('TC-u5-find-uuid-priority：uuid 片段命中后短路，不走 task 匹配（TC-find-match-priority）', async () => {
        // subagent A：sessionId 含 'abc123'（uuid 片段命中）
        const idA = 'aabc123e-0000-0000-0000-000000000001'
        await makeSubagentSession(saDir, {
          name: `1111111111_${idA}.jsonl`,
          id: idA,
          cwd: '/demo',
        })
        // subagent B：sessionId 不含 abc123，但 manifest.task 含 abc123
        const idB = '0aaaaaaa-bbbb-cccc-dddd-000000000006'
        const subPathB = await makeSubagentSession(saDir, {
          name: `2222222222_${idB}.jsonl`,
          id: idB,
          cwd: '/demo',
        })
        await makeRecordManifest(recordsDir, {
          id: `sa-${idB}`,
          rootSessionId: 'root-6',
          sessionFile: subPathB,
          task: '任务包含 abc123 关键词',
        })

        // 'abc123' 全十六进制 → uuid 特征；A 的 sessionId 含 abc123 → uuid 片段命中 → 短路
        const { matches } = await findSessions('abc123', agentDir)
        expect(matches).toHaveLength(1)
        expect(matches[0].sessionId).toBe(idA)
        // B 不入选（uuid 命中短路，不走 task 匹配）
        expect(matches.some((m) => m.sessionId === idB)).toBe(false)
      })
    })

    it('uuid 片段命中候选补全元数据：fileName/mtime/sizeBytes 真实值（019e6c96 锚）', async () => {
      // 2 条 session、恰 1 条 id 含片段 'e6c96'：uuid 片段路径命中后仍补读元数据字段。
      // 命中文件按真实 pi 落盘命名（<id>.jsonl），fileName 断言含该 id
      await makeSession(slugDir, { name: `${FIX_E6}.jsonl`, id: FIX_E6, cwd: '/demo' })
      await makeSession(slugDir, { name: 'other.jsonl', id: '019ffff-cccc-dddd', cwd: '/demo' })

      const { matches } = await findSessions('e6c96', agentDir)
      expect(matches.length).toBeGreaterThan(0)
      const hit = matches.find((m) => m.sessionId.startsWith('019e6c96'))!
      expect(hit.fileName).toContain('019e6c96')
      expect(hit.mtime).toBeGreaterThan(0)
      expect(hit.sizeBytes).toBeGreaterThan(0)
    })
  })

  // ============================================================
  // u11：标题元数据 metadataProvider 注入（design 2026-09-10 §6.6）
  // 覆盖三条调用策略中的 ①惰性 ②窄化（TTL 缓存句柄在 tool-handler 注入侧，
  // 见 tool-handler.test.ts u11 段）+ 两条 guard + §11.3b 多目录合并语义
  // + 纯 TS 首条 user 降级路径保留。
  // provider 一律注入替身（不真调 pi SessionManager）。
  // ============================================================
  describe('u11 标题元数据（metadataProvider 注入，§6.6）', () => {
    let root: string
    let agentDir: string
    /** 平铺 main 根（taiji 形态：session 直在 sessions/ 下，[default] 根无子目录） */
    let flatMain: string
    /** legacy 根（dirname(agentDir)/sessions） */
    let legacyDir: string

    async function writeSession(
      dir: string,
      opts: { name: string; id: string; cwd?: string; firstUserText?: string },
    ): Promise<string> {
      await mkdir(dir, { recursive: true })
      const lines = [JSON.stringify({ type: 'session', id: opts.id, cwd: opts.cwd ?? '/demo' })]
      if (opts.firstUserText !== undefined) {
        lines.push(
          JSON.stringify({
            type: 'message',
            id: `${opts.id}-m1`,
            message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
          }),
        )
      }
      const path = join(dir, opts.name)
      await writeFile(path, lines.join('\n') + '\n')
      return path
    }

    beforeEach(async () => {
      // agentDir 挂在 mkdtemp 子目录下，legacy 根（dirname(agentDir)/sessions）仍在
      // 自建 tmp 树内，不污染共享 tmpdir（也不受其他用例残留影响）
      root = await mkdtemp(join(tmpdir(), 'find-u11-'))
      agentDir = join(root, 'agent')
      flatMain = join(agentDir, 'sessions')
      legacyDir = join(root, 'sessions')
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('① 惰性触发：uuid 精确/归一化路径不调 provider（spy 计数 0）', async () => {
      await writeSession(flatMain, { name: 'a.jsonl', id: '019cafe00001', firstUserText: '无关' })
      const provider = vi.fn(async () => [])
      // 精确子串层命中
      await findSessions('019cafe00001', agentDir, { metadataProvider: provider })
      expect(provider).not.toHaveBeenCalled()
      // 归一化层命中（大写变体：精确层大小写敏感 0 命中，norm 层命中后短路）
      await findSessions('019CAFE00001', agentDir, { metadataProvider: provider })
      expect(provider).not.toHaveBeenCalled()
    })

    it('② keyword 路径调用 provider 且标题进匹配（name 命中，preview 取元数据首消息免深读）', async () => {
      const pathA = await writeSession(flatMain, {
        name: 'a.jsonl',
        id: 'title-aaaa',
        firstUserText: '首消息完全无关',
      })
      await writeSession(flatMain, { name: 'b.jsonl', id: 'title-bbbb', firstUserText: '另一个无关会话' })
      const provider = vi.fn(async (dir: string) =>
        dir === flatMain
          ? [
              {
                path: pathA,
                id: 'title-aaaa',
                cwd: '/demo',
                name: '福耀玻璃深度研究',
                modified: new Date('2026-09-01'),
                firstMessage: '首消息完全无关',
              },
            ]
          : [],
      )
      const { matches } = await findSessions('福耀玻璃', agentDir, { metadataProvider: provider })
      // 平铺存在的 [default] 根被调用，且永传非空串
      expect(provider).toHaveBeenCalledTimes(1)
      expect(provider.mock.calls[0][0]).toBe(flatMain)
      expect(provider.mock.calls[0][0].length).toBeGreaterThan(0)
      // 标题命中：name 透传 + preview 取元数据 firstMessage
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('title-aaaa')
      expect(matches[0].name).toBe('福耀玻璃深度研究')
      expect(matches[0].firstMessagePreview).toBe('首消息完全无关')
    })

    it('③ 窄化：含子目录根跳过 provider，候选不退出 keyword 匹配（回退首条 user，标题留空）', async () => {
      // 纯 pi 形态：文件在 encodeCwd 子目录 → [default] 根含子目录 → listAll 跳过
      await writeSession(join(flatMain, '--Users-demo--'), {
        name: 'a.jsonl',
        id: 'nested-aaaa',
        firstUserText: '重构插件架构 plugin review',
      })
      const provider = vi.fn(async () => [])
      const { matches } = await findSessions('plugin', agentDir, { metadataProvider: provider })
      expect(provider).not.toHaveBeenCalled()
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('nested-aaaa')
      expect(matches[0].firstMessagePreview).toContain('plugin')
      // 标题维度降级留空：「能找到 session」不受影响（§6.6 降级路径）
      expect(matches[0].name).toBeUndefined()
    })

    it('④ guard：provider 抛错降级（标题留空 + 不抛，回退首条 user 匹配）', async () => {
      await writeSession(flatMain, {
        name: 'a.jsonl',
        id: 'err-aaaa',
        firstUserText: '按首条消息命中的文本',
      })
      const provider = vi.fn(async () => {
        throw new Error('listAll boom')
      })
      const { matches } = await findSessions('按首条消息命中', agentDir, {
        metadataProvider: provider,
      })
      expect(provider).toHaveBeenCalledTimes(1) // 调用了但抛错
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe('err-aaaa')
      expect(matches[0].name).toBeUndefined()
      expect(matches[0].firstMessagePreview).toContain('按首条消息命中')
    })

    it('⑤ 多目录结果合并：按 id 去重、重复取新 modified（§11.3b）', async () => {
      const pathA = await writeSession(flatMain, {
        name: 'a.jsonl',
        id: 'dup-id-0001',
        firstUserText: '无关',
      })
      // legacy 根平铺存在（0 文件也算存在根，isFlatRoot 空集恒真）
      await mkdir(legacyDir, { recursive: true })
      const provider = vi.fn(async (dir: string) =>
        dir === flatMain
          ? [{ path: pathA, id: 'dup-id-0001', cwd: '/demo', name: '旧标题', modified: new Date(1000) }]
          : [{ path: pathA, id: 'dup-id-0001', cwd: '/demo', name: '新标题', modified: new Date(2000) }],
      )
      const { matches } = await findSessions('新标题', agentDir, { metadataProvider: provider })
      expect(provider).toHaveBeenCalledTimes(2) // 两个平铺存在的根各一次
      expect(matches).toHaveLength(1)
      expect(matches[0].name).toBe('新标题') // 同 id 重复 → 取新 modified 的条目
      const miss = await findSessions('旧标题', agentDir, { metadataProvider: provider })
      expect(miss.matches).toHaveLength(0) // 旧条目已按合并规则丢弃
    })

    it('⑥ guard：仅对存在的根调用且永传非空串（不存在根 / 不存在 liveSessionDir 不调）', async () => {
      await writeSession(flatMain, { name: 'a.jsonl', id: 'guard-aaaa', firstUserText: '无关' })
      const provider = vi.fn(async () => [])
      await findSessions('zzznohit9q', agentDir, {
        liveSessionDir: join(agentDir, 'no-such-dir'),
        metadataProvider: provider,
      })
      // 仅平铺存在的 [default] 根被调；不存在的 liveSessionDir 与 [legacy] 根均被排除
      expect(provider).toHaveBeenCalledTimes(1)
      expect(provider.mock.calls[0][0]).toBe(flatMain)
      expect(provider.mock.calls.every((c) => typeof c[0] === 'string' && c[0].length > 0)).toBe(true)
    })

    it('⑥b liveSessionDir 与平铺根同字面路径 → 同目录只调一次（字面路径去重）', async () => {
      await writeSession(flatMain, { name: 'a.jsonl', id: 'dedup-aaaa', firstUserText: '无关' })
      const provider = vi.fn(async () => [])
      await findSessions('zzznohit9q', agentDir, {
        liveSessionDir: flatMain,
        metadataProvider: provider,
      })
      expect(provider).toHaveBeenCalledTimes(1)
      expect(provider.mock.calls[0][0]).toBe(flatMain)
    })

    it('⑦ recent：仅对 limit 截断后的少数候选补元数据（旧候选所在根不调）', async () => {
      const pNew1 = await writeSession(flatMain, { name: 'n1.jsonl', id: 'recent-new-1' })
      const pNew2 = await writeSession(flatMain, { name: 'n2.jsonl', id: 'recent-new-2' })
      await writeSession(legacyDir, { name: 'o1.jsonl', id: 'recent-old-1' })
      await writeSession(legacyDir, { name: 'o2.jsonl', id: 'recent-old-2' })
      const base = Math.floor(Date.now() / 1000)
      await utimes(pNew1, base + 300, base + 300)
      await utimes(pNew2, base + 200, base + 200)
      await utimes(join(legacyDir, 'o1.jsonl'), base + 100, base + 100)
      await utimes(join(legacyDir, 'o2.jsonl'), base + 50, base + 50)
      const provider = vi.fn(async (dir: string) =>
        dir === flatMain
          ? [
              { path: pNew1, id: 'recent-new-1', cwd: '/demo', name: '最新标题一', modified: new Date((base + 300) * 1000) },
              { path: pNew2, id: 'recent-new-2', cwd: '/demo', name: '最新标题二', modified: new Date((base + 200) * 1000) },
            ]
          : [],
      )
      const { matches, truncated } = await findSessions('recent', agentDir, {
        limit: 2,
        metadataProvider: provider,
      })
      expect(truncated).toBe(true)
      expect(matches.map((m) => m.sessionId)).toEqual(['recent-new-1', 'recent-new-2'])
      // provider 只调最新两个候选所在的平铺根；被截断的 legacy 根候选不触发补元数据
      expect(provider).toHaveBeenCalledTimes(1)
      expect(provider.mock.calls[0][0]).toBe(flatMain)
      // 截断后少数候选补到标题
      expect(matches[0].name).toBe('最新标题一')
      expect(matches[1].name).toBe('最新标题二')
    })
  })
});

// ======== 来源：result.test.ts ========
describe("result", () => {
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

  // ---- fixture 工具（合成 subagent session，同 tool-handler.test.ts makeFixtureSubagent 结构；
  // [session-store-layout-inversion] 新布局存储树，分区键 = manifest.rootSessionId 常量）----

  /** 存储树分区 sid fixture（合法 pi sid 形态；与 makeSubagent 内 manifest.rootSessionId 同值）。 */
  const FIX_ROOT_SID = '0aaaaaaa-bbbb-7ccc-dddd-0000000000r1'

  interface SubagentFixture { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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
    const sessionsDir = resolveStoreSubagentSessionsDir(dir, FIX_ROOT_SID)
    const sessionFile = join(sessionsDir, `${f.realId}.jsonl`)
    if (f.sessionFileExists !== false) {
      await mkdir(sessionsDir, { recursive: true })
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
    const recordsDir = resolveStoreSubagentRecordsDir(dir, FIX_ROOT_SID)
    await mkdir(recordsDir, { recursive: true })
    await writeFile(
      join(recordsDir, `${f.saId}.json`),
      JSON.stringify({
        id: f.saId,
        rootSessionId: FIX_ROOT_SID,
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
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'session-reader-result-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
          `${join(resolveStoreSubagentSessionsDir(dir, FIX_ROOT_SID), `${realId}.jsonl`)}` +
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

  it('6. 不存在 id：sa-id 无 manifest → zcode_record_not_found（U9 统一错误范围）；uuid 片段零匹配 → 无匹配 session', async () => {
    await expect(
      handleSessionRead({ action: 'result', session: 'sa-nonexist-9999' }, { agentDir: dir }),
    ).rejects.toThrow(/zcode_record_not_found/)
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
});

// ======== 来源：tool-handler.test.ts ========
describe("tool-handler", () => {
  /**
 * M3 tool-handler 集成测试。
 *
 * 测试框架 vitest（禁止 node:test/tsx）。直接调 handleSessionRead（纯逻辑，agentDir 注入），
 * agentDir 全部指向 mkdtemp 自建自删的 fixture 目录（按断言逻辑构造的最小 session 文件，
 * 不读本机真实用户数据目录），fixture 生命周期与各 describe 的 beforeEach/afterEach 绑定。
 *
 * 覆盖全 11 action 主路径 + F1(find 零匹配)/F4(turn 越界)/F5(缺参)/resolveSessionId 片段等价，
 * 以及 u8 doctor / u9 归一化 / u10 find 分组 / u11 metadataProvider 缓存 / u12 跨会话检索（各见对应 describe）。
 */

  describe('handleSessionRead', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）
    const SLUG = '--demo-cwd--'
    // 家族 fixture 组：根 FAM → fork 子代 FORK（跨 cwd，parentSession 指 FAM 文件）
    // → 隔代 subagent SUB2（rootSessionId=FORK）。前缀互异，断言按 id 精确区分层级。
    const FAM = '019fe620-8ae1-78a7-b76a-43a1ba4cc3c7'
    const FORK = '019fe632-aaaa-7bbb-8ccc-00000000fe32'
    const SUB2 = '019fe635-aaaa-7bbb-8ccc-00000000fe35'

    /**
   * 主 fixture session（FIX_E6）：2 turn 的最小多形态 session——
   * - T000 含 toolCall + toolResult（detail 摘要态断言），文本含 'plugin'（search 断言）
   * - T001 纯文本收尾（outline 计数 / fragment 等价断言）
   * 另加 1 条无关 session（id 不含 e6c96）：find 片段全扫「多条候选恰一条命中」语义。
   */
    async function writeMainFixtures(): Promise<void> {
      const sessionDir = join(dir, 'sessions', SLUG)
      await mkdir(sessionDir, { recursive: true })
      const msg = (id: string, parentId: string, message: Record<string, unknown>): string =>
        JSON.stringify({ type: 'message', id, parentId, message })
      const e6Lines = [
        JSON.stringify({ type: 'session', id: FIX_E6, cwd: '/demo' }),
        msg(`${FIX_E6}-m0`, FIX_E6, {
          role: 'user',
          content: [{ type: 'text', text: '调研 plugin 架构怎么落地' }],
        }),
        msg(`${FIX_E6}-m1`, `${FIX_E6}-m0`, {
          role: 'assistant',
          content: [
            { type: 'text', text: '先看现有目录结构' },
            { type: 'toolCall', id: 'tc-e6-1', name: 'bash', arguments: { command: 'ls src' } },
          ],
        }),
        msg(`${FIX_E6}-m2`, `${FIX_E6}-m1`, {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc-e6-1',
          content: [{ type: 'text', text: 'src/plugin.ts' }],
        }),
        msg(`${FIX_E6}-m3`, `${FIX_E6}-m2`, {
          role: 'user',
          content: [{ type: 'text', text: '继续深入' }],
        }),
        msg(`${FIX_E6}-m4`, `${FIX_E6}-m3`, {
          role: 'assistant',
          content: [{ type: 'text', text: '完成，共两轮。' }],
        }),
      ]
      await writeFile(join(sessionDir, `${FIX_E6}.jsonl`), e6Lines.join('\n') + '\n')
      await makeFixtureSession(dir, '019ffff-aaaa-bbbb-cccc-00000000ffff', '无关会话')
    }

    /** 家族 fixture：FAM 根 + FORK（跨 cwd fork）+ 挂在 FORK 下的隔代 subagent（manifest 建族）。 */
    async function writeFamilyFixtures(): Promise<void> {
      const famPath = join(dir, 'sessions', SLUG, `${FAM}.jsonl`)
      await writeFile(famPath, JSON.stringify({ type: 'session', id: FAM, cwd: '/demo' }) + '\n')
      const forkDir = join(dir, 'sessions', '--fork-cwd--')
      await mkdir(forkDir, { recursive: true })
      await writeFile(
        join(forkDir, `${FORK}.jsonl`),
        JSON.stringify({ type: 'session', id: FORK, cwd: '/fork', parentSession: famPath }) + '\n',
      )
      await makeFixtureSubagent(dir, 'sa-fe635', { realSessionId: SUB2, rootSessionId: FORK })
    }

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-main-'))
      dir = join(dataDir, 'agent')
      await writeMainFixtures()
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('1. find by uuid fragment returns matching session', async () => {
      const r = await handleSessionRead({ action: 'find', query: 'e6c96' }, { agentDir: dir })
      const d = r.details as { matches: Array<{ sessionId: string }> }
      expect(d.matches.some((m) => m.sessionId.startsWith('019e6c96'))).toBe(true)
      expect(r.content[0]).toEqual({ type: 'text', text: expect.any(String) })
    })

    it('2. outline yields all turns within token budget (v2 O1: <=1500)', async () => {
      const r = await handleSessionRead({ action: 'outline', session: FIX_E6 }, { agentDir: dir })
      const d = r.details as { turns: unknown[]; tokenEstimate: number }
      expect(d.turns.length).toBe(2)
      // v2 O1：加 assistantBrief + 修 toolSummary bug 后阈值 1500（design §3.3 D4）
      expect(d.tokenEstimate).toBeLessThanOrEqual(1500)
    })

    it('3. detail single turn returns toolResult summary by default (v2 O3)', async () => {
      // fixture 的 T000 是含 toolCall + toolResult 的 turn
      const r = await handleSessionRead({ action: 'detail', session: FIX_E6, turns: 'T000' }, { agentDir: dir })
      const d = r.details as { entries: Array<{ type: string; message?: { role?: string } }> }
      expect(d.entries.length).toBeGreaterThan(0)
      // v2 O3：默认 toolResult 变摘要态（type=toolResultSummary），条目不消失
      expect(d.entries.some((e) => e.type === 'toolResultSummary')).toBe(true)
      // 不再有 role=toolResult 的原文 entry（除非 includeToolResult:true）
      expect(d.entries.some((e) => e.message?.role === 'toolResult')).toBe(false)
    })

    it('4. family lists fork children and隔代 subagents', async () => {
      await writeFamilyFixtures()
      const r = await handleSessionRead({ action: 'family', session: FAM }, { agentDir: dir })
      const d = r.details as {
        forks: Array<{ sessionId: string }>
        subagents: Array<{ sessionId: string }>
      }
      expect(d.forks.some((f) => f.sessionId === FORK)).toBe(true)
      // 隔代：SUB2.rootSessionId=FORK（fork 子代），从家族根 FAM 出发仍能关联
      expect(d.subagents.some((s) => s.sessionId === SUB2)).toBe(true)
    })

    it('5. search pattern returns hits', async () => {
      const r = await handleSessionRead({ action: 'search', session: FIX_E6, pattern: 'plugin' }, { agentDir: dir })
      const d = r.details as { hits: Array<{ turnIndex: number; matchSnippet: string }> }
      expect(d.hits.length).toBeGreaterThan(0)
      expect(typeof d.hits[0].matchSnippet).toBe('string')
    })

    it('6. export outline materializes a .md file under the session store tree', async () => {
      // export 写目标 = <dataDir>/ext-sessions/<sid>/session-view.md（session-store-layout-
      // inversion 域 6）：agentDir 参数 = <dataDir>/agent（mkdtemp tmp 子目录，导出树随 tmp
      // 整体清理）；读侧经 liveSessionDir=[live] 根扫本 describe 的 fixture sessions 目录。
      const dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-export-'))
      try {
        const r = await handleSessionRead(
          { action: 'export', session: FIX_E6, format: 'outline' },
          { agentDir: join(dataDir, 'agent'), liveSessionDir: join(dir, 'sessions') },
        )
        const d = r.details as { path: string; sizeBytes: number }
        expect(d.path).toBe(join(dataDir, 'ext-sessions', FIX_E6, 'session-view.md'))
        expect(existsSync(d.path)).toBe(true)
        expect(d.sizeBytes).toBeGreaterThan(0)
      } finally {
        await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    // source:'main' 收窄到 main 侧（显式 source 查询走单组原语义，见 TC12/TC13）
    it('7. F1 find zero match returns empty matches + fact-based self-check (no throw)', async () => {
      const r = await handleSessionRead(
        { action: 'find', query: 'zzz-nonexistent-session-9q8x2', source: 'main' },
        { agentDir: dir },
      )
      const d = r.details as { matches: unknown[]; truncated: boolean }
      expect(d.matches).toEqual([])
      expect(d.truncated).toBe(false)
      // u9 F1 重写（§5.2）：事实型自检 + 无归因断言 + 无「recent 看全量」误导
      expect(r.content[0].text).toContain('无匹配 session')
      expect(r.content[0].text).toContain('自检（发现层，只陈述事实）')
      expect(r.content[0].text).not.toContain('真的没有')
      expect(r.content[0].text).not.toContain('recent')
    })

    it('8. F4 detail turn out of range throws with 越界', async () => {
      await expect(
        handleSessionRead({ action: 'detail', session: FIX_E6, turns: 'T999' }, { agentDir: dir }),
      ).rejects.toThrow(/越界/)
    })

    it('9. F5 outline missing session throws naming session', async () => {
      await expect(handleSessionRead({ action: 'outline' }, { agentDir: dir })).rejects.toThrow(/session/)
    })

    it('10. resolveSessionId fragment equivalent to full id', async () => {
      const rFull = await handleSessionRead({ action: 'outline', session: FIX_E6 }, { agentDir: dir })
      const rFrag = await handleSessionRead({ action: 'outline', session: 'e6c96' }, { agentDir: dir })
      const dFull = rFull.details as { turns: unknown[] }
      const dFrag = rFrag.details as { turns: unknown[] }
      expect(dFrag.turns.length).toBe(dFull.turns.length)
    })
  })

  describe('extract (v2 O4)', () => {
    let dir: string
    let dataDir: string
    const SLUG = '--demo-cwd--'

    /**
   * extract fixture session（FIX_E6）：3 user turn 的最小多素材形态——
   * - T000：bash git log（commits git-cmd 主路径：def5678a）+ bash ls + read
   *  （commits commit-context 次路径：abc1234f，hash 邻近含 'feat:'）
   * - T001：edit（files op 素材）
   * - T002：纯文本收尾
   * 计数锚：user 3 / toolCall 4（bash 2）/ toolResult 4（bash 2）。
   */
    async function writeExtractFixture(): Promise<void> {
      const sessionDir = join(dir, 'sessions', SLUG)
      await mkdir(sessionDir, { recursive: true })
      const msg = (id: string, parentId: string, message: Record<string, unknown>): string =>
        JSON.stringify({ type: 'message', id, parentId, message })
      const lines = [
        JSON.stringify({ type: 'session', id: FIX_E6, cwd: '/demo' }),
        msg(`${FIX_E6}-m0`, FIX_E6, {
          role: 'user',
          content: [{ type: 'text', text: '第一条：查一下最近的提交' }],
        }),
        msg(`${FIX_E6}-m1`, `${FIX_E6}-m0`, {
          role: 'assistant',
          content: [
            { type: 'text', text: '好，先看 git 记录' },
            { type: 'toolCall', id: 'tc-git', name: 'bash', arguments: { command: 'git log --oneline -3' } },
          ],
        }),
        msg(`${FIX_E6}-m2`, `${FIX_E6}-m1`, {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc-git',
          content: [{ type: 'text', text: 'def5678a feat: fix crash' }],
        }),
        msg(`${FIX_E6}-m3`, `${FIX_E6}-m2`, {
          role: 'assistant',
          content: [
            { type: 'text', text: '再看下文件列表' },
            { type: 'toolCall', id: 'tc-ls', name: 'bash', arguments: { command: 'ls src' } },
          ],
        }),
        msg(`${FIX_E6}-m4`, `${FIX_E6}-m3`, {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc-ls',
          content: [{ type: 'text', text: 'src/index.ts' }],
        }),
        msg(`${FIX_E6}-m5`, `${FIX_E6}-m4`, {
          role: 'assistant',
          content: [
            { type: 'text', text: '读一下说明' },
            { type: 'toolCall', id: 'tc-read', name: 'read', arguments: { path: '/repo/README.md' } },
          ],
        }),
        msg(`${FIX_E6}-m6`, `${FIX_E6}-m5`, {
          role: 'toolResult',
          toolName: 'read',
          toolCallId: 'tc-read',
          content: [{ type: 'text', text: 'deploy abc1234f done\nfeat: add login' }],
        }),
        msg(`${FIX_E6}-m7`, `${FIX_E6}-m6`, {
          role: 'user',
          content: [{ type: 'text', text: '第二条：改代码' }],
        }),
        msg(`${FIX_E6}-m8`, `${FIX_E6}-m7`, {
          role: 'assistant',
          content: [
            { type: 'text', text: '来改' },
            {
              type: 'toolCall',
              id: 'tc-edit',
              name: 'edit',
              arguments: { path: '/repo/src/app.ts', edits: [{ oldText: 'a', newText: 'b' }] },
            },
          ],
        }),
        msg(`${FIX_E6}-m9`, `${FIX_E6}-m8`, {
          role: 'toolResult',
          toolName: 'edit',
          toolCallId: 'tc-edit',
          content: [{ type: 'text', text: 'ok' }],
        }),
        msg(`${FIX_E6}-m10`, `${FIX_E6}-m9`, {
          role: 'user',
          content: [{ type: 'text', text: '第三条：完成' }],
        }),
        msg(`${FIX_E6}-m11`, `${FIX_E6}-m10`, {
          role: 'assistant',
          content: [{ type: 'text', text: '全部完成。' }],
        }),
      ]
      await writeFile(join(sessionDir, `${FIX_E6}.jsonl`), lines.join('\n') + '\n')
    }

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-extract-'))
      dir = join(dataDir, 'agent')
      await writeExtractFixture()
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('user-messages returns all user entries with turn + full text', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'user-messages' },
        { agentDir: dir },
      )
      const d = r.details as {
        what: string
        count: number
        shown: number
        truncated: boolean
        items: Array<{ turn: number; text: string }>
      }
      expect(d.what).toBe('user-messages')
      expect(d.count).toBe(3) // 全量 user entry 计数锚（fixture 3 条 user）
      // F9 预算可能截断：items 是 shown 子集，shown <= count
      expect(d.shown).toBeLessThanOrEqual(d.count)
      expect(d.items.length).toBe(d.shown)
      expect(d.items.length).toBeGreaterThan(0)
      expect(
        d.items.every((it) => typeof it.turn === 'number' && typeof it.text === 'string'),
      ).toBe(true)
    })

    it('commands (no filter) returns all tool calls with name + summary', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'commands' },
        { agentDir: dir },
      )
      const d = r.details as {
        count: number
        shown: number
        items: Array<{ name: string; summary: string }>
      }
      expect(d.count).toBe(4) // 全量 toolCall 计数锚（fixture：bash×2 + read + edit）
      expect(d.shown).toBeLessThanOrEqual(d.count)
      expect(d.items.length).toBe(d.shown)
      expect(
        d.items.every((it) => typeof it.name === 'string' && typeof it.summary === 'string'),
      ).toBe(true)
      // 抽查 bash summary 含 "bash: "（D1 映射）
      const bashItem = d.items.find((it) => it.name === 'bash')
      if (bashItem !== undefined) {
        expect(bashItem.summary).toContain('bash: ')
      }
    })

    it('commands tool=bash returns 2 all bash', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'commands', tool: 'bash' },
        { agentDir: dir },
      )
      const d = r.details as {
        count: number
        shown: number
        items: Array<{ name: string }>
      }
      expect(d.count).toBe(2) // bash toolCall 全量（F9 可能截断 shown 子集）
      expect(d.items.every((it) => it.name === 'bash')).toBe(true)
    })

    it('commands tool=nonexist triggers F8 with tool distribution (no throw)', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'commands', tool: 'nonexist' },
        { agentDir: dir },
      )
      const d = r.details as {
        toolDistribution: Array<{ name: string; count: number }>
      }
      expect(r.content[0].text).toContain('无匹配')
      expect(r.content[0].text).toContain('bash×2')
      expect(r.content[0].text).toContain('👉')
      expect(d.toolDistribution.some((t) => t.name === 'bash' && t.count === 2)).toBe(true)
    })

    it('files returns deduped paths with op (read/edit/write/head)', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'files' },
        { agentDir: dir },
      )
      const d = r.details as {
        count: number
        items: Array<{ path: string; basename: string; op: string; turns: number[] }>
      }
      expect(d.count).toBeGreaterThan(0)
      expect(d.items.length).toBeGreaterThan(0)
      // 抽查含 .ts 或 .md 文件
      expect(
        d.items.some((it) => it.path.endsWith('.ts') || it.path.endsWith('.md')),
      ).toBe(true)
      // op 含 read/edit/write/head 之一
      expect(d.items.some((it) => /read|edit|write|head/.test(it.op))).toBe(true)
      // turns 是数组（去重后出现过的轮次）
      expect(d.items.every((it) => Array.isArray(it.turns))).toBe(true)
    })

    it('commits returns hash list with 7-8 hex + source turn', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'commits' },
        { agentDir: dir },
      )
      const d = r.details as {
        count: number
        items: Array<{ hash: string; turn: number; source: string; context: string }>
      }
      // git-cmd 主路径（bash git log 结果）取到 hash
      expect(d.count).toBeGreaterThan(0)
      // commits 已知会误匹配/漏报（D6），只验每条格式
      for (const it of d.items) {
        expect(it.hash).toMatch(/^[0-9a-f]{7,8}$/)
        expect(typeof it.turn).toBe('number')
        expect(['git-cmd', 'commit-context']).toContain(it.source)
      }
    })

    it('tool-results (no filter) returns all results with toolName + text', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'tool-results' },
        { agentDir: dir },
      )
      const d = r.details as {
        count: number
        shown: number
        items: Array<{ toolName: string; text: string }>
      }
      expect(d.count).toBe(4) // 全量 toolResult 计数锚（fixture 4 条）
      expect(d.shown).toBeLessThanOrEqual(d.count)
      expect(
        d.items.every((it) => typeof it.toolName === 'string' && typeof it.text === 'string'),
      ).toBe(true)
    })

    it('tool-results tool=bash returns 2 all bash', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'tool-results', tool: 'bash' },
        { agentDir: dir },
      )
      const d = r.details as { count: number; items: Array<{ toolName: string }> }
      expect(d.count).toBe(2)
      expect(d.items.every((it) => it.toolName === 'bash')).toBe(true)
    })

    it('tool-results tool=nonexist triggers F8 (no throw)', async () => {
      const r = await handleSessionRead(
        { action: 'extract', session: FIX_E6, what: 'tool-results', tool: 'nonexist' },
        { agentDir: dir },
      )
      expect(r.content[0].text).toContain('无匹配')
      expect(r.content[0].text).toContain('bash×2')
    })

    it('F7 missing what throws with 无效 + valid values', async () => {
      // what 缺失是合法 SessionReadParams（optional），handler 层 F7 防御校验。
      // isExtractWhat 对 undefined 返 false → 同一 throw 路径，覆盖非法值场景。
      const params: SessionReadParams = { action: 'extract', session: FIX_E6 }
      await expect(handleSessionRead(params, { agentDir: dir })).rejects.toThrow(/无效/)
      await expect(handleSessionRead(params, { agentDir: dir })).rejects.toThrow(
        /user-messages\/commands\/files\/commits\/tool-results/,
      )
    })

    it('S2: extract turns 越界文案说明 extract turn 体系（不指向 outline）', async () => {
      // extract 用全量 entry 分段（含 compaction/旁支），turn index 与 outline leaf 视图不对齐
      let msg = ''
      try {
        await handleSessionRead(
          { action: 'extract', session: FIX_E6, what: 'user-messages', turns: 'T999' },
          { agentDir: dir },
        )
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toContain('extract 的 turn 范围与 outline 不同')
      expect(msg).not.toContain('用 outline 重看有效范围')
      expect(msg).toContain('该 session extract 共')
    })
  })

  // ---- fixture 工具（tmpdir 造最小 session 文件，供 F2/MF-5 用例）----

  async function makeFixtureSession(
    dir: string,
    id: string,
    firstUserText: string,
  ): Promise<void> {
    const slug = '--demo-cwd--'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: id + '-m1',
        parentId: id,
        message: { role: 'user', content: [{ type: 'text', text: firstUserText }] },
      }),
    ]
    await writeFile(join(dir, 'sessions', slug, id + '.jsonl'), lines.join('\n') + '\n')
  }

  describe('F2 多匹配消歧（fixture，MF-9）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，[session-store-layout-inversion]）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-f2-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('共享 uuid 片段 → 不抛错，content 含两候选 + 👉，details.ambiguous=true', async () => {
      const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
      const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'
      await makeFixtureSession(dir, ID1, '第一段内容')
      await makeFixtureSession(dir, ID2, '第二段内容')

      // outline 走 resolveSessionId → 2 匹配 → F2 消歧（不抛错）
      const r = await handleSessionRead({ action: 'outline', session: '019e6c96-aaaa' }, { agentDir: dir })
      const d = r.details as { ambiguous: boolean; candidates: Array<{ sessionId: string }> }
      expect(d.ambiguous).toBe(true)
      expect(d.candidates).toHaveLength(2)
      expect(d.candidates.some((c) => c.sessionId === ID1)).toBe(true)
      expect(d.candidates.some((c) => c.sessionId === ID2)).toBe(true)
      const text = r.content[0].text
      expect(text).toContain(ID1)
      expect(text).toContain(ID2)
      expect(text).toContain('👉')
    })

    it('search/detail/expand/extract 同样走 F2 消歧（不抛错）', async () => {
      const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
      const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'
      await makeFixtureSession(dir, ID1, '第一段内容')
      await makeFixtureSession(dir, ID2, '第二段内容')

      for (const action of ['detail', 'expand', 'search', 'export', 'extract'] as const) {
        const params: SessionReadParams = { action, session: '019e6c96-aaaa' }
        if (action === 'detail') params.turns = 'T001'
        if (action === 'expand') params.turn = 'T001'
        if (action === 'search') params.pattern = 'x'
        if (action === 'extract') params.what = 'user-messages'
        const r = await handleSessionRead(params, { agentDir: dir })
        const d = r.details as { ambiguous: boolean }
        expect(d.ambiguous, `action=${action}`).toBe(true)
        expect(r.content[0].text).toContain('👉')
      }
    })
  })

  describe('outline skippedLines 报告（fixture，D8d 有检测必有报告）', () => {
    let dir: string
    let dataDir: string
    const SID = '019e6c96-bbbb-cccc-dddd-00000000000b'

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-skipped-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('坏行计入 stats.skippedLines 且文本尾部可见（不静默跳过）', async () => {
      // 中间注入 1 行坏 JSON（半截对象）：parser 计 skippedLines=1，outline 必须报告
      const slug = '--demo-cwd--'
      await mkdir(join(dir, 'sessions', slug), { recursive: true })
      const lines = [
        JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
        JSON.stringify({
          type: 'message',
          id: SID + '-m1',
          parentId: SID,
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        }),
        '{"broken json line',
      ]
      await writeFile(join(dir, 'sessions', slug, SID + '.jsonl'), lines.join('\n') + '\n')

      const r = await handleSessionRead({ action: 'outline', session: SID }, { agentDir: dir })
      const d = r.details as { stats: { skippedLines: number } }
      expect(d.stats.skippedLines).toBe(1)
      expect(r.content[0].text).toContain('1 skipped lines')
    })

    it('无坏行时不输出 skipped 片段（正常 session 零噪音）', async () => {
      await makeFixtureSession(dir, SID, 'clean session')
      const r = await handleSessionRead({ action: 'outline', session: SID }, { agentDir: dir })
      const d = r.details as { stats: { skippedLines: number } }
      expect(d.stats.skippedLines).toBe(0)
      expect(r.content[0].text).not.toContain('skipped lines')
    })
  })

  // ============================================================
  // E7：行渲染统一（ext-simplify-04 U5，design D3）。outline 与 export {format:"outline"}
  // 共用 renderOutline 返回的渲染行（OutlineResult.lines）+ 同一尾段拼装——预算度量 =
  // 展示 by construction；旁支标记统一为 `[旁支 N entries]`（改前 handler 侧第二份行
  // 格式知识输出裸 `[旁支]`，已随 formatOutlineText 删除）。
  // ============================================================
  describe('E7 行渲染统一（outline 与 export outline 同一渲染行）', () => {
    let dir: string
    let dataDir: string
    const SID = '019e6c96-bbbb-cccc-dddd-00000000000e'

    /** 写含 fork 旁支的 session：主链 R→m1(user)→m2(assistant)，b1/b2 挂 m1 下成
   * 旁支子树（buildTreeView：branches[m1]=2；segmentTurns：单 turn [m1, m2]，
   * 旁支 entry 不进 leaf 视图）。 */
    async function writeForkSession(): Promise<void> {
      await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
      const msg = (id: string, parentId: string, role: 'user' | 'assistant', text: string) =>
        JSON.stringify({
          type: 'message',
          id: `${SID}-${id}`,
          parentId,
          message: { role, content: [{ type: 'text', text }] },
        })
      const lines = [
        JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
        msg('m1', SID, 'user', 'fork point turn'),
        msg('b1', `${SID}-m1`, 'assistant', 'branch one'),
        msg('b2', `${SID}-m1`, 'assistant', 'branch two'),
        msg('m2', `${SID}-m1`, 'assistant', 'main line answer'),
      ]
      await writeFile(join(dir, 'sessions', '--demo-cwd--', `${SID}.jsonl`), lines.join('\n') + '\n')
    }

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-e7-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('① allBranches:true → 旁支行标记 `[旁支 N entries]`（N=forkPoint 旁支子树 entry 数）+ 尾段同改前语义', async () => {
      await writeForkSession()
      const r = await handleSessionRead(
        { action: 'outline', session: SID, allBranches: true },
        { agentDir: dir },
      )
      const text = r.content[0].text
      // 旁支标记带 entry 数；裸 `[旁支]` 旧形态零出现（'[旁支]' 与 '[旁支 2 entries]' 互不为子串）
      expect(text).toContain('T000 · fork point turn · → main line answer · [旁支 2 entries]')
      expect(text).not.toContain('[旁支]')
      // stats 尾段与改前语义一致（totalEntries = leaf 2 + 旁支 2）
      expect(text).toContain('1 turns · 4 entries · ')
    })

    it('② 两 action 一致性：export {format:"outline"} 物化全文 === outline content 文本（旁支行同形态）', async () => {
      await writeForkSession()
      const outline = await handleSessionRead(
        { action: 'outline', session: SID, allBranches: true },
        { agentDir: dir },
      )
      const exp = await handleSessionRead(
        { action: 'export', session: SID, format: 'outline', allBranches: true },
        { agentDir: dir },
      )
      const d = exp.details as { path: string }
      const exported = await readFile(d.path, 'utf8')
      // 干净 session（无坏行）下两 action 全文逐字节一致——同一 result.lines + 同一尾段拼装
      expect(exported).toBe(outline.content[0].text)
      expect(exported).toContain('[旁支 2 entries]')
    })
  })

  describe('search 灾难性正则降级 + abort（fixture，MF-5 回归）', () => {
    let dir: string
    let dataDir: string
    const SID = '019e6c96-bbbb-cccc-dddd-00000000000a'

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-search-'))
      dir = join(dataDir, 'agent')
      await makeFixtureSession(dir, SID, 'aaa plugin 内容')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('嵌套量词 pattern (a+)+ → 降级字面子串（不挂死，零命中）', async () => {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern: '(a+)+' }, { agentDir: dir })
      const d = r.details as { hits: unknown[] }
      // 字面量 '(a+)+' 不在内容里 → 0 命中（若按正则执行会命中 'aaa' 且可能指数回溯）
      expect(d.hits).toHaveLength(0)
    })

    it('普通正则仍按正则匹配', async () => {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern: 'a+' }, { agentDir: dir })
      const d = r.details as { hits: unknown[] }
      expect(d.hits.length).toBeGreaterThan(0)
    })

    it('范围量词 {m,n} 形态 → 降级字面子串（(a{1,3})*、(a{0,2})*、(a{1,3}){2,}，MF-1 回归）', async () => {
      for (const pattern of ['(a{1,3})*', '(a{0,2})*', '(a{1,3}){2,}']) {
        const r = await handleSessionRead({ action: 'search', session: SID, pattern }, { agentDir: dir })
        const d = r.details as { hits: unknown[] }
        // 字面量不含这些 pattern → 0 命中；若按正则执行会指数回溯挂死
        expect(d.hits, `pattern=${pattern}`).toHaveLength(0)
      }
    })

    it('alternation/嵌套量词分支 (a|aa)+、(a*)* → 降级字面子串（MF-5 分支回归）', async () => {
      for (const pattern of ['(a|aa)+', '(a*)*']) {
        const r = await handleSessionRead({ action: 'search', session: SID, pattern }, { agentDir: dir })
        const d = r.details as { hits: unknown[] }
        expect(d.hits, `pattern=${pattern}`).toHaveLength(0)
      }
    })

    it('(a{1,3}) 单独使用不被降级（组后无尾随量词，仍按正则执行）', async () => {
      const r = await handleSessionRead(
        { action: 'search', session: SID, pattern: '(a{1,3})' },
        { agentDir: dir },
      )
      const d = r.details as { hits: unknown[] }
      // 按正则执行命中 'aaa' → >0 命中（若被降级为字面量则 0 命中）
      expect(d.hits.length).toBeGreaterThan(0)
    })

    it('降级标注：header 含「已降级为字面子串匹配」（S-3）', async () => {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern: '(a+)+' }, { agentDir: dir })
      expect(r.content[0].text).toContain('已降级为字面子串匹配')
    })

    it('非法正则 pattern → 字面子串兜底不抛错（零命中，S-6）', async () => {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern: '[unclosed' }, { agentDir: dir })
      const d = r.details as { hits: unknown[] }
      expect(d.hits).toHaveLength(0)
    })

    it('scope 过滤：scope=assistant 零命中（fixture 仅 user 角色，S-6）', async () => {
      const r = await handleSessionRead(
        { action: 'search', session: SID, pattern: 'aaa', scope: 'assistant' },
        { agentDir: dir },
      )
      const d = r.details as { hits: unknown[] }
      expect(d.hits).toHaveLength(0)
    })

    it('limit 截断 → truncated=true + hits 限长（3 条命中 limit=2，S-6）', async () => {
      const sid2 = '019e6c96-bbbb-cccc-dddd-00000000000b'
      // message 链式 parentId（与真实 pi session 一致）：m0→session 根，m1→m0，m2→m1，
      // 否则 buildTreeView 只回溯最后一条的父链，前两条被当旁支过滤
      const lines = [
        JSON.stringify({ type: 'session', id: sid2, cwd: '/demo' }),
        ...['aa1', 'aa2', 'aa3'].map((t, i) =>
          JSON.stringify({
            type: 'message',
            id: `${sid2}-m${i}`,
            parentId: i === 0 ? sid2 : `${sid2}-m${i - 1}`,
            message: { role: 'user', content: [{ type: 'text', text: t }] },
          }),
        ),
      ]
      await writeFile(
        join(dir, 'sessions', '--demo-cwd--', `${sid2}.jsonl`),
        lines.join('\n') + '\n',
      )
      const r = await handleSessionRead(
        { action: 'search', session: sid2, pattern: 'aa', limit: 2 },
        { agentDir: dir },
      )
      const d = r.details as { hits: unknown[]; truncated: boolean }
      expect(d.truncated).toBe(true)
      expect(d.hits).toHaveLength(2)
    })

    it('aborted signal → search 抛中断错误（不继续扫描）', async () => {
      const ac = new AbortController()
      ac.abort()
      await expect(
        handleSessionRead({ action: 'search', session: SID, pattern: 'x' }, { agentDir: dir }, ac.signal),
      ).rejects.toThrow(/中断/)
    })
  })

  describe('extract commits 双路径（fixture：git-cmd 主路径 + commit-context 次路径 + 去重）', () => {
    let dir: string
    let dataDir: string
    const SID = '019e6c96-bbbb-cccc-dddd-00000000000c'

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-commits-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    /** 写单个 session JSONL（commits 用例行内联传入）。 */
    async function writeCommitsSession(id: string, lines: string[]): Promise<void> {
      await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
      await writeFile(
        join(dir, 'sessions', '--demo-cwd--', `${id}.jsonl`),
        lines.join('\n') + '\n',
      )
    }

    it('commit-context 次路径：非 git bash 的 toolResult，hash 邻近含关键词才收（D6）', async () => {
      await writeCommitsSession(SID, [
        JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
        JSON.stringify({
          type: 'message',
          id: `${SID}-m1`,
          parentId: SID,
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tc-read-1', name: 'read', arguments: { path: join(tmpdir(), 'log.txt') } },
            ],
          },
        }),
        // read 结果：hash 邻近 30 字符窗口含 'feat:' → commit-context 次路径纳入
        JSON.stringify({
          type: 'message',
          id: `${SID}-m2`,
          parentId: `${SID}-m1`,
          message: {
            role: 'toolResult',
            toolName: 'read',
            toolCallId: 'tc-read-1',
            content: [{ type: 'text', text: 'deploy abc1234f done\nfeat: add login' }],
          },
        }),
        // read 结果：hash 无关键词邻近 → 两路径都不收（过滤分支）
        JSON.stringify({
          type: 'message',
          id: `${SID}-m3`,
          parentId: `${SID}-m2`,
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tc-read-2', name: 'read', arguments: { path: join(tmpdir(), 'out.txt') } },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: `${SID}-m4`,
          parentId: `${SID}-m3`,
          message: {
            role: 'toolResult',
            toolName: 'read',
            toolCallId: 'tc-read-2',
            content: [{ type: 'text', text: 'output 9998887 plain text' }],
          },
        }),
      ])
      const r = await handleSessionRead({ action: 'extract', session: SID, what: 'commits' }, { agentDir: dir })
      const d = r.details as { count: number; items: Array<{ hash: string; source: string }> }
      const hashes = d.items.map((it) => it.hash)
      expect(hashes).toContain('abc1234f')
      expect(hashes).not.toContain('9998887')
      expect(d.items.find((it) => it.hash === 'abc1234f')?.source).toBe('commit-context')
    })

    it('去重高置信优先：同 hash 同时命中 git-cmd 与 commit-context → 保留 git-cmd 一条', async () => {
      await writeCommitsSession(SID, [
        JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
        JSON.stringify({
          type: 'message',
          id: `${SID}-m1`,
          parentId: SID,
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tc-bash-1', name: 'bash', arguments: { command: 'git log --oneline -3' } },
            ],
          },
        }),
        // bash + git log → git-cmd 高置信（含 def5678a）
        JSON.stringify({
          type: 'message',
          id: `${SID}-m2`,
          parentId: `${SID}-m1`,
          message: {
            role: 'toolResult',
            toolName: 'bash',
            toolCallId: 'tc-bash-1',
            content: [{ type: 'text', text: 'def5678a feat: fix crash' }],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: `${SID}-m3`,
          parentId: `${SID}-m2`,
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tc-read-1', name: 'read', arguments: { path: join(tmpdir(), 'deploy.txt') } },
            ],
          },
        }),
        // read 结果同 hash def5678a + 关键词 merged → low 候选，去重后丢弃
        JSON.stringify({
          type: 'message',
          id: `${SID}-m4`,
          parentId: `${SID}-m3`,
          message: {
            role: 'toolResult',
            toolName: 'read',
            toolCallId: 'tc-read-1',
            content: [{ type: 'text', text: 'deploy def5678a merged' }],
          },
        }),
      ])
      const r = await handleSessionRead({ action: 'extract', session: SID, what: 'commits' }, { agentDir: dir })
      const d = r.details as { count: number; items: Array<{ hash: string; source: string }> }
      const dupes = d.items.filter((it) => it.hash === 'def5678a')
      expect(dupes).toHaveLength(1)
      expect(dupes[0].source).toBe('git-cmd')
      expect(d.count).toBe(1)
    })
  })

  describe('renderExtractItems F9 截断（S3 首项超大 + S4 文案）', () => {
    it('S3: 首项超大内部截断 → body 不超预算，shown<count + truncated=true', () => {
      // 首项 10000 字符 >> EXTRACT_BUDGET_BYTES(8000)；旧逻辑放行首项致 body≈10KB
      const longText = 'x'.repeat(10000)
      const items = [
        { turn: 5, text: longText },
        { turn: 6, text: 'short6' },
        { turn: 7, text: 'short7' },
      ]
      const r = renderExtractItems(
        'user-messages',
        items,
        (it) => `T${String(it.turn).padStart(3, '0')}: ${it.text}`,
        (it) => [it.turn],
      )
      const d = r.details as { what: string; count: number; shown: number; truncated: boolean }
      expect(d.truncated).toBe(true)
      expect(d.count).toBe(3)
      expect(d.shown).toBe(1) // 首项截断后保留，后续项因预算用未加入
      // body（含文案行）字节数远小于 3 项全量（30000+ 字节），≤ 预算 + 合理余量
      const bodyBytes = Buffer.byteLength(r.content[0].text, 'utf8')
      expect(bodyBytes).toBeLessThan(8000 * 1.5)
      // 截断标记存在（首项被内部 slice + 省略号）
      expect(r.content[0].text).toContain('…')
      // 完整 longText 不在输出里（已被截断）
      expect(r.content[0].text).not.toContain(longText)
    })

    it('S4: F9 文案含实际 turn 范围 + 实际 token（非固定 2000）', () => {
      // 3 项各 ~3000 字节，累计超 8000 → 第 3 项触发截断（文案报 shown turn 范围）
      const items = [
        { turn: 10, text: 'a'.repeat(3000) },
        { turn: 20, text: 'b'.repeat(3000) },
        { turn: 30, text: 'c'.repeat(3000) },
      ]
      const r = renderExtractItems(
        'user-messages',
        items,
        (it) => `T${String(it.turn).padStart(3, '0')}: ${it.text}`,
        (it) => [it.turn],
      )
      const text = r.content[0].text
      // 文案含 turn 范围（shown 的 min-max turn）
      expect(text).toMatch(/T010-T0\d{2}/)
      // 文案含实际 token（从 body 实际字节算），不再是固定 2000
      expect(text).toContain('token 达预算上限')
      expect(text).not.toContain('≈2000 token')
      // 文案含 shown/count
      expect(text).toMatch(/已显示 \d+\/\d+ 项/)
    })
  })

  // ============================================================
  // w2 新增：resolveSessionId 三形态（① 绝对路径 / ② sa-id / ③ findSessions 透传 source）
  // + ES1/ES2 错误契约 + source 透传 + 真实数据检查（design TC2-TC18）
  // ============================================================

  /**
 * 造 subagent manifest + session 文件（TC7/TC8/TC10/CQ3/TC14-TC17 用）。
 * sessionFileExists:false 模拟 GC（manifest 存在但 session 文件不存在 → ES1）。
 * slug 可指定 cwd 编码目录名（TC15 worktree 形态），缺省 '--demo-cwd--'。
 * 返回 session 文件绝对路径（= manifest.sessionFile）。
 */
  async function makeFixtureSubagent(
    dir: string,
    saId: string,
    opts: {
      realSessionId: string
      rootSessionId?: string
      agentName?: string
      sessionFileExists?: boolean
      firstUserText?: string
      slug?: string
    },
  ): Promise<string> {
    // [session-store-layout-inversion] 新布局存储树：分区键 = rootSessionId（无 encodeCwd
    // 目录层，opts.slug 已无布局语义，保留入参兼容旧调用点但不参与路径推导）
    const rootSid = opts.rootSessionId ?? 'root-session-1'
    const sessionFile = join(resolveStoreSubagentSessionsDir(dir, rootSid), `${opts.realSessionId}.jsonl`)
    if (opts.sessionFileExists !== false) {
      await mkdir(resolveStoreSubagentSessionsDir(dir, rootSid), { recursive: true })
      const lines = [
        JSON.stringify({ type: 'session', id: opts.realSessionId, cwd: '/demo' }),
        JSON.stringify({
          type: 'message',
          id: opts.realSessionId + '-m1',
          parentId: opts.realSessionId,
          message: {
            role: 'user',
            content: [{ type: 'text', text: opts.firstUserText ?? 'subagent work' }],
          },
        }),
      ]
      await writeFile(sessionFile, lines.join('\n') + '\n')
    }
    const recordsDir = resolveStoreSubagentRecordsDir(dir, rootSid)
    await mkdir(recordsDir, { recursive: true })
    await writeFile(
      join(recordsDir, `${saId}.json`),
      JSON.stringify({
        id: saId,
        rootSessionId: rootSid,
        agentName: opts.agentName ?? 'explorer',
        sessionFile,
      }),
    )
    return sessionFile
  }

  describe('resolveSessionId ① 绝对路径形态（w2 TC2-TC6）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，[session-store-layout-inversion]）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-path-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC2: 绝对路径 outline → sessionId=header 真实 id（非文件名）', async () => {
      const fileId = '019e6c96-dddd-eeee-ffff-000000000b1'
      // 文件名 arbitrary-name 与 header id 不同，验 sessionId 取 header id
      const filePath = join(dir, 'sessions', '--demo-cwd--', 'arbitrary-name.jsonl')
      await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
      const lines = [
        JSON.stringify({ type: 'session', id: fileId, cwd: '/demo' }),
        JSON.stringify({
          type: 'message',
          id: fileId + '-m1',
          parentId: fileId,
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        }),
      ]
      await writeFile(filePath, lines.join('\n') + '\n')
      // export 的 details.path = session-view-<sessionId>.md，含 header 真实 id，不含文件名
      const r = await handleSessionRead(
        { action: 'export', session: filePath, format: 'outline' },
        { agentDir: dir },
      )
      const d = r.details as { path: string }
      expect(d.path).toContain(fileId)
      expect(d.path).not.toContain('arbitrary-name')
    })

    it('TC3: 绝对路径文件不存在 → F6 风格错误（含 👉）', async () => {
      const filePath = join(
        dir,
        'sessions',
        '--demo-cwd--',
        `not-exist-${Date.now()}.jsonl`,
      )
      await expect(
        handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
      ).rejects.toThrow(/读取失败.*文件不存在/)
      await expect(
        handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
      ).rejects.toThrow('👉')
    })

    it('TC4: 绝对路径非 .jsonl → F6 风格错误', async () => {
      const filePath = join(dir, 'sessions', '--demo-cwd--', 'x.txt')
      await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
      await writeFile(filePath, 'not jsonl')
      await expect(
        handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
      ).rejects.toThrow(/读取失败.*非 \.jsonl/)
    })

    it('TC5: 绝对路径 header 读不出（首行非 session header）→ F6 风格错误', async () => {
      const filePath = join(dir, 'sessions', '--demo-cwd--', 'bad.jsonl')
      await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
      await writeFile(filePath, JSON.stringify({ type: 'custom', customType: 'x' }) + '\n')
      await expect(
        handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
      ).rejects.toThrow(/读取失败.*首行非合法 session header/)
    })

    it('TC5 变体: 绝对路径空文件 → F6 风格错误', async () => {
      const filePath = join(dir, 'sessions', '--demo-cwd--', 'empty.jsonl')
      await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
      await writeFile(filePath, '')
      await expect(
        handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
      ).rejects.toThrow(/读取失败.*首行非合法 session header/)
    })

    it('TC6: ~ 前缀展开到 homedir（文件实际在 homedir 下）', async () => {
      // fs-guard：真实 homedir 根在白名单外（禁止在用户主目录根散落 .sr-w2-test-*）——
      // homedir 经文件头 vi.mock 指到 mkdtemp tmp（白名单内），「~ 前缀展开」断言语义不变
      const fakeHome = await mkdtemp(join(tmpdir(), 'tool-handler-tc6-home-'))
      homeState.fakeHome = fakeHome
      try {
        const home = homedir()
        const tmpUnderHome = await mkdtemp(join(home, '.sr-w2-test-'))
        try {
          const fileId = '019e6c96-dddd-eeee-ffff-0000000006c1'
          const sessionFile = join(tmpUnderHome, 's.jsonl')
          await writeFile(
            sessionFile,
            JSON.stringify({ type: 'session', id: fileId, cwd: '/demo' }) + '\n',
          )
          // ~/开头的相对 homedir 路径
          const tildePath = '~/' + sessionFile.slice(home.length + 1)
          const r = await handleSessionRead(
            { action: 'export', session: tildePath, format: 'outline' },
            { agentDir: dir },
          )
          expect((r.details as { path: string }).path).toContain(fileId)
        } finally {
          await rm(tmpUnderHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        }
      } finally {
        homeState.fakeHome = undefined
        await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  describe('resolveSessionId ② sa-id 形态（w2 TC7-TC10 + CQ3）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，[session-store-layout-inversion]）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-said-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC7: sa-id 恰 1 命中 + sessionFile 存在 → 成功，sessionId=header 真实 id（非 sa-）', async () => {
      const realId = '019e6c96-dddd-eeee-ffff-0000000007a1'
      await makeFixtureSubagent(dir, 'sa-aaa', { realSessionId: realId, firstUserText: 'do task' })
      const r = await handleSessionRead(
        { action: 'export', session: 'sa-aaa', format: 'outline' },
        { agentDir: dir },
      )
      const d = r.details as { path: string }
      expect(d.path).toContain(realId)
      expect(d.path).not.toContain('sa-aaa')
    })

    it('TC8: sa-id 命中但 sessionFile 不存在（GC/未写入）→ ES1（含 manifest 元数据 + 👉）', async () => {
      await makeFixtureSubagent(dir, 'sa-gc', {
        realSessionId: '019e6c96-dddd-eeee-ffff-0000000008a2',
        rootSessionId: 'root-1',
        agentName: 'explorer',
        sessionFileExists: false,
      })
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-gc' }, { agentDir: dir }),
      ).rejects.toThrow('session 文件不存在')
      // 错误含 manifest 全部元数据 + 👉
      try {
        await handleSessionRead({ action: 'outline', session: 'sa-gc' }, { agentDir: dir })
      } catch (e) {
        const msg = (e as Error).message
        expect(msg).toContain('sa-gc')
        expect(msg).toContain('root-1')
        expect(msg).toContain('explorer')
        expect(msg).toContain('sessionFile:')
        expect(msg).toContain('👉')
        expect(msg).toContain('action:"family"')
      }
    })

    it('TC9: sa-id 0 命中（可能 running）→ zcode_record_not_found（U9：sa-id 语境统一错误范围，含 family 指引 + 👉）', async () => {
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-nonexist-9999' }, { agentDir: dir }),
      ).rejects.toThrow('zcode_record_not_found')
      try {
        await handleSessionRead({ action: 'outline', session: 'sa-nonexist-9999' }, { agentDir: dir })
      } catch (e) {
        const msg = (e as Error).message
        expect(msg).toContain('未落盘')
        expect(msg).toContain('action:"family"')
        expect(msg).toContain('👉')
      }
    })

    it('TC10: sa-id 片段输入（精确相等不命中）→ zcode_record_not_found + 完整 sa- id 重试指引（U9 统一错误范围）', async () => {
      await makeFixtureSubagent(dir, 'sa-c8c8dfa8', {
        realSessionId: '019e6c96-dddd-eeee-ffff-0000000010a3',
      })
      // 片段 sa-c8c8 不等于完整 sa-c8c8dfa8 → 精确相等不命中（兜底亦未命中）
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-c8c8' }, { agentDir: dir }),
      ).rejects.toThrow('zcode_record_not_found')
      // 片段输入恢复路径在指引内可见（A4：ES2 原文案「用完整 sa- id 重试」的覆盖补全）
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-c8c8' }, { agentDir: dir }),
      ).rejects.toThrow(/完整 sa- id（形如 `sa-xxxx`）后重试/)
    })

    it('sa-id 多 manifest 命中（数据异常）→ ES2 ambiguous（C4）', async () => {
      // 同 sa-id 的两个 manifest（不同 rootSessionId 分区，模拟数据异常——新布局分区键 =
      // rootSessionId，同分区同名 manifest 会互覆，双 manifest 只能跨分区构造）
      for (const [rootSid, realId] of [
        ['0aaaaaaa-bbbb-7ccc-dddd-0000000004r1', '019e6c96-dddd-eeee-ffff-0000000004a4'],
        ['0aaaaaaa-bbbb-7ccc-dddd-0000000004r2', '019e6c96-dddd-eeee-ffff-0000000004a5'],
      ] as const) {
        const sessionsDir = resolveStoreSubagentSessionsDir(dir, rootSid)
        const sessionFile = join(sessionsDir, `${realId}.jsonl`)
        await mkdir(sessionsDir, { recursive: true })
        await writeFile(
          sessionFile,
          JSON.stringify({ type: 'session', id: realId, cwd: '/demo' }) + '\n',
        )
        const recordsDir = resolveStoreSubagentRecordsDir(dir, rootSid)
        await mkdir(recordsDir, { recursive: true })
        await writeFile(
          join(recordsDir, 'sa-dup.json'),
          JSON.stringify({
            id: 'sa-dup',
            rootSessionId: rootSid,
            agentName: 'a',
            sessionFile,
          }),
        )
      }
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-dup' }, { agentDir: dir }),
      ).rejects.toThrow(/匹配 2 个 record.*数据异常/)
    })

    it('CQ3: sa-id 命中但 sessionFile header 读不出 → F6 风格（不降级 record.id 当 sessionId）', async () => {
      // sessionFile 存在但首行非 session header → readSessionHeaderIdSync 返 undefined
      const rootSid = 'r' // 合法 pi sid 形态（单字符分区）
      const sessionFile = join(resolveStoreSubagentSessionsDir(dir, rootSid), 'bad.jsonl')
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, JSON.stringify({ type: 'custom', customType: 'x' }) + '\n')
      const recordsDir = resolveStoreSubagentRecordsDir(dir, rootSid)
      await mkdir(recordsDir, { recursive: true })
      await writeFile(
        join(recordsDir, 'sa-bad.json'),
        JSON.stringify({
          id: 'sa-bad',
          rootSessionId: 'r',
          agentName: 'a',
          sessionFile,
        }),
      )
      // 抛 F6 风格（读取失败 + 首行非合法 session header），不降级返回 sa-bad 当 sessionId
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-bad' }, { agentDir: dir }),
      ).rejects.toThrow(/读取失败.*首行非合法 session header/)
    })
  })

  describe('sa-id entry 兜底 v2 终态条锚定（W1 D1 版本门补齐，第三层兜底消费方）', () => {
    // fixture 骨架对齐 zcode-routing.test.ts：root/agent = agentDir、root/live-sessions =
    // liveSessionDir（entry 兜底候选根）、root/engines/zcode/session-db/db.sqlite = 隔离库
    // 白名单形态路径（不落文件——正向用例锚命中后进 zcode 读链，在白名单存在性检查处
    // 产出 zcode_db_unreadable，无需真实 sqlite）。
    const ISOLATED_DB_SEGMENTS = ['engines', 'zcode', 'session-db', 'db.sqlite']
    let root: string
    let agentDir: string
    let liveDir: string
    let dbPath: string
    let appendEntries: ReturnType<typeof vi.fn>

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'tool-handler-v2anchor-'))
      agentDir = join(root, 'agent')
      liveDir = join(root, 'live-sessions')
      await mkdir(agentDir, { recursive: true })
      await mkdir(liveDir, { recursive: true })
      dbPath = join(root, ...ISOLATED_DB_SEGMENTS)
      appendEntries = vi.fn()
      setPiHandle({ appendEntry: appendEntries } as unknown as Parameters<typeof setPiHandle>[0])
    })
    afterEach(async () => {
      setPiHandle(undefined)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    /** live session 内追加 subagent-record custom 行（首行 session header）。 */
    async function writeLiveEntryLine(lineData: Record<string, unknown>): Promise<void> {
      const path = join(liveDir, 'main.jsonl')
      await writeFile(
        path,
        JSON.stringify({ type: 'session', id: 'live-main-1', cwd: '/proj' }) +
          '\n' +
          JSON.stringify({ type: 'custom', customType: 'subagent-record', id: 'e-v2', parentId: null, data: lineData }) +
          '\n',
      )
    }

    /** v2 终态条 data（载荷形态对齐 subagent-core SubagentRecordSettledEntryData）。 */
    function v2SettledData(opts: { engine?: string; sessionRef?: Record<string, string> } = {}): Record<string, unknown> {
      const data: Record<string, unknown> = {
        v: 2,
        kind: 'settled',
        id: 'sa-v2-1',
        status: 'idle',
        stopReason: 'end_turn',
        endedAt: 123,
        turns: 2,
        totalTokens: 20,
        model: undefined,
        thinkingLevel: undefined,
        result: 'done text',
      }
      if (opts.engine !== undefined) data.engine = opts.engine
      if (opts.sessionRef !== undefined) {
        data.engineHandle = { sessionRef: opts.sessionRef, poolKey: 'shared' }
      }
      return data
    }

    /** v2 注册条 data（身份域，不携带 engineHandle——非锚源）。 */
    function v2RegisteredData(): Record<string, unknown> {
      return {
        v: 2,
        kind: 'registered',
        id: 'sa-v2-1',
        agent: 'dev',
        task: 't',
        slug: 's',
        origin: 'tool',
        rootSessionId: 'live-main-1',
        depth: 0,
        startedAt: 1,
      }
    }

    function logCallsWithReason(reason: string): number {
      return appendEntries.mock.calls.filter(
        ([ct, d]) => ct === 'session-reader:log' && (d as { data?: { reason?: string } })?.data?.reason === reason,
      ).length
    }

    it('v2 终态条完整锚 → 兜底命中进 zcode 读链（dbPath 白名单内未落盘 → zcode_db_unreadable，非 not_found）', async () => {
      await writeLiveEntryLine(v2SettledData({ engine: 'zcode', sessionRef: { sessionId: 'sess_v2', dbPath } }))
      // 锚命中 → resolveZcodeRoute → zcode 读链 → 白名单存在性检查（文件未落盘）
      // zcode_db_unreadable = 锚定成功的输出级证据（锚未命中此处是 zcode_record_not_found）
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-v2-1' }, { agentDir, liveSessionDir: liveDir }),
      ).rejects.toThrow('zcode_db_unreadable')
    })

    it('v2 终态条 engine=zcode 但 sessionRef 缺 dbPath → zcode_anchor_missing + 结构化日志记「缺 dbPath」', async () => {
      await writeLiveEntryLine(v2SettledData({ engine: 'zcode', sessionRef: { sessionId: 'sess_v2' } }))
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-v2-1' }, { agentDir, liveSessionDir: liveDir }),
      ).rejects.toThrow('zcode_anchor_missing')
      // 归因进结构化日志不进 LLM 可见部分（§3.4）：firstIncompleteAnchorReason 的 v2 分支
      //（tool-handler 唯一消费点）产出 missing-dbPath
      expect(logCallsWithReason('missing-dbPath')).toBeGreaterThanOrEqual(1)
    })

    it('v2 注册条（kind="registered"）不是锚源 → zcode_record_not_found（不误报 anchor_missing）', async () => {
      await writeLiveEntryLine(v2RegisteredData())
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-v2-1' }, { agentDir, liveSessionDir: liveDir }),
      ).rejects.toThrow('zcode_record_not_found')
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-v2-1' }, { agentDir, liveSessionDir: liveDir }),
      ).rejects.not.toThrow('zcode_anchor_missing')
    })

    it('v2 终态条 engine 缺省（pi 形态 v2）→ zcode_record_not_found（D5 engine 判别防误归因）', async () => {
      // pi record 的 v2 终态条：engine 缺省、sessionRef 无 dbPath——不是「zcode 锚不完整」，
      // 不适用旧版本产物指引；误归因 missing-dbPath → zcode_anchor_missing 即红
      await writeLiveEntryLine(v2SettledData())
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-v2-1' }, { agentDir, liveSessionDir: liveDir }),
      ).rejects.toThrow('zcode_record_not_found')
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-v2-1' }, { agentDir, liveSessionDir: liveDir }),
      ).rejects.not.toThrow('zcode_anchor_missing')
    })
  })

  describe('source 透传（w2 TC12-TC13，依赖 w1 findSessions opts.source）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，[session-store-layout-inversion]）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-src-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC12: find source 过滤——subagent 只返回 subagent 候选，main 只返回 main', async () => {
      const sharedFragment = '019e6c96'
      const mainId = `${sharedFragment}-aaaa-bbbb-cccc-0000000012d1`
      const subId = `${sharedFragment}-aaaa-bbbb-cccc-0000000012d2`
      await makeFixtureSession(dir, mainId, 'main content')
      await makeFixtureSubagent(dir, 'sa-sub12', { realSessionId: subId, firstUserText: 'sub content' })

      // 无 source → 两者
      const rBoth = await handleSessionRead(
        { action: 'find', query: sharedFragment },
        { agentDir: dir },
      )
      const dBoth = rBoth.details as {
        matches: Array<{ source: string; sessionId: string }>
      }
      expect(dBoth.matches.some((m) => m.sessionId === mainId)).toBe(true)
      expect(dBoth.matches.some((m) => m.sessionId === subId)).toBe(true)

      // source:subagent → 只 sub
      const rSub = await handleSessionRead(
        { action: 'find', query: sharedFragment, source: 'subagent' },
        { agentDir: dir },
      )
      const dSub = rSub.details as {
        matches: Array<{ source: string; sessionId: string }>
      }
      expect(dSub.matches.every((m) => m.source === 'subagent')).toBe(true)
      expect(dSub.matches.some((m) => m.sessionId === subId)).toBe(true)
      expect(dSub.matches.some((m) => m.sessionId === mainId)).toBe(false)

      // source:main → 只 main
      const rMain = await handleSessionRead(
        { action: 'find', query: sharedFragment, source: 'main' },
        { agentDir: dir },
      )
      const dMain = rMain.details as {
        matches: Array<{ source: string; sessionId: string }>
      }
      expect(dMain.matches.every((m) => m.source === 'main')).toBe(true)
      expect(dMain.matches.some((m) => m.sessionId === mainId)).toBe(true)
      expect(dMain.matches.some((m) => m.sessionId === subId)).toBe(false)
    })

    it('TC13: outline source:main → resolveSessionId ③ 收窄到 main 候选（无 source 时多匹配 F2）', async () => {
      const sharedFragment = '019e6c96'
      const mainId = `${sharedFragment}-aaaa-bbbb-cccc-0000000013e1`
      const subId = `${sharedFragment}-aaaa-bbbb-cccc-0000000013e2`
      await makeFixtureSession(dir, mainId, 'main content')
      await makeFixtureSubagent(dir, 'sa-sub13', { realSessionId: subId, firstUserText: 'sub content' })

      // 无 source → main+sub 共享片段 → 2 匹配 → F2 消歧
      const rMulti = await handleSessionRead(
        { action: 'outline', session: sharedFragment },
        { agentDir: dir },
      )
      expect((rMulti.details as { ambiguous: boolean }).ambiguous).toBe(true)

      // source:main → 收窄到 main → 唯一匹配 → outline 成功，且是 main（export path 含 mainId）
      const rExp = await handleSessionRead(
        { action: 'export', session: sharedFragment, source: 'main', format: 'outline' },
        { agentDir: dir },
      )
      expect((rExp.details as { path: string }).path).toContain(mainId)
    })
  })

  describe('subagent sa-id（w2 TC14-TC17，fixture）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）
    const TC14_ID = '0aaaaaaa-0000-7000-8000-0000000014a1'
    const TC15_ID = '0aaaaaaa-0000-7000-8000-0000000015a2'

    /**
   * 两个存活 subagent + 一个 GC manifest：
   * - TC14 走普通 slug（sa-id → manifest → sessionFile → outline）
   * - TC15 的 sessionFile 落在 '--private-var-folders-' 编码目录（worktree cwd 形态），
   *   覆盖 manifest 树的递归扫描
   * - TC17 的 manifest sessionFile 指向不存在路径（模拟 .jsonl 被 GC）
   */
    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-tc14-'))
      dir = join(dataDir, 'agent')
      await makeFixtureSubagent(dir, 'sa-tc14', {
        realSessionId: TC14_ID,
        firstUserText: 'subagent task',
      })
      await makeFixtureSubagent(dir, 'sa-tc15', {
        realSessionId: TC15_ID,
        slug: '--private-var-folders-abc--',
        firstUserText: 'worktree subagent task',
      })
      await makeFixtureSubagent(dir, 'sa-tc17-gc', {
        realSessionId: '0aaaaaaa-0000-7000-8000-0000000017a3',
        sessionFileExists: false,
      })
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC14: completed subagent sa-id outline 成功（场景 1，sessionId=header 真实 id）', async () => {
      const r = await handleSessionRead({ action: 'outline', session: 'sa-tc14' }, { agentDir: dir })
      const d = r.details as { turns: unknown[] }
      expect(d.turns.length).toBeGreaterThan(0)
    })

    it('TC15: worktree 编码目录 subagent 读取（场景 1b，递归扫描覆盖）', async () => {
      const r = await handleSessionRead({ action: 'outline', session: 'sa-tc15' }, { agentDir: dir })
      expect(((r.details as { turns: unknown[] }).turns).length).toBeGreaterThan(0)
    })

    it('TC16: 嵌套后代直接 outline（场景 1c，绝对路径形态读任意节点）', async () => {
      // 绝对路径形态直接读（M0 入口不依赖 findSessions）
      const r = await handleSessionRead(
        {
          action: 'outline',
          session: join(resolveStoreSubagentSessionsDir(dir, 'root-session-1'), `${TC14_ID}.jsonl`),
        },
        { agentDir: dir },
      )
      expect(((r.details as { turns: unknown[] }).turns).length).toBeGreaterThan(0)
    })

    it('TC17: GC/failed manifest → ES1（场景 4，sessionFile 不存在）', async () => {
      await expect(
        handleSessionRead({ action: 'outline', session: 'sa-tc17-gc' }, { agentDir: dir }),
      ).rejects.toThrow('session 文件不存在')
    })
  })

  // ============================================================
  // w6: doWorkflow action（TC-w6-single-run/multi-run/runid-filter/runid-not-found/no-runs/snapshot-skip/call-jump）
  // ============================================================

  // ---- workflow fixture 常量（uuid 特征，互不为子串）----
  const WF_ROOT = '019w6aaa-0000-7000-b000-000000000001' // 发起 workflow 的 main session
  const WF_CALL = '019w6bbb-0000-7000-b000-000000000002' // workflow call 的目标 session（call-jump）
  const SUB_WF_ROOT = '019w6ccc-0000-7000-b000-000000000003' // 发起 workflow 的 subagent session（MF-2）

  /** 写 main session（header + 1 条 user message，让 outline 有 turn）。返回绝对路径。 */
  async function wfMainSession(
    dir: string,
    slug: string,
    id: string,
    opts?: { cwd?: string },
  ): Promise<string> {
    const sessionDir = join(dir, 'sessions', slug)
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, `${id}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'session', id, cwd: opts?.cwd ?? `/proj/${slug}` }),
      JSON.stringify({
        type: 'message',
        id: `${id}-m1`,
        parentId: id,
        message: { role: 'user', content: [{ type: 'text', text: 'run workflow' }] },
      }),
    ]
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  /** 写 wf-state 文件（每行一个快照 JSON）。返回绝对路径。 */
  async function wfStateFile(
    dir: string,
    slug: string,
    fileName: string,
    lines: string[],
  ): Promise<string> {
    const wfDir = join(dir, 'sessions', slug, 'workflow-state')
    await mkdir(wfDir, { recursive: true })
    const path = join(wfDir, fileName)
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  describe('doWorkflow（w6，fixture）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，[session-store-layout-inversion]）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-wf-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    // ---- [D16③] v2 record 流档概览（recordPath 锚点 = record 流路径）----

    /** 向 main session 追加 workflow-record v2 注册条目行（recordPath 锚点指向 record 流）。 */
    async function wfV2Registered(
      dir: string,
      slug: string,
      id: string,
      runId: string,
      recordPath: string,
    ): Promise<void> {
      const sessionPath = join(dir, 'sessions', slug, `${id}.jsonl`)
      const line = JSON.stringify({
        type: 'custom',
        id: `wf-reg-${runId}`,
        parentId: id,
        customType: 'workflow-record',
        data: { v: 2, kind: 'registered', runId, workflowName: 'rec-flow', scriptName: 'rec-flow', slug: 'rec-flow', startedAt: 1758000000000, recordPath: recordPath },
        timestamp: '2026-09-28T00:00:00Z',
      })
      await writeFile(sessionPath, line + '\n', { flag: 'a' })
    }

    /** 构造 v2 record 流文件（run-created + agent-settled[+终局] 帧提 calls）并写注册条目——
   *  [ADR-0095] v1 读侧删除后的单档 fixture 形态（替代 wf-state 快照 + link 指针）。 */
    async function wfV2Run(
      dir: string,
      slug: string,
      id: string,
      runId: string,
      calls: Array<{ sessionId: string; sessionFile: string }>,
      opts: { settled?: boolean } = {},
    ): Promise<string> {
      const lines = [
        JSON.stringify({ type: 'run-created', seq: 1, ts: 1758000000000, runId, workflowName: 'test-wf', argsSummary: '{}' }),
        ...calls.map((c, i) =>
          JSON.stringify({ type: 'agent-settled', seq: 2 + i, ts: 1758000001000 + i, taskIndex: i, attempt: 1, outcome: 'done', durationMs: 100, result: { content: 'ok', sessionId: c.sessionId, sessionFile: c.sessionFile } }),
        ),
      ]
      if (opts.settled) {
        lines.push(JSON.stringify({ type: 'run-settled', seq: 2 + calls.length, ts: 1758000002000, outcome: 'done' }))
      }
      const recordPath = await wfStateFile(dir, slug, `${runId}.record.jsonl`, lines)
      await wfV2Registered(dir, slug, id, runId, recordPath)
      return recordPath
    }

    it('[D16③] v2 档 record 流概览：注册条目锚点直读流——steps 提 sessionFile、status 三态、不进 skippedRuns（活跃 run 红线）', async () => {
      const slug = '--wf-record--'
      await wfMainSession(dir, slug, WF_ROOT)
      const callSession = join(dir, 'sessions', slug, `${WF_CALL}.jsonl`)
      const recordPath = await wfStateFile(dir, slug, 'wf-rec-1.record.jsonl', [
        JSON.stringify({ type: 'run-created', seq: 1, ts: 1758000000000, runId: 'wf-rec-1', workflowName: 'rec-flow', argsSummary: '{}' }),
        JSON.stringify({ type: 'agent-started', seq: 2, ts: 1758000000100, taskIndex: 0, agentName: 'rec-step', attempt: 1 }),
        JSON.stringify({ type: 'agent-settled', seq: 3, ts: 1758000001500, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 1400, result: { content: 'ok', sessionId: WF_CALL, sessionFile: callSession } }),
        JSON.stringify({ type: 'run-settled', seq: 4, ts: 1758000002000, outcome: 'done', artifactsDir: '/tmp/wf' }),
      ])
      await wfV2Registered(dir, slug, WF_ROOT, 'wf-rec-1', recordPath)

      const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
      const d = r.details as {
        runs: Array<{ runId: string; status: string; script?: string; steps: Array<{ sessionId?: string; sessionFile?: string }> }>
        skippedRuns?: unknown[]
      }
      // 红线：record 流 run 正常解析——不退化为 skippedRuns
      expect(d.skippedRuns).toBeUndefined()
      expect(d.runs).toHaveLength(1)
      expect(d.runs[0].runId).toBe('wf-rec-1')
      expect(d.runs[0].status).toBe('done')
      expect(d.runs[0].script).toBe('rec-flow')
      expect(d.runs[0].steps).toHaveLength(1)
      expect(d.runs[0].steps[0].sessionFile).toBe(callSession)
      expect(d.runs[0].steps[0].sessionId).toBe(WF_CALL)
      expect(r.content[0].type).toBe('text')
      expect((r.content[0] as { text: string }).text).toContain('wf-rec-1')
      expect((r.content[0] as { text: string }).text).toContain('rec-step')
    })

    it('[D16③][D2] v2 档活跃 run（流无终局帧）→ status running、概览不退化为 skippedRuns；中断转移帧 → interrupted', async () => {
      const slug = '--wf-running--'
      await wfMainSession(dir, slug, WF_ROOT)
      // 活跃：run-created + agent-started（无 settled/终局帧）
      const activePath = await wfStateFile(dir, slug, 'wf-run-1.record.jsonl', [
        JSON.stringify({ type: 'run-created', seq: 1, ts: 1758000000000, runId: 'wf-run-1', workflowName: 'run-flow', argsSummary: '{}' }),
        JSON.stringify({ type: 'agent-started', seq: 2, ts: 1758000000100, taskIndex: 0, agentName: 'in-flight', attempt: 1 }),
      ])
      await wfV2Registered(dir, slug, WF_ROOT, 'wf-run-1', activePath)
      const r1 = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
      const d1 = r1.details as { runs: Array<{ runId: string; status: string }>; skippedRuns?: unknown[] }
      expect(d1.skippedRuns).toBeUndefined()
      expect(d1.runs.find((x) => x.runId === 'wf-run-1')?.status).toBe('running')

      // 中断：追加 run-interrupted 转移帧 → status interrupted（[D2] 暂停态）
      // 同 slug 同 main session 追加条目（第二个 slug 目录会触发同 id 多匹配消歧）
      const slug2 = slug
      const intPath = await wfStateFile(dir, slug2, 'wf-int-1.record.jsonl', [
        JSON.stringify({ type: 'run-created', seq: 1, ts: 1758000000000, runId: 'wf-int-1', workflowName: 'int-flow', argsSummary: '{}' }),
        JSON.stringify({ type: 'agent-started', seq: 2, ts: 1758000000100, taskIndex: 0, agentName: 'crashed-step', attempt: 1 }),
        JSON.stringify({ type: 'run-interrupted', seq: 3, ts: 1758000009000, errorCode: 'crashed', reason: 'process killed' }),
      ])
      await wfV2Registered(dir, slug2, WF_ROOT, 'wf-int-1', intPath)
      const r2 = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
      const d2 = r2.details as { runs: Array<{ runId: string; status: string }>; skippedRuns?: unknown[] }
      expect(d2.skippedRuns).toBeUndefined()
      expect(d2.runs.find((x) => x.runId === 'wf-int-1')?.status).toBe('interrupted')
    })

    it('TC-w6-single-run：单 run 概览，content 含 run 头行/budget/step，details.runs/runIds 非空', async () => {
      const slug = '--wf-single--'
      await wfMainSession(dir, slug, WF_ROOT)
      const callSession = join(dir, 'sessions', slug, `${WF_CALL}.jsonl`)
      await wfV2Run(dir, slug, WF_ROOT, 'wf-single-1', [
        { sessionId: WF_CALL, sessionFile: callSession },
      ], { settled: true })

      const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
      const d = r.details as {
        runs: Array<{
          runId: string
          status: string
          steps: Array<{ sessionId: string; sessionFile: string }>
        }>
        runIds: string[]
      }
      expect(d.runs).toHaveLength(1)
      expect(d.runs[0].runId).toBe('wf-single-1')
      expect(d.runs[0].status).toBe('done')
      expect(d.runs[0].steps).toHaveLength(1)
      expect(d.runs[0].steps[0].sessionId).toBe(WF_CALL)
      expect(d.runs[0].steps[0].sessionFile).toBe(callSession)
      expect(d.runIds).toEqual(['wf-single-1'])
      // content 含 renderWorkflowOverview 输出
      const text = r.content[0].text
      expect(text).toContain('run: wf-single-1')
      expect(text).toContain('[done]')
      expect(text).toContain('budget:')
      expect(text).toContain('#0')
      expect(text).toContain('call=' + WF_CALL.slice(0, 12))
      expect(text).toContain(callSession)
    })

    it('TC-w6-multi-run：多 run 拼接，content 含两段 overview，runs.length===2', async () => {
      const slug = '--wf-multi--'
      await wfMainSession(dir, slug, WF_ROOT)
      await wfV2Run(dir, slug, WF_ROOT, 'wf-multi-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }], { settled: true })
      await wfV2Run(dir, slug, WF_ROOT, 'wf-multi-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }], { settled: true })

      const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
      const d = r.details as { runs: Array<{ runId: string }>; runIds: string[] }
      expect(d.runs).toHaveLength(2)
      expect(d.runIds).toHaveLength(2)
      expect(d.runIds).toContain('wf-multi-1')
      expect(d.runIds).toContain('wf-multi-2')
      const text = r.content[0].text
      expect(text).toContain('run: wf-multi-1')
      expect(text).toContain('run: wf-multi-2')
    })

    it('TC-w6-runid-filter：runId 过滤命中单 run', async () => {
      const slug = '--wf-filter--'
      await wfMainSession(dir, slug, WF_ROOT)
      await wfV2Run(dir, slug, WF_ROOT, 'wf-filter-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }], { settled: true })
      await wfV2Run(dir, slug, WF_ROOT, 'wf-filter-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }], { settled: true })

      const r = await handleSessionRead(
        { action: 'workflow', session: WF_ROOT, runId: 'wf-filter-1' },
        { agentDir: dir },
      )
      const d = r.details as {
        runs: Array<{ runId: string }>
        runIds: string[]
        requestedRunId?: string
      }
      expect(d.runs).toHaveLength(1)
      expect(d.runIds).toEqual(['wf-filter-1'])
      expect(d.requestedRunId).toBe('wf-filter-1')
      const text = r.content[0].text
      expect(text).toContain('run: wf-filter-1')
      expect(text).not.toContain('run: wf-filter-2')
    })

    it('TC-w6-runid-not-found：runId 无匹配→ES-wf-runid-not-found（列候选+👉，不抛错）', async () => {
      const slug = '--wf-notfound--'
      await wfMainSession(dir, slug, WF_ROOT)
      await wfV2Run(dir, slug, WF_ROOT, 'wf-nf-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }], { settled: true })
      await wfV2Run(dir, slug, WF_ROOT, 'wf-nf-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }], { settled: true })

      const r = await handleSessionRead(
        { action: 'workflow', session: WF_ROOT, runId: 'wf-nonexist' },
        { agentDir: dir },
      )
      const d = r.details as { runs: unknown[]; runIds: string[]; requestedRunId?: string }
      expect(d.runs).toEqual([])
      expect(d.runIds).toContain('wf-nf-1')
      expect(d.runIds).toContain('wf-nf-2')
      expect(d.requestedRunId).toBe('wf-nonexist')
      const text = r.content[0].text
      expect(text).toContain('wf-nonexist')
      expect(text).toContain('wf-nf-1')
      expect(text).toContain('wf-nf-2')
      expect(text).toContain('👉')
    })

    it('TC-w6-no-runs：无 workflow run→ES-wf-no-runs（提示+👉family，不抛错）', async () => {
      const slug = '--wf-noruns--'
      await wfMainSession(dir, slug, WF_ROOT)
      // 无 wf-link（session 存在但未发起 workflow）

      const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
      const d = r.details as { runs: unknown[]; runIds: unknown[]; sessionId?: string }
      expect(d.runs).toEqual([])
      expect(d.runIds).toEqual([])
      expect(d.sessionId).toBe(WF_ROOT)
      const text = r.content[0].text
      expect(text).toContain('无 workflow run')
      expect(text).toContain('👉')
      expect(text).toContain('family')
    })

    // [ADR-0095] TC-w6-snapshot-skip（快照不可读 → skippedRuns）随 v1 读侧删除：
    // 发现链收敛 v2 后 run 一律 record 流直读（读失败 → running 兜底不 skipped），
    // skippedRuns 快照链对 v2 档不可达。

    it('TC-w6-call-jump：workflow 概览 call sessionId 可被 resolveSessionId 深读（outline 跳转，§7 场景 2）', async () => {
      const slug = '--wf-jump--'
      await wfMainSession(dir, slug, WF_ROOT)
      // 真实存在的 call session（main session 形态，findSessions 可匹配）
      const callPath = await wfMainSession(dir, slug, WF_CALL, { cwd: '/proj/call' })
      await wfV2Run(dir, slug, WF_ROOT, 'wf-jump-1', [{ sessionId: WF_CALL, sessionFile: callPath }], { settled: true })

      // 第一次：workflow 概览，拿 call sessionId
      const rWf = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
      const dWf = rWf.details as {
        runs: Array<{ steps: Array<{ sessionId: string; sessionFile: string }> }>
      }
      expect(dWf.runs).toHaveLength(1)
      const callSessionId = dWf.runs[0].steps[0].sessionId
      expect(callSessionId).toBe(WF_CALL)

      // 第二次：用 call sessionId 调 outline（m0 resolveSessionId 三形态复用）
      const rOutline = await handleSessionRead(
        { action: 'outline', session: callSessionId },
        { agentDir: dir },
      )
      const dOutline = rOutline.details as { turns: unknown[] }
      expect(dOutline.turns.length).toBeGreaterThan(0)
    })

    it('TC-w6-subagent-session：workflow action 对 subagent session 直读 wf-link 不抛错（MF-2）', async () => {
      const slug = '--wf-subagent--'
      // subagent session 放 subagents/ 下（不在 sessions/——buildFamilyFromFs 的 main byId
      // 索引外，旧实现 resolveFamily 找不到会抛「session not found in family index」）
      const subDir = resolveStoreSubagentSessionsDir(dir, SUB_WF_ROOT)
      await mkdir(subDir, { recursive: true })
      const subPath = join(subDir, `${SUB_WF_ROOT}.jsonl`)
      await writeFile(
        subPath,
        JSON.stringify({ type: 'session', id: SUB_WF_ROOT, cwd: `/proj/${slug}` }) + '\n',
      )
      const callSession = join(dir, 'sessions', slug, `${WF_CALL}.jsonl`)
      // subagent session 的 v2 注册条目（[ADR-0095] v1 link 形态删除；record 流直读同源）
      const recordPath = await wfStateFile(dir, slug, 'wf-sub-1.record.jsonl', [
        JSON.stringify({ type: 'run-created', seq: 1, ts: 1758000000000, runId: 'wf-sub-1', workflowName: 'test-wf', argsSummary: '{}' }),
        JSON.stringify({ type: 'agent-settled', seq: 2, ts: 1758000001000, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 100, result: { content: 'ok', sessionId: WF_CALL, sessionFile: callSession } }),
        JSON.stringify({ type: 'run-settled', seq: 3, ts: 1758000002000, outcome: 'done' }),
      ])
      await writeFile(
        subPath,
        JSON.stringify({
          type: 'custom',
          id: 'wf-reg-wf-sub-1',
          parentId: SUB_WF_ROOT,
          customType: 'workflow-record',
          data: { v: 2, kind: 'registered', runId: 'wf-sub-1', workflowName: 'test-wf', scriptName: 'test-wf', slug: 'wf-sub', startedAt: 1758000000000, recordPath },
          timestamp: '2026-09-28T00:00:00Z',
        }) + '\n',
        { flag: 'a' },
      )

      const r = await handleSessionRead({ action: 'workflow', session: SUB_WF_ROOT }, { agentDir: dir })
      const d = r.details as { runs: Array<{ runId: string }>; runIds: string[] }
      expect(d.runs).toHaveLength(1)
      expect(d.runs[0].runId).toBe('wf-sub-1')
      expect(d.runIds).toEqual(['wf-sub-1'])
      expect(r.content[0].text).toContain('run: wf-sub-1')
      expect(r.content[0].text).toContain('call=')
    })
  })

  // ============================================================
  // m3b：doFamily recursive false/true（TC-m3b-dofamily-recursive-false/true）
  // ============================================================

  describe('doFamily recursive（m3b U8 接入）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）
    const MAIN = '019e6c96-cccc-dddd-eeee-000000000001'
    const SUB = '019e6c96-cccc-dddd-eeee-000000000002'

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-recursive-'))
      dir = join(dataDir, 'agent')
      await makeFixtureSession(dir, MAIN, 'main session 内容')
      // 顶层 subagent（rootSessionId=MAIN，无 parentRecordId → flat 回退）
      await makeFixtureSubagent(dir, `sa-${SUB.slice(0, 8)}`, {
        realSessionId: SUB,
        rootSessionId: MAIN,
        agentName: 'explorer',
        firstUserText: 'subagent task',
      })
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC-m3b-dofamily-recursive-false：不传 recursive → flat family（m0-m2 零回归）', async () => {
      const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
      // details 是 Family 对象（root/subagents/workflows），非 { tree }
      const d = r.details as {
        root: { sessionId: string }
        subagents: Array<{ sessionId: string; rootSessionId: string }>
        workflows: unknown[]
      }
      expect(d.root.sessionId).toBe(MAIN)
      expect(d.subagents.some((s) => s.sessionId === SUB)).toBe(true)
      expect(Array.isArray(d.workflows)).toBe(true)
      // content 是 formatFamilyText（非 formatExecutionTreeText）
      expect(r.content[0].text).toContain('root:')
      expect(r.content[0].text).not.toContain('execution tree')
    })

    it('TC-m3b-dofamily-recursive-true：recursive=true → ExecutionTree（details.tree）', async () => {
      const r = await handleSessionRead(
        { action: 'family', session: MAIN, recursive: true },
        { agentDir: dir },
      )
      const d = r.details as {
        tree: {
          root: { type: string; sessionId: string; children: unknown[] }
          totalNodes: number
          maxDepth: number
          sourceMode: string
          truncated: boolean
        }
      }
      expect(d.tree).toBeDefined()
      expect(d.tree.root.type).toBe('main')
      expect(d.tree.root.sessionId).toBe(MAIN)
      // subagent 挂 root（flat 回退，无 parentRecordId）
      expect(d.tree.root.children).toHaveLength(1)
      expect(d.tree.totalNodes).toBe(2) // main + subagent
      expect(d.tree.sourceMode).toBe('flat-fallback') // 旧机制无 parentRecordId
      expect(d.tree.truncated).toBe(false)
      // content 是 formatExecutionTreeText（含 execution tree 头部）
      expect(r.content[0].text).toContain('execution tree')
      expect(r.content[0].text).toContain('node(s)')
      expect(r.content[0].text).toContain('👉')
    })
  })

  // ===========================================================================
  // ext-simplify-04 U4/E2（D2②）：formatFamilyText subagents 行富字段展示
  // status 终态短标签 + agent 名 + task 截 60 摘要；孤儿只标 [已清理]；P4 输出量级检查。
  // ===========================================================================

  describe('formatFamilyText subagents 行富字段（ext-simplify-04 U4 / E2）', () => {
    const MAIN = '0aaaaaaa-bbbb-7ccc-dddd-0000000000f1'
    const SUB = '0aaaaaaa-bbbb-7ccc-dddd-0000000000f2'
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'tool-handler-family-rich-'))
      dir = join(dataDir, 'agent')
      await makeFixtureSession(dir, MAIN, 'main session')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    /** alive subagent：session 文件（header + 可选 identity 尾行）+ 可选 manifest 富字段 */
    async function writeSubagent(
      realId: string,
      opts: {
        manifest?: { agentName?: string; task?: string; slug?: string; model?: string; status?: string }
        identityTask?: string
        identityAgent?: string
      } = {},
    ): Promise<void> {
      const sessionDir = resolveStoreSubagentSessionsDir(dir, MAIN)
      await mkdir(sessionDir, { recursive: true })
      const subPath = join(sessionDir, `${realId}.jsonl`)
      const lines = [JSON.stringify({ type: 'session', id: realId, cwd: '/demo' })]
      if (opts.identityTask !== undefined || opts.identityAgent !== undefined) {
        lines.push(
          JSON.stringify({
            type: 'custom',
            customType: 'subagent-identity',
            data: {
              id: `sa-${realId.slice(0, 8)}`,
              rootSessionId: MAIN,
              slug: 'identity-slug',
              agent: opts.identityAgent ?? 'explorer',
              task: opts.identityTask ?? 't',
            },
          }),
        )
      }
      await writeFile(subPath, lines.join('\n') + '\n')
      if (opts.manifest) {
        const recordsDir = resolveStoreSubagentRecordsDir(dir, MAIN)
        await mkdir(recordsDir, { recursive: true })
        await writeFile(
          join(recordsDir, `sa-${realId}.json`),
          JSON.stringify({
            id: `sa-${realId}`,
            rootSessionId: MAIN,
            sessionFile: subPath,
            ...opts.manifest,
          }),
        )
      }
    }

    /** 孤儿 manifest：sessionFile 指向不存在路径（模拟 .jsonl 被 GC） */
    async function writeOrphanManifest(
      saId: string,
      fields: { agentName?: string; task?: string; slug?: string; status?: string } = {},
    ): Promise<void> {
      const recordsDir = resolveStoreSubagentRecordsDir(dir, MAIN)
      await mkdir(recordsDir, { recursive: true })
      await writeFile(
        join(recordsDir, `${saId}.json`),
        JSON.stringify({ id: saId, rootSessionId: MAIN, sessionFile: '/nonexistent/gc.jsonl', ...fields }),
      )
    }

    it('manifest 主路径：subagents 行含 [status] agent 名 · task 摘要；root 段不变', async () => {
      await writeSubagent(SUB, {
        manifest: { agentName: 'coder', task: '修复登录表单校验并补测试', slug: 'fix-login', status: 'completed' },
      })
      const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
      const text = r.content[0].text
      // 富字段行形态（设计 §3.1）：slug 后接 [status] agent · task 摘要
      expect(text).toContain('slug=fix-login [completed] coder · 修复登录表单校验并补测试')
      // root/parents/forks/workflows 段不变（root 行含完整 id + 日期括号）
      expect(text).toContain(`root: ${MAIN} (`)
    })

    it('P4 输出量级：task 截 60 字符（超出加省略号），换行压平不破坏行结构', async () => {
      const SUB2 = '0aaaaaaa-bbbb-7ccc-dddd-0000000000f3'
      await writeSubagent(SUB, {
        manifest: { agentName: 'coder', task: 'A'.repeat(100), slug: 'long-task', status: 'running' },
      })
      await writeSubagent(SUB2, {
        manifest: { agentName: 'worker', task: 'line1\nline2\ttabbed', slug: 'nl-task', status: 'failed' },
      })
      const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
      const text = r.content[0].text
      // 截断：恰 60 字符 + 省略号，原文 61+ 连续段不出现
      expect(text).toContain(`${'A'.repeat(60)}…`)
      expect(text).not.toContain('A'.repeat(61))
      // 换行/制表压平为单空格
      expect(text).toContain('slug=nl-task [failed] worker · line1 line2 tabbed')
      // 行结构：subagents 段 = 头行 + 每 subagent 恰一行（换行未折叠出额外行）
      const lines = text.split('\n')
      const headIdx = lines.indexOf('subagents:')
      const subLines = lines.slice(headIdx + 1)
      expect(subLines).toHaveLength(2)
      expect(subLines.every((l) => l.startsWith('  ') && l.trim().length > 0)).toBe(true)
    })

    it('孤儿（cleanedUp）：仍标 [已清理]，不展开 status/agent/task 摘要', async () => {
      await writeOrphanManifest('sa-ghost-id', {
        agentName: 'worker',
        task: 'ghost task',
        slug: 'ghost-slug',
        status: 'completed',
      })
      const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
      const text = r.content[0].text
      expect(text).toContain('slug=ghost-slug [已清理]')
      // 已清理即终局：manifest 富字段不进文本（无深读入口，摘要无消费价值）
      expect(text).not.toContain('ghost task')
      expect(text).not.toContain('[completed]')
    })

    it('P-fallback（无 manifest）：identity 回退 task/agent 仍展示，status 无则无标签', async () => {
      await writeSubagent(SUB, { identityTask: 'fix bug', identityAgent: 'worker' })
      const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
      const text = r.content[0].text
      // P-fallback：task/agent 从 identity 回退（slug 取 identity.slug），status 不可回退 → 无 [x] 标签
      expect(text).toContain('slug=identity-slug worker · fix bug')
      expect(text).not.toContain('[completed]')
      expect(text).not.toContain('[running]')
    })
  })

  // ===========================================================================
  // doctor action（u8：design 2026-09-10 §6.3/§6.4/§7B 要点 2/4/5/8 + §6.11 U14b 段）
  // 全部 mkdtemp fixture 自建自删，不触碰真实数据目录。
  // ===========================================================================

  // doctor details 契约直用 doctor.ts 导出的 DoctorDetails（不再自建局部镜像——生产侧
  // 形状漂移由编译期捕捉，S-R2 同步）

  describe('doctor action（u8：环境判定 + 根表 + 告警 + 残留 glob）', () => {
    let tmp: string

    const SLUG = '--Users-foo--'

    /** 写 .jsonl fixture（父目录自建），内容合法 session header */
    async function writeJsonl(path: string, id = 'x'): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `{"type":"session","id":"${id}"}\n`)
    }

    /**
   * taiji 形态四根 fixture：dataDir 目录名带 .taiji 前缀（detectEnvironment 的
   * PI_CODING_AGENT_DIR 形态判据 `<*>/.taiji*\/agent` 可命中，托管判定走正态）。
   * live=agent/sessions 与 default 同字面路径（default 去重）、legacy 独立非空、subagent 独立。
   */
    async function buildFourRootFixture(): Promise<{
      dataDir: string
      agentDir: string
      signals: SessionReadSignals
    }> {
      const dataDir = join(tmp, '.taiji-fixture')
      const agentDir = join(dataDir, 'agent')
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'), 'aaaaaaaa')
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'b.jsonl'), 'bbbbbbbb')
      await writeJsonl(join(dataDir, 'sessions', 'old.jsonl'), 'cccccccc') // legacy 非空
      await writeJsonl(
        join(resolveStoreSubagentSessionsDir(agentDir, '0aaaaaaa-bbbb-7ccc-dddd-000000000d1'), 's.jsonl'),
        'dddddddd',
      )
      return {
        dataDir,
        agentDir,
        signals: {
          agentDir,
          liveSessionDir: join(agentDir, 'sessions'),
          env: {
            TAIJI_AGENT_EXT_LOG: '1',
            PI_CODING_AGENT_DIR: agentDir,
            TAIJI_AGENT_DATA_DIR: dataDir,
          },
        },
      }
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'tool-handler-doctor-'))
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('四根表渲染：优先级序 + 去重注记 + 文件数/耗时 + 托管判定行 + 事实型诊断（无归因断言）', async () => {
      const { dataDir, agentDir, signals } = await buildFourRootFixture()
      const r = await handleSessionRead({ action: 'doctor' }, signals)
      const text = r.content[0].text

      // 环境判定行：双信号合取 → taiji（托管）+ 数据目录 + evidence 正态
      expect(text).toContain('环境判定：taiji（托管）')
      expect(text).toContain(`数据目录：${dataDir}`)
      expect(text).toContain('依据：')
      expect(text).toContain(`PI_CODING_AGENT_DIR='${agentDir}' → 形态匹配`)

      // 四根按优先级序渲染
      const liveIdx = text.indexOf('[live]')
      const defIdx = text.indexOf('[default]')
      const legacyIdx = text.indexOf('[legacy]')
      const subIdx = text.indexOf('[subagent]')
      expect(liveIdx).toBeGreaterThan(-1)
      expect(defIdx).toBeGreaterThan(liveIdx)
      expect(legacyIdx).toBeGreaterThan(defIdx)
      expect(subIdx).toBeGreaterThan(legacyIdx)

      // 去重注记（§7B 要点 4）：default 与第 1 行（live）同路径，已去重
      expect(text).toContain('与 1 同路径，已去重')

      // 事实型诊断：只陈述最高优先级 main 根 N 文件；禁止归因断言（§7B 要点 5）
      expect(text).toContain(
        `诊断：最高优先级 main 根 [live] ${join(agentDir, 'sessions')}：2 文件。`,
      )
      expect(text).not.toContain('真的没有')

      // details 程序化形态
      const d = r.details as DoctorDetails
      expect(d.roots.map((x) => x.kind)).toEqual(['live', 'default', 'legacy', 'subagent'])
      expect(d.roots[0].fileCount).toBe(2)
      expect(typeof d.roots[0].scanMs).toBe('number')
      expect(d.roots[1].dedupedInto).toBe('live')
      expect(d.roots[1].fileCount).toBeUndefined()
      expect(d.roots[2].fileCount).toBe(1) // legacy 独立实扫
      // subagent 默认 stat 模式：只列路径与可扫性，无计数
      expect(d.roots[3].exists).toBe(true)
      expect(d.roots[3].fileCount).toBeUndefined()
      expect(d.roots[3].scanMs).toBeUndefined()
    })

    it('legacy 非空告警：独立非空 → 告警；不存在 → 无告警；与 live 同路径被去重 → 不告警（§5.1）', async () => {
      // 正态：legacy 独立且非空
      const { signals } = await buildFourRootFixture()
      const positive = await handleSessionRead({ action: 'doctor' }, signals)
      expect(positive.content[0].text).toContain(
        `告警：[legacy] 根 ${join(tmp, '.taiji-fixture', 'sessions')} 非空（1 文件）`,
      )

      // 反态：legacy 目录不存在
      const agentDir2 = join(tmp, 'data2', 'agent')
      await writeJsonl(join(agentDir2, 'sessions', SLUG, 'a.jsonl'))
      const negative = await handleSessionRead({ action: 'doctor' }, { agentDir: agentDir2 })
      expect(negative.content[0].text).not.toContain('告警：')

      // 去重态：live 与 legacy 同路径（文件非空）→ 已去重不告警
      const dataDir3 = join(tmp, 'data3')
      const agentDir3 = join(dataDir3, 'agent')
      await writeJsonl(join(dataDir3, 'sessions', SLUG, 'a.jsonl'))
      const deduped = await handleSessionRead(
        { action: 'doctor' },
        { agentDir: agentDir3, liveSessionDir: join(dataDir3, 'sessions') },
      )
      expect(deduped.content[0].text).not.toContain('告警：')
      expect(deduped.content[0].text).toContain('已去重')
    })

    it('subagent 根默认不扫（只列路径与可扫性）；includeSubagents:true 才扫出文件数（§6.3）', async () => {
      const { agentDir, signals } = await buildFourRootFixture()

      const def = await handleSessionRead({ action: 'doctor' }, signals)
      const defSub = (def.details as DoctorDetails).roots.find((x) => x.kind === 'subagent')
      expect(defSub?.fileCount).toBeUndefined()
      expect(defSub?.scanMs).toBeUndefined()
      expect(defSub?.exists).toBe(true)
      expect(def.content[0].text).toContain('未扫描（subagent 根默认不扫')

      const full = await handleSessionRead({ action: 'doctor', includeSubagents: true }, signals)
      const fullSub = (full.details as DoctorDetails).roots.find((x) => x.kind === 'subagent')
      expect(fullSub?.fileCount).toBe(1)
      expect(fullSub?.exists).toBe(true)
    })

    it('无缓存形态（ext-simplify-04 U3）：重复调用输出一致（每次实扫），新落盘文件立即可见', async () => {
      // 原三个用例（缓存命中不重扫 / TTL 到期失效 / find 不读 doctor 缓存 PS-14）随
      // doctor 缓存机删除而合并为本用例——无缓存层后「find/doctor 读到旧计数」的形态
      // 在结构上不存在，检查点收敛为：输出无「缓存命中」行 + 每次调用实扫（新增文件
      // 下一次调用即见，反而更实时）
      const agentDir = join(tmp, 'agent')
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
      const signals: SessionReadSignals = { agentDir }

      const first = (await handleSessionRead({ action: 'doctor' }, signals)).details as DoctorDetails
      const firstDef = first.roots.find((x) => x.kind === 'default')!
      expect(firstDef.fileCount).toBe(1)

      const second = await handleSessionRead({ action: 'doctor' }, signals)
      const secondDef = (second.details as DoctorDetails).roots.find((x) => x.kind === 'default')!
      expect(secondDef.fileCount).toBe(1) // 两次输出一致（同目录无变化）
      expect(second.content[0].text).not.toContain('缓存命中')

      // 新 session 落盘 → 下一次 doctor / find 均立即可见（无缓存层，每次实扫）
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'b.jsonl'), 'bbbbbbbb')
      const third = (await handleSessionRead({ action: 'doctor' }, signals)).details as DoctorDetails
      expect(third.roots.find((x) => x.kind === 'default')!.fileCount).toBe(2)
      const r = await handleSessionRead({ action: 'find', query: 'bbbbbbbb' }, { agentDir })
      const d = r.details as { matches: Array<{ sessionId: string }> }
      expect(d.matches.some((m) => m.sessionId.includes('bbbbbbbb'))).toBe(true)
    })

    it('env/bundleUrl 信号缺失降级：仍出环境判定行（standalone-pi · 未知）+ 完整根表，不抛错', async () => {
      const agentDir = join(tmp, 'agent')
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
      // signals 无 env/bundleUrl 字段（u3 旧信号包形态）
      const r = await handleSessionRead({ action: 'doctor' }, { agentDir })
      const text = r.content[0].text
      expect(text).toContain('环境判定：standalone-pi · 发行形态：未知（不猜）')
      expect(text).toContain('TAIJI_AGENT_EXT_LOG=<未设置> → 未命中')
      expect(text).toContain('会话根（按优先级）')
      expect(text).toContain('[default]')
      expect(text).toContain(
        `诊断：最高优先级 main 根 [default] ${join(agentDir, 'sessions')}：1 文件。`,
      )
    })

    it('空 agentDir 防御：无根表、诊断「无候选根」（不扫 cwd 相对路径）', async () => {
      const r = await handleSessionRead({ action: 'doctor' }, { agentDir: '' })
      const text = r.content[0].text
      expect(text).toContain('诊断：无候选根')
      expect(text).not.toContain('[default]')
      expect((r.details as DoctorDetails).roots).toEqual([])
    })
  })

  // ============================================================
  // u9：F1 重写（§5.2 事实型自检 + 编辑距离 top-3 + 四条做法 + 禁止项）
  // + uuid 归一化两级匹配（§6.7 子决策 1 + §11.5 对比基线）
  // ============================================================

  describe('u9 F1 重写 + uuid 归一化（fixture，§5.2 / §6.7 / §11.5）', () => {
    let tmp: string
    const SLUG = '--demo-cwd--'
    const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
    const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'

    /**
   * 写 session 文件（文件名 = `${id}.jsonl`，extractSessionIdFromFilename 可提取——
   * F1 编辑距离候选的 id 来源）。subagent:true 写入 subagent 根。
   */
    async function writeSession(
      id: string,
      opts?: { subagent?: boolean; firstUserText?: string },
    ): Promise<void> {
      // [session-store-layout-inversion] subagent 会话在新布局存储树（分区 sid 固定合法形态）
      const dir = opts?.subagent
        ? resolveStoreSubagentSessionsDir(join(tmp, 'agent'), '0aaaaaaa-bbbb-7ccc-dddd-0000000000s1')
        : join(tmp, 'agent', 'sessions', SLUG)
      await mkdir(dir, { recursive: true })
      const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
      if (opts?.firstUserText !== undefined) {
        lines.push(
          JSON.stringify({
            type: 'message',
            id: `${id}-m1`,
            message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
          }),
        )
      }
      await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
    }

    /** find action 便捷调用（agentDir = tmp/agent）。 */
    function find(query: string, extra?: Partial<SessionReadParams>): Promise<ToolResultLike> {
      return handleSessionRead({ action: 'find', query, ...extra }, { agentDir: join(tmp, 'agent') })
    }

    interface ToolResultLike { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
      content: Array<{ type: string; text: string }>
      details: unknown
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'tool-handler-f1-'))
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('① 大写 uuid 片段命中（§3.3 盲区：String.includes 大小写敏感）', async () => {
      await writeSession(ID1, { firstUserText: '无关内容' })
      const r = await find('019E6C96-AAAA')
      const d = r.details as { matches: Array<{ sessionId: string }> }
      expect(d.matches).toHaveLength(1)
      expect(d.matches[0].sessionId).toBe(ID1)
    })

    it('② 去连字符完整 uuid 命中（§3.3 盲区：与带连字符 id 不构成子串）', async () => {
      await writeSession(ID1, { firstUserText: '无关内容' })
      // 去连字符形态与 sessionId/path 均不构成精确子串，只能走归一化层
      const r = await find('019e6c96aaaabbbbcccc000000000001')
      const d = r.details as { matches: Array<{ sessionId: string }> }
      expect(d.matches).toHaveLength(1)
      expect(d.matches[0].sessionId).toBe(ID1)
    })

    it('③ F1 文案四要素 + 负向断言（无 recent 误导指引、无「真的没有」归因）', async () => {
      await writeSession(ID1, { firstUserText: '无关内容' })
      const r = await find('zzz-no-hit-9q8x')
      const text = r.content[0].text

      // 首行 + ①事实型自检行（根计数 / 候选集判定 / 归一化声明）
      expect(text).toContain('无匹配 session："zzz-no-hit-9q8x"')
      expect(text).toContain('自检（发现层，只陈述事实）')
      expect(text).toContain('[default]')
      expect(text).toContain('候选集非空（共 1 文件），根解析正常')
      expect(text).toContain('查询已做 uuid 归一化匹配（小写 + 去连字符）后仍无命中')
      // ②编辑距离候选段存在
      expect(text).toContain('最接近的候选（编辑距离）')
      // ③「正确做法」四条
      expect(text).toContain('正确做法')
      expect(text).toContain('改用标题/keyword')
      expect(text).toContain('直接传绝对路径')
      expect(text).toContain('更短前缀')
      expect(text).toContain('action:"doctor"')
      // ④最后一行封死 shell 绕行
      expect(text).toContain('不要用 shell find/ls/rg 搜 session 目录，不要 cat/read 原始 .jsonl')
      // 负向：无「recent 看全量」误导、无归因断言
      expect(text).not.toContain('recent')
      expect(text).not.toContain('真的没有')
      // details 程序化契约保持（零匹配形态不变）
      expect(r.details).toEqual({ matches: [], truncated: false })
    })

    it('④ 编辑距离 top-3：近似 id 入选（标注 source 与差异位），远 id 被挤出', async () => {
      const near1 = '019aaabc-0000-7000-8000-00000000000a'
      const near2 = '019aaabc-0000-7000-8000-00000000000b'
      const near3 = '019aaabc-0000-7000-8000-00000000000c'
      const far = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      await writeSession(near1)
      await writeSession(near2)
      await writeSession(near3, { subagent: true })
      await writeSession(far)
      // 手算锚点：query 与 near* 前 33 字符相同，第 34 位起 z→0/z→0/z→a，距离 3
      expect(levenshtein('019aaabc-0000-7000-8000-000000000zzz', near1)).toBe(3)
      expect(levenshtein('kitten', 'sitting')).toBe(3)

      const r = await find('019aaabc-0000-7000-8000-000000000zzz')
      const text = r.content[0].text
      // top-3 恰为三个近似候选（far 距离约 36，第 4 名被上限挤掉）
      expect(text).toContain(near1)
      expect(text).toContain(near2)
      expect(text).toContain(near3)
      expect(text).not.toContain(far)
      // 差异位标注（首个差异字符，1-based）
      expect(text).toContain('差异在第 34 位：z → 0')
      // source 标注：near3 在 subagent 根，标注透传
      expect(text).toContain(`${near3}  subagent`)
    })

    it('⑤ §11.5 归一化对比基线：增量仅限大小写/连字符变体，非 uuid 乱串不被 norm 误吸', async () => {
      const idHit = '019cafe0-1234-7000-8000-deadbeef0001'
      await writeSession(idHit, { firstUserText: '福耀玻璃深度研究' })
      await writeSession(ID2, { firstUserText: '完全不同的另一个会话' })

      // 现状基线：精确小写片段命中 1
      const base = await find('019cafe0')
      expect((base.details as { matches: unknown[] }).matches).toHaveLength(1)
      // 大写变体：增量 = 同一 id（大小写变体），无新对象
      const upper = await find('019CAFE0')
      expect((upper.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
      // 去连字符变体：增量 = 同一 id（连字符变体），无新对象
      const noDash = await find('019cafe0123470008000deadbeef0001')
      expect((noDash.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
      // 'deadbeef' 段是带连字符 id 的连续子串——现状精确匹配已命中，norm 后命中数不变（无增量）
      const deadbeef = await find('deadbeef')
      expect((deadbeef.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
      // keyword 路径不受 norm 影响（非 uuid 特征照常回退首消息）
      const kw = await find('福耀玻璃')
      expect((kw.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
      // 非 uuid 乱串：0 命中（norm 不把乱串吸进 uuid 匹配）
      const junk = await find('zzznotexist9q')
      expect((junk.details as { matches: unknown[] }).matches).toHaveLength(0)
      // hex 乱串（uuid 特征但非任何 id 子串）：两级均 0 → 短路不回退（与现状一致，无召回回归）
      const hexJunk = await find('0123456789abcdef')
      expect((hexJunk.details as { matches: unknown[] }).matches).toHaveLength(0)
    })

    it('⑥ 自检行计数 = 本次实扫结果 + 去重根注记', async () => {
      const agentDir = join(tmp, 'agent')
      // 根扫描无缓存（doctor 缓存机已删，ext-simplify-04 U3）——doctor 首跑后落盘的
      // 文件，find 自检行照实扫计数（原 PS-14「doctor 缓存 0 文件」形态结构性不存在）
      await mkdir(join(agentDir, 'sessions'), { recursive: true })
      await handleSessionRead({ action: 'doctor' }, { agentDir })
      // 之后 session 落盘（main 2 + subagent 1）
      await writeSession(ID1)
      await writeSession(ID2)
      await writeSession('019e6c96-aaaa-bbbb-cccc-000000000003', { subagent: true })

      const r = await handleSessionRead(
        { action: 'find', query: 'zzz-no-hit-9q8x' },
        { agentDir },
      )
      const text = r.content[0].text
      expect(text).toContain(`${join(agentDir, 'sessions')}：2 文件`)
      expect(text).toContain(`${resolveSessionStoreRoot(agentDir)}：1 文件`)
      expect(text).toContain('候选集非空（共 3 文件）')

      // 完整信号包（live 与 default 同路径）→ 去重根注记，不重复计数
      const deduped = await handleSessionRead(
        { action: 'find', query: 'zzz-no-hit-9q8x' },
        { agentDir, liveSessionDir: join(agentDir, 'sessions') },
      )
      expect(deduped.content[0].text).toContain('同路径，已去重')
      expect(deduped.content[0].text).toContain('候选集非空（共 3 文件）')
    })
  })

  // ============================================================
  // 片段解析接通 [live] 根（同一 roots 契约）：resolveByFragment/doXxx 透传
  // liveSessionDir——[live]≠[default] 环境（纯 pi + 显式 --session-dir）下，find
  // 能列出的 session 在 outline/result 等解析路径同样可达；F1 自检行含 [live] 根行。
  // 全部 mkdtemp fixture 自建自删，不触碰真实数据目录。
  // ============================================================

  describe('片段解析接通 [live] 根（fixture，同一 roots 契约）', () => {
    let tmp: string
    const SLUG = '--live-cwd--'
    const ID = '019e6c96-aaaa-bbbb-cccc-0000000000aa'
    const FRAGMENT = '0000000000aa'
    let agentDir: string
    /** liveSessionDir 信号（encodeCwd 形态，normalizeLiveSessionDir 剥层到 sessions/ 根）。 */
    let liveDir: string
    /** 剥层后的 [live] 根路径（F1 自检行的显示形态）。 */
    let liveRoot: string

    /** 在指定目录写 session 文件（header + user 消息，extraLines 追加 assistant 等条目）。 */
    async function writeSessionAt(dir: string, id: string, extraLines: string[] = []): Promise<void> {
      await mkdir(dir, { recursive: true })
      const lines = [
        JSON.stringify({ type: 'session', id, cwd: '/demo' }),
        JSON.stringify({
          type: 'message',
          id: `${id}-m1`,
          parentId: id,
          message: { role: 'user', content: [{ type: 'text', text: 'live 根里的会话' }] },
        }),
        ...extraLines,
      ]
      await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'tool-handler-live-'))
      agentDir = join(tmp, 'agent')
      await mkdir(join(agentDir, 'sessions'), { recursive: true }) // [default] 空根
      liveDir = join(tmp, 'pi-live', 'sessions', SLUG)
      liveRoot = join(tmp, 'pi-live', 'sessions')
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('① [live]≠[default]：outline 片段解析到 [live] 根 session；不传信号则 F1（负向对照）', async () => {
      await writeSessionAt(liveDir, ID)
      // 接通后：片段解析可达 [live] 根，outline 正常产出
      const r = await handleSessionRead(
        { action: 'outline', session: FRAGMENT },
        { agentDir, liveSessionDir: liveDir },
      )
      const d = r.details as { stats: { totalTurns: number } }
      expect(d.stats.totalTurns).toBeGreaterThanOrEqual(1)
      // 负向对照：不传 liveSessionDir（三根降级）→ 同一片段 F1 零匹配
      //（[default]/[legacy]/[subagent] 均无此文件——证明命中确实来自 [live] 根）
      await expect(
        handleSessionRead({ action: 'outline', session: FRAGMENT }, { agentDir }),
      ).rejects.toThrow(/无匹配 session/)
    })

    it('② F1 自检行含 [live] 根行（剥层路径 + 实扫计数），与 [default] 空根同表可见', async () => {
      await writeSessionAt(liveDir, ID)
      const caught = await handleSessionRead(
        { action: 'outline', session: 'zzz-no-hit-9q8x' },
        { agentDir, liveSessionDir: liveDir },
      ).catch((e: unknown) => e)
      expect(caught).toBeInstanceOf(Error)
      const text = (caught as Error).message
      expect(text).toContain('无匹配 session："zzz-no-hit-9q8x"')
      expect(text).toContain('自检（发现层，只陈述事实）')
      // [live] 根行：encodeCwd 已剥层到 sessions/ 根，计数 = 本次实扫
      expect(text).toContain(`${liveRoot}：1 文件`)
      // [default] 空根同表可见（同一 roots 契约的全貌）
      expect(text).toContain(`${join(agentDir, 'sessions')}：0 文件`)
    })

    it('③ result 片段形态同样可达 [live] 根（per-call deps 接线）', async () => {
      await writeSessionAt(liveDir, ID, [
        JSON.stringify({
          type: 'message',
          id: `${ID}-a1`,
          parentId: `${ID}-m1`,
          message: { role: 'assistant', content: [{ type: 'text', text: '最终结论正文' }] },
        }),
      ])
      const r = await handleSessionRead(
        { action: 'result', session: FRAGMENT },
        { agentDir, liveSessionDir: liveDir },
      )
      expect(r.content[0].text).toContain('最终结论正文')
    })
  })

  // ============================================================
  // u10：find 分组输出（design 2026-09-10 §5.1 形态 / §6.7 子决策 2/3 / §8.2 回归基线）
  // ============================================================

  describe('u10 find 分组输出（fixture，§6.7 子决策 2/3 + §8.2 回归基线）', () => {
    let tmp: string
    const SLUG = '--demo-cwd--'
    // uuidv7 同毫秒时间前缀碰撞是现网「34 条 subagent」形态的成因（§3.4），fixture 沿用共享前缀
    const PREFIX = '019e6c96'
    const mainId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-d${String(n).padStart(11, '0')}`
    const subId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-e${String(n).padStart(11, '0')}`

    /** 写 session 文件（subagent:true 写入 subagent 根），形态同 u9 段 writeSession。 */
    async function writeSession(
      id: string,
      opts?: { subagent?: boolean; firstUserText?: string },
    ): Promise<void> {
      // [session-store-layout-inversion] subagent 会话在新布局存储树（分区 sid 固定合法形态）
      const dir = opts?.subagent
        ? resolveStoreSubagentSessionsDir(join(tmp, 'agent'), '0aaaaaaa-bbbb-7ccc-dddd-0000000000s1')
        : join(tmp, 'agent', 'sessions', SLUG)
      await mkdir(dir, { recursive: true })
      const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
      if (opts?.firstUserText !== undefined) {
        lines.push(
          JSON.stringify({
            type: 'message',
            id: `${id}-m1`,
            message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
          }),
        )
      }
      await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
    }

    /**
   * 写带 assistant 正文的 subagent（manifest + session 文件三行形态），
   * 供 result action 批量调用（回归基线：批量头行 8 字符短 id 不受 u10 影响）。
   */
    async function writeSubagentWithResult(saId: string, id: string, body: string): Promise<void> {
      const sessionFile = join(
        resolveStoreSubagentSessionsDir(join(tmp, 'agent'), 'root-u10'),
        `${id}.jsonl`,
      )
      await mkdir(dirname(sessionFile), { recursive: true })
      const lines = [
        JSON.stringify({ type: 'session', id, cwd: '/demo' }),
        JSON.stringify({
          type: 'message',
          id: `${id}-m1`,
          message: { role: 'user', content: [{ type: 'text', text: 'task' }] },
        }),
        JSON.stringify({
          type: 'message',
          id: `${id}-a1`,
          message: { role: 'assistant', content: [{ type: 'text', text: body }] },
        }),
      ]
      await writeFile(sessionFile, lines.join('\n') + '\n')
      const recordsDir = resolveStoreSubagentRecordsDir(join(tmp, 'agent'), 'root-u10')
      await mkdir(recordsDir, { recursive: true })
      await writeFile(
        join(recordsDir, `${saId}.json`),
        JSON.stringify({ id: saId, rootSessionId: 'root-u10', agentName: 'explorer', sessionFile }),
      )
    }

    function find(
      query: string,
      extra?: Partial<SessionReadParams>,
    ): ReturnType<typeof handleSessionRead> {
      return handleSessionRead({ action: 'find', query, ...extra }, { agentDir: join(tmp, 'agent') })
    }

    interface FindDetails { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
      matches: Array<{ source: string; sessionId: string }>
      truncated: boolean
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'tool-handler-u10-'))
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('① main 置顶 + 全 id + ↳ 可复制调用串 + 编号跨组连续（§5.1 全列出形态）', async () => {
      const M1 = mainId(1)
      const S1 = subId(1)
      const S2 = subId(2)
      await writeSession(M1, { firstUserText: 'main content' })
      await writeSession(S1, { subagent: true, firstUserText: 'sub content one' })
      await writeSession(S2, { subagent: true, firstUserText: 'sub content two' })

      const r = await find(PREFIX)
      const text = r.content[0].text
      // main 段置顶：main 组头与 main id 均先于 subagent 出现
      expect(text.indexOf('main（')).toBeLessThan(text.indexOf('subagent（'))
      expect(text.indexOf(M1)).toBeLessThan(text.indexOf(S1))
      expect(text).toContain('main（1 条命中）：')
      expect(text).toContain('subagent（2 条命中）：')
      // 全 id：36 字符完整出现，8 字符截断形态消失（§6.7 子决策 3）
      expect(text).toContain(M1)
      expect(text).not.toContain(`${M1.slice(0, 8)}…`)
      // ↳ 可复制调用串只附 main 候选（subagent 噪声不配指针）
      expect(text).toContain(`↳ session_read { action:"outline", session:"${M1}" }`)
      expect(text).not.toContain(`session:"${S1}"`)
      // 编号跨组连续：main 是 1 号，subagent 段续 2 号（组内 mtime 序不固定，用正则）
      expect(text).toContain(`  1. ${M1}`)
      expect(text).toMatch(/  2\. 019e6c96-aaaa-bbbb-cccc-e0000000000[12]/)
      // details 合并列表：main 首位、集合完整、无截断
      const d = r.details as FindDetails
      expect(d.truncated).toBe(false)
      expect(d.matches[0]).toMatchObject({ source: 'main', sessionId: M1 })
      expect(new Set(d.matches.map((m) => m.sessionId))).toEqual(new Set([M1, S1, S2]))
    })

    it('② subagent 超剩余配额 → 折叠计数行 + 加 source:"subagent" 提示（§6.7 子决策 2）', async () => {
      const M1 = mainId(1)
      await writeSession(M1)
      for (let i = 1; i <= 3; i++) await writeSession(subId(i), { subagent: true })

      // limit 2：main 1 条（无溢出）→ 剩余配额 1 → subagent 展示 1 条 + 溢出折叠
      const r = await find(PREFIX, { limit: 2 })
      const text = r.content[0].text
      expect(text).toContain('main（1 条命中）：')
      expect(text).toContain('subagent（>1 条命中，显示前 1 条）：')
      expect(text).toContain('… 另有 subagent 命中未显示。👉 加 source:"subagent" 查看')
      const d = r.details as FindDetails
      expect(d.truncated).toBe(true)
      expect(d.matches).toHaveLength(2)
      expect(d.matches[0].source).toBe('main')
      expect(d.matches.filter((m) => m.source === 'subagent')).toHaveLength(1)
    })

    it('③ main 命中占满 limit → subagent 段 0 条仅显示计数（§6.7：main 优先占满）', async () => {
      for (let i = 1; i <= 3; i++) await writeSession(mainId(i))
      for (let i = 1; i <= 2; i++) await writeSession(subId(i), { subagent: true })

      const r = await find(PREFIX, { limit: 3 })
      const text = r.content[0].text
      expect(text).toContain('main（3 条命中）：')
      expect(text).toContain('subagent（有命中未显示——展示配额已被 main 占满）：')
      expect(text).toContain('👉 加 source:"subagent" 查看')
      // subagent 条目与调用串不出现（0 条展示）
      expect(text).not.toContain(subId(1))
      const d = r.details as FindDetails
      expect(d.matches).toHaveLength(3)
      expect(d.matches.every((m) => m.source === 'main')).toBe(true)
      // 合并总量：命中 3 main + 2 sub > 展示 3 → truncated=true
      expect(d.truncated).toBe(true)
    })

    it('④ truncated 按合并总量计算（命中总数 vs 实际输出数，含 main 恰满边界）', async () => {
      for (let i = 1; i <= 2; i++) await writeSession(mainId(i))
      for (let i = 1; i <= 2; i++) await writeSession(subId(i), { subagent: true })

      // a) 全列出（4 ≤ 20）：truncated=false
      const all = (await find(PREFIX)).details as FindDetails
      expect(all.matches).toHaveLength(4)
      expect(all.truncated).toBe(false)

      // b) main 恰好占满 limit（2/2）+ subagent 有命中 → 仍截断（防 main 恰满漏探测 subagent）
      const exact = (await find(PREFIX, { limit: 2 })).details as FindDetails
      expect(exact.matches).toHaveLength(2)
      expect(exact.matches.every((m) => m.source === 'main')).toBe(true)
      expect(exact.truncated).toBe(true)

      // c) 混合截断：展示 3（2 main + 1 sub）< 命中 4 → truncated=true
      const mixed = (await find(PREFIX, { limit: 3 })).details as FindDetails
      expect(mixed.matches).toHaveLength(3)
      expect(mixed.matches.filter((m) => m.source === 'main')).toHaveLength(2)
      expect(mixed.matches.filter((m) => m.source === 'subagent')).toHaveLength(1)
      expect(mixed.truncated).toBe(true)
    })

    it('⑤a 回归基线：find{query:<前缀>, limit:100} main 0 条 + subagent 全列（现网 34 条形态）', async () => {
      for (let i = 1; i <= 34; i++) await writeSession(subId(i), { subagent: true })

      const r = await find(PREFIX, { limit: 100 })
      const d = r.details as FindDetails
      expect(d.matches).toHaveLength(34)
      expect(d.matches.every((m) => m.source === 'subagent')).toBe(true)
      expect(d.truncated).toBe(false)
      const text = r.content[0].text
      // main 段 0 条可辨识（防「全是 subagent」被误读），subagent 段全列不折叠
      expect(text).toContain('main（0 条命中）：')
      expect(text).toContain('subagent（34 条命中）：')
      expect(text).not.toContain('加 source:"subagent"')
    })

    it('⑤b 回归基线：result 批量头行仍 8 字符短 id（SESSION_ID_PREFIX_LEN 通路不动）', async () => {
      const R1 = `${PREFIX}-aaaa-bbbb-cccc-f00000000001`
      const R2 = `${PREFIX}-aaaa-bbbb-cccc-f00000000002`
      await writeSubagentWithResult('sa-u10-r1', R1, 'alpha body')
      await writeSubagentWithResult('sa-u10-r2', R2, 'beta body')

      const res = await handleSessionRead(
        { action: 'result', session: 'sa-u10-r1,sa-u10-r2' },
        { agentDir: join(tmp, 'agent') },
      )
      const text = res.content[0].text
      expect(text).toContain(`(session ${R1.slice(0, 8)}…)`)
      expect(text).toContain(`(session ${R2.slice(0, 8)}…)`)
    })

    it('⑤c 回归基线：recent 查询 main 段置顶可辨识', async () => {
      for (let i = 1; i <= 2; i++) await writeSession(mainId(i))
      for (let i = 1; i <= 2; i++) await writeSession(subId(i), { subagent: true })

      const r = await find('recent')
      const text = r.content[0].text
      expect(text.indexOf('main（2 条命中）：')).toBeLessThan(text.indexOf('subagent（2 条命中）：'))
      const d = r.details as FindDetails
      expect(d.matches).toHaveLength(4)
      // 分组价值：main/subagent 的 mtime 交错也被 main 段置顶（§8.2「main 段置顶后可辨识」）
      expect(d.matches.slice(0, 2).every((m) => m.source === 'main')).toBe(true)
      expect(d.truncated).toBe(false)
    })

    it('⑥ resolveByFragment 独立无分组语义：outline 片段多匹配 → F2 全量候选（不被配额截断）', async () => {
      for (let i = 1; i <= 2; i++) await writeSession(mainId(i))
      for (let i = 1; i <= 3; i++) await writeSession(subId(i), { subagent: true })

      // 解析路径（resolveByFragment → findSessions limit:10 无 source）保持 mtime 排序 +
      // limit 截断原语义：5 命中全进 F2 消歧候选，无 main 置顶/配额分组介入（§6.7 末条）
      const r = await handleSessionRead({ action: 'outline', session: PREFIX }, { agentDir: join(tmp, 'agent') })
      const d = r.details as { ambiguous: boolean; candidates: Array<{ sessionId: string }> }
      expect(d.ambiguous).toBe(true)
      expect(d.candidates).toHaveLength(5)
      expect(new Set(d.candidates.map((c) => c.sessionId))).toEqual(
        new Set([mainId(1), mainId(2), subId(1), subId(2), subId(3)]),
      )
    })

    it('⑥b 显式 source 查询走单组原语义：不折叠、保持 mtime+limit 截断', async () => {
      for (let i = 1; i <= 3; i++) await writeSession(subId(i), { subagent: true })

      // 显式 source 本身就是折叠提示所指的展开动作，不再折叠
      const r = await find(PREFIX, { source: 'subagent', limit: 1 })
      const text = r.content[0].text
      expect(text).toContain('subagent（1 条命中）：')
      expect(text).not.toContain('加 source:"subagent"')
      const d = r.details as FindDetails
      expect(d.matches).toHaveLength(1)
      expect(d.matches[0].source).toBe('subagent')
      expect(d.truncated).toBe(true)
    })
  })

  // ============================================================
  // E1：find 单次根解析（ext-simplify-04 U2，探针 P1）。spy 打在 roots 模块命名空间
  // 上跨模块拦截（find.ts / findNoMatch 渲染链的消费点全走同一入口），断言 doFind
  // 全路径（分组 / 显式 source / 零匹配）resolveSessionRoots 恰调用 1 次——改前分组
  // 2 次、零匹配 3 次（impl-plan D-15④ 登记的分组双倍实扫债），预解析根复用后恒 1 次。
  // ============================================================
  describe('E1 find 单次根解析（探针 P1：resolveSessionRoots 恰 1 次）', () => {
    let tmp: string
    const SLUG = '--e1-cwd--'
    const PREFIX = '019e7e10'
    const mainId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-d${String(n).padStart(11, '0')}`
    const subId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-e${String(n).padStart(11, '0')}`

    /** 写 session 文件（subagent:true 写入 subagent 根），形态同 u10 段 writeSession。 */
    async function writeSession(id: string, opts?: { subagent?: boolean }): Promise<void> {
      // [session-store-layout-inversion] subagent 会话在新布局存储树（分区 sid 固定合法形态）
      const dir = opts?.subagent
        ? resolveStoreSubagentSessionsDir(join(tmp, 'agent'), '0aaaaaaa-bbbb-7ccc-dddd-0000000000s1')
        : join(tmp, 'agent', 'sessions', SLUG)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, `${id}.jsonl`),
        JSON.stringify({ type: 'session', id, cwd: '/e1' }) + '\n',
      )
    }

    function find(
      query: string,
      extra?: Partial<SessionReadParams>,
    ): ReturnType<typeof handleSessionRead> {
      return handleSessionRead({ action: 'find', query, ...extra }, { agentDir: join(tmp, 'agent') })
    }

    /** spy 计数器 + 断言 helper：包装一段 find 调用，返回 { 结果, 调用次数 }。 */
    async function findCounting(
      query: string,
      extra?: Partial<SessionReadParams>,
    ): Promise<{ result: Awaited<ReturnType<typeof handleSessionRead>>; resolveCalls: number }> {
      const rootsModule = await import('../discovery/roots.js')
      const spy = vi.spyOn(rootsModule, 'resolveSessionRoots')
      try {
        const result = await find(query, extra)
        return { result, resolveCalls: spy.mock.calls.length }
      } finally {
        spy.mockRestore()
      }
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'tool-handler-e1-'))
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('① 分组路径（main + subagent 两段查询，有命中）：恰 1 次', async () => {
      await writeSession(mainId(1))
      await writeSession(subId(1), { subagent: true })
      const { result, resolveCalls } = await findCounting(PREFIX)
      const d = result.details as { matches: Array<{ source: string }>; truncated: boolean }
      // 前置：两段确实各自命中（分组语义不变），再断言扫描收敛
      expect(d.matches).toHaveLength(2)
      expect(new Set(d.matches.map((m) => m.source))).toEqual(new Set(['main', 'subagent']))
      expect(d.truncated).toBe(false)
      expect(resolveCalls).toBe(1)
    })

    it('② 显式 source 路径（单组查询，有命中）：恰 1 次', async () => {
      await writeSession(mainId(1))
      await writeSession(subId(1), { subagent: true })
      const { result, resolveCalls } = await findCounting(PREFIX, { source: 'subagent' })
      const d = result.details as { matches: Array<{ source: string }> }
      expect(d.matches).toHaveLength(1)
      expect(d.matches[0].source).toBe('subagent')
      expect(resolveCalls).toBe(1)
    })

    it('③ 分组零匹配 → F1 自检行：恰 1 次（改前 3 次）且根表仍进渲染', async () => {
      await writeSession(mainId(1))
      const { result, resolveCalls } = await findCounting('zzz-e1-no-hit-9q8x')
      const d = result.details as { matches: unknown[]; truncated: boolean }
      expect(d.matches).toEqual([])
      expect(d.truncated).toBe(false)
      // F1 自检行消费预解析根表（非空根计数可见 = roots 确实传入而非空列表）
      expect(result.content[0].text).toContain('自检（发现层，只陈述事实）')
      expect(result.content[0].text).toContain('候选集非空')
      expect(resolveCalls).toBe(1)
    })

    it('④ 显式 source 零匹配 → F1 自检行：恰 1 次（改前 2 次）', async () => {
      await writeSession(subId(1), { subagent: true })
      const { result, resolveCalls } = await findCounting('zzz-e1-no-hit-9q8x', { source: 'main' })
      expect(result.content[0].text).toContain('无匹配 session')
      expect(result.content[0].text).toContain('自检（发现层，只陈述事实）')
      expect(resolveCalls).toBe(1)
    })
  })

  // ============================================================
  // u11：metadataProvider 注入 + TTL 缓存（design 2026-09-10 §6.6）
  // handler 级集成：注入包装（metadata 缓存独立实例——根扫描无缓存，doctor 缓存机
  // 已删除，ext-simplify-04 U3，不存在串扰面）
  // + 标题渲染（§5.1 候选行标题优先）+ provider 抛错降级不外抛。
  // 策略①惰性/②窄化/合并语义在 find.test.ts u11 段覆盖。
  // ============================================================
  describe('u11 metadataProvider 注入 + TTL 缓存（fixture，§6.6）', () => {
    let tmp: string
    /** 平铺 main 根（taiji 形态），同时作 liveSessionDir（与 [default] 根同字面路径） */
    let flatMain: string

    async function writeSession(
      id: string,
      opts?: { firstUserText?: string },
    ): Promise<string> {
      await mkdir(flatMain, { recursive: true })
      const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
      if (opts?.firstUserText !== undefined) {
        lines.push(
          JSON.stringify({
            type: 'message',
            id: `${id}-m1`,
            message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
          }),
        )
      }
      const path = join(flatMain, `${id}.jsonl`)
      await writeFile(path, lines.join('\n') + '\n')
      return path
    }

    function findWithProvider(
      query: string,
      provider: SessionMetadataProvider,
    ): ReturnType<typeof handleSessionRead> {
      return handleSessionRead(
        { action: 'find', query },
        { agentDir: join(tmp, 'agent'), liveSessionDir: flatMain },
        undefined,
        provider,
      )
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'tool-handler-u11-'))
      flatMain = join(tmp, 'agent', 'sessions')
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('② 标题进匹配与渲染：keyword 命中 name → 候选行标题优先展示 + details.matches[].name 透传', async () => {
      const id = 'm-title-0001'
      const p = await writeSession(id, { firstUserText: '首消息无关' })
      const provider = vi.fn(async (dir: string) =>
        dir === flatMain
          ? [
              {
                path: p,
                id,
                cwd: '/demo',
                name: '太保寿险深度研究攻坚',
                modified: new Date(),
                firstMessage: '首消息无关',
              },
            ]
          : [],
      )
      const r = await findWithProvider('太保寿险', provider)
      const text = r.content[0].text
      // §5.1 形态：候选行末段为标题（name 优先于首消息预览）
      expect(text).toContain('太保寿险深度研究攻坚')
      const d = r.details as { matches: Array<{ sessionId: string; name?: string }> }
      expect(d.matches[0].sessionId).toBe(id)
      expect(d.matches[0].name).toBe('太保寿险深度研究攻坚')
      // 注入边界生效：provider 被 TTL 包装调用且实参非空串
      expect(provider).toHaveBeenCalledTimes(1)
      expect(provider.mock.calls[0][0]).toBe(flatMain)
    })

    it('④ provider 抛错 → handler 不抛，降级首条 user 匹配（标题留空，错误不外泄）', async () => {
      const id = 'err-handler-01'
      await writeSession(id, { firstUserText: 'handler 降级命中文本' })
      const provider = vi.fn(async () => {
        throw new Error('listAll secret boom')
      })
      const r = await findWithProvider('handler 降级命中', provider)
      const d = r.details as { matches: Array<{ sessionId: string; name?: string }> }
      expect(d.matches).toHaveLength(1)
      expect(d.matches[0].sessionId).toBe(id)
      expect(d.matches[0].name).toBeUndefined()
      // 错误细节不进工具输出（降级不是错误）
      expect(r.content[0].text).not.toContain('boom')
    })

    it('⑤ TTL 缓存（fake timers）：TTL 内不重调、过期重调、目录 mtime 变化失效', async () => {
      const id = 'ttl-00000001'
      const p = await writeSession(id, { firstUserText: '无关' })
      const provider = vi.fn(async (dir: string) =>
        dir === flatMain
          ? [{ path: p, id, cwd: '/demo', name: '标题', modified: new Date() }]
          : [],
      )
      // 仅 fake Date（缓存 TTL 判定用），fs/performance 走真实实现
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        // 首查：cache miss → 调 1 次
        await findWithProvider('zzznohit9q', provider)
        expect(provider).toHaveBeenCalledTimes(1)
        // TTL 内二查：命中缓存不重调
        await findWithProvider('zzznohit9q', provider)
        expect(provider).toHaveBeenCalledTimes(1)
        // TTL 过期 → 重调
        vi.setSystemTime(Date.now() + METADATA_CACHE_TTL_MS + 1)
        await findWithProvider('zzznohit9q', provider)
        expect(provider).toHaveBeenCalledTimes(2)
        // TTL 内但目录 mtime 变化 → 失效重调
        const bumped = new Date(Date.now() + 60_000)
        await utimes(flatMain, bumped, bumped)
        await findWithProvider('zzznohit9q', provider)
        expect(provider).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // u12 跨会话内容检索（fixture，§2 目标 5 / §8.2 V8：窄化前置 + 字节上限 + 渲染）
  // 全部 mkdtemp fixture 自建自删，不触碰真实数据目录。
  // ---------------------------------------------------------------------------

  describe('u12 跨会话内容检索（fixture，V8）', () => {
    let tmp: string
    /** main 根（平铺，[default] 根直扫）与 subagent 根 */
    let mainDir: string
    const SLUG = '--demo-cwd--'
    // uuidv7 风格形态（find 输出的完整 id 即此形态；u12 索引按 header id，不依赖文件名反推）
    const mainId = (n: number) => `019e6c96-aaaa-bbbb-cccc-d${String(n).padStart(11, '0')}`
    const subId = (n: number) => `019e6c96-aaaa-bbbb-cccc-e${String(n).padStart(11, '0')}`

    /**
   * 写多 turn session（链式 parentId——buildTreeView leaf 回溯需要，无链的后行 entry
   * 会被当旁支过滤，MF-5 段同款教训）。turn 分段：user 开新 turn，assistant 并入当前。
   */
    async function writeSession(
      id: string,
      turns: Array<{ role: 'user' | 'assistant'; text: string }>,
      opts?: { subagent?: boolean },
    ): Promise<void> {
      const dir = opts?.subagent
        ? resolveStoreSubagentSessionsDir(join(tmp, 'agent'), '0aaaaaaa-bbbb-7ccc-dddd-0000000000s2')
        : join(tmp, 'agent', 'sessions')
      await mkdir(dir, { recursive: true })
      const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
      turns.forEach((t, i) => {
        lines.push(
          JSON.stringify({
            type: 'message',
            id: `${id}-m${i}`,
            parentId: i === 0 ? id : `${id}-m${i - 1}`,
            message: { role: t.role, content: [{ type: 'text', text: t.text }] },
          }),
        )
      })
      await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
    }

    /** 造大文件：追加一条 2KB filler 文本（字节上限用例用，pattern 避开 filler 字符）。 */
    async function writeFatSession(id: string): Promise<void> {
      await writeSession(id, [
        { role: 'user', text: `filler ${'x'.repeat(2048)}` },
        { role: 'assistant', text: 'done' },
      ])
    }

    interface CrossDetails { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
      rejected?: boolean
      candidateCount?: number
      pattern: string
      scope: string
      degraded: boolean
      byteBudget: number
      scannedBytes: number
      scanned: Array<{
        sessionId: string
        source: string
        name?: string
        hits: Array<{ turnIndex: number; entryIndex: number; role: string; matchSnippet: string }>
        hitsTotal?: number
      }>
      skipped: Array<{ sessionId: string; reason: string; sizeBytes?: number }>
      truncated: boolean
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'tool-handler-u12-'))
      mainDir = join(tmp, 'agent', 'sessions')
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('① 窄化拒绝：候选超上限 → 拒绝文案 + 先 find 指引，不深扫（V8）', async () => {
      // 库中放一个真实可命中的 session——拒绝路径不得把它扫出来
      await writeSession(mainId(1), [
        { role: 'user', text: '讨论 adj_factor 的历史数据' },
        { role: 'assistant', text: 'adj_factor 表在 dws 库' },
      ])
      const ids = Array.from({ length: MULTI_SEARCH_MAX_SESSIONS + 1 }, (_, i) => mainId(i + 10))
      const r = await handleSessionRead(
        { action: 'search', session: ids.join(','), pattern: 'adj_factor' },
        { agentDir: join(tmp, 'agent') },
      )
      const text = r.content[0].text
      expect(text).toContain('跨会话检索已拒绝')
      expect(text).toContain(`超出单次上限 ${MULTI_SEARCH_MAX_SESSIONS} 个`)
      expect(text).toContain('先窄化')
      expect(text).toContain('action:"find"')
      expect(text).toContain('action:"search", session:"<id1>,<id2>"')
      const d = r.details as Partial<CrossDetails>
      expect(d.rejected).toBe(true)
      expect(d.candidateCount).toBe(MULTI_SEARCH_MAX_SESSIONS + 1)
      // 不深扫：可命中内容与命中结构都不出现
      expect(text).not.toContain('adj_factor 表在 dws 库')
      expect(text).not.toContain('hits:')
      expect(d.scanned).toBeUndefined()
    })

    it('②a 字节上限截断：预算按序消耗，放不下的文件起整段停止并报告已扫范围', async () => {
      const A = mainId(1)
      const B = mainId(2)
      await writeSession(A, [
        { role: 'user', text: 'small session' },
        { role: 'assistant', text: 'ok' },
      ])
      await writeFatSession(B)
      // 直接调导出函数注入小预算（工具路径走默认 64MB，fixture 不构造 64MB 文件）
      const r = await searchAcrossSessions([A, B], 'zzzkw', { agentDir: join(tmp, 'agent') }, {
        byteBudget: 1024,
      })
      const d = r.details as CrossDetails
      // A 扫完（无命中也入 scanned），B 放不下 → byte-budget，且其 sizeBytes 有报告
      expect(d.scanned).toHaveLength(1)
      expect(d.scanned[0].sessionId).toBe(A)
      expect(d.scannedBytes).toBeGreaterThan(0)
      expect(d.scannedBytes).toBeLessThanOrEqual(1024)
      expect(d.skipped).toHaveLength(1)
      expect(d.skipped[0]).toMatchObject({ sessionId: B, reason: 'byte-budget' })
      expect(d.skipped[0].sizeBytes).toBeGreaterThan(1024)
      const text = r.content[0].text
      expect(text).toContain('not scanned')
      expect(text).toContain(B)
      expect(text).toContain(A)
      // 未扫 id 附单独检索指引
      expect(text).toContain(`action:"search", session:"${B}", pattern:"zzzkw"`)
    })

    it('②b 首个文件即超预算 → 0 扫描，整段未扫报告（不突破上限）', async () => {
      const B = mainId(2)
      await writeFatSession(B)
      const r = await searchAcrossSessions([B], 'zzzkw', { agentDir: join(tmp, 'agent') }, {
        byteBudget: 512,
      })
      const d = r.details as CrossDetails
      expect(d.scanned).toHaveLength(0)
      expect(d.scannedBytes).toBe(0)
      expect(d.skipped).toEqual([{ sessionId: B, reason: 'byte-budget', sizeBytes: expect.any(Number) }])
      expect(r.content[0].text).toContain('not scanned')
    })

    it('③ 命中渲染：session 列表（完整 id+source+标题）+ turn 索引/角色/片段 + 可执行调用串', async () => {
      const A = mainId(1)
      const B = subId(1)
      const C = mainId(2)
      // A：T000 两命中（user+assistant）+ T001 一命中（assistant）
      await writeSession(A, [
        { role: 'user', text: '查询 adj_factor 的历史数据' },
        { role: 'assistant', text: 'adj_factor 表在 dws 库' },
        { role: 'user', text: '换一个话题' },
        { role: 'assistant', text: '再看 adj_factor 的最新分区' },
      ])
      await writeSession(B, [
        { role: 'user', text: 'subagent task 无关键词' },
        { role: 'assistant', text: '结果里含 adj_factor 字样' },
      ], { subagent: true })
      await writeSession(C, [
        { role: 'user', text: '完全没有关键词的内容' },
      ])
      const provider: SessionMetadataProvider = async (dir) =>
        dir === mainDir
          ? [{ path: join(mainDir, `${A}.jsonl`), id: A, cwd: '/demo', name: '太保寿险深度研究', modified: new Date() }]
          : []
      const r = await handleSessionRead(
        { action: 'search', session: `${A},${B},${C}`, pattern: 'adj_factor' },
        { agentDir: join(tmp, 'agent'), liveSessionDir: mainDir },
        undefined,
        provider,
      )
      const text = r.content[0].text
      // header：命中/已扫计数 + 默认预算标注（handleSessionRead 路径走 SEARCH_SCAN_BYTE_BUDGET，
      // formatScanBytes 的 MB 形态恒 1 位小数）
      expect(text).toContain('2/3 session(s) hit for /adj_factor/')
      expect(text).toContain(`${(SEARCH_SCAN_BYTE_BUDGET / (1024 * 1024)).toFixed(1)}MB budget`)
      // 命中块：完整 id + source + 标题（provider 注入）+ 命中数，列表序 = 传入序
      expect(text).toContain(`1. ${A} · main · 太保寿险深度研究（3 hits）`)
      expect(text).toContain(`2. ${B} · subagent（1 hit）`)
      // turn 索引 + entry 序号 + 角色 + 片段
      expect(text).toContain('     T000 #0 user: ')
      expect(text).toContain('     T000 #1 assistant: ')
      expect(text).toContain('     T001 #1 assistant: ')
      // 可直接执行的调用串（真实参数 = pattern）
      expect(text).toContain(`↳ session_read { action:"search", session:"${A}", pattern:"adj_factor" }`)
      expect(text).toContain(`↳ session_read { action:"search", session:"${B}", pattern:"adj_factor" }`)
      // 已扫无命中段
      expect(text).toContain('scanned, no hit:')
      expect(text).toContain(`${C} · main`)
      const d = r.details as CrossDetails
      expect(d.rejected).toBeUndefined()
      expect(d.truncated).toBe(false)
      expect(d.degraded).toBe(false)
      expect(d.byteBudget).toBe(SEARCH_SCAN_BYTE_BUDGET)
      expect(d.skipped).toEqual([])
      expect(d.scanned.map((s) => s.sessionId)).toEqual([A, B, C])
      expect(d.scanned[0].hits).toHaveLength(3)
      expect(d.scanned[0].name).toBe('太保寿险深度研究')
      expect(d.scanned[1].hits).toHaveLength(1)
      // B 只有一条 user → 单 turn，assistant 命中在 T000 #1
      expect(d.scanned[1].hits[0]).toMatchObject({
        turnIndex: 0,
        entryIndex: 1,
        role: 'assistant',
      })
      expect(d.scanned[2].hits).toHaveLength(0)
    })

    it('④ 无命中形态 + not-found 报告（不在库中的 id 不中断整体）', async () => {
      const A = mainId(1)
      const GHOST = mainId(99)
      await writeSession(A, [{ role: 'user', text: '普通内容' }])
      const r = await handleSessionRead(
        { action: 'search', session: `${A},${GHOST}`, pattern: 'zzznothing' },
        { agentDir: join(tmp, 'agent') },
      )
      const text = r.content[0].text
      expect(text).toContain('0/1 session(s) hit for /zzznothing/')
      expect(text).toContain('scanned, no hit:')
      expect(text).toContain(`${A} · main`)
      expect(text).toContain('换更精确 pattern')
      expect(text).toContain('not found in library')
      expect(text).toContain(`- ${GHOST}`)
      const d = r.details as CrossDetails
      expect(d.scanned).toHaveLength(1)
      expect(d.scanned[0].hits).toHaveLength(0)
      expect(d.skipped).toEqual([{ sessionId: GHOST, reason: 'not-found' }])
    })

    it('⑤ 单会话语义无回归：无逗号 session 走原路径（hits 结构），pattern 含逗号不误分流', async () => {
      const A = mainId(1)
      await writeSession(A, [
        { role: 'user', text: 'aaa plugin 内容' },
        { role: 'assistant', text: 'bbb' },
      ])
      // 单 id：原 details.hits 结构与 header 形态不变
      const r = await handleSessionRead(
        { action: 'search', session: A, pattern: 'plugin' },
        { agentDir: join(tmp, 'agent') },
      )
      expect(r.content[0].text).toContain('1 hit(s) for /plugin/')
      const d = r.details as { hits: unknown[]; truncated: boolean; scanned?: unknown }
      expect(d.hits).toHaveLength(1)
      expect(d.truncated).toBe(false)
      expect(d.scanned).toBeUndefined()
      // pattern 含逗号不触发跨会话（分流只看 session）
      const r2 = await handleSessionRead(
        { action: 'search', session: A, pattern: 'aaa,bbb' },
        { agentDir: join(tmp, 'agent') },
      )
      expect((r2.details as { hits: unknown[] }).hits).toHaveLength(0)
      expect((r2.details as { scanned?: unknown }).scanned).toBeUndefined()
      expect(r2.content[0].text).not.toContain('session(s) hit')
    })

    it('⑥ per-session limit 截断：超限 session 标注 >N hits，truncated=true', async () => {
      const A = mainId(1)
      await writeSession(A, [
        { role: 'user', text: 'kw one' },
        { role: 'assistant', text: 'kw two' },
        { role: 'user', text: 'kw three' },
      ])
      const r = await searchAcrossSessions([A], 'kw', { agentDir: join(tmp, 'agent') }, { limit: 2 })
      const d = r.details as CrossDetails
      expect(d.truncated).toBe(true)
      expect(d.scanned[0].hits).toHaveLength(2)
      expect(d.scanned[0].hitsTotal).toBe(3)
      expect(r.content[0].text).toContain('（>3 hits, showing first 2）')
    })

    it('⑦ abort 信号透传：跨会话扫描中断抛错（与单会话 MF-5 语义一致）', async () => {
      const A = mainId(1)
      await writeSession(A, [{ role: 'user', text: 'content' }])
      const ac = new AbortController()
      ac.abort()
      await expect(
        searchAcrossSessions([A], 'kw', { agentDir: join(tmp, 'agent') }, { signal: ac.signal }),
      ).rejects.toThrow(/中断/)
    })
  })
});
