/**
 * M1（e2e real）：models.json 脏数据 → bundled pi 拒绝加载 → sanitize 自愈。
 *
 * [R4 保留不翻，2026-09-15 L2.5 faux 翻轨盘点] 本 spec 断言的就是 **bundled pi 版本行为**
 * （0.80.3 → 0.84.4 语义固化，见下「版本语义」节）——faux 轨替换的是 LLM 演员而非 pi
 * 二进制，此处验证面（pi schema 校验 + composition 降级语义）与 LLM 无关也不该 faux 化。
 * pi bump 时触发重验（正式登记归 e2e-map，阶段 3 收录）。
 *
 * 对应修复：48777f91b fix(runtime): sanitize invalid providers from models.json on startup
 * Bug 场景：重装后 models.json 残留脏 provider，pi 加载失败 → 自定义 provider 全部丢失
 * → 前端 Model not found。
 *
 * 真实性（零 mock）：
 * - 真实 bundled pi 二进制（/Applications/TaiJi.app/... 或 env TAIJI_BUNDLED_PI_BIN
 *   或 repo 内 apps/electron/resources/pi/pi-darwin-arm64）
 * - 真实 models.json（seed 临时目录，PI_CODING_AGENT_DIR 隔离）
 * - 真实 sanitizeInvalidProviders（tsx 子进程跑 runtime 源码）
 *
 * ── [版本语义 0.80.3 → 0.84.4]（探针实测 2026-09-15，实装 0.84.4）────────────────
 * 权威源 = node_modules/@earendil-works/pi-coding-agent@0.84.4 的 dist 编译 JS + bundled
 * 二进制实跑（C-proc-08：禁用记忆/网络断言 pi 行为）。探针落在 /tmp 一次性脚本，关键实测
 * 输出已固化到下方两条断言的注释中。
 *
 * ① 「空壳 provider 拖垮整个 models.json」在 0.84.4 只在 **schema 层**成立，composition 层
 *    已按 provider 隔离：
 *    - `{name}`（八字段全缺）→ 该 provider 抛 "must specify ..." 但**只影响自己**，
 *      model-runtime.recomposeProvider 把错误收进 compositionErrors 并降级（无 base 则
 *      deleteProvider），其他 provider 的模型照常列出。实测（legal + {name}）：
 *      `legal gpt-4o` 仍列出 + stderr `Provider "concurrency-verify-A": ... must specify ...`。
 *    - `null` 记录 / 空串字段（`""`）→ **整文件**被 TypeBox schema 拒绝（0.84.4 校验器是
 *      TypeBox 非 zod，`ProviderConfigSchema` 的 name/baseUrl/apiKey/api 带 minLength:1）：
 *      `Invalid models.json schema:\n  - providers.broken: must be object` /
 *      `providers.broken.baseUrl: must not have fewer than 1 characters`，legal/gpt-4o
 *      **不列出**（0 行）。→ 这才是 0.84.4 下「一个坏 provider 拖垮所有自定义 provider」
 *      的现存形态，也是本 spec 主链路的验证目标。
 * ② `{apiKey, name}`（历史事故形态）在 0.80.3 五字段判定下是空壳、在 0.84.4 八字段判定下
 *    **已合法**（apiKey 在场即算 specify）→ 不该被 sanitize 删除（沿旧判定误删 = 数据丢失级
 *    bug，见 pi-provider-repair.ts W1b/A-02）。实测（legal + {apiKey,name}）：无 "must specify"、
 *    `legal gpt-4o` 列出、文件条目原样保留。
 *
 * 断言设计（两条，均基于上述实测）：
 * - A 主链路：schema 级脏数据（null / 空串 / {name} 全缺）→ 0.84.4 整文件拒绝（输出含
 *   "Invalid models.json schema"、不含 legal/gpt-4o 行）→ sanitize 剔除 → 再次 list-models
 *   无 schema 错误且含 legal/gpt-4o 行。
 * - B 版本语义 pin：{apiKey,name} 合法（不被 sanitize 剔除、pi 正常列出）、{name} 才被剔除；
 *   单独 {name} 坏条目只影响自己（legal 仍列出 = composition 层隔离）。
 *
 * 注意：pi 加载失败时 exit code 仍为 0（降级内置默认模型 / 逐 provider 隔离），故断言基于
 * 输出内容而非退出码。
 */
import { test, expect } from '@playwright/test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const SANITIZE_SCRIPT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sanitize-providers.mts')

