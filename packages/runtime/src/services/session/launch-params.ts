/**
 * launch 参数组装域（S6 迁出，纯函数族）：pi 进程 spawn 前的启动参数组装——
 * skill/extension 路径解析、替换系统提示词、launch preset 解析、preset + override
 * 的 client options 子集构建。原实现分居 Facade 4 方法（getSkillPaths /
 * getExtensionPaths / getReplaceSystemPrompt / getLaunchPresetOptions）与 lifecycle
 * 私有 buildPresetClientOptions，同概念域合并（消费方：lifecycle create/restore/fork
 * 三处 spawn 路径，经 ILifecycleSessionOps 委托到达——窄接口声明不变）。
 *
 * 零私有状态：全部依赖经参数传入（configStore / extensionService / configService /
 * presetService），故为模块级纯函数而非类。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { expandHome } from '../../utils/path-utils.js'
import type { ThinkingLevel } from '@taiji/shared'
import { BUILTIN_PRESET_IDS, PI_THINKING_LEVELS, PRESET_FALLBACK_ENV_KEYS } from '@taiji/shared'
import type { IExtensionService, IConfigService } from '../../interfaces.js'
import type { IConfigStore } from '../ports/config.js'
import type { PresetService, PresetResolution } from '../preset-service.js'
import { BUILTIN_EXTENSIONS_MISSING } from '../../utils/errors.js'

/**
 * thinkingLevel 合法值集合（S-RT-5；W2 值域 SSOT 派生，A-03 修复）。
 *
 * 值 = shared PI_THINKING_LEVELS（pi 0.84.1 全集 7 值，锚点见 pi-preset.ts），
 * 不再手写数组——手写值域曾缺 'max' 导致 composer 最高档被静默丢弃。
 * 用 readonly 数组做运行时校验：buildPresetClientOptions 透传 thinkingOverride 到
 * pi 前先校验，非法值 warn 后忽略（不传给 pi，避免 pi 报错或行为异常）。
 *
 * 「shared 常量 ↔ pi-protocol PiThinkingLevel」的编译期双向防漂移锁随 S6 迁至
 * pi-protocol.ts 的 ThinkingLevelDriftGuard（比对双方的概念自然家；本文件不再
 * import Pi 侧类型——check_pi_type_leak 边界规则）。
 */
const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = PI_THINKING_LEVELS

/**
 * 收集有效的 skill 路径（pi-provider-store + 存在性过滤）。
 *
 * FR-1（cw-2026-07-21-scan-project-agents-skills）：相对路径按 session cwd resolve 成绝对路径再 existsSync filter。
 * 修复现状 bug：原实现忽略 cwd，discovery.json 中的相对路径（如 .agents/skills）
 * 按 runtime 进程 cwd（app.getAppPath/resourcesPath）解析 → 在该 cwd 下不存在被 filter 掉 →
 * pi 启动 --skill 参数为空 → pi 加载不到项目 skill。
 * resolve 基准是 session cwd（用户当前项目），返回绝对路径避免 pi 侧再次错位。
 *
 * R1（review fix）：~/xxx 家目录前缀先 expandHome 展开（与 W2 loadSkills 对称）。
 * 否则 isAbsolute('~/...') false → resolve(cwd, '~/...') = <cwd>/~/... 错位 → filter 掉全局 skill。
 * discovery.json 实际配置 ~/.pi/agent/skills、~/.agents/skills 等带 ~ 前缀，必须展开。
 */
export function resolveSkillPaths(configStore: IConfigStore, cwd: string): string[] {
  const normalize = (p: string): string => {
    const expanded = expandHome(p)
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
  }
  return configStore.getSkillPaths().filter((p) => {
    const resolved = normalize(p)
    if (existsSync(resolved)) {
      return true
    }
    console.warn(`[session-service] skill path not found, skipping: ${p} (resolved: ${resolved})`)
    return false
  }).map(normalize)
}

/**
 * 收集有效的 extension 路径（经 ExtensionService）。cwd 用于解析相对的 discovery extension 目录。
 *
 * 打包产物断链（builtin staged 目录缺失）不可降级：rethrow 贯通 resolver 的
 * fail-fast（electron-build R3-S1）——吞掉会让无 presetId 的 session 启动路径
 * pi 无 --extension 静默启动（system-prompt 注入 / msg-id 映射无声失效），
 * 与 preset 路径（resolveLaunchPresetOptions 全链无 catch）语义对齐，错误冒泡到
 * session handler 可见。其余意外错误维持降级（旧版兼容：空列表不阻断会话）。
 */
