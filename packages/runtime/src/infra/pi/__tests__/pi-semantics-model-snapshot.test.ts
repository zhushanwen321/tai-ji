/**
 * pi 模型快照 / refresh / 配置加载语义探针（model-switch-live-provider-sync，PS-41/42/43 的
 * 机器防线，受 C-proc-08 版本门禁约束）。
 *
 * 为什么需要这组断言：本设计的两条主干都建立在 pi 的**行为语义**上——
 * ① 运行中进程的可用模型集合冻结在 spawn 时刻（`set_model` 只查内存快照、pi 无 watcher/refresh RPC）
 *    → 「新增 provider 后切不过去」的根因；
 * ② `ctx.modelRegistry.refresh({allowNetwork:false})` 会**重读磁盘配置**且**零网络** → 本设计的解法；
 * ③ `ModelConfig.load` 对「文件缺失」与「解析/schema 失败」的差异化语义（ENOENT = 合法空配置；
 *    非法 = 空配置 + error 全文）→ 扩展的按文件基线规则与坏配置可见性链的前提。
 * pi 升级若改动任一条，本文件先行红，避免「静默失效」被当成用户配置问题排查。
 *
 * 测试框架：vitest（禁 node:test）。纯静态读 dist（不 spawn pi，不进 REAL_PI_TESTS 分池）。
 * pi 包不可达的环境 skip 而非 fail（同 pi-paths-config-dir-contract.test.ts 的 skip-if 约定）。
 *
 * 运行命令：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-model-snapshot.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function locatePiDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
    if (existsSync(join(candidate, 'core', 'model-runtime.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

function locatePiAiDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
    if (existsSync(join(candidate, 'models.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

const PI_DIST = locatePiDist()
const PI_AI_DIST = locatePiAiDist()
const SKIP_REASON = PI_DIST && PI_AI_DIST
  ? ''
  : 'pi 实装 dist 不可达（cwd 上溯 6 级未命中 pi-coding-agent / pi-ai）'
if (!PI_DIST || !PI_AI_DIST) {
  console.warn(`[pi-semantics-model-snapshot] skip：${SKIP_REASON}`)
}

/** 读 dist 文件正文（含路径定位 + 存在性断言，便于失败时一眼看出是文件被改名还是内容变了）。 */
function readDist(dist: string, relative: string): string {
  const path = join(dist, relative)
  expect(existsSync(path), `pi 实装文件缺失（路径可能被改名）：${relative}`).toBe(true)
  return readFileSync(path, 'utf-8')
}

