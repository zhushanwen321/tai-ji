/**
 * ArchiveService 三操作方法体级单测（session-archive 设计 D5/D8/D9/D13——真实 tmp
 * 目录驱动，fake deps 编排观测）。
 *
 * 覆盖（impl-plan u-archive-service 验收条款）：
 * - 三操作（archive/unarchive/purgeArchive）全链 + 前置三门 + 错误码；
 * - 聚合不变量 1-4（互斥存在 / 压缩体消费前校验 / 列表派生 / 扫描范围互斥）；
 * - per-session 三操作串行化（压缩中 unarchive 等待后正确执行；后到者对已消失
 *   归档单元 fail-fast）；
 * - purge 簿记存在性门（无簿记拒绝 + 零副作用）；
 * - suppress 消费点探针（残留风险 R2）：归档活跃 session 的死亡处置调用序。
 *
 * D9 转移表穷举单测（generateTableTests 18 组合）在 archive-entry-machine.test.ts
 * （基建包 M1 交付，testCommand 同被 `vitest run archive` 命中）；cascade 引用枚举
 * 源入参扩展的分支断言三组在 session-content-cascade-archive.test.ts；自愈七行在
 * archive-self-heal.test.ts。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/archive/archive-service.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SessionSummary } from '@taiji/shared'
import { encodeCwd } from '@taiji/shared/paths'
import { subscribeSessionDeathDisposition, fireDeathDisposition } from '../session/session-lifecycle.js'
import { extractSessionName, parseSessionHeader } from '../../infra/pi/session-file-utils.js'
import { ArchiveError, ArchiveService, type ArchiveServiceDeps } from './archive-service.js'

// ── fixture ───────────────────────────────────────────────────────────────────

const CWD_A = '/proj/archive-test-a'
const ENC_A = encodeCwd(CWD_A)

interface Fixture {  // oe-exempt:20261020:wip:归档域测试 fixture 形态类型，单实现为当前形态——30 天窗口内联或等第二变体
  root: string
  dataDir: string
  agentDir: string
  sessionsRoot: string
  archiveRoot: string
  storeRoot: string
  service: ArchiveService
  calls: string[]
  warnings: string[]
  trashed: string[]
  treeTrashed: string[]
  /** scanned 态注册（findScannedSession 返回值）。 */
  registerScanned(sid: string, cwd: string, filePath: string): void
  /** 活跃态注册（getActiveSession 返回值）。 */
  registerActive(sid: string, cwd: string, sessionFilePath: string | undefined): void
  setGenerating(sid: string | null): void
  setSummary(sid: string, summary: SessionSummary): void
  /** 建 sessions 主文件（header + 尾部 session_info）+ 可选旁挂。 */
  writeMainFile(sid: string, cwd: string, opts?: { name?: string; extraLines?: string[]; sidecars?: string[] }): string
  /** 建附件域源目录（ext-sessions 存储树内）。 */
  seedAssetDomain(sid: string, domain: string): string
}