export async function resolveExtensionPaths(extensionService: IExtensionService, cwd?: string): Promise<string[]> {
  try {
    return await extensionService.getExtensionPaths(cwd)
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === BUILTIN_EXTENSIONS_MISSING) throw e
    console.warn('[session-service] getExtensionPaths failed:', e)
    return []
  }
}

/** 当前生效的替换系统提示词（委托 ConfigService.getReplaceSystemPrompt；未注入时 undefined，pi 走默认系统提示词）。 */
export function resolveReplaceSystemPrompt(configService: IConfigService | null | undefined): string | undefined {
  return configService?.getReplaceSystemPrompt()
}

/**
 * 模式 replace 段是否「启用且有实义文本」。
 *
 * 空白判定用 trim（与 spawn-args 的 `?.trim()` 拼装门同口径）：若只按 `!== ''` 判非空，
 * 一个「enabled + 纯空白」的模式段会返回空白串 → spawn-args 的 trim 门将其丢弃 →
 * 替换无值可传且**全局值已被压掉**，等价于「替换为空」的静默失效。故空白视为「未配置」，
 * 回落下一步（全局 / pi 默认）。
 */
function hasEffectivePromptSegment(segment: { enabled: boolean; prompt: string } | undefined): segment is { enabled: boolean; prompt: string } {
  return segment !== undefined && segment.enabled && segment.prompt.trim() !== ''
}

/**
 * 模式级替换系统提示词的取值 helper（D3 优先级：模式 replace > 全局 replace > pi 默认）。
 *
 * 规则集中这一处，create/restore/fork 三处 spawn 共用（避免三处各写一份优先级判断）。
 * 返回 undefined 即「无替换」——pi 走自带系统提示词。
 *
 * 取值与 argv 拼装的职责边界：本 helper 只做「选谁」，**不做** pi 二义陷阱的 `\n` 前缀处理
 * ——前缀统一落在 spawn-args 的 argv 拼装处（`toInlinePromptValue`），模式值与全局值两条
 * 来路同一处加前缀，不会出现「漏了某条通道」。
 */
export function resolveEffectiveSystemPrompt(
  resolution: PresetResolution | undefined,
  globalReplace: string | undefined,
): string | undefined {
  const segment = resolution?.prompt?.replace
  return hasEffectivePromptSegment(segment) ? segment.prompt : globalReplace
}

/**
 * 模式级追加系统提示词的取值 helper（D3 链序：模式 append 段无全局对手——全局追加由
 * `@zhushanwen/pi-system-prompt` 扩展独立处理，两者共存不互斥）。
 *
 * 未启用 / 空白 / 未配置 → undefined（不拼 `--append-system-prompt`）。
 * `\n` 前缀处理同 resolveEffectiveSystemPrompt，落在 spawn-args 拼装处。
 */
export function resolveAppendSystemPrompt(resolution: PresetResolution | undefined): string | undefined {
  const segment = resolution?.prompt?.append
  return hasEffectivePromptSegment(segment) ? segment.prompt : undefined
}

/**
 * 单条 extension 路径是否指向 subagent-workflow（in-flight 上报方，D5 ① per-session
 * 可用性判定的谓词）。
 *
 * 匹配口径 = 既有判定先例（session-records.readDeclaredEnginesFallback 定位安装目录）：
 * 后缀或完整路径段匹配，覆盖 npm 名 `pi-subagent-workflow`（staged / live env 布局）
 * 与 dev 源码目录 `extensions/universal/subagent-workflow` 两种路径形态。
 */
export function isSubagentWorkflowExtensionPath(p: string): boolean {
  return p.endsWith('subagent-workflow') || p.includes(`${sep}subagent-workflow`)
}

/**
 * spawn 注入列表是否含 subagent-workflow（crash-forensics §3.3 D5 ①：injected 的判定
 * 谓词——「该 session 实际注入了 subagent-workflow」）。输入 = spawn 时刻的
 * getExtensionPaths / preset 解析结果，**不做**全局配置快照重查（mid-session 禁用窗口
 * 语义，见 inflight-mirror.ts 文件头）。
 */
export function hasSubagentWorkflowExtension(paths: readonly string[]): boolean {
  return paths.some(isSubagentWorkflowExtensionPath)
}

/**
 * 按 launch presetId 解析 pi 启动参数（委托 PresetService.resolve）。
 *
 * 供 session-lifecycle 的 create/restoreSession/forkSession 调用（runtime-lifecycle-integration slice）。
 * 返回 undefined 仅当 presetService 未注入（组合根未构造，理论上不会发生）。
 *
 * 找不到指定 preset 时 fallback 到 builtin:full（设计文档 §4.3 runtime 锁定）：
 * preset 被删 / 历史 session 的 presetId 失效时，用全工具模式兜底而非放弃 preset 解析。
 * builtin:full 永在（DEFAULT_PRESETS 保证），故理论上不会二次 fallback 失败。
 *
 * 设计文档 §8.1 + §4.3：session-lifecycle 拿到 PresetResolution 后覆盖现有
 * resolveExtensionPaths/resolveSkillPaths 结果，并追加 toolArgs/flags 到 pi args。
 */
