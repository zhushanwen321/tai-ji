/**
 * 零特征共享池清单加载器。
 *
 * 权威源 = docs/testing/zero-mock-pool.json（SSOT，派生与判据说明见其 _meta）：
 * subagent-core / core / zcode-subagent-cli 三包的默认档测试按「零特征文件 →
 * shared project（isolate:false，模块图与 worker 跨文件复用）；其余 → isolated
 * project（每文件新进程）」分池。本模块只做「读权威源 + 按包过滤」的纯派生，不含
 * 任何文件清单——清单漂移由 scripts/check-zero-mock-pool.mjs 机器校验拦截（G1-G7）。
 *
 * 与 domain-exclusions.ts 的分工：domain-map 管「挂载渲染重型文件默认档排除 + 域触发」
 * （renderer/ui），本表管「node 环境三包的共享池准入」——两表无交集，互不消费。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 登记表的最小结构形状（只取本模块消费的字段）。 */
interface PoolRegistryShape {  // oe-exempt:20261028:test:登记表 JSON 的局部形状类型，与 domain-exclusions 同形态
  packages?: Record<string, unknown>
}

/**
 * 加载指定包的共享池文件清单（包内相对 posix 路径，如 'src/__tests__/x.test.ts'）。
 *
 * @param pkgRoot 包根绝对路径（vitest.config.ts 的 __dirname）
 * @param pkgName 仓库包目录名（'subagent-core' / 'core' / 'zcode-subagent-cli'，
 *        与登记表 packages 键一致）
 */
export function loadZeroMockPool(pkgRoot: string, pkgName: string): string[] {
  const registryPath = resolve(pkgRoot, '../../docs/testing/zero-mock-pool.json')
  const raw: unknown = JSON.parse(readFileSync(registryPath, 'utf-8'))
  const { packages } = raw as PoolRegistryShape
  const files = packages?.[pkgName]
  if (!Array.isArray(files)) {
    throw new Error(
      `[zero-mock-pool] 登记表 ${registryPath} 缺 packages.${pkgName}——跑 node scripts/check-zero-mock-pool.mjs --update 修复`,
    )
  }
  return files.filter((f): f is string => typeof f === 'string')
}