const cleanupDirs: string[] = []

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'taiji-archive-svc-'))
  cleanupDirs.push(root)
  const dataDir = root
  const agentDir = join(root, 'agent')
  const sessionsRoot = join(agentDir, 'sessions')
  const archiveRoot = join(agentDir, 'archive')
  const storeRoot = join(root, 'ext-sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(storeRoot, { recursive: true })

  const calls: string[] = []
  const warnings: string[] = []
  const trashed: string[] = []
  const treeTrashed: string[] = []
  const scanned = new Map<string, { cwd: string; filePath: string }>()
  const active = new Map<string, { cwd: string; sessionFilePath?: string }>()
  const summaries = new Map<string, SessionSummary>()
  let generating: string | null = null

  const deps: ArchiveServiceDeps = {
    isGenerating: (sid) => sid === generating,
    getActiveSession: (sid) => active.get(sid),
    findScannedSession: (sid) => scanned.get(sid),
    disposeUserStopped: (sid) => { calls.push(`userStopped:${sid}`) },
    // 生产接线同款（index.ts：fireArchiveDisposition → fireDeathDisposition('archive')）——
    // fake 同时驱动真实登记器，处置通道探针经本 fixture 端到端可达。
    fireArchiveDisposition: (sid, hasDestroySink) => {
      calls.push(`archive-disp:${sid}:${hasDestroySink}`)
      fireDeathDisposition(sid, 'archive', { hasDestroySink })
    },
    closeAllBtwLines: async (sid) => { calls.push(`btw:${sid}`); return [] },
    detachSession: (sid) => { calls.push(`detach:${sid}`) },
    destroyPiSession: async (sid) => { calls.push(`destroy:${sid}`) },
    removeSessionEntry: (sid) => { calls.push(`removeEntry:${sid}`) },
    reapBackgroundTasks: async (_dir, sid) => { calls.push(`reap:${sid}`) },
    clearRemovedSessionData: (sid) => { calls.push(`tombstone:${sid}`) },
    unbindCanvas: (sid) => { calls.push(`unbind:${sid}`) },
    trash: async (path) => {
      calls.push(`trash:${path}`)
      trashed.push(path)
      // fake 通道语义对齐真实废纸篓：原位置不再存在（供「处置完成」断言）。
      rmSync(path, { force: true, maxRetries: 5, retryDelay: 20 })
    },
    trashDirectory: async (dir) => {
      calls.push(`treeTrash:${dir}`)
      treeTrashed.push(dir)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
    invalidateScanCache: () => { calls.push('invalidateScan') },
    broadcastSessionList: () => { calls.push('broadcast') },
    // 读回链真实化（生产接线语义，index.ts 组装根同构）：活跃 summaries Map 优先
    // （模拟 sessionService.getSummary 的 lifecycle Map 读取），miss 走持久化扫描侧
    // 构造（扫 sessions/ 树按 header.id 定位 + 名称尾读）——恢复态（非活跃）session
    // 的 summary 从磁盘真实读回，禁 canned 注入形态掩盖读回链断裂。
    getSessionSummary: (sid) => summaries.get(sid) ?? scanPersistedSummary(sessionsRoot, sid),
    warn: (message) => { warnings.push(message) },
  }
  const service = new ArchiveService(deps, { dataDir, archiveRoot, agentDir, sessionsRoot })

  const fixture: Fixture = {
    root, dataDir, agentDir, sessionsRoot, archiveRoot, storeRoot, service, calls, warnings, trashed, treeTrashed,
    registerScanned: (sid, cwd, filePath) => { scanned.set(sid, { cwd, filePath }) },
    registerActive: (sid, cwd, sessionFilePath) => { active.set(sid, { cwd, sessionFilePath }) },
    setGenerating: (sid) => { generating = sid },
    setSummary: (sid, summary) => { summaries.set(sid, summary) },
    writeMainFile: (sid, cwd, opts = {}) => {
      const dir = join(sessionsRoot, encodeCwd(cwd))
      mkdirSync(dir, { recursive: true })
      const fileName = `2026-10-20T00-00-00-000Z_${sid}.jsonl`
      const filePath = join(dir, fileName)
      const lines = [
        JSON.stringify({ type: 'session', id: sid, cwd, timestamp: '2026-10-20T00:00:00.000Z' }),
        ...(opts.extraLines ?? []),
        JSON.stringify({ type: 'session_info', name: opts.name ?? `会话-${sid}` }),
      ]
      writeFileSync(filePath, `${lines.join('\n')}\n`)
      for (const ext of opts.sidecars ?? []) writeFileSync(filePath + ext, '{}')
      return filePath
    },
    seedAssetDomain: (sid, domain) => {
      const dir = join(storeRoot, sid, domain)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `item-${domain}.dat`)
      writeFileSync(file, 'asset-bytes')
      return file
    },
  }
  return fixture
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

function summaryOf(sid: string, cwd: string): SessionSummary {
  return {
    id: sid,
    label: `会话-${sid}`,
    cwd,
    status: 'idle',
    lastActiveAt: 1,
    modelId: '',
    tokenCount: 0,
  }
}

/**
 * 持久化扫描侧 summary 构造（fixture 读回链的磁盘腿——镜像 SessionScanner.listAll
 * 持久化路径的最小形态：扫 sessions/ 桶按 header.id 定位 + extractSessionName 尾读
 * 取名 + 主文件 mtime 排序键）。生产接线 = index.ts 组装根 listPersistedSessions 合并链。
 */
function scanPersistedSummary(sessionsRoot: string, sid: string): SessionSummary | undefined {
  if (!existsSync(sessionsRoot)) return undefined
  for (const bucket of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const dir = join(sessionsRoot, bucket.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(dir, file)
      const header = parseSessionHeader(filePath)
      if (header === null || header.id !== sid || header.cwd === undefined) continue
      return {
        id: sid,
        label: extractSessionName(filePath) ?? basename(header.cwd),
        cwd: header.cwd,
        status: 'idle',
        lastActiveAt: statSync(filePath).mtimeMs,
        modelId: '',
        tokenCount: 0,
        source: 'scan',
        sessionFile: filePath,
      }
    }
  }
  return undefined
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** 归档 + 等待后台压缩任务完成（fixture 内便捷口——轮询簿记 status）。 */
async function archiveAndCompress(f: Fixture, sid: string): Promise<string> {
  await f.service.archive(sid)
  const unitDir = join(f.archiveRoot, ENC_A)
  const ledgerPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`)
  for (let i = 0; i < 100; i++) {
    const ledger = readJson(ledgerPath)
    if (ledger.status === 'archived') return ledgerPath
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`压缩任务超时未完成 (sessionId=${sid})`)
}

// ── archive 三操作之归档 ──────────────────────────────────────────────────────

describe('ArchiveService.archive', () => {
  it('非活跃（scanned）session：搬移顺序旁挂→主文件→附件三目录、簿记骨架、广播', async () => {
    const f = makeFixture()
    const sid = 'sess-aaaa11'
    const mainPath = f.writeMainFile(sid, CWD_A, { sidecars: ['.project.json', '.meta.json'] })
    f.seedAssetDomain(sid, 'attachments')
    f.seedAssetDomain(sid, 'artifacts')
    f.registerScanned(sid, CWD_A, mainPath)
    const originalContent = readFileSync(mainPath)

    await f.service.archive(sid)

    // 搬移：sessions/ 侧清空（不变量 1 前半 + 不变量 4——移出扫描范围）。
    expect(existsSync(mainPath)).toBe(false)
    expect(existsSync(`${mainPath}.project.json`)).toBe(false)
    expect(existsSync(join(f.storeRoot, sid, 'attachments'))).toBe(false)
    // 归档单元构成（D1 布局）。
    const unitDir = join(f.archiveRoot, ENC_A)
    const plain = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    expect(existsSync(plain)).toBe(true)
    expect(readFileSync(plain).equals(originalContent)).toBe(true)
    expect(existsSync(`${plain}.project.json`)).toBe(true)
    expect(existsSync(`${plain}.meta.json`)).toBe(true)
    expect(existsSync(join(unitDir, 'assets', sid, 'attachments', 'item-attachments.dat'))).toBe(true)
    expect(existsSync(join(unitDir, 'assets', sid, 'artifacts', 'item-artifacts.dat'))).toBe(true)
    // 簿记骨架（D5 步骤 4）。
    const ledger = readJson(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))
    expect(ledger.status).toBe('staging')
    expect(ledger.summary).toBeNull()
    expect(ledger.name).toBe(`会话-${sid}`)
    expect(ledger.sessionId).toBe(sid)
    expect(ledger.cwd).toBe(CWD_A)
    expect(ledger.originalFile).toBe(`2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    expect(ledger.rawBytes).toBe(originalContent.byteLength)
    // scanned 分支编排：无 suppress/detach；btw 级联停止（活跃/非活跃共用，D8——
    // 不停止则线进程继续写留置域）+ 收殓 + 缓存失效 + 广播。
    expect(f.calls).toEqual([`btw:${sid}`, `reap:${sid}`, 'invalidateScan', 'broadcast'])
  })

  it('活跃 session：杀 pi 前置五步复刻 delete 分支（archive 处置登记先于 detach/destroy）', async () => {
    const f = makeFixture()
    const sid = 'sess-bbbb22'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerActive(sid, CWD_A, mainPath)

    await f.service.archive(sid)

    // 活跃编排序（D5 步骤 2 ①-⑤）：userStopped → archive 处置登记 → btw → detach →
    // destroy → removeEntry → reap，先于 invalidateScan/broadcast。
    const prefix = [
      `userStopped:${sid}`,
      `archive-disp:${sid}:true`,
      `btw:${sid}`,
      `detach:${sid}`,
      `destroy:${sid}`,
      `removeEntry:${sid}`,
      `reap:${sid}`,
    ]
    expect(f.calls.slice(0, prefix.length)).toEqual(prefix)
    expect(existsSync(mainPath)).toBe(false)
    expect(readJson(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`)).status).toBe('staging')
  })

  it('门 1：生成中拒绝 archive_generating（零搬移）', async () => {
    const f = makeFixture()
    const sid = 'sess-cccc33'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setGenerating(sid)

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_generating' })
    expect(existsSync(mainPath)).toBe(true)
    expect(f.calls).toEqual([])
  })

  it('门 2：已存在该 sessionId 的簿记拒绝 archive_already_archived', async () => {
    const f = makeFixture()
    const sid = 'sess-dddd44'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await f.service.archive(sid) // 第一笔成功

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_already_archived' })
    expect(existsSync(mainPath)).toBe(false) // 第二笔零动作（主文件早已搬走）
  })

  it('门 3：目标桶路径被同名文件占用（mkdir 失败）→ archive_io_error', async () => {
    const f = makeFixture()
    const sid = 'sess-eeee55'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    // 占位文件抢先占据桶目录路径 → mkdirSync recursive 失败（EEXIST/ENOTDIR 形态）。
    mkdirSync(f.archiveRoot, { recursive: true })
    writeFileSync(join(f.archiveRoot, ENC_A), 'occupier')

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_io_error' })
    expect(existsSync(mainPath)).toBe(true)
  })

  it('归档对象不存在（内存无 + 磁盘无）→ not found 普通 Error（零副作用）', async () => {
    const f = makeFixture()
    await expect(f.service.archive('sess-ghost99')).rejects.toThrow(/not found/)
    expect(f.calls).toEqual([])
  })

  it('零消息 session（主文件未落盘，条目 26）：空归档成功——name 回退 sessionId、rawBytes 0、旁挂随迁、无压缩任务、幂等重入门 2', async () => {
    const f = makeFixture()
    const sid = 'sess-empty26'
    // 活跃零消息形态：sessionFilePath 有值（pi SessionManager 构造期即派生路径）但文件
    // 不存在（首 flush 前不落盘，规则 #6）；create 期 sidecar 已写在该路径旁。
    const fileName = `2026-10-20T00-00-00-000Z_${sid}.jsonl`
    const mainPath = join(f.sessionsRoot, ENC_A, fileName)
    mkdirSync(join(f.sessionsRoot, ENC_A), { recursive: true })
    writeFileSync(`${mainPath}.preset.json`, '{}')
    f.registerActive(sid, CWD_A, mainPath)

    // 旧形态：rename ENOENT → archive_io_error；现按登记倾向方案直接成功（空归档语义）。
    await f.service.archive(sid)

    // 空归档单元：无主文件；簿记在（name 回退 sessionId、rawBytes 0）；旁挂随迁。
    const unitDir = join(f.archiveRoot, ENC_A)
    expect(existsSync(join(unitDir, fileName))).toBe(false)
    const ledger = readJson(join(unitDir, `${fileName}.archive.json`))
    expect(ledger.status).toBe('staging')
    expect(ledger.name).toBe(sid)
    expect(ledger.rawBytes).toBe(0)
    expect(ledger.cwd).toBe(CWD_A)
    expect(existsSync(join(unitDir, `${fileName}.preset.json`))).toBe(true)
    // 活跃退场照常（teardown 不因空归档跳过）+ 成功侧广播。
    expect(f.calls).toContain(`destroy:${sid}`)
    expect(f.calls).toContain('broadcast')
    // 压缩任务不派发：短暂让渡后无 .zst、无压缩域 warn、簿记保持 staging 稳定态。
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(existsSync(join(unitDir, `${fileName}.zst`))).toBe(false)
    expect(f.warnings.filter((w) => w.includes('压缩'))).toEqual([])
    expect(readJson(join(unitDir, `${fileName}.archive.json`)).status).toBe('staging')
    // 幂等：重复归档走门 2 的明确领域错误（archive_already_archived），非底层 IO 错误。
    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_already_archived' })
  })

  it('符号链接 cwd（条目 27）：realpath 归一分桶——主文件重定位自真值分桶、簿记 cwd 存真值、恢复回真值分桶原位', async () => {
    const f = makeFixture()
    const sid = 'sess-sym27'
    // 真实目录 + 指向它的符号链接（macOS /var → /private/var 同款形态，tmp 下自建复现）。
    // realCwd 经 realpathSync 全链解析为 pi 的编码基准（pi spawn 子进程 process.cwd()
    // 返回内核全解析真值——本机实测 spawn cwd=/tmp/symtest-link 子进程 process.cwd()
    // 返回 /private/tmp/symtest-real；macOS tmpdir() 自身即 /var 未解析形态）。
    const realCwd = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-archive-realcwd-')))
    cleanupDirs.push(realCwd)
    const linkCwd = join(f.root, 'link-cwd')
    symlinkSync(realCwd, linkCwd)
    expect(realpathSync(linkCwd)).toBe(realCwd) // 前置锚：链接解析基准成立
    // pi 落盘形态：主文件在 realpath 分桶、header.cwd = 全解析真值（pi SessionManager
    // 以 process.cwd() 落 header）。
    const fileName = `2026-10-20T00-00-00-000Z_${sid}.jsonl`
    const realMainPath = join(f.sessionsRoot, encodeCwd(realCwd), fileName)
    mkdirSync(join(f.sessionsRoot, encodeCwd(realCwd)), { recursive: true })
    writeFileSync(
      realMainPath,
      `${JSON.stringify({ type: 'session', id: sid, cwd: realCwd, timestamp: '2026-10-20T00:00:00.000Z' })}\n`
        + `${JSON.stringify({ type: 'session_info', name: `会话-${sid}` })}\n`,
    )
    // 定位源形态（真机探针复现）：active.cwd = 未解析链接路径，sessionFilePath = 按未解析
    // cwd 派生的分桶路径（磁盘不存在——旧形态 rename 源 ENOENT）。
    f.registerActive(sid, linkCwd, join(f.sessionsRoot, encodeCwd(linkCwd), fileName))

    await f.service.archive(sid)

    // 归档单元按 realpath 真值编码分桶；主文件从真值分桶搬入；未解析编码桶不被创建。
    const unitDir = join(f.archiveRoot, encodeCwd(realCwd))
    expect(existsSync(join(unitDir, fileName))).toBe(true)
    expect(existsSync(join(f.archiveRoot, encodeCwd(linkCwd)))).toBe(false)
    expect(existsSync(realMainPath)).toBe(false)
    // 簿记 cwd 存 realpath 真值（恢复侧按簿记 cwd 原样推导——两侧同编码即往返一致）。
    const ledger = readJson(join(unitDir, `${fileName}.archive.json`))
    expect(ledger.cwd).toBe(realCwd)

    // 恢复路径一致性（条目 27 验收）：sessionOriginalPath 按簿记 cwd 推导 = realpath 分桶
    // 原位（与 pi 落盘位同桶）；summary 读回走磁盘扫描腿（header.id 定位）。
    const reply = await f.service.unarchive(sid)
    expect(reply.session.id).toBe(sid)
    expect(existsSync(realMainPath)).toBe(true)
    expect(existsSync(join(f.archiveRoot, encodeCwd(realCwd), `${fileName}.archive.json`))).toBe(false)
  })
})

// ── 后台压缩任务（staging → archived）───────────────────────────────────────

describe('后台压缩任务', () => {
  it('压缩体 + 摘要 + sha256 落簿记终态，明文删除', async () => {
    const f = makeFixture()
    const sid = 'sess-ffff66'
    const mainPath = f.writeMainFile(sid, CWD_A, {
      extraLines: [
        JSON.stringify({ type: 'message', message: { role: 'user', content: '帮我看看这个问题' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '先分析根因。' }] } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '结论：需要修复 X。' }] } }),
      ],
    })
    const original = readFileSync(mainPath)
    f.registerScanned(sid, CWD_A, mainPath)

    const ledgerPath = await archiveAndCompress(f, sid)
    const unitDir = join(f.archiveRoot, ENC_A)
    const plain = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    const compressedPath = `${plain}.zst`

    const ledger = readJson(ledgerPath)
    expect(ledger.status).toBe('archived')
    expect(ledger.codec).toBe('zstd-3')
    const compressed = readFileSync(compressedPath)
    expect(ledger.compressedBytes).toBe(compressed.byteLength)
    expect(ledger.sha256).toBe(sha256Hex(compressed))
    // 往返一致（V1 验收的单元级锚点）。
    expect(zstdDecompressSync(compressed).equals(original)).toBe(true)
    // 摘要（D4：agent 文本取从后向前第一个非空块 = 最后一段「结论」）。
    expect(ledger.summary).toEqual({
      turns: [{ user: '帮我看看这个问题', agent: '结论：需要修复 X。' }],
    })
    // 明文已删。
    expect(existsSync(plain)).toBe(false)
    // 压缩完成通知（D11「后台任务完成事件刷新」的事件源）：archive 步骤 5 广播 +
    // 压缩终态写入后广播各一次（staging→archived 的 renderer 刷新由收帧侧拉取承载）。
    expect(f.calls.filter((c) => c === 'broadcast')).toHaveLength(2)
  })
})

// ── unarchive（恢复）─────────────────────────────────────────────────────────

describe('ArchiveService.unarchive', () => {
  it('archived 态恢复：解压回原位逐字节一致、旁挂/附件回位、归档单元清空、返回 summary', async () => {
    const f = makeFixture()
    const sid = 'sess-uuuu77'
    const mainPath = f.writeMainFile(sid, CWD_A, { sidecars: ['.project.json'] })
    const original = readFileSync(mainPath)
    // 原文件 mtime 设旧（锚定置顶排序语义：列表序 = 主文件 mtime 降序，恢复必须让
    // mtime = 恢复时刻，§5.1「原项目组顶部」——否则按旧时间落回旧位置）。
    const stale = new Date('2020-01-01T00:00:00Z')
    utimesSync(mainPath, stale, stale)
    f.seedAssetDomain(sid, 'attachments')
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await archiveAndCompress(f, sid)
    const restoreStartedAt = Date.now()

    const reply = await f.service.unarchive(sid)

    expect(reply.session.id).toBe(sid)
    // 原位恢复（不变量 1 后半：sessions/ 有主文件 + archive 无簿记）。
    expect(readFileSync(mainPath).equals(original)).toBe(true)
    expect(existsSync(`${mainPath}.project.json`)).toBe(true)
    expect(existsSync(join(f.storeRoot, sid, 'attachments', 'item-attachments.dat'))).toBe(true)
    // 恢复置顶排序语义：重建主文件 mtime = 恢复时刻（远新于 2020 锚点）。
    expect(statSync(mainPath).mtimeMs).toBeGreaterThanOrEqual(restoreStartedAt)
    // 归档单元清空（簿记/压缩体/旁挂/assets 全消失——目录壳可留）。
    const unitDir = join(f.archiveRoot, ENC_A)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`))).toBe(false)
    expect(existsSync(join(unitDir, 'assets', sid, 'attachments'))).toBe(false)
    expect(f.calls.slice(-2)).toEqual(['invalidateScan', 'broadcast'])
  })

  it('staging 态恢复：明文直接回原位（无压缩体可校验）', async () => {
    const f = makeFixture()
    const sid = 'sess-ssss88'
    const mainPath = f.writeMainFile(sid, CWD_A)
    const original = readFileSync(mainPath)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await f.service.archive(sid) // staging（不等压缩）

    await f.service.unarchive(sid)

    expect(readFileSync(mainPath).equals(original)).toBe(true)
  })

  it('真实读回链：恢复态（非活跃）session 从磁盘扫描侧构造 summary（不注入活跃读回）', async () => {
    // unarchive 不 spawn pi、不进 lifecycle Map（Map 装载唯一入口 = create/restore/fork）——
    // 恢复后的 session 只存在于磁盘。本用例不调 setSummary（活跃 Map 恒空），reply 的
    // SessionSummary 必须经磁盘扫描腿真实读回：sessionFile 指向回场原路径、名称从恢复
    // 文件 session_info 尾读提取（与生产 listPersistedSessions 合并链同语义）。
    const f = makeFixture()
    const sid = 'sess-rrrr11'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)

    const reply = await f.service.unarchive(sid)

    expect(reply.session.id).toBe(sid)
    expect(reply.session.cwd).toBe(CWD_A)
    expect(reply.session.label).toBe(`会话-${sid}`)
    expect(reply.session.source).toBe('scan')
    expect(reply.session.sessionFile).toBe(mainPath)
  })

  it('冲突检测前置：原路径已存在同名主文件 → archive_restore_conflict，簿记归位、原件不动', async () => {
    const f = makeFixture()
    const sid = 'sess-cccc99'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 手工放置同名冲突文件（V6 场景）。
    writeFileSync(mainPath, '{"type":"session","id":"other"}\n')
    const conflicting = readFileSync(mainPath)
    const unitDir = join(f.archiveRoot, ENC_A)

    await expect(f.service.unarchive(sid)).rejects.toMatchObject({ code: 'archive_restore_conflict' })

    // 簿记归位（.archive.json 在 / .restoring 不在），归档物完好，冲突原件未被覆盖。
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(true)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.restoring`))).toBe(false)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`))).toBe(true)
    expect(readFileSync(mainPath).equals(conflicting)).toBe(true)
  })

  it('不变量 2（压缩体消费前校验）：篡改压缩体 → archive_corrupted，簿记归位原件不动', async () => {
    const f = makeFixture()
    const sid = 'sess-tttt00'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    const unitDir = join(f.archiveRoot, ENC_A)
    const compressedPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    writeFileSync(compressedPath, readFileSync(compressedPath).subarray(0, 10)) // 截断损坏

    await expect(f.service.unarchive(sid)).rejects.toMatchObject({ code: 'archive_corrupted' })

    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(true)
    expect(existsSync(compressedPath)).toBe(true) // 原件（损坏体）不动
    expect(existsSync(mainPath)).toBe(false) // 未半途恢复
  })

  it('无簿记 → archive_not_found（恢复中条目对用户不可见）', async () => {
    const f = makeFixture()
    await expect(f.service.unarchive('sess-ghost11')).rejects.toMatchObject({ code: 'archive_not_found' })
  })
})

