/**
 * 等价性测试 REAL 轨（真实 LLM turn）门控——与 pi-fixture.ts 的 faux 轨分离的独立模块。
 *
 * 为什么单独成文件：REAL 门控探测要读本机真实 `~/.pi/agent` 凭证文件（auth.json /
 * models.json，只读存在性与非空 key，不触凭证值、不进断言）。pi-fixture 的全部现役
 * 消费方都是 faux 轨（凭证无关），若探测留在 pi-fixture 模块顶层，任何 import
 * pi-fixture 的测试文件都会在加载期无条件触发真实凭证读取。拆出后探测只被显式
 * import 本模块的加载链触发（当前 = spawnPiFixture 的 real 分支按需动态 import），
 * faux 轨运行零真实凭证读取。
 *
 * 引用约定：真实 LLM turn 用例（TEST-STRATEGY §4 完整基线，开发机手动跑）一律
 * `import { REAL_PI_READY } from './real-pi-gate.js'` + `describe.skipIf(!REAL_PI_READY)`
 * 包裹；`TAIJI_SKIP_REAL_PI=1` 强制跳过（探测短路，连凭证文件都不读）。
 * 新增真实 LLM 文件须同步登记 vitest.config.ts 的 REAL_PI_TESTS 分池（守卫脚本
 * session-manager-e2e-fixture-unit 识别本模块的 import 信号做双向对账）。
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// 从叶子模块 pi-environment 取用（原 import pi-fixture 与其动态 import 本文件构成循环依赖）
import { DEFAULT_MODEL, PI_PATH } from './pi-environment.js'

const DEFAULT_PROVIDER = DEFAULT_MODEL.split('/')[0]!

/**
 * 强制跳过真实 pi（LLM turn）用例的 env 开关（'1' / 'true' 生效）。
 * CI test-runtime job 显式设置——把「CI 只跑凭证无关子集」从隐式事实（CI 恰好无 ~/.pi）
 * 变为显式声明；本机也可用它模拟无凭证环境验证 skip 语义。双轨说明见 TEST-STRATEGY.md §4。
 */
const FORCE_SKIP_REAL_PI_ENV = 'TAIJI_SKIP_REAL_PI'

/** 真实 agent 目录（凭证所在）：与 pi config.js getAgentDir() 同规则
 * （dist/config.js:412-418）——PI_CODING_AGENT_DIR 覆盖 → ~/.pi/agent。角色是「拷贝源 +
 * 探测源」：凭证探测读它；real spawn 把其中凭证文件原样拷进临时 agent dir（探测与 pi
 * 实读同源，见 pi-fixture.ts 文件头「agent dir 隔离」）。本目录里的扩展不随子进程加载。 */
export function piAgentDir(): string {
  const envDir = process.env['PI_CODING_AGENT_DIR']
  if (envDir && envDir.trim() !== '') return envDir
  return join(homedir(), '.pi', 'agent')
}

/**
 * 需要带入隔离 agent dir 的凭证类文件（pi 0.84.1 实装读取清单，逐项依据 dist 实现行号）：
 * - auth.json：stored 凭证（dist/config.js:428-430 getAuthPath；dist/core/auth-storage.js:17
 *   默认路径 join(getAgentDir(), 'auth.json')）
 * - models.json：自定义 provider/模型定义与 providers[].apiKey（dist/config.js:424-426
 *   getModelsPath；dist/core/model-runtime.js:76 默认路径）
 * - models-store.json：动态 provider catalog 缓存（dist/core/models-store.js:29 默认路径，
 *   model-runtime.js:80 落在 models.json 同目录）；条目经 FileAuthStorageBackend 存储、可能含
 *   key，属凭证类；缺失安全（parse 空 content 返回 {}），存在则拷以保证 catalog 与真实环境一致。
 * 刻意不带入：settings.json（global packages/extensions 清单是 npm 扩展注入源，缺失安全——
 * dist/core/settings-manager.js loadFromStorage 空 content 返回 {}）、extensions/（全局扩展
 * 自动发现目录）、skills/prompts/themes/tools/bin/sessions（等价性协议用例不涉及）。
 */
const CREDENTIAL_FILE_NAMES = ['auth.json', 'models.json', 'models-store.json'] as const

/** 把真实 agentDir 中的凭证文件原样拷入临时 agentDir（存在才拷；探测已保证至少一份在位）。 */
export function copyCredentialFiles(sourceAgentDir: string, targetAgentDir: string): void {
  for (const name of CREDENTIAL_FILE_NAMES) {
    const source = join(sourceAgentDir, name)
    if (!existsSync(source)) continue
    copyFileSync(source, join(targetAgentDir, name))
  }
}

/** provider 的 env API key 变量名（pi-ai env-api-keys.ts 映射表同形态：
 * 大写 + '-'→'_' + '_API_KEY' 后缀，如 xiaomi-token-plan-cn → XIAOMI_TOKEN_PLAN_CN_API_KEY）。 */
function providerEnvApiKey(provider: string): string {
  return `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`
}

