/**
 * AttachmentStore 模块直接测试（S1 附件存储迁出，设计 §4.2 场景 B——模块测试面）。
 *
 * 边界用例（20MB 上限拒绝 / 路径穿越拒绝）直接对模块测试：不经 WS 链路、不构造
 * Facade（本文件 import 无 session-service，机器可 grep 验证）。
 *
 * 与 test/session-service.test.ts「业务持久化写安全守卫」互补：彼处经 Facade 委托
 * 入口锁定 S1 迁移后端到端行为不变（探针 P3），此处锁定新模块可独立构造与直接测试。
 *
 * 真实文件 I/O：writeImage/migrateImage/writeSegmentsMetadata 写真实 attachments/tmpdir
 * 文件，读回校验后清理。dataDir 由 vitest globalSetup 的 TAIJI_AGENT_DATA_DIR 指向 tmp
 * 目录，getAttachmentsDir 落盘天然隔离，不污染用户数据。白名单外来源用本测试文件自身
 * （仓库内路径，既非 tmpdir 也非 attachments，且无需在白名单外写任何文件——fs-guard 兼容）。
 *
 * 运行：cd packages/runtime && pnpm vitest run src/services/session/__tests__/attachment-store.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { AttachmentStore } from '../attachment-store.js'
import { getAttachmentsDir } from '@taiji/shared/paths'
import { IMAGE_LIMITS } from '@taiji/shared'
import type { SegmentsMetadataEntry, SegmentsMetadataFile } from '@taiji/shared'

const store = new AttachmentStore()

// renameSync 失败注入开关（r1-S14，vi.hoisted：vi.mock 工厂提升后仍可引用；机制同
// import-service.test.ts 的 copyFile 失败注入先例）。EPERM retry 分支在 POSIX 上不可
// 有机触达（rename(file,file) 原子成功，rename(file,dir) 会被 quarantine 前置吞掉），
// 只能 mock 注入。'once'：首跳抛后自复位（覆盖 unlink+retry 成功路径）；'always'：
// 双跳均抛（覆盖 retryErr 抛出 + tmp 清理路径）；'off'：透传 actual。
const renameFailureState = vi.hoisted(() => ({ mode: 'off' as 'off' | 'once' | 'always' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameFailureState.mode === 'off') return actual.renameSync(...args)
      if (renameFailureState.mode === 'once') renameFailureState.mode = 'off'
      const err = new Error('simulated EPERM (Windows rename-over-existing)') as Error & { code: string }
      err.code = 'EPERM'
      throw err
    },
  }
})

/** 收尾清理清单（写入即登记，afterEach 统一 rm） */
const writtenPaths: string[] = []
afterEach(() => {
  for (const p of writtenPaths.splice(0)) {
    try { rmSync(p) } catch { /* 忽略清理失败 */ }
  }
  vi.restoreAllMocks()
})

function makeEntry(clientUuid: string, timestamp = 1000): SegmentsMetadataEntry {
  return { clientUuid, segments: [{ type: 'text', text: 'hi' }], timestamp }
}

