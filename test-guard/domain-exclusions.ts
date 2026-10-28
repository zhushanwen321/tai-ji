/**
 * 默认档挂载渲染测试排除清单加载器。
 *
 * 权威源 = docs/testing/domain-map.json（域 → 测试文件清单，round6 Wave2 范围收缩）：
 * 挂载渲染重型测试默认档（pnpm test）不收集不装载，改哪个功能域由
 * scripts/run-domain-tests.mjs <domain> 按域触发（该脚本设置 TAIJI_TEST_DOMAIN
 * 并按域传显式文件清单）。本模块只做「读权威源 + 按包过滤」的纯派生，不含任何
 * 文件清单——清单漂移由 scripts/check-domain-map.mjs 机器校验拦截。
 *
 * 门控语义：TAIJI_TEST_DOMAIN 设置时返回空数组（域触发档不排除，配合 run 脚本的
 * 显式文件清单精确选中）；未设置（默认档）返回本包被迁出文件的包内相对路径，
 * 供 vitest.config.ts 并入 test.exclude（必须与 configDefaults.exclude 合并，
 * 不能整体替换——否则放开 node_modules/dist 默认排除）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 域触发档的门控 env（run 脚本与 config 两侧同名引用）。 */
export const DOMAIN_GATE_ENV = 'TAIJI_TEST_DOMAIN'

/** domain-map.json 的最小结构形状（只取本模块消费的字段）。 */
interface DomainMapShape {  // oe-exempt:20261027:test:
  domains?: Record<string, { files?: unknown }>
}

/**
 * 加载指定包在默认档要排除的测试文件（包内相对 posix 路径，如 'src/...'）。
 *
 * @param pkgRoot 包根绝对路径（vitest.config.ts 的 __dirname）
 * @param pkgPrefix 仓库根起算的包路径前缀（'packages/renderer/' / 'packages/ui/'），
 *        与 domain-map.json 的文件条目前缀形态一致
 */
export function loadDomainExclusions(pkgRoot: string, pkgPrefix: string): string[] {
  if (process.env[DOMAIN_GATE_ENV]) return []
  const mapPath = resolve(pkgRoot, '../../docs/testing/domain-map.json')
  const raw: unknown = JSON.parse(readFileSync(mapPath, 'utf-8'))
  const { domains } = raw as DomainMapShape
  const out: string[] = []
  for (const entry of Object.values(domains ?? {})) {
    for (const file of entry.files ?? []) {
      if (typeof file === 'string' && file.startsWith(pkgPrefix)) {
        out.push(file.slice(pkgPrefix.length))
      }
    }
  }
  return out
}