type ReadJsonResult = {
  data?: unknown
  /** 文件不可读/不可解析时的错误（进 skip 理由，格式问题不静默） */
  error?: string
}

function readJsonFile(path: string): ReadJsonResult {
  try {
    return { data: JSON.parse(readFileSync(path, 'utf-8')) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 真实 pi（LLM turn）用例可用性探测：null = 就绪；非 null = skip 理由。
 *
 * 探测链对齐 pi 实际凭证解析（pi-mono auth-storage.ts hasAuth / model-registry 的静态 source）：
 * 1. env API key（environment source）
 * 2. `<agentDir>/auth.json` 的 provider 条目含非空 key（stored source，主路径——
 *    DEFAULT_MODEL 走 pi 内置 provider，本机凭证即此形态）
 * 3. `<agentDir>/models.json` providers[provider].apiKey（models_json_key source，补充路径）
 * OAuth 型凭证（token 刷新依赖 pi 运行时交互）不判定可用——只认静态可读的 api_key 形态。
 * 探测只读文件与 env，不发起网络请求，不触碰凭证值本身。
 */
function detectRealPiSkipReason(): string | null {
  if (!PI_PATH) return 'pi binary not found（which/where pi 未命中）'

  const forced = process.env[FORCE_SKIP_REAL_PI_ENV]
  if (forced === '1' || forced === 'true') {
    return `env ${FORCE_SKIP_REAL_PI_ENV}=${forced}（等价性基线双轨：本环境只跑凭证无关子集，完整基线含真实 LLM turn 跑在开发机，见 TEST-STRATEGY.md §4）`
  }

  const agentDir = piAgentDir()
  const checked: string[] = []

  // 1) env API key
  const envKey = providerEnvApiKey(DEFAULT_PROVIDER)
  const envValue = process.env[envKey]
  if (envValue && envValue.trim() !== '') return null
  checked.push(`env ${envKey}`)

  // 2) auth.json provider 条目（stored source，主路径）
  const authPath = join(agentDir, 'auth.json')
  const auth = readJsonFile(authPath)
  if (auth.data !== undefined) {
    const cred = (auth.data as Record<string, unknown>)[DEFAULT_PROVIDER]
    if (typeof cred === 'object' && cred !== null) {
      const key = (cred as { key?: unknown }).key
      if (typeof key === 'string' && key.trim() !== '') return null
      checked.push(`${authPath} 的 "${DEFAULT_PROVIDER}" 条目缺非空 key`)
    } else {
      checked.push(`${authPath} 无 "${DEFAULT_PROVIDER}" 条目`)
    }
  } else {
    checked.push(`${authPath}（${auth.error ?? '不存在或不可读'}）`)
  }

  // 3) models.json providers[provider].apiKey（models_json_key source）
  const modelsPath = join(agentDir, 'models.json')
  const models = readJsonFile(modelsPath)
  if (models.data !== undefined) {
    const providers = (models.data as { providers?: unknown }).providers
    const entry =
      typeof providers === 'object' && providers !== null
        ? (providers as Record<string, unknown>)[DEFAULT_PROVIDER]
        : undefined
    const apiKey = typeof entry === 'object' && entry !== null ? (entry as { apiKey?: unknown }).apiKey : undefined
    if (typeof apiKey === 'string' && apiKey.trim() !== '') return null
    checked.push(`${modelsPath} providers."${DEFAULT_PROVIDER}".apiKey`)
  } else {
    checked.push(`${modelsPath}（${models.error ?? '不存在或不可读'}）`)
  }

  return `pi 凭证不可用：DEFAULT_MODEL "${DEFAULT_MODEL}" 需要 provider "${DEFAULT_PROVIDER}" 的 API key，已探测 ${checked.join('；')} 均未命中。真实 LLM turn 用例 skip（mock / fixture 重放子集照跑），完整等价性基线请在凭证在位的开发机运行（TEST-STRATEGY.md §4 等价性双轨）`
}

/** 凭证探测结果（模块顶层；本模块只被 REAL 轨消费方显式 import，顶层执行即按需探测）：
 * null = binary + 凭证双就绪；非 null = skip 理由（binary 缺席 / 凭证缺失 / env 强制三态可分辨）。 */
export const REAL_PI_SKIP_REASON: string | null = detectRealPiSkipReason()

/** 真实 pi（LLM turn）用例可运行。引用方一律 `import { REAL_PI_READY } from './real-pi-gate.js'`
 * + `describe.skipIf(!REAL_PI_READY)` 包裹（取代只判 binary 的旧 `!PI_PATH` 条件——pi binary
 * 在 CI 可达但凭证不可达）。 */
export const REAL_PI_READY: boolean = REAL_PI_SKIP_REASON === null

if (!REAL_PI_READY) {
  // skip 理由显式可见：模块加载时输出（每个引用文件一次）+ describe 名注入（见各测试文件）
  console.warn(`[equivalence] 真实 pi（LLM turn）用例 skip：${REAL_PI_SKIP_REASON}`)
}