export async function resolveLaunchPresetOptions(
  presetService: PresetService | null | undefined,
  presetId: string,
  cwd: string,
): Promise<PresetResolution | undefined> {
  if (!presetService) return undefined
  let preset = presetService.getPreset(presetId)
  let fellBackFromPresetId: string | undefined
  if (!preset) {
    // 找不到 preset 时 fallback 到 builtin:full（设计文档 §4.3）。
    // 避免返回 undefined 让 session-lifecycle 退到无 tool/thinking args 的旧行为。
    // F1（设计 `.tmp/tech-design/mode-system-composer-density.md` §7.5 E4）：回落事实必须
    // 随 resolution 上抛——restore 路径据此向 renderer 披露「模式已删除，本次以全工具模式启动」。
    // 只报「已删除」不报后果即 E4 判定前提未达成。
    fellBackFromPresetId = presetId
    preset = presetService.getPreset(BUILTIN_PRESET_IDS.FULL)
    if (!preset) return undefined  // 理论上不会发生（builtin 永在）
  }
  // `resolve` 是 async（PresetService.resolve → Promise<PresetResolution>）：必须 await，
  // 否则回落分支的 `{ ...resolution }` 展开 Promise 得空壳对象，静默丢掉 toolArgs/flags/
  // extensionPaths/prompt 等全部字段（回落会话实际拿不到全工具参数，而披露行仍称「以全工具
  // 模式启动」→ 假陈述）。无回落分支在 async 调用方 await 后恰好正确，故该缺陷长期未暴露。
  const resolution = await presetService.resolve(preset, cwd)
  // 无回落时保持对象同一性（既有测试/调用方断言 `.toBe(resolution)`；回落才新建对象附加事实）。
  return fellBackFromPresetId === undefined ? resolution : { ...resolution, fellBackFromPresetId }
}

/**
 * 模式回落事实 → pi 子进程出站 env（F1b，设计 `.tmp/tech-design/mode-system-composer-density.md`
 * §7.5 E4 的 trace 披露面）。
 *
 * `resolveLaunchPresetOptions` 检测到悬空 presetId 时在 resolution 上附
 * `fellBackFromPresetId`，本 helper 把它翻译成 pi 子进程 env：回落时 FROM=原悬空 id /
 * TO=`builtin:full`；**未回落时两键写空串**而非省略——出站基座是「白名单过滤后的父 env」，
 * 父 env 的 `TAIJI_` 前缀键会被继承，空串覆盖可显式清除陈旧值（避免非回落 session 被
 * 误披露为已回落）。两键恒存在让 extension 侧读取形状稳定。
 *
 * 返回值直接作为 `RpcClientOptions.env` 的 extras（经 ProcessManager.createSession →
 * rpc-client.start → buildPiOutboundEnv → buildOutboundChildEnv，C-proc-09 出站契约）。
 * 纯函数、无副作用。
 */
export function buildPresetFallbackEnv(resolution: PresetResolution | undefined): Record<string, string> {
  const from = resolution?.fellBackFromPresetId
  return {
    [PRESET_FALLBACK_ENV_KEYS.FROM]: from ?? '',
    [PRESET_FALLBACK_ENV_KEYS.TO]: from === undefined ? '' : BUILTIN_PRESET_IDS.FULL,
  }
}

/** buildPresetClientOptions 的返回形状：pi createSession options（preset 相关字段）的子集（全部可选）。 */
export interface PresetClientOptions {
  tools?: string[]
  excludeTools?: string[]
  noTools?: boolean
  noSkills?: boolean
  noContextFiles?: boolean
  model?: string
  thinkingLevel?: ThinkingLevel
}