/** tmpdir 下造一个 fromPath 文件（migrateImage 合法来源），自动登记清理 */
function makeTmpFile(bytes: Buffer, label: string): string {
  const p = join(tmpdir(), `taiji-att-store-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  writeFileSync(p, bytes)
  writtenPaths.push(p)
  return p
}

describe('AttachmentStore · writeImage', () => {
  it('panel 态（sessionId 非空）→ 写 attachments/<sessionId>/ 返回 persisted:true，内容 round-trip', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const result = await store.writeImage('att-store-panel-1', bytes.toString('base64'), 'image/png', 'shot.png')
    writtenPaths.push(result.path)
    const expectedDir = getAttachmentsDir('att-store-panel-1')
    expect(result.path.startsWith(expectedDir)).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    expect(Array.from(readFileSync(result.path))).toEqual(Array.from(bytes))
    expect(result.fileName).toMatch(/^[0-9a-f-]+-shot\.png$/)
    expect(result.displayName).toBe('shot.png')
    expect(result.persisted).toBe(true)
  })

  it('landing 降级（sessionId 为空）→ 写 tmpdir 返回 persisted:false', async () => {
    const result = await store.writeImage('', Buffer.from([0x01]).toString('base64'), 'image/png', 'x.png')
    writtenPaths.push(result.path)
    expect(result.path.startsWith(tmpdir())).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    expect(result.persisted).toBe(false)
  })

  it('边界：base64 解码后超 IMAGE_LIMITS.SINGLE_MAX_BYTES → 拒绝且不写文件（场景 B 大小上限）', async () => {
    // 解码字节数估算 = ceil(len*3/4)，取保证超上限的 base64 长度（由常量推导，不硬编码 20MB）
    const overLimitLen = Math.ceil(((IMAGE_LIMITS.SINGLE_MAX_BYTES + 1) * 4) / 3)
    await expect(
      store.writeImage('att-store-big-1', 'A'.repeat(overLimitLen), 'image/png', 'big.png'),
    ).rejects.toThrow(/图片过大.*20MB/)
    expect(existsSync(getAttachmentsDir('att-store-big-1'))).toBe(false)
  })

  it('边界：name 含路径穿越片段 → sanitize 剥离，落盘文件名扁平不逃逸 attachments 目录（场景 B 路径穿越）', async () => {
    const result = await store.writeImage(
      'att-store-sanitize-1',
      Buffer.from([0x01]).toString('base64'),
      'image/png',
      '../../etc/passwd.png',
    )
    writtenPaths.push(result.path)
    const expectedDir = getAttachmentsDir('att-store-sanitize-1')
    expect(result.path.startsWith(expectedDir)).toBe(true)
    const rel = relative(expectedDir, result.path)
    expect(rel).not.toMatch(/[\\/]/)
    expect(existsSync(result.path)).toBe(true)
  })

  it('非 image/* mimeType → 拒绝', async () => {
    await expect(store.writeImage('att-store-mime-1', 'x', 'text/plain', 'x')).rejects.toThrow(
      'mimeType must start with image/',
    )
  })
})

describe('AttachmentStore · migrateImage', () => {
  it('happy path: tmpdir 文件 → attachments/<sessionId>/，原文件 move 非复制', async () => {
    const bytes = Buffer.from([0x89, 0x50])
    const fromPath = makeTmpFile(bytes, 'happy')
    const result = await store.migrateImage(fromPath, 'att-store-mig-1', 'shot.png')
    writtenPaths.push(result.path)
    const expectedDir = getAttachmentsDir('att-store-mig-1')
    expect(result.path.startsWith(expectedDir)).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    expect(Array.from(readFileSync(result.path))).toEqual(Array.from(bytes))
    expect(existsSync(fromPath)).toBe(false)
  })

  it('边界：fromPath 白名单外（仓库内文件）→ 拒绝，源文件不动（场景 B 路径穿越）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // fs-guard（2026-09-02 防线）禁止在白名单外写文件，改用已存在的仓库内文件作白名单外
    // 来源（既非 tmpdir 也非 attachments 目录），语义与原 homedir 临时文件等价
    const evilFile = fileURLToPath(import.meta.url)
    await expect(store.migrateImage(evilFile, 'att-store-evil-1', 'leaked.txt')).rejects.toThrow(
      'migrate-session-image failed',
    )
    // 原文件仍在原位（未被 move），目标目录无泄漏物
    expect(existsSync(evilFile)).toBe(true)
    expect(existsSync(join(getAttachmentsDir('att-store-evil-1'), 'leaked.txt'))).toBe(false)
  })

  it('边界：sessionId 含 ../ → getAttachmentsDir 校验拒绝（场景 B 路径穿越）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fromPath = makeTmpFile(Buffer.from([0x01]), 'sid')
    await expect(store.migrateImage(fromPath, '../etc', 'x.png')).rejects.toThrow('migrate-session-image failed')
    // 合法来源文件未被 move
    expect(existsSync(fromPath)).toBe(true)
  })

  it('fromPath 不存在 → 拒绝', async () => {
    const ghostPath = join(tmpdir(), `taiji-att-store-ghost-${Date.now()}.png`)
    await expect(store.migrateImage(ghostPath, 'att-store-ghost-1', 'x.png')).rejects.toThrow(/source file not found/)
  })

  it('sessionId 为空 → 拒绝（requires non-empty sessionId）', async () => {
    const fromPath = makeTmpFile(Buffer.from([0x01]), 'empty-sid')
    await expect(store.migrateImage(fromPath, '', 'x.png')).rejects.toThrow(
      'migrate-session-image requires non-empty sessionId',
    )
  })
})

describe('AttachmentStore · writeSegmentsMetadata', () => {
  const SID = 'att-store-seg-1'

  function readSidecar(sessionId: string): SegmentsMetadataFile {
    return JSON.parse(readFileSync(join(getAttachmentsDir(sessionId), 'segments.json'), 'utf-8')) as SegmentsMetadataFile
  }

  it('追加新 entry + 同 clientUuid 覆盖（去重语义）', async () => {
    await store.writeSegmentsMetadata(SID, makeEntry('u-1', 1000))
    await store.writeSegmentsMetadata(SID, makeEntry('u-2', 2000))
    let file = readSidecar(SID)
    expect(file.version).toBe(1)
    expect(file.entries.map((e) => e.clientUuid)).toEqual(['u-1', 'u-2'])
    // 同 uuid 重发 → 覆盖不追加
    await store.writeSegmentsMetadata(SID, makeEntry('u-1', 9999))
    file = readSidecar(SID)
    expect(file.entries).toHaveLength(2)
    expect(file.entries[0]?.timestamp).toBe(9999)
  })

  it('边界：sessionId 为空 → 拒绝', async () => {
    await expect(store.writeSegmentsMetadata('', makeEntry('u-x'))).rejects.toThrow(
      'write-segments-metadata requires non-empty sessionId',
    )
  })

  // ── [defer segments 化 / D-A1-2] deferEntryId 去重（裸 uuid key 与 clientUuid 空间互斥）──

  function makeDeferEntry(deferEntryId: string, timestamp = 1000): SegmentsMetadataEntry {
    return { deferEntryId, segments: [{ type: 'text', text: 'hi' }, { type: 'image', id: 'i', path: '/tmp/a.png', fileName: 'a.png', displayName: 'a.png' }], timestamp }
  }

  it('defer 条目：同 deferEntryId 覆盖（去重语义，flush 重试重提交同条目）+ 与 clientUuid 条目互不干扰', async () => {
    const sid = 'att-store-defer-1'
    writtenPaths.push(join(getAttachmentsDir(sid), 'segments.json'))
    await store.writeSegmentsMetadata(sid, makeDeferEntry('3f2504e0-4f89-41d3-9a0c-0305e82c3301', 1000))
    await store.writeSegmentsMetadata(sid, makeEntry('u-1', 2000))
    let file = readSidecar(sid)
    // 两类 key 并存（写入方各按各的 key）
    expect(file.entries.map((e) => e.deferEntryId ?? null)).toEqual(['3f2504e0-4f89-41d3-9a0c-0305e82c3301', null])
    expect(file.entries.map((e) => e.clientUuid ?? null)).toEqual([null, 'u-1'])

    // 同 deferEntryId 重写 → 覆盖不追加；clientUuid 条目不受影响（互不交叉匹配）
    await store.writeSegmentsMetadata(sid, makeDeferEntry('3f2504e0-4f89-41d3-9a0c-0305e82c3301', 9999))
    file = readSidecar(sid)
    expect(file.entries).toHaveLength(2)
    expect(file.entries[0]?.timestamp).toBe(9999)
    expect(file.entries[1]?.clientUuid).toBe('u-1')

    // 新 deferEntryId → 追加
    await store.writeSegmentsMetadata(sid, makeDeferEntry('3f2504e0-4f89-41d3-9a0c-0305e82c3302', 3000))
    file = readSidecar(sid)
    expect(file.entries).toHaveLength(3)
  })

  it('损坏 segments.json → 隔离 .corrupt 副本后降级为空，写入不阻断', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = getAttachmentsDir('att-store-corrupt-1')
    mkdirSync(dir, { recursive: true })
    const sidecar = join(dir, 'segments.json')
    writeFileSync(sidecar, '{ half-written json', 'utf-8')
    writtenPaths.push(sidecar)
    await store.writeSegmentsMetadata('att-store-corrupt-1', makeEntry('u-recover'))
    // 降级为空后新 entry 成为唯一内容
    const file = readSidecar('att-store-corrupt-1')
    expect(file.entries.map((e) => e.clientUuid)).toEqual(['u-recover'])
    // 损坏现场被隔离保留（.corrupt-<ts> 副本，时间戳动态生成，按前缀扫描）
    const quarantined = readdirSync(dir).some((n) => n.startsWith('segments.json.corrupt-'))
    expect(quarantined).toBe(true)
    errSpy.mockRestore()
  })

  it('失败注入（r1-S14）：tmp 写失败（tmpPath 被目录占用）→ reject 且不产生 segments.json', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = getAttachmentsDir('att-store-tmpfail-1')
    mkdirSync(join(dir, 'segments.json.tmp'), { recursive: true }) // writeFileSync(tmpPath) 必抛 EISDIR
    writtenPaths.push(join(dir, 'segments.json.tmp'))
    await expect(store.writeSegmentsMetadata('att-store-tmpfail-1', makeEntry('u-fail'))).rejects.toThrow(
      'write-segments-metadata failed',
    )
    // 失败后无正式 sidecar 落地（外层 catch 收口，不留下半截状态）
    expect(existsSync(join(dir, 'segments.json'))).toBe(false)
    expect(errSpy).toHaveBeenCalledWith('[session-service] writeSegmentsMetadata failed:', expect.any(Error))
    errSpy.mockRestore()
  })

  it('失败注入（r1-S14）：rename 抛 EPERM 单次 → unlink 清目标后 retry 成功，sidecar 正确落盘', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sid = 'att-store-eperm-1'
    await store.writeSegmentsMetadata(sid, makeEntry('u-first', 1000)) // 目标已存在（rename-over 场景前提）
    renameFailureState.mode = 'once'
    await store.writeSegmentsMetadata(sid, makeEntry('u-second', 2000))
    const file = readSidecar(sid)
    expect(file.entries.map((e) => e.clientUuid)).toEqual(['u-first', 'u-second'])
    expect(existsSync(join(getAttachmentsDir(sid), 'segments.json.tmp'))).toBe(false)
    renameFailureState.mode = 'off'
    errSpy.mockRestore()
  })

  it('失败注入（r1-S14）：rename 双跳均抛 EPERM → reject retryErr 且 tmp 被清理', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sid = 'att-store-eperm-2'
    renameFailureState.mode = 'always'
    try {
      await expect(store.writeSegmentsMetadata(sid, makeEntry('u-rf'))).rejects.toThrow(
        'write-segments-metadata failed',
      )
    } finally {
      renameFailureState.mode = 'off'
    }
    // retry 失败分支清理 tmp（无 .tmp 残留）
    expect(existsSync(join(getAttachmentsDir(sid), 'segments.json.tmp'))).toBe(false)
    errSpy.mockRestore()
  })
})
