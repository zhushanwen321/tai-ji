import semver from 'semver'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** 获取 taiji 宿主版本号。优先使用构建时注入的环境变量，回退到 cwd 向上查找 package.json。 */
export function getAppVersion(): string {
  // tsup define 在构建时注入（tsup.config.ts）
  const injected = process.env.TAIJI_AGENT_VERSION
  if (injected) return injected

  // 回退：开发模式下从 package.json 读取
  try {
    let dir = process.cwd()
    const MAX_PARENT_LEVELS = 10
    for (let i = 0; i < MAX_PARENT_LEVELS; i++) {
      const pkgPath = path.join(dir, 'package.json')
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
        return pkg.version
      } catch {
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    return '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export interface CompatibilityResult {
  compatible: boolean
  reason?: string
}

export function checkPluginCompatibility(engineRange: string): CompatibilityResult {
  if (!engineRange || engineRange === '*') {
    return { compatible: true }
  }

  if (!semver.validRange(engineRange)) {
    return { compatible: false, reason: `Invalid version range: "${engineRange}"` }
  }

  const appVersion = getAppVersion()
  if (!semver.satisfies(appVersion, engineRange)) {
    return { compatible: false, reason: `Requires taiji ${engineRange}, current is v${appVersion}` }
  }

  return { compatible: true }
}
