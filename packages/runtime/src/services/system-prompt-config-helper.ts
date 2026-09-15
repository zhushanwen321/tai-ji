/**
 * System prompt 配置读写 helper（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 职责：~/.taiji/system-prompt.json 的读写（独立文件，不复用 config.json）+
 * replace/append 两段提示词的长度校验。插件读此文件热生效（replace 启动期注入、
 * append 每轮 before_agent_start 注入）。
 *
 * 抽出原因：config-service.ts 超 ESLint max-lines(500)。本模块含 system prompt
 * 相关方法，移到本模块后 ConfigService 仅保留单行委托，行为 / 签名 / import 路径零变化
 *（复用 worktree-config-helper 的 accessors 注入模式，纯函数经 configDir 参数注入）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_PROMPT_MAX_LENGTH, type SystemPromptConfig } from '@taiji/shared'
import { atomicWrite } from '../utils/fs-utils.js'
import { defaultSystemPromptConfig, mergeSystemPromptConfig } from './config-merge-helpers.js'
import { JSON_INDENT, uniqueTmpSuffix } from './app-config-store.js'

/** system-prompt.json 路径（configDir 经参数注入，原 ConfigService.systemPromptPath 逐字搬迁）。 */
function systemPromptPath(configDir: string): string {
  return join(configDir, 'system-prompt.json')
}

/**
 * 读取 system-prompt.json。文件不存在返回默认配置（corrupted:false）；JSON 损坏返回默认配置（corrupted:true）。
 * 纯函数：configDir 经参数注入（原 ConfigService.getSystemPromptConfig 逐字搬迁）。
 */
export function getSystemPromptConfig(configDir: string): { config: SystemPromptConfig; corrupted: boolean } {
  const cp = systemPromptPath(configDir)
  if (!existsSync(cp)) {
    return { config: defaultSystemPromptConfig(), corrupted: false }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(cp, 'utf-8'))
  } catch {
    return { config: defaultSystemPromptConfig(), corrupted: true }
  }
  return { config: mergeSystemPromptConfig(raw), corrupted: false }
}

/**
 * 写入 system-prompt.json。replace/append prompt 超长（>SYSTEM_PROMPT_MAX_LENGTH）返回 ok:false + error，不写盘。
 * 纯函数：configDir 经参数注入（原 ConfigService.setSystemPromptConfig 逐字搬迁）。
 */
export function setSystemPromptConfig(configDir: string, config: SystemPromptConfig): { ok: boolean; error?: string } {
  if (config.replace.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `replace prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH})`,
    }
  }
  // append 同样校验长度：append 虽不走 argv（无 Windows 32k 限制），但无上限会导致
  // 每轮拼进 systemPrompt 的 token 失控。复用同一上限保持双卡 UX 一致。
  if (config.append.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `append prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH})`,
    }
  }
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  // 用唯一 tmp 后缀避免并发 setSystemPromptConfig 撞固定 .tmp 文件
  // （两次并发写入会共用同一 system-prompt.json.tmp，后写的 writeFileSync 覆盖前者数据）。
  atomicWrite(
    systemPromptPath(configDir),
    JSON.stringify(config, null, JSON_INDENT),
    uniqueTmpSuffix(),
  )
  return { ok: true }
}

/**
 * 返回当前生效的替换提示词（replace.enabled && prompt 非空白时），否则 undefined。
 * rpc-client spawn 时透传。纯函数：configDir 经参数注入（原 ConfigService.getReplaceSystemPrompt 逐字搬迁）。
 */
export function getReplaceSystemPrompt(configDir: string): string | undefined {
  const { config } = getSystemPromptConfig(configDir)
  if (config.replace.enabled && config.replace.prompt.trim() !== '') {
    // 防御性长度兜底：setSystemPromptConfig 写入期已校验上限，但 replace/append 启用态切换
    // 或外部直接篡改 system-prompt.json 可能写入超长 prompt。原样返回会让超长 prompt 进
    // pi spawn argv，触发 Windows 32k 命令行截断。降级为不注入（返回 undefined）比注入
    // 残缺内容更安全。错误信息风格与 setSystemPromptConfig 一致。
    if (config.replace.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
      console.warn(
        `[config-service] replace prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH}), falling back to undefined (replace disabled this run)`,
      )
      return undefined
    }
    return config.replace.prompt
  }
  return undefined
}
