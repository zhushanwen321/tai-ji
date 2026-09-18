/**
 * PiRetrySettings — ILlmRetrySettings port 的 infra 实现。
 *
 * settings.json retry 域的读写全部经 pi-settings-store（唯一读写层 + 跨进程锁 + retry
 * 字段域 scope merge，D1a/D1b/D2）；读侧缺省合并/写侧 D3 嵌套 merge 的纯函数在
 * services/llm-retry-config-helper（infra 只做 I/O 编排，D17 三层）。
 */

import { join } from 'node:path'
import type { LlmRetryConfig } from '@taiji/shared'
import type { ILlmRetrySettings, LlmRetryConfigSnapshot } from '../../services/ports/llm-retry-settings.js'
import { mergeRetryConfig, resolveRetryConfig, validateRetryConfigForWrite } from '../../services/llm-retry-config-helper.js'
import { getPiAgentDir } from './pi-paths.js'
import { readSettings, setSettingsPath, updateSettingsFields, invalidateSettingsCache } from './pi-settings-store.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * ILlmRetrySettings 实现。
 * @param settingsDir pi agent 配置目录（<dataDir>/agent），settings.json 所在地。
 *                    测试可注入临时目录；生产默认 getPiAgentDir()。
 */
export class PiRetrySettings implements ILlmRetrySettings {
  constructor(settingsDir: string = getPiAgentDir()) {
    // 对齐 pi-settings-store 路径到同一 settings.json（与 PiExtensionSettings 同模式，
    // 保证各域在测试/生产读写同一文件，D17 单一所有者）。
    setSettingsPath(join(settingsDir, 'settings.json'))
  }

  getRetryConfig(): LlmRetryConfigSnapshot {
    // 读前失效缓存（同 PiExtensionSettings.getPackages 先例）：pi 子进程 set_auto_retry 直接
    // 落盘、不经本 store 写路径，读前失效保证 GUI 打开分组必见 pi 最新落盘值，不吃 3s TTL 陈旧值。
    // invalidate 只丢内存缓存不触盘；坏文件由 store schema guard 兜底 {}。
    invalidateSettingsCache()
    return resolveRetryConfig(readSettings().retry)
  }

  setRetryConfig(config: LlmRetryConfig): { ok: boolean; error?: string } {
    const validated = validateRetryConfigForWrite(config)
    if (!validated.ok) {
      return { ok: false, error: validated.error }
    }
    try {
      // 锁内 RMW + retry 字段域 merge；mutator 契约：纯内存改字段，禁 I/O / 嵌套 updateSettingsFields。
      // D3 嵌套 merge 在 mergeRetryConfig 纯函数内（基于锁内 draft 的最新 retry）。
      updateSettingsFields('retry', s => {
        s.retry = mergeRetryConfig(s.retry, config)
      })
      return { ok: true }
    } catch (err) {
      // 锁超时 / 写盘失败：同一错误信封（D10，设计 §3.3 错误规格表）。
      return { ok: false, error: toErrorMessage(err) }
    }
  }
}
