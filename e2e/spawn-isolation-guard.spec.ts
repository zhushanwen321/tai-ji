/**
 * 真机批次播种隔离 guard（mock 层零启动零 token）——锁 seedRealCredentials 的播种契约：
 * 真机 e2e 的 pi 进程不得依赖宿主全局环境（隔离落点 = 播种产物；spawn 构造侧的
 * --no-extensions / PI_CODING_AGENT_DIR 已由 pi-rpc 与 pi-subagent-cli 的单测分别锁定，
 * 此处不重复）。
 *
 * 三条契约（每条对应一个宿主环境泄漏面）：
 * 1. settings.json 播种最小子集——不带宿主 packages 清单（settings packages 通道；
 *    真机批次仍经 auth.json/models.json 拷贝拿到真 LLM 凭据——隔离不破坏认证）；
 * 2. discovery.json 空态——宿主 discovery 勾选目录不进 pi spawn 的 --extension 白名单
 *    （文件缺失时 runtime 回落「全部 preset 默认勾选」，宿主自定义扩展目录会被六源发现
 *    的 discovery 源收进真机 argv——batch-s3 现场实证）；
 * 3. 播种 schema 与 runtime 读回形态对齐——discovery-store 只认 version:2，形态漂移
 *    会走 fallback 静默回落默认全勾（防线失效且无信号），此处断言拦截该漂移。
 *
 * 执行形态：纯 fs + 纯构造断言，不 launch Electron、不 spawn pi、零 token——electron
 * project（mock 层，CI 固定环节）可直接承载；凭证源 = spec 自建 fixture 目录（经
 * TAIJI_GUARD_CREDENTIAL_SOURCE 注入），不依赖宿主真实凭证。
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedRealCredentials } from './fixtures/batch-real-helpers'
// 相对路径直引 shared 常量源（@taiji/shared 的 workspace 链接不在根 node_modules——
// e2e spec 从仓根上下文解析不到该包名；constants.ts 零依赖，直引无传递成本）
import { DEFAULT_DISCOVERY_CONFIG } from '../packages/shared/src/constants'

/** guard 专用凭证源 env 键（sourceAgentDir 的 envVar 参数语义：env 值 = 目录路径）。 */
const GUARD_CREDENTIAL_SOURCE = 'TAIJI_GUARD_CREDENTIAL_SOURCE'

/** 自建 fixture 凭证源目录（settings 带 defaultProvider/defaultModel + 凭据文件齐全）。 */
function makeFixtureCredentialSource(root: string): string {
  const src = path.join(root, 'credential-source', 'agent')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'settings.json'), JSON.stringify({
    defaultProvider: 'guard-provider',
    defaultModel: 'guard-model',
    // 宿主污染模拟：packages 清单在场——播种后必须被剥除（契约 1 的反例基座）
    packages: ['npm:@zhushanwen/pi-subagent-workflow'],
    skills: ['/host/.pi/agent/skills'],
  }, null, 2))
  fs.writeFileSync(path.join(src, 'auth.json'), JSON.stringify({
    'guard-provider': { key: 'guard-key', type: 'token' },
  }, null, 2))
  fs.writeFileSync(path.join(src, 'models.json'), JSON.stringify({
    providers: { 'guard-provider': { apiKey: 'guard-key', models: [] } },
  }, null, 2))
  return src
}

test.describe('真机批次播种隔离 guard', () => {
  let root = ''
  let dataDir = ''

  test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-spawn-guard-'))
    dataDir = path.join(root, 'data')
    process.env[GUARD_CREDENTIAL_SOURCE] = makeFixtureCredentialSource(root)
    seedRealCredentials(dataDir, 'spawn-guard', { envVar: GUARD_CREDENTIAL_SOURCE })
  })

  test.afterEach(() => {
    delete process.env[GUARD_CREDENTIAL_SOURCE]
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  test('契约 1：settings.json 播种最小子集——宿主 packages/skills 清单被剥除，凭据文件继承', () => {
    const agentDir = path.join(dataDir, 'agent')
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')) as Record<string, unknown>
    // 宿主清单泄漏面：packages/skills 不得出现在播种产物（真机批次的 pi 进程 settings 无用户清单）
    expect(settings, 'settings.json 播种产物不应携带宿主 packages 清单').not.toHaveProperty('packages')
    expect(settings, 'settings.json 播种产物不应携带宿主 skills 清单').not.toHaveProperty('skills')
    // 认证最小集保持：过 runtime getDefaultModel 门禁的 defaultProvider/defaultModel 在场
    expect(settings['defaultProvider']).toBe('guard-provider')
    expect(settings['defaultModel']).toBe('guard-model')
    // 真机批次仍拿到真 LLM 凭据：auth.json / models.json 从凭证源拷贝继承（隔离不破坏认证）
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8')) as Record<string, unknown>
    expect(auth['guard-provider'], 'auth.json 应从凭证源继承（真 LLM 凭据可达）').toBeDefined()
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')) as { providers?: Record<string, unknown> }
    expect(models.providers?.['guard-provider'], 'models.json 应从凭证源继承（真 LLM 凭据可达）').toBeDefined()
  })

  test('契约 2：discovery.json 播种空态——宿主勾选目录不进 discovery 源', () => {
    const discoveryPath = path.join(dataDir, 'agent', 'discovery.json')
    expect(fs.existsSync(discoveryPath), 'discovery.json 必须播种（缺失会让 runtime 回落默认全勾）').toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')) as {
      version: number
      skill: { projectPaths: string[]; globalPaths: string[] }
      agent: { projectPaths: string[]; globalPaths: string[] }
      extension: { projectPaths: string[]; globalPaths: string[] }
    }
    for (const kind of ['skill', 'agent', 'extension'] as const) {
      const scoped = discovery[kind]
      expect(scoped?.projectPaths, `discovery.${kind}.projectPaths 应为空数组`).toEqual([])
      expect(scoped?.globalPaths, `discovery.${kind}.globalPaths 应为空数组`).toEqual([])
    }
  })

  test('契约 3：播种 schema 与 runtime discovery 默认态形态对齐（漂移拦截）', () => {
    // runtime discovery-store 只认 version:2，其余走 fallback 静默回落默认全勾——
    // 版本升级时本断言红，提示同步本播种形态（防防线静默失效）。
    const discovery = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'agent', 'discovery.json'), 'utf8'),
    ) as { version: number }
    expect(discovery.version, 'discovery.json schema 版本须与 runtime DISCOVERY_SCHEMA_VERSION（当前 2）一致').toBe(2)
    // 形态键对齐 shared 默认态：三 kind 结构须与 DEFAULT_DISCOVERY_CONFIG 同构——
    // shared 端增删 kind 时本断言红，提示同步播种空态的 kind 集合。
    const sharedKinds = Object.keys(DEFAULT_DISCOVERY_CONFIG).sort()
    expect(sharedKinds, 'shared 默认态的 kind 集合（防 schema 演进后播种空态缺 kind 被补默认）').toEqual(['agent', 'extension', 'skill'])
  })
})