/**
 * 构建 create/restoreSession/forkSession 三处共用的 preset + override client options 子集（S-RT-4）。
 *
 * 三处原先用完全相同的 spread 模式（toolArgs/flags/modelOverride/thinkingOverride 条件 spread），
 * 抽 helper 消除重复，保证三处 preset 字段映射逻辑完全一致（避免一处改动另两处漏改）。
 *
 * 输入：
 *  - resolution：PresetService.resolve 的结果（可能 undefined → 返回空对象，仅 override 生效）。
 *  - modelOverride / thinkingOverride：D5 契约快照化语义——landing 新建路径恒传 renderer
 *    resolveLaunchConfig 的解析终值（不再缺省，透传即生效，preset 同名字段档对 landing 不可达）；
 *    `override > preset 字段 > 全局默认` fallback 链整体保留，服务不经 landing 解析层的入口
 *    （fork / restore / agent-managed create——session-manager-handler.ts 的 create，override
 *    可缺省走 preset/默认档）。C-RL-6 优先级（override > preset 同名字段）不变。
 *
 * 输出：pi createSession options 的子集（preset 相关字段），调用方再与 skillPaths/extensionPaths/systemPrompt
 * 等基础字段合并 spread 进 createSession。返回的子集字段都是可选的，undefined 字段不出现（条件 spread）。
 *
 * S-RT-5：thinkingOverride 校验合法值，非法值 warn 后忽略（不透传给 pi）。
 */
/**
 * S-RT-5：thinkingLevel 校验合法值。Landing 传入与 preset 字段都可能是非法值
 *（如前端未约束 / preset JSON 手改），透传给 pi 会触发 pi 报错或静默忽略，统一在此拦截。
 * 非法值 warn 后忽略（返回 undefined，不透传给 pi）。
 */
function resolveEffectiveThinking(rawThinking: string | undefined): ThinkingLevel | undefined {
  // widening cast（与 shared isPiLaunchPreset 的 TOOL_MODES 同款惯例）：includes 收窄参数类型，
  // 此处本意就是对任意 string 做白名单判定。
  if (rawThinking !== undefined && (VALID_THINKING_LEVELS as readonly string[]).includes(rawThinking)) {
    return rawThinking as ThinkingLevel
  }
  if (rawThinking !== undefined) {
    console.warn(`[lifecycle] invalid thinking level: ${rawThinking}, ignored`)
  }
  return undefined
}

export function buildPresetClientOptions(
  resolution: PresetResolution | undefined,
  modelOverride: string | undefined,
  thinkingOverride: string | undefined,
): PresetClientOptions {
  // C-RL-6 优先级（设计文档 §5.2）：Landing 传入 > preset 字段。
  // model 不校验值域（provider/modelId 形式自由，pi 报错由用户感知）。
  const effectiveModel = modelOverride ?? resolution?.modelOverride
  const effectiveThinking = resolveEffectiveThinking(thinkingOverride ?? resolution?.thinkingLevel)

  return {
    // preset 字段（resolution 存在时才设，条件 spread 避免 undefined 覆盖默认）
    ...(resolution?.toolArgs.tools && { tools: resolution.toolArgs.tools }),
    ...(resolution?.toolArgs.excludeTools && { excludeTools: resolution.toolArgs.excludeTools }),
    ...(resolution?.toolArgs.noTools && { noTools: true }),
    ...(resolution?.flags.noSkills && { noSkills: true }),
    ...(resolution?.flags.noContextFiles && { noContextFiles: true }),
    ...(effectiveModel && { model: effectiveModel }),
    ...(effectiveThinking && { thinkingLevel: effectiveThinking }),
  }
}

/**
 * L2 对账探针（D7/E6，observability）：create 入参 override 与 pi get_state 读回生效值的
 * 比对，不一致时输出单行结构化 warn（消费点 = readBackCreateState，每 create 恰一次 →
 * 速率上限 ≤1 行/create 天然满足）。
 *
 * 不设硬断言不抛错：pi pattern 引擎静默换模/钳制是合法行为（读回播种已让显示收敛真值），
 * 探针目的只是让「renderer 请求的 vs pi 实际生效的」漂移可 grep 排查（E6 恢复指引）。
 *
 * 字段语义：requested 侧 undefined 跳过该字段——create 未传 override 不比（preset 档/
 * 全局默认档由 C-RL-6 兜底链解析，不在对账范围，agent-managed create 即此形态）；
 * 两侧皆有值且不等才算 mismatch（读回侧缺失无法断定漂移，不记）。
 */
export function warnLaunchEffectiveMismatch(
  requested: { model?: string; thinkingLevel?: string },
  effective: { modelId?: string; thinkingLevel?: string },
): void {
  const modelMismatch =
    requested.model !== undefined && effective.modelId !== undefined && requested.model !== effective.modelId
  const thinkingMismatch =
    requested.thinkingLevel !== undefined && effective.thinkingLevel !== undefined &&
    requested.thinkingLevel !== effective.thinkingLevel
  if (!modelMismatch && !thinkingMismatch) return
  console.warn(
    `[launch-config] effective mismatch: requested=${requested.model},${requested.thinkingLevel} ` +
    `effective=${effective.modelId},${effective.thinkingLevel}`,
  )
}
