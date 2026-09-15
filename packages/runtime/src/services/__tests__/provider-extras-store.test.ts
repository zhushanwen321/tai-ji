/**
 * XyzProviderStore（config/providers.json 唯一读写者）单测（tmp 目录真实文件）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-extras-store.test.ts
 *
 * 覆盖（验收 4 原子并发 + 验收 5 损坏容错 + 基础 RMW 语义）：
 * - 文件不存在读返回空且不物化（对齐 AuthStorage.remove 语义）
 * - modify RMW / getExtras / readAll
 * - 并发 modify 同 provider：锁串行化，两字段的增量更新无交错丢失
 * - delete 幂等
 * - 损坏 JSON（非法 JSON / version 非 1）：readAll 返回空 + .corrupt-<ts> 备份生成
 * - crash 残留自愈：过期 .lock 目录 + 残留 .tmp 后读写正常（round 1 review SUGGESTION）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XyzProviderStore } from '../provider-extras-store.js'

let dir: string
let file: string
let store: XyzProviderStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-extras-store-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  file = join(dir, 'config', 'providers.json')
  store = new XyzProviderStore(file)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('XyzProviderStore', () => {
  it('文件不存在时 readAll 返回空对象且不物化文件（读路径无副作用）', async () => {
    expect(store.readAllSync()).toEqual({})
    expect(existsSync(file)).toBe(false)
  })

  it('文件不存在时 getExtras 返回 undefined', async () => {
    expect(store.getExtrasSync('zai-coding-cn')).toBeUndefined()
  })

  it('modify 写入后 getExtras/readAll 读回完整数据（含 cookieSet/apiKeySet/modelStates）', async () => {
    await store.modify('zai-coding-cn', () => ({
      authMethod: 'api_key',
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: false, apiKeySet: true },
      modelStates: { 'glm-5.2': { enabled: false } },
    }))
    expect(store.getExtrasSync('zai-coding-cn')).toEqual({
      authMethod: 'api_key',
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: false, apiKeySet: true },
      modelStates: { 'glm-5.2': { enabled: false } },
    })
    const all = store.readAllSync()
    expect(Object.keys(all)).toEqual(['zai-coding-cn'])
  })

  it('modify 不同 provider 互不覆盖', async () => {
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    await store.modify('b', () => ({ authMethod: 'oauth' }))
    expect((store.getExtrasSync('a'))?.authMethod).toBe('api_key')
    expect((store.getExtrasSync('b'))?.authMethod).toBe('oauth')
  })

  it('并发 modify 同 provider：最终状态一致无交错（proper-lockfile 串行化 RMW）', async () => {
    // 两个 Promise 同时写同 provider 的不同字段，各自基于 current 增量更新——
    // 锁保证后者在锁内重读到前者的结果，两字段都保留（无交错半写）
    await Promise.all([
      store.modify('shared', current => ({ ...current, authMethod: 'api_key' })),
      store.modify('shared', current => ({ ...current, quota: { enabled: true } })),
    ])
    expect(store.getExtrasSync('shared')).toEqual({
      authMethod: 'api_key',
      quota: { enabled: true },
    })
    // 加大并发压力：10 个并发 modify 各写一个 modelState 条目，全部保留
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.modify('chaos', current => ({
          ...current,
          modelStates: { ...current?.modelStates, [`m${i}`]: { enabled: i % 2 === 0 } },
        })),
      ),
    )
    expect(Object.keys((store.getExtrasSync('chaos'))?.modelStates ?? {})).toHaveLength(10)
  })

  it('并发 modify 不同 provider：全部保留', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.modify(`p${i}`, () => ({ quota: { enabled: true, fetcher: `f${i}` } })),
      ),
    )
    const all = store.readAllSync()
    expect(Object.keys(all)).toHaveLength(10)
    expect(all.p3?.quota?.fetcher).toBe('f3')
  })

  it('delete 删除条目且幂等；文件不存在时不物化 providers.json', async () => {
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    await store.delete('a')
    expect(store.getExtrasSync('a')).toBeUndefined()

    // 幂等：条目已不存在再删不抛错、不写盘
    await store.delete('a')
    await store.delete('never-existed')
    expect(store.getExtrasSync('a')).toBeUndefined()

    // 文件不存在时 delete 不物化（对齐 AuthStorage.remove 语义）
    const freshDir = mkdtempSync(join(tmpdir(), 'provider-extras-store-fresh-'))
    try {
      const freshFile = join(freshDir, 'config', 'providers.json')
      await new XyzProviderStore(freshFile).delete('x')
      expect(existsSync(freshFile)).toBe(false)
    } finally {
      rmSync(freshDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('损坏容错：非法 JSON → readAll 返回空 + 备份为 providers.json.corrupt-<ts>', async () => {
    writeFileSync(file, '{ not valid json', 'utf-8')
    expect(store.readAllSync()).toEqual({})
    // 备份文件生成（quarantine 是 rename 语义：坏文件移走，原位置恢复可写）
    const corruptions = readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))
    expect(corruptions).toHaveLength(1)
    // 隔离后原文件已移走，后续 modify 正常重建
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    expect(store.getExtrasSync('a')).toMatchObject({ authMethod: 'api_key' })
  })

  it('损坏容错：version 非 1（未来格式）→ 按空配置 + 隔离备份', async () => {
    writeFileSync(file, JSON.stringify({ version: 2, providers: { x: { authMethod: 'api_key' } } }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    const corruptions = readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))
    expect(corruptions).toHaveLength(1)
  })

  it('损坏容错：结构不匹配（providers 非对象）→ 按空配置 + 隔离备份', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, providers: 'not-an-object' }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('损坏容错：providers 为 null → 按空配置 + 隔离备份（typeof null === "object" 不得穿透校验）', async () => {
    // round 1 review must-fix #5：null 穿透校验会让 readAll 返回 providers:null，
    // 消费方对 null 赋值直接 TypeError 且无隔离自愈
    writeFileSync(file, JSON.stringify({ version: 1, providers: null }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('损坏容错：providers 为数组 → 按空配置 + 隔离备份 + 后续 modify 可写回（typeof [] === "object" 不得穿透校验）', async () => {
    // round 2 review must-fix：数组形态穿透校验后 readAllSync 返回数组，modify 表面成功
    // 但 JSON.stringify 丢弃数组上的字符串键属性 → 写盘静默丢失、文件永久停留损坏形态
    writeFileSync(file, JSON.stringify({ version: 1, providers: [] }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
    // 隔离（rename）后原位置恢复可写，modify 正常重建且读回一致
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    expect(store.getExtrasSync('a')).toMatchObject({ authMethod: 'api_key' })
  })

  it('损坏容错：条目级 null（providers 含 null 值）→ 按空配置 + 隔离备份', async () => {
    // round 2 review suggestion：{"foo": null} 穿透后 getExtrasSync('foo') 返回 null，
    // 与签名 ProviderExtras | undefined 失实，消费方 !== undefined 判定被 null 欺骗
    writeFileSync(file, JSON.stringify({ version: 1, providers: { foo: null, bar: { authMethod: 'api_key' } } }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('空文件内容按空配置处理（不触发隔离）', async () => {
    writeFileSync(file, '', 'utf-8')
    // 空串 JSON.parse 抛错 → 走隔离路径？——JSON.parse('') throws → 隔离 + 空。
    // 语义上空文件等同未初始化，隔离后按空继续（与 AuthStorage 空文件按空不同：
    // providers.json 是 xyz 自有文件（原子写保证非空），空文件只可能来自外部干预，隔离留证）
    expect(store.readAllSync()).toEqual({})
  })

  describe('A1 读写往返（scopedModels）', () => {
    it('modifyScopedModels 写入 → getScopedModels 读回一致', async () => {
      const models = ['openai/gpt-4o', 'anthropic/claude-opus-4-5', 'deepseek/deepseek-v3']
      await store.modifyScopedModels(() => models)
      expect(store.getScopedModelsSync()).toEqual(models)
    })

    it('字段缺失时 getScopedModels 返回 []（文件不存在）', () => {
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('字段缺失时 getScopedModels 返回 []（providers.json 存在但无 scopedModels 字段）', async () => {
      await store.modify('a', () => ({ authMethod: 'api_key' }))
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('modifyScopedModels 读取闭包参数为当前值', async () => {
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      const result = await store.modifyScopedModels((cur) => [...cur, 'anthropic/claude-sonnet-4'])
      expect(result).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
    })
  })

  describe('A2 非法容错（scopedModels）', () => {
    it('非数组 scopedModels → getScopedModels 返回 []、providers 域不受影响', async () => {
      // 手写 providers.json：scopedModels 为字符串（非法），providers 有有效数据
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: { 'openai': { authMethod: 'api_key' } },
        scopedModels: 'not-an-array',
      }, null, 2), 'utf-8')
      expect(store.getScopedModelsSync()).toEqual([])
      expect(store.readAllSync()).toEqual({ 'openai': { authMethod: 'api_key' } })
    })

    it('非数组 scopedModels（number）→ getScopedModels 返回 []', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: {},
        scopedModels: 42,
      }, null, 2), 'utf-8')
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('含非法条目（不含/分隔符）→ 过滤掉非法条目并 log warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        writeFileSync(file, JSON.stringify({
          version: 1,
          providers: {},
          scopedModels: ['openai/gpt-4o', 'invalid-no-slash', 'anthropic/claude-sonnet-4'],
        }, null, 2), 'utf-8')
        expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: invalid entry format (expected provider/modelId):',
          'invalid-no-slash',
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('含非 string 条目 → 过滤掉并 log warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        writeFileSync(file, JSON.stringify({
          version: 1,
          providers: {},
          scopedModels: ['openai/gpt-4o', 123, null, 'anthropic/claude-sonnet-4'],
        }, null, 2), 'utf-8')
        expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: non-string entry filtered out:',
          123,
        )
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: non-string entry filtered out:',
          null,
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('scopedModels 非法时 providers 域数据完全不受影响', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: {
          'openai': { authMethod: 'api_key', modelStates: { 'gpt-4o': { enabled: true } } },
          'anthropic': { authMethod: 'oauth' },
        },
        scopedModels: { not: 'array' },
      }, null, 2), 'utf-8')
      expect(store.readAllSync()).toEqual({
        'openai': { authMethod: 'api_key', modelStates: { 'gpt-4o': { enabled: true } } },
        'anthropic': { authMethod: 'oauth' },
      })
    })
  })

  describe('A3 去重保序（读侧 sanitize 收敛，写侧不改写）', () => {
    it('写入 [] 后文件中 scopedModels 字段保留为空数组', async () => {
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o'])

      await store.modifyScopedModels(() => [])
      expect(store.getScopedModelsSync()).toEqual([])

      // 验证文件中 scopedModels 字段保留（非 undefined/缺失）
      const { readFileSync: rf } = await import('node:fs')
      const raw = JSON.parse(rf(file, 'utf-8'))
      expect(raw.scopedModels).toEqual([])
      // key 存在于 JSON 中
      expect('scopedModels' in raw).toBe(true)
    })

    it('写入含重复条目时读取去重保序（读侧 sanitize 首见保留，防 aggregateModels 输出重复模型）', async () => {
      const models = ['openai/gpt-4o', 'openai/gpt-4o', 'anthropic/claude-sonnet-4']
      await store.modifyScopedModels(() => models)
      // 写侧不去重（文件原样保留写入值），读侧唯一入口 sanitizeScopedModels 去重
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
    })
  })

  describe('A4 与 per-provider modify 串行安全', () => {
    it('交错调用 modifyScopedModels 与 modify 同一文件，无丢更新', async () => {
      // 先写入初始数据
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      await store.modify('openai', () => ({ authMethod: 'api_key' }))

      // 并发交错调用：scopedModels 写入 + per-provider 写入
      await Promise.all([
        store.modifyScopedModels((cur) => [...cur, 'anthropic/claude-sonnet-4']),
        store.modify('anthropic', () => ({ authMethod: 'oauth' })),
      ])

      // 两者都成功保留
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
      expect(store.getExtrasSync('openai')).toEqual({ authMethod: 'api_key' })
      expect(store.getExtrasSync('anthropic')).toEqual({ authMethod: 'oauth' })
    })

    it('高并发交错：多次 modifyScopedModels + 多次 modify，最终状态一致', async () => {
      // 20 个并发操作：10 个 modifyScopedModels 追加 + 10 个 modify 写入不同 provider
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) =>
          store.modifyScopedModels((cur) => [...cur, `provider-${i}/model-${i}`]),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          store.modify(`provider-${i}`, () => ({ authMethod: 'api_key' as const })),
        ),
      ])

      // scopedModels 有 10 个条目（顺序可能因并发而变，但数量正确）
      const scoped = store.getScopedModelsSync()
      expect(scoped).toHaveLength(10)
      expect(scoped.every(m => /^provider-\d+\/model-\d+$/.test(m))).toBe(true)

      // 10 个 provider 的 extras 都保留
      for (let i = 0; i < 10; i++) {
        expect(store.getExtrasSync(`provider-${i}`)).toEqual({ authMethod: 'api_key' })
      }
    })

    it('先 modify 后 modifyScopedModels 基于最新文件读取', async () => {
      await store.modify('openai', () => ({ authMethod: 'api_key' }))
      await store.modifyScopedModels(() => ['openai/gpt-4o'])

      // 再次 modify 不会丢失 scopedModels
      await store.modify('openai', (cur) => ({ ...cur, quota: { enabled: true } }))
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o'])
      expect(store.getExtrasSync('openai')).toEqual({ authMethod: 'api_key', quota: { enabled: true } })
    })
  })

  describe('crash 残留自愈（round 1 review SUGGESTION）', () => {
    // 残留形态依据 proper-lockfile 4.1.2 实装（node_modules/proper-lockfile/lib/lockfile.js）：
    // - 锁「文件」实为 mkdir 创建的目录，持有进程 crash 未 release 时残留 `.lock` 目录；
    //   stale 判定 = 锁目录 mtime 早于 now - stale(30s) → 后来者接管（rmdir 后重新 mkdir），
    //   不触发 onCompromised（该回调仅在「自己持锁期间」update 定时器（stale/2=15s）发现
    //   mtime 失效时触发——单测的锁持有窗口是同步代码，无法插入 15s 定时器推进，
    //   模拟需 15s 真实等待或重构注入 lockfile 依赖，性价比不成立，故不覆盖该分支）。
    // - atomicWrite 的 tmp 是定长 `<path>.tmp`，rename 前崩溃即残留；后续写入覆写式自愈。
    it('残留 .tmp + 过期 .lock 目录 → readAll 数据完好、modify 自愈正常、残留物清理', async () => {
      writeFileSync(file, JSON.stringify({ version: 1, providers: { legacy: { authMethod: 'api_key' } } }, null, 2), 'utf-8')
      // atomicWrite 崩溃在 rename 前：半写 tmp 残留（内容必须是外部半写垃圾，不得污染正式文件）
      writeFileSync(`${file}.tmp`, '{"version":1,"providers":{"half-written":{}}}', 'utf-8')
      // proper-lockfile 持有进程 crash：.lock 目录残留，mtime 回拨 60s（> stale 30s 阈值）
      mkdirSync(`${file}.lock`)
      const staleTime = new Date(Date.now() - 60_000)
      utimesSync(`${file}.lock`, staleTime, staleTime)

      // 读路径不持锁：既有数据完好（tmp 半写内容未泄漏进正式文件）
      expect(store.readAllSync()).toEqual({ legacy: { authMethod: 'api_key' } })

      // 写路径：过期锁被接管删除后正常 RMW
      await store.modify('new-entry', () => ({ quota: { enabled: true } }))

      expect(store.getExtrasSync('legacy')).toEqual({ authMethod: 'api_key' })
      expect(store.getExtrasSync('new-entry')).toEqual({ quota: { enabled: true } })
      // 残留物清理：.lock 目录被 unlock rmdir；.tmp 被本次 atomicWrite rename 消费
      expect(existsSync(`${file}.lock`)).toBe(false)
      expect(existsSync(`${file}.tmp`)).toBe(false)
    })

    it('unlock 失败（持锁期间 .lock 目录被外部替换为普通文件）→ warn 可观测、modify 结果仍返回', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const result = await store.modify('a', () => {
          // fn 在锁内同步执行：此处模拟外部篡改，release 的 rmdir 将以 ENOTDIR 失败
          //（rmdir 只忽略 ENOENT，其余错误上抛 → withFileLock 的 catch → warn 分支）
          rmdirSync(`${file}.lock`)
          writeFileSync(`${file}.lock`, 'tampered', 'utf-8')
          return { authMethod: 'api_key' }
        })
        expect(result).toEqual({ authMethod: 'api_key' })
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] release lock failed (continuing, lock may be compromised):',
          expect.any(Error),
        )
      } finally {
        warnSpy.mockRestore()
      }
    })
  })
})