/** 取以 `start` 开头到 `endExclusive` 的片段（两端按首次出现匹配；用于把断言限定在函数体内）。 */
function slice(source: string, start: string, endExclusive: string): string {
  const from = source.indexOf(start)
  expect(from, `锚点未命中：${start}`).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(endExclusive, from)
  expect(to, `结束锚点未命中：${endExclusive}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe.skipIf(!PI_DIST || !PI_AI_DIST)('PS-41 · set_model 只查内存快照 + Model not found 文案', () => {
  it('set_model 从 getAvailableSnapshot() 解析，未命中回 `Model not found: <provider>/<id>`', () => {
    const src = readDist(PI_DIST!, 'modes/rpc/rpc-mode.js')
    const body = slice(src, 'case "set_model"', 'case "cycle_model"')
    expect(body).toContain('modelRuntime.getAvailableSnapshot()')
    expect(body).toMatch(/models\.find\(\s*\(m\)\s*=>\s*m\.provider === command\.provider && m\.id === command\.modelId/)
    expect(body).toContain('Model not found: ${command.provider}/${command.modelId}')
    // 唯一的落点：快照找不到就报错，没有任何「重读磁盘 / 触发 refresh」的兜底
    expect(body).not.toContain('ModelConfig.load')
    expect(body).not.toContain('refresh(')
  })

  it('getAvailableSnapshot() 只回缓存（快照来自 create() 期 refresh，运行期不自动重建）', () => {
    const src = readDist(PI_DIST!, 'core/model-runtime.js')
    const body = slice(src, 'getAvailableSnapshot()', 'getError()')
    expect(body).toContain('return this.snapshot.available')
    // 快照更新点只在 updateModelSnapshot（由 rebuildProviders / refresh 触发）
    const update = slice(src, 'updateModelSnapshot()', 'async runAvailabilityRefresh')
    expect(update).toContain('available: all.filter(')
  })

  it('getError() 合成 config error + per-provider composition error（坏配置的唯一判据面）', () => {
    const src = readDist(PI_DIST!, 'core/model-runtime.js')
    const body = slice(src, 'getError()', 'getRegisteredProviderConfig')
    expect(body).toContain('this.config.getError()')
    expect(body).toContain('compositionErrors')
    expect(body).toContain('this.availabilityError')
  })
})

describe.skipIf(!PI_DIST || !PI_AI_DIST)('PS-42 · refresh 重读磁盘 + allowNetwork:false 零网络', () => {
  it('ModelRuntime.refresh 首行重读 models.json 配置并按新配置重组 providers', () => {
    const src = readDist(PI_DIST!, 'core/model-runtime.js')
    const body = slice(src, 'async refresh(options = {})', 'registerNativeProvider')
    expect(body).toContain('this.config = await ModelConfig.load(this.modelsPath)')
    expect(body).toMatch(/rebuildProviders\(\)|recomposeProvider\(providerId\)/)
    expect(body).toContain('updateModelSnapshot()')
    expect(body).toContain('queueAvailabilityRefresh(options.signal)')
    expect(body).toContain('return { aborted:')
    // 返回体不含 getError（调用方必须另调 registry.getError()）
    expect(body).not.toContain('getError')
  })

  it('allowNetwork:false 在凭据解析 / 网络动作之前提前返回（pi-ai 本地恢复相位）', () => {
    const src = readDist(PI_AI_DIST!, 'models.js')
    const body = slice(src, 'async refresh(options = {})', 'async resolveRefreshCredential')
    // 关键 early-return：本地相位跑完就 return，resolvedCredential 之前
    expect(body).toMatch(/if \(!allowNetwork \|\| signal\.aborted\)\s*\n\s*return;/)
    expect(body).toContain('const allowNetwork = options.allowNetwork ?? true')
  })

  it('ModelRegistry.refresh 直通 runtime，getError 是独立方法（两调用面）', () => {
    const src = readDist(PI_DIST!, 'core/model-registry.js')
    const refresh = slice(src, 'refresh(options)', 'getError()')
    expect(refresh).toContain('return this.runtime.refresh(options)')
    const getError = slice(src, 'getError()', 'getAll()')
    expect(getError).toContain('return this.runtime.getError()')
  })
})

describe.skipIf(!PI_DIST || !PI_AI_DIST)('PS-43 · ModelConfig.load 的两种不可用形态', () => {
  it('ENOENT → 合法空 config 且无 error', () => {
    const src = readDist(PI_DIST!, 'core/model-config.js')
    const body = slice(src, 'static async load(', 'getProvider(')
    expect(body).toMatch(/code === "ENOENT"/)
    expect(body).toContain('return new ModelConfig(new Map())')
  })

  it('解析 / schema 失败 → 空 config + error 全文（含两类文案）', () => {
    const src = readDist(PI_DIST!, 'core/model-config.js')
    const body = slice(src, 'static async load(', 'getProvider(')
    expect(body).toMatch(/Failed to parse models\.json/)
    expect(body).toMatch(/Invalid models\.json schema/)
  })

  it('ModelDefinitionSchema.id 必填且 minLength 1（id 缺失会拒载整个文件）', () => {
    const src = readDist(PI_DIST!, 'core/model-config.js')
    const body = slice(src, 'const ModelDefinitionSchema', 'const ModelOverrideSchema')
    expect(body).toMatch(/id:\s*Type\.String\(\{\s*minLength:\s*1\s*\}\)/)
    // id 不在 Optional 里（必填）
    expect(body).not.toMatch(/id:\s*Type\.Optional/)
    const provider = slice(src, 'const ProviderConfigSchema', 'const ModelsConfigSchema')
    expect(provider).toMatch(/models:\s*Type\.Optional\(Type\.Array\(ModelDefinitionSchema\)\)/)
  })

  it('providers.models 无 string 分支（字符串模型项对 pi 非法）', () => {
    const src = readDist(PI_DIST!, 'core/model-config.js')
    const provider = slice(src, 'const ProviderConfigSchema', 'const ModelsConfigSchema')
    // `models` 只接受对象数组——U6 取消「字符串归一」的依据
    expect(provider).not.toMatch(/Type\.Union\(\[Type\.String/)
  })
})
