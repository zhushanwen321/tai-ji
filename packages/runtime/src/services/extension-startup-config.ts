/**
 * Extension 启动配置声明机制（startup-config 统一初始化入口）。
 *
 * 背景：extension 的用户配置文件（<agentDir>/config/<pkg>-ext-config.json 等）此前
 * 各自惰性首建——permission 在首个 session 首个 turn 的 loadAndWatchConfig 里 ensure，
 * rename-session / smart-context 由 GUI 首次 RMW 时建，subagent-workflow config.json
 * 从不建。用户体验缺口：装好打开应用、一个 session 都没建时，配置文件不存在、
 * 不可发现、不可手编。
 *
 * 机制：extension 在 package.json `taiji.startupConfig` 数组里声明自己需要在
 * 启动时就绪的配置文件（相对 agentDir 的路径 + 静态默认内容），runtime 启动后台
 * 序列（startup-background-init）统一 ensure。
 *
 * 硬语义：
 * - **已存在 → 一律跳过，绝不覆盖**（用户配置神圣；含用户改过/改坏的文件——坏文件
 *   由各 extension 的 load 侧 normalize 回落处理，不是本机制职责）。
 * - 缺失 → 首建：2 空格缩进 + 尾换行 + mode 0o600（对齐 permission ensureConfigFile
 *   与 llm-shared saveConfig 的落盘形态）。首建无旧内容可损，直接 writeFileSync
 *   即可（原子写是为防覆盖进行中的旧内容，此处不存在）；runtime 与 extension 惰性
 *   ensure 并发首建的竞态最终一致（守护测试保证两侧默认内容深相等）。
 *
 * 注册物是**静态声明**而非初始化代码：app 启动时 pi 进程未起、extension 代码不在场，
 * runtime 能用的只有 extension 静态产物（package.json）。内容由代码派生的声明
 * （如 engines.json 来自 registry listEngines()）不适用本机制，走各自的双层机制
 * （静态声明兜底 + extension 到场覆写权威版，参照 U7b engines.json）。
 *
 * 声明与各包代码 DEFAULT 常量的等值由**各包守护测试**锁死
 * （startup-config-declaration.test.ts，防 package.json 声明与代码默认值漂移）。
 * 约定文档：docs/extensions/extension-conventions.md「启动配置声明」节。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { logger } from '../infra/logger.js'

/** 首建文件的 JSON 缩进（2 空格，与 extension 侧 llm-shared saveConfig 的 JSON_INDENT 一致——见文件头「首建形态」）。 */
const JSON_INDENT = 2

/** package.json `taiji.startupConfig` 单条声明的运行时形状（校验后）。 */
export interface DeclaredStartupConfigEntry {
  /** 目标文件路径，相对 pi agentDir（禁止绝对路径 / `..` 逃逸）。 */
  path: string
  /** 默认内容（plain object）。仅当目标文件不存在时写入。 */
  content: Record<string, unknown>
  /** 声明来源（extension 目录名），仅供日志归因。 */
  source: string
}

/** ensure 执行报告（供启动日志「失败要出声」）。 */
export interface StartupConfigEnsureReport {
  ensured: number
  skipped: number
  failed: number
}

/** 校验后的声明数组可能含被拒条目的 warn；read 阶段直接逐条 warn 跳过，不单独报告。 */

/**
 * 读取并校验全部 extension 的 startupConfig 声明。
 *
 * 逐目录逐条目独立容错：坏 package.json / 无 taiji 字段 / 声明非数组 / 条目
 * 形状非法 / 路径非法 → warn 跳过该条（或该包），不影响其余。纯函数（不做 IO 写）。
 */
