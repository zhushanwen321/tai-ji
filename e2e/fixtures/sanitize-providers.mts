/**
 * tsx 子进程入口：调用 runtime 的真实 sanitizeInvalidProviders 并输出结果。
 *
 * 由 models-json-sanitize-real.spec.ts spawn 调用（node_modules/.bin/tsx）：
 *   MODELS_JSON_PATH=<tmp>/pi/agent/models.json tsx sanitize-providers.mts
 *
 * 为什么用 tsx 子进程而非在 spec 内直接 import：
 * - runtime 源码是 TS（type: module），且内部 import 用显式 .js 后缀指向 .ts 文件
 *   （如 './pi-paths.js' → pi-paths.ts），playwright 的单文件转译不处理这种解析
 * - tsx 是 runtime dev 模式同款运行时（esbuild 转译 + .js→.ts 后缀解析），行为一致
 *
 * 为什么 setModelsPath：sanitize 默认读生产路径（~/.taiji/...）的 models.json，
 * 必须显式指向测试临时目录，避免触碰真实用户数据（与 workspace-real.spec.ts 的
 * makePresetDataDir 隔离思路一致）。
 */
import { setModelsPath, sanitizeInvalidProviders } from '../../packages/runtime/src/infra/pi/pi-provider-store.ts'

const modelsPath = process.env.MODELS_JSON_PATH
if (!modelsPath) {
  throw new Error('MODELS_JSON_PATH env required (absolute path to the models.json to sanitize)')
}

setModelsPath(modelsPath)
const result = sanitizeInvalidProviders()
// 单行前缀标记，spec 侧正则提取（stdout 可能混入 tsx/runtime 的 console 输出）
console.log('SANITIZE_RESULT=' + JSON.stringify(result))
