/**
 * Preset 域 —— pi 启动预设列表 / 默认预设读取 / 设置默认预设。
 *
 * 设计文档：docs/architecture/pi-launch-presets.md
 *
 * 依赖方向：transport + pending（经 request helper 的 command 统一发送 ClientMessage 并关联 Promise）。
 * preset 域无 server-push 广播（protocol.ts 不含 preset.* ServerMessageType），全部是按需 RPC：
 * - list：拉全部预设（内置 + 自定义），reply { presets } 解包 .presets。
 * - getDefault：拉全局默认预设 id，reply { presetId } 解包 .presetId。
 * - setDefault：设全局默认预设（写 pi-presets.json），ack 型 reply void。
 *
 * 与 session 域同构（command helper 收敛 4 行 RPC 模板，调用方从 reply 解包字段）。
 */
import type { PiLaunchPreset } from '@xyz-agent/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/**
 * 列出全部 pi 启动预设（内置 + 自定义）。
 * reply payload 是 { presets }，解包 .presets。
 * type=preset.list（runtime PresetMessageHandler 处理）。
 */
export async function list(): Promise<PiLaunchPreset[]> {
  const reply = await command('preset.list', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.presets
}

/**
 * 读取全局默认预设 id（设计文档 §5.3，存 pi-presets.json defaultPresetId）。
 * reply payload 是 { presetId }，解包 .presetId。
 * 缺省值 'builtin:full'（runtime 在无配置时返回全工具模式）。
 */
export async function getDefault(): Promise<string> {
  const reply = await command('preset.getDefault', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.presetId
}

/**
 * 设置全局默认预设（写 pi-presets.json defaultPresetId）。
 * ack 型（reply void），全局默认预设变更无独立广播通道——调用方乐观更新本地 state 即可。
 * presetId 必须是已存在的预设 id（runtime 校验存在性，不存在抛错）。
 */
export function setDefault(presetId: string): Promise<void> {
  return command('preset.setDefault', { presetId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 创建自定义预设。
 * reply payload 是 { preset }（runtime 可能补全 id/order 等字段），解包 .preset。
 * runtime PresetService.savePreset 写入 pi-presets.json。
 */
export async function create(preset: PiLaunchPreset): Promise<PiLaunchPreset> {
  const reply = await command('preset.create', { preset }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.preset
}

/**
 * 更新预设（含内置预设的用户可编辑字段，如 toolMode/extensionMode 等）。
 * reply payload 是 { preset }，解包 .preset。
 * 内置预设的 name/id/builtin 字段不可改（runtime PresetGuardError 拦截）。
 */
export async function update(preset: PiLaunchPreset): Promise<PiLaunchPreset> {
  const reply = await command('preset.update', { preset }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.preset
}

/**
 * 删除自定义预设（内置预设不可删，runtime PresetGuardError 拦截）。
 * ack 型（reply void）。
 */
export function remove(presetId: string): Promise<void> {
  return command('preset.delete', { presetId }, RPC_BACKSTOP_TIMEOUT_MS)
}