export function readDeclaredStartupConfigs(extensionPaths: string[]): DeclaredStartupConfigEntry[] {
  const out: DeclaredStartupConfigEntry[] = []
  for (const dir of extensionPaths) {
    const pkgPath = join(dir, 'package.json')
    let pkg: unknown
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    } catch (e) {
      // 目录无 package.json（discovery 噪音）或坏 JSON：非错误，静默跳过
      if (existsSync(pkgPath)) {
        logger.warn(`[extension-startup-config] bad package.json, skipped: ${pkgPath} (${e instanceof Error ? e.message : String(e)})`)
      }
      continue
    }
    const taijiNs = (pkg as Record<string, unknown>)['taiji']
    if (typeof taijiNs !== 'object' || taijiNs === null) continue
    const declared = (taijiNs as Record<string, unknown>)['startupConfig']
    if (declared === undefined) continue
    if (!Array.isArray(declared)) {
      logger.warn(`[extension-startup-config] startupConfig is not an array, skipped: ${pkgPath}`)
      continue
    }
    const source = dir.split(sep).pop() ?? dir
    declared.forEach((raw, i) => {
      const entry = validateEntry(raw, source)
      if (entry) out.push(entry)
      else logger.warn(`[extension-startup-config] invalid startupConfig[${i}], skipped: ${pkgPath}`)
    })
  }
  // 跨包重复 path 声明：read 阶段去重保留首个（后到者被丢弃，不进 ensure、
  // 不计 skipped），warn 同时点名先到者（保留生效方）与后到者，辅助排查配置面误复制。
  const seen = new Map<string, string>()
  const deduped: DeclaredStartupConfigEntry[] = []
  for (const entry of out) {
    const firstSource = seen.get(entry.path)
    if (firstSource !== undefined) {
      logger.warn(`[extension-startup-config] duplicate startupConfig path '${entry.path}': keeping declaration of ${firstSource}, dropping ${entry.source}`)
      continue
    }
    seen.set(entry.path, entry.source)
    deduped.push(entry)
  }
  return deduped
}

/** 单条目形状校验：path 合法相对路径（无 .. 段、非绝对）+ content 为 plain object。 */
function validateEntry(raw: unknown, source: string): DeclaredStartupConfigEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const path = r['path']
  const content = r['content']
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return null
  // `..` 段拒绝：按分隔符切分判断（同时覆盖 'a/../../b' 形态）。win 盘符（C:\b）在
  // win32 被 isAbsolute 拦截；POSIX 上 C:\b 非绝对路径，会作为字面文件名通过本层，
  // 由 ensure 阶段的 resolve 界内复核兜住（无逃逸，仅落在 agentDir 内的怪名文件）。
  const segments = path.split(/[\\/]/)
  if (segments.includes('..')) return null
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null
  return { path, content: content as Record<string, unknown>, source }
}

/**
 * 统一 ensure 全部声明条目：已存在跳过（绝不覆盖），缺失首建。
 *
 * 每条目独立 try/catch：单条失败（如目录不可写）warn 后继续，不阻塞其余，
 * 返回报告供调用方出声（failed > 0 时启动日志升级为 warn）。
 *
 * @param extensionPaths extension 目录列表（extensionService.getExtensionPaths()）
 * @param agentDir pi agent 目录（getPiAgentDir()；显式注入便于测试隔离）
 */
export function ensureDeclaredStartupConfigs(
  extensionPaths: string[],
  agentDir: string,
): StartupConfigEnsureReport {
  const report: StartupConfigEnsureReport = { ensured: 0, skipped: 0, failed: 0 }
  for (const entry of readDeclaredStartupConfigs(extensionPaths)) {
    // resolve 后必须仍在 agentDir 内（path 校验的双保险：join 结果理论上已在界内，
    // 此处防御性复核，防止未来校验逻辑变动引入逃逸）
    const target = resolve(join(agentDir, entry.path))
    if (target !== resolve(agentDir) && !target.startsWith(resolve(agentDir) + sep)) {
      report.failed++
      logger.warn(`[extension-startup-config] path escapes agentDir, rejected: ${entry.source} -> ${entry.path}`)
      continue
    }
    try {
      if (existsSync(target)) {
        report.skipped++
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      // flag 'wx'（存在即拒）：把「绝不覆盖」从 check-then-act 升级为结构性保证——
      // existsSync 与 write 之间被并发首建（extension 惰性 ensure 同窗口）时 EEXIST
      // 而非覆盖。EEXIST + target 此刻存在 = 另一写者已建同内容文件，等价跳过计
      // skipped；mkdir 的 EEXIST（父路径被同名文件占住，target 不存在）归 failed。
      writeFileSync(target, `${JSON.stringify(entry.content, null, JSON_INDENT)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
      report.ensured++
    } catch (e) {
      const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined
      if (code === 'EEXIST' && existsSync(target)) {
        report.skipped++
        continue
      }
      report.failed++
      if (code === 'EEXIST') {
        // EEXIST 但 target 复查不存在：broken symlink 占位（O_EXCL 拒写穿符号链接，
        // POSIX 规定）或并发建后即删的瞬态——异常态出声，下次启动自愈重试
        logger.warn(`[extension-startup-config] ensure hit EEXIST but target missing (broken symlink or create-then-delete race), will retry next boot: ${entry.source} -> ${entry.path}`)
      } else {
        logger.warn(`[extension-startup-config] ensure failed: ${entry.source} -> ${entry.path} (${e instanceof Error ? e.message : String(e)})`)
      }
    }
  }
  return report
}
