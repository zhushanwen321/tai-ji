/**
 * pi 可执行文件定位（从 process-manager.ts 抽出为共享函数，E 方案 relay-registry 复用）。
 *
 * 两个消费方：ProcessManager（主 pi 会话，原调用点行为零变化）与 relay 注册表
 * （受托 spawn 真实 pi 子进程——与 pi-invocation 同款决策链的 runtime 侧落点，设计
 * §4.2）。搜索顺序与日志前缀保持抽取前原样。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { isPackaged } from '../../utils/runtime-env.js'
import { buildOutboundChildEnv } from '../spawn-env.js'

// Find pi executable path (cross-platform). Search order:
// Packaged: Resources/pi/pi-<plat>-<arch>
// Dev: apps/electron/resources/pi/pi-<plat>-<arch> (prepare-pi-resources.sh 产物)
//   fallback: PATH (which/where pi) → nvm → common locations
export function findPiExecutable(projectRoot: string): string {
  const platform = process.platform  // 'darwin' | 'win32' | 'linux'
  const arch = process.arch          // 'arm64' | 'x64'
  const binaryName = platform === 'win32'
    ? `pi-windows-${arch}.exe`
    : `pi-${platform}-${arch}`

  // Packaged mode: use bundled pi binary from resources
  if (isPackaged()) return findPackagedPi(binaryName)

  // Development mode: 优先用 resources/pi 里 prepare 的二进制（与打包版本统一）。
  // projectRoot = apps/electron/（dev 模式 app.getAppPath()，runtime 的 cwd），resources/pi 在其下。
  const devPi = findDevResourcesPi(projectRoot, binaryName)
  if (devPi !== undefined) return devPi

  // Development mode fallback: original discovery logic
  const isWindows = process.platform === 'win32'

  // 1. PATH → 2. nvm managed node installations → 3. common locations → bare 'pi'
  return findPiOnPath(isWindows)
    ?? findPiInNvm(isWindows)
    ?? findPiInCommonLocations(isWindows)
    // Fallback to bare 'pi' (will fail with clear error)
    ?? 'pi'
}

/** Packaged mode：Runtime's cwd = process.resourcesPath (set by runtime-manager.ts)。 */
function findPackagedPi(binaryName: string): string {
  const bundledPi = join(process.cwd(), 'pi', binaryName)

  if (!existsSync(bundledPi)) {
    throw new Error(
      `Bundled pi binary not found at ${bundledPi}. `
      + `Expected binary: ${binaryName}. `
      + 'The application installation may be corrupted.',
    )
  }

  console.log(`[process-manager] using bundled pi: ${bundledPi}`)
  return bundledPi
}

/** Dev mode：apps/electron/resources/pi 里 prepare 的二进制；缺失时 warn 并返回 undefined。 */
function findDevResourcesPi(projectRoot: string, binaryName: string): string | undefined {
  const devPi = join(projectRoot, 'resources', 'pi', binaryName)
  if (existsSync(devPi)) {
    console.log(`[process-manager] using dev resources pi: ${devPi}`)
    return devPi
  }
  console.warn(`[process-manager] resources/pi/${binaryName} not found, falling back to system PATH`)
  return undefined
}

/** PATH 探测（which/where pi；Windows 'where' may return multiple lines, take first）。 */
function findPiOnPath(isWindows: boolean): string | undefined {
  try {
    const whichCmd = isWindows ? 'where pi' : 'which pi'
    const which = execSync(whichCmd, {
      encoding: 'utf-8',
      // C-proc-09：出站契约构建器组装 env（which/where 只读探测，仅需 PATH）
      env: buildOutboundChildEnv({ parentEnv: process.env }),
    }).trim()
    // Windows 'where' may return multiple lines, take first
    const firstMatch = which.split('\n')[0].trim()
    if (firstMatch && existsSync(firstMatch)) return firstMatch
  } catch {
    // expected: pi not in PATH
    void 0
  }
  return undefined
}

/** nvm managed node installations 探测（nvm-windows 在 %APPDATA%\nvm，unix 在 ~/.nvm）。 */
function findPiInNvm(isWindows: boolean): string | undefined {
  if (isWindows) {
    // nvm-windows stores versions in %APPDATA%\nvm
    const nvmDir = join(process.env.APPDATA ?? '', 'nvm')
    try {
      const versions = readdirSync(nvmDir)
      for (const ver of versions) {
        const piPath = join(nvmDir, ver, 'pi.cmd')
        if (existsSync(piPath)) return piPath
        const piExe = join(nvmDir, ver, 'pi.exe')
        if (existsSync(piExe)) return piExe
      }
    } catch {
      // expected: directory not found, skip
      void 0
    }
  } else {
    const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
    try {
      const versions = readdirSync(nvmDir)
      for (const ver of versions) {
        const piPath = join(nvmDir, ver, 'bin', 'pi')
        if (existsSync(piPath)) return piPath
      }
    } catch {
      // expected: directory not found, skip
      void 0
    }
  }
  return undefined
}

/** Common locations 探测（npm global bin 等）。 */
function findPiInCommonLocations(isWindows: boolean): string | undefined {
  const commonPaths = isWindows
    ? [
      join(process.env.APPDATA ?? '', 'npm', 'pi.cmd'),
      join(process.env.APPDATA ?? '', 'npm', 'pi.exe'),
    ]
    : [
      '/usr/local/bin/pi',
      join(homedir(), 'bin', 'pi'),
    ]
  for (const p of commonPaths) {
    if (existsSync(p)) return p
  }
  return undefined
}