/** bundled pi 二进制候选（env 覆盖 → 本地打包版 → repo 产物）。找不到则 skip。 */
function resolveBundledPiBin(): string | null {
  const candidates = [
    process.env.TAIJI_BUNDLED_PI_BIN,
    '/Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64',
    path.join(REPO_ROOT, 'apps', 'electron', 'resources', 'pi', 'pi-darwin-arm64'),
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

const SKIP_REASON =
  'bundled pi 二进制未找到（env TAIJI_BUNDLED_PI_BIN / /Applications/TaiJi.app/... / apps/electron/resources/pi/pi-darwin-arm64）'

/** 跑 bundled pi --list-models，返回 stdout+stderr 合并输出（不抛，调用方断言内容）。 */
function runPiListModels(piBin: string, piAgentDir: string): SpawnSyncReturns<string> {
  return spawnSync(piBin, ['--list-models'], {
    env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDir },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function piOutput(r: SpawnSyncReturns<string>): string {
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

/** 合法 provider：完整 baseUrl/api/apiKey + models（--list-models 应列出其 gpt-4o）。 */
const LEGAL_PROVIDER = {
  baseUrl: 'https://api.example.com/v1',
  api: 'openai-completions',
  apiKey: 'sk-test',
  models: [
    { id: 'gpt-4o', name: 'gpt-4o', input: ['text'], contextWindow: 128000, maxTokens: 8192 },
  ],
}

/** 历史事故形态：仅 apiKey+name。0.84.4 判为合法（apiKey 在场），sanitize 不得删除。 */
const APIKEY_ONLY_PROVIDER = { apiKey: 'sk-empty-shell', name: 'empty shell provider' }

/** 真·空壳：八字段全缺。sanitize 判定为无效 → 剔除。 */
const TRULY_EMPTY_SHELL = { name: 'empty shell provider' }

/** schema 级脏数据：null 记录 / 空串字段（0.84.4 整文件拒绝的两类形态，见头部 ①）。 */
const NULL_RECORD = null
const EMPTY_STRING_FIELDS = { baseUrl: '', api: '', apiKey: '', models: [] as unknown[] }

/** seed 隔离数据目录：<tmp>/pi/agent/models.json，返回 { dataDir, piAgentDir, modelsFile }。 */
function seedModelsJson(models: unknown): { dataDir: string; piAgentDir: string; modelsFile: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-m1-'))
  const piAgentDir = path.join(dataDir, 'pi', 'agent')
  fs.mkdirSync(piAgentDir, { recursive: true })
  const modelsFile = path.join(piAgentDir, 'models.json')
  fs.writeFileSync(modelsFile, JSON.stringify(models, null, 2))
  return { dataDir, piAgentDir, modelsFile }
}

/** 触发修复：tsx 子进程跑 runtime 真实 sanitizeInvalidProviders，返回其 removed 列表。 */
function runSanitize(modelsFile: string): { removed: string[]; stdout: string } {
  const sanitized = spawnSync(TSX_BIN, [SANITIZE_SCRIPT], {
    env: { ...process.env, MODELS_JSON_PATH: modelsFile },
    encoding: 'utf-8',
    timeout: 30_000,
  })
  const stdout = sanitized.stdout ?? ''
  expect(sanitized.status, `sanitize 子进程失败: ${sanitized.stderr ?? stdout}`).toBe(0)
  const resultMatch = /SANITIZE_RESULT=(\{.*\})/.exec(stdout)
  expect(resultMatch, 'sanitize 子进程应输出 SANITIZE_RESULT=JSON').not.toBeNull()
  const result = JSON.parse(resultMatch![1] ?? 'null') as { removed?: string[] }
  expect(Array.isArray(result.removed), 'sanitize 结果应含 removed 数组').toBe(true)
  return { removed: [...(result.removed ?? [])].sort(), stdout }
}

function readProviders(modelsFile: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(modelsFile, 'utf-8')) as { providers: Record<string, unknown> }
  return raw.providers
}

test('M1-A (e2e real): schema 级脏数据致 bundled pi 整文件拒绝加载，sanitize 后恢复', async () => {
  const piBin = resolveBundledPiBin()
  test.skip(!piBin, SKIP_REASON)

  const { dataDir, piAgentDir, modelsFile } = seedModelsJson({
    providers: {
      legal: LEGAL_PROVIDER,
      'null-record': NULL_RECORD,
      'empty-string-fields': EMPTY_STRING_FIELDS,
      'shell-truly-empty': TRULY_EMPTY_SHELL,
    },
  })

  try {
    // ── 1. 复现：0.84.4 因 schema 违规拒绝整个 models.json ──
    const before = runPiListModels(piBin, piAgentDir)
    expect(before.status).toBe(0) // 0.84.4 降级内置默认，不硬失败——但必须报加载错误
    const beforeOutput = piOutput(before)
    expect(beforeOutput, 'null 记录应触发 schema 级整文件拒绝').toContain('Invalid models.json schema')
    expect(beforeOutput, 'legal provider 尚在的模型不应列出（整文件拒绝 → Model not found 根因）').toMatch(
      /providers\.null-record: must be object/,
    )
    expect(beforeOutput, '空串字段应被 schema 层 minLength:1 拒绝').toMatch(
      /must not have fewer than 1 characters/,
    )
    expect(beforeOutput, '自定义 provider 的模型不应列出（Model not found 根因）').not.toMatch(/legal\s+gpt-4o/)

    // ── 2. 触发修复：tsx 子进程跑 runtime 真实 sanitizeInvalidProviders ──
    const { removed } = runSanitize(modelsFile)
    expect(removed, '三类脏数据（null / 空串 / 全缺空壳）都应被剔除').toEqual([
      'empty-string-fields',
      'null-record',
      'shell-truly-empty',
    ])

    // 文件层面确认：脏数据已删、合法保留
    const afterSanitize = readProviders(modelsFile)
    expect(afterSanitize['null-record'], 'models.json 不应再含 null 记录').toBeUndefined()
    expect(afterSanitize['empty-string-fields'], 'models.json 不应再含空串字段条目').toBeUndefined()
    expect(afterSanitize['shell-truly-empty'], 'models.json 不应再含全缺空壳').toBeUndefined()
    expect(afterSanitize.legal, '合法 provider 必须保留').toBeDefined()

    // ── 3. 验证修复：bundled pi 正常加载，legal/gpt-4o 列出 ──
    const after = runPiListModels(piBin, piAgentDir)
    expect(after.status).toBe(0)
    const afterOutput = piOutput(after)
    expect(afterOutput, 'schema 加载错误应消失').not.toContain('Invalid models.json schema')
    expect(afterOutput).not.toContain('Failed to load models.json')
    expect(afterOutput, '合法 provider 的模型应被列出').toMatch(/legal\s+gpt-4o/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('M1-B (e2e real): {apiKey,name} 空壳在 0.84.4 已合法（不被误删），全缺空壳才剔除', async () => {
  const piBin = resolveBundledPiBin()
  test.skip(!piBin, SKIP_REASON)

  const { dataDir, piAgentDir, modelsFile } = seedModelsJson({
    providers: {
      legal: LEGAL_PROVIDER,
      'concurrency-verify-A': APIKEY_ONLY_PROVIDER,
      'shell-truly-empty': TRULY_EMPTY_SHELL,
    },
  })

  try {
    // ── 1. 0.84.4 八字段判定：{apiKey,name} 合法，且全缺空壳的报错只影响自己（per-provider 隔离）──
    const before = runPiListModels(piBin, piAgentDir)
    expect(before.status).toBe(0)
    const beforeOutput = piOutput(before)
    expect(beforeOutput, 'apiKey 在场不应触发 schema 级整文件拒绝').not.toContain('Invalid models.json schema')
    expect(beforeOutput, '全缺空壳仍触发 composition 层 must specify 报错').toContain('must specify')
    expect(
      beforeOutput,
      'composition 报错按 provider 隔离：合法 provider 的模型仍应列出',
    ).toMatch(/legal\s+gpt-4o/)

    // ── 2. sanitize 只剔全缺空壳，不碰 apiKey-only 条目（沿 0.80.3 五字段判定 = 数据丢失）──
    const { removed } = runSanitize(modelsFile)
    expect(removed, '仅八字段全缺的空壳应被剔除，{apiKey,name} 必须保留').toEqual(['shell-truly-empty'])

    const afterSanitize = readProviders(modelsFile)
    expect(afterSanitize['concurrency-verify-A'], '{apiKey,name} 条目不得被 sanitize 误删').toEqual(
      APIKEY_ONLY_PROVIDER,
    )
    expect(afterSanitize['shell-truly-empty'], '全缺空壳应从 models.json 删除').toBeUndefined()

    // ── 3. 修复后 bundled pi 加载：无 must specify、legal 正常列出 ──
    const after = runPiListModels(piBin, piAgentDir)
    expect(after.status).toBe(0)
    const afterOutput = piOutput(after)
    expect(afterOutput, '全缺空壳已剔除 → must specify 报错应消失').not.toContain('must specify')
    expect(afterOutput, '合法 provider 的模型应被列出').toMatch(/legal\s+gpt-4o/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