// ── purgeArchive（彻底删除）─────────────────────────────────────────────────

describe('ArchiveService.purgeArchive', () => {
  it('正常链：簿记门过 → tombstone → 残树整树软删 → btw → 解绑 → 压缩体进废纸篓 → 归档单元清空', async () => {
    const f = makeFixture()
    const sid = 'sess-pppp22'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 残树（留置域：subagents/logs 等，D8）。
    mkdirSync(join(f.storeRoot, sid, 'subagents', 'sessions'), { recursive: true })
    writeFileSync(join(f.storeRoot, sid, 'subagents', 'sessions', 'sub-1.jsonl'), '{}')

    await f.service.purgeArchive(sid)

    // 编排序（D5 步骤 1-7）。
    const idxTrash = f.calls.findIndex((c) => c.startsWith('treeTrash:'))
    expect(idxTrash).toBeGreaterThan(f.calls.indexOf(`tombstone:${sid}`))
    expect(f.calls).toContain(`btw:${sid}`)
    expect(f.calls).toContain(`unbind:${sid}`)
    // 残树整树软删 + 压缩体进废纸篓。
    expect(f.treeTrashed).toEqual([join(f.storeRoot, sid)])
    const compressedPath = join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    expect(f.trashed).toEqual([compressedPath])
    // 归档单元清空（簿记消失即 purge 完成，不变量 3 的条目消亡形态）。
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    expect(existsSync(compressedPath)).toBe(false)
    // 无 keep-all 说明字段（referenceScan ok）。
    expect(f.warnings.filter((w) => w.includes('keep-all'))).toEqual([])
  })

  it('簿记存在性门：无簿记 → archive_not_found 且零副作用（对在场 session 的真删拦截）', async () => {
    const f = makeFixture()
    const sid = 'sess-gggg33'
    const mainPath = f.writeMainFile(sid, CWD_A) // 在场 session（已恢复形态）
    f.registerScanned(sid, CWD_A, mainPath)

    await expect(f.service.purgeArchive(sid)).rejects.toMatchObject({ code: 'archive_not_found' })

    // 零副作用：无任何原语调用、主文件与磁盘原样。
    expect(f.calls).toEqual([])
    expect(existsSync(mainPath)).toBe(true)
  })

  it('staging + 压缩体残留（压缩收尾窗口形态）：purge mainCandidates 补处置压缩体（防永久孤儿）', async () => {
    const f = makeFixture()
    const sid = 'sess-tail66'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 手工构造压缩收尾窗口磁盘形态（未经自愈）：明文已删 + 压缩体在场 + 簿记改回 staging。
    const unitDir = join(f.archiveRoot, ENC_A)
    const plain = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    rmSync(plain, { force: true })
    const archived = readJson(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))
    const stagingLedger = {
      sessionId: archived.sessionId,
      name: archived.name,
      originalFile: archived.originalFile,
      cwd: archived.cwd,
      archivedAt: archived.archivedAt,
      rawBytes: archived.rawBytes,
      status: 'staging',
      summary: null,
    }
    const ledgerPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`)
    writeFileSync(ledgerPath, `${JSON.stringify(stagingLedger, null, 2)}\n`)

    await f.service.purgeArchive(sid)

    // staging 分支补压缩体候选：明文（已缺，存在性跳过）+ 压缩体都进处置，簿记消失达终态。
    const compressedPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    expect(f.trashed).toContain(compressedPath)
    expect(existsSync(ledgerPath)).toBe(false)
  })

  it('keep-all 保守分支：压缩体损坏 → 引用枚举源缺失 → subagents 整域保留 + reply 携带 keptSubagentsDir', async () => {    const f = makeFixture()
    const sid = 'sess-kkkk44'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 残树含 subagents 域（会被 keep-all 保守保留）。
    mkdirSync(join(f.storeRoot, sid, 'subagents', 'sessions'), { recursive: true })
    const keptFile = join(f.storeRoot, sid, 'subagents', 'sessions', 'sub-keep.jsonl')
    writeFileSync(keptFile, '{}')
    // 压缩体截断损坏（sha256 校验不过 → 不解压 → 枚举源哨兵缺失 → cascade 读失败）。
    const compressedPath = join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    writeFileSync(compressedPath, readFileSync(compressedPath).subarray(0, 8))

    const reply = await f.service.purgeArchive(sid)

    // 归档单元照常清除（含损坏压缩体进废纸篓）。
    expect(f.trashed).toEqual([compressedPath])
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    // subagents 整域保守保留（宁保留不误删）+ reply 保守保留说明字段（失败显式上报）。
    expect(existsSync(keptFile)).toBe(true)
    expect(reply.keptSubagentsDir).toBe(join(f.storeRoot, sid, 'subagents'))
  })
})

// ── per-session 三操作串行化（在途任务表）───────────────────────────────────

describe('per-session 串行化（D5 在途任务表）', () => {
  it('压缩中发起 unarchive：等待压缩终态后执行，恢复内容完整', async () => {
    const f = makeFixture()
    const sid = 'sess-wait55'
    const mainPath = f.writeMainFile(sid, CWD_A, {
      extraLines: [JSON.stringify({ type: 'message', message: { role: 'user', content: '问题 A' } })],
    })
    const original = readFileSync(mainPath)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await f.service.archive(sid) // 压缩任务刚入队（未完成）

    await f.service.unarchive(sid) // 与在途压缩任务并发——串行化等待

    // 压缩完成后才轮到恢复：恢复的是解压产物，逐字节一致。
    expect(readFileSync(mainPath).equals(original)).toBe(true)
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
  })

  it('压缩中发起 purgeArchive：等待压缩终态后执行，压缩体先生成再进废纸篓', async () => {
    const f = makeFixture()
    const sid = 'sess-wait77'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await f.service.archive(sid) // 压缩任务刚入队（未完成）

    const reply = await f.service.purgeArchive(sid) // 与在途压缩任务并发——串行化等待

    // 压缩先达终态后 purge 才执行：归档态压缩体进废纸篓（staging 明文直读路径不会产生该处置）。
    expect(reply.sessionId).toBe(sid)
    const compressedPath = join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    expect(f.trashed).toContain(compressedPath)
    // 归档单元终态全清（簿记与压缩体均不在）。
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    expect(existsSync(compressedPath)).toBe(false)
  })

  it('unarchive 与 purgeArchive 并发：后到者对已消失归档单元 fail-fast（archive_not_found）', async () => {
    const f = makeFixture()
    const sid = 'sess-race66'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await archiveAndCompress(f, sid)

    // 同时发起：恢复先注册（到达顺序），purge 排在其后。
    const unarchivePromise = f.service.unarchive(sid)
    const purgePromise = f.service.purgeArchive(sid)
    const [unarchiveResult, purgeResult] = await Promise.allSettled([unarchivePromise, purgePromise])

    // 先到者成功（恢复完成），后到者对已消失归档单元 fail-fast——不会「恢复完成即被彻底删除」。
    expect(unarchiveResult.status).toBe('fulfilled')
    expect(purgeResult.status).toBe('rejected')
    if (purgeResult.status === 'rejected') {
      expect(purgeResult.reason).toBeInstanceOf(ArchiveError)
      expect((purgeResult.reason as ArchiveError).code).toBe('archive_not_found')
    }
    // 磁盘终态 = 恢复形态（不是删除形态）。
    expect(existsSync(mainPath)).toBe(true)
  })
})

// ── 聚合不变量 3（列表派生）─────────────────────────────────────────────────

describe('不变量 3：归档列表 = 扫描 .archive.json 派生', () => {
  it('列表条目与簿记一一对应；.restoring 不在列表；projectId 从 .project.json 旁挂回填', async () => {
    const f = makeFixture()
    const sid = 'sess-list77'
    const mainPath = f.writeMainFile(sid, CWD_A, { sidecars: ['.project.json'] })
    writeFileSync(`${mainPath}.project.json`, JSON.stringify({ projectId: 'proj-9' }))
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    const other = 'sess-list88'
    const otherPath = f.writeMainFile(other, '/proj/archive-test-b')
    f.registerScanned(other, '/proj/archive-test-b', otherPath)
    await f.service.archive(other) // staging 态（无 .project 旁挂）

    const entries = f.service.listArchiveEntries()
    expect(entries.map((e) => e.sessionId).sort()).toEqual([other, sid].sort())
    const mine = entries.find((e) => e.sessionId === sid)
    expect(mine?.projectId).toBe('proj-9')
    expect(mine?.status).toBe('archived')

    // .restoring 不在列表：手工构造恢复中形态（rename 簿记），恢复中条目对用户不可见。
    const unitDir = join(f.archiveRoot, ENC_A)
    renameSync(
      join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`),
      join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.restoring`),
    )
    const afterRestore = f.service.listArchiveEntries()
    expect(afterRestore.map((e) => e.sessionId)).toEqual([other])
  })
})

// ── 'archive' 处置登记探针（条目 28：归档退场经处置登记到达组合根单一汇聚点）──────

describe("'archive' 处置登记探针（条目 28：GUI 侧栏归档与 agent 工具 archive_session 两入口共用的收尾触发点）", () => {
  it('真实登记通道：archive 活跃 session 触发 disposition=archive、hasDestroySink=true（GUI 入口 handleSessionArchive 的唯一动作 = 调本服务）', async () => {
    const seen: Array<{ sid: string; disposition: string; hasDestroySink: boolean }> = []
    const unsubscribe = subscribeSessionDeathDisposition((sid, disposition, detail) => {
      seen.push({ sid, disposition, hasDestroySink: detail.hasDestroySink })
    })
    try {
      const f = makeFixture()
      const sid = 'sess-probe-1'
      const mainPath = f.writeMainFile(sid, CWD_A)
      f.registerActive(sid, CWD_A, mainPath)

      await f.service.archive(sid)

      // ArchiveService 经 deps.fireArchiveDisposition 接线到真实登记器——组合根订阅同款
      // 形态收到 'archive' 处置（组合根对该值统一 speakSessionDeath(sid, 'exit') 收尾
      // completion-watch 债权，两入口同判）。
      expect(seen).toEqual([{ sid: 'sess-probe-1', disposition: 'archive', hasDestroySink: true }])
    } finally {
      unsubscribe()
    }
  })

  it('归档被前置三门拒绝（生成中）时零登记：债权零损伤（处置登记在门 1/2/3 之后）', async () => {
    const seen: Array<{ sid: string; disposition: string; hasDestroySink: boolean }> = []
    const unsubscribe = subscribeSessionDeathDisposition((sid, disposition, detail) => {
      seen.push({ sid, disposition, hasDestroySink: detail.hasDestroySink })
    })
    try {
      const f = makeFixture()
      const sid = 'sess-probe-2'
      const mainPath = f.writeMainFile(sid, CWD_A)
      f.registerActive(sid, CWD_A, mainPath)
      f.setGenerating(sid)

      await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_generating' })
      expect(seen).toEqual([])
    } finally {
      unsubscribe()
    }
  })
})

/**
 * 处置通道消费点核实结论（现行接线，探针锚定）：
 * - 组合根消费（runtime index.ts subscribeSessionDeathDisposition）：'archive' 分支
 *   speakSessionDeath(sid, 'exit') 收尾 completion-watch 债权 + 立 suppressedDeaths 标
 *   （hasDestroySink 时）——收尾回到单一汇聚点，GUI 与 agent 工具两入口同判；
 * - 销毁回调消费（index.ts setOnSessionDestroyed 第二订阅者）：removeSessionEntry 的
 *   销毁回调查标即消、跳过二次发声；
 * - intentional destroy 的 exit 事件（process-manager.ts）：destroySession 先清
 *   clientToId/processes 条目，pi 进程随后 exit 反查无条目直接 return——exit 通道结构性
 *   拦截，不产生伪造死亡通知。
 */
