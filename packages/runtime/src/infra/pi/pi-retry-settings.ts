/**
 * PiRetrySettings — ILlmRetrySettings port 的 infra 实现。
 *
 * settings.json retry 域的读写全部经 pi-settings-store（唯一读写层 + 跨进程锁 + retry
 * 字段域 scope merge，D1a/D1b/D2）；读侧缺省合并/写侧 D3 嵌套 merge 的纯函数在
 * services/llm-retry-config-helper（infra 只做 I/O 编排，D17 三层）。
 *
 * [RT-3#12 去全局化] 本类不再持有 settingsDir 参数、构造不再调用 setSettingsPath——
 * 模块级写入目标被最后构造者决定是机械缺陷（生产实参与 getSettingsPath() 同值，
 * 该调用本是 no-op）。需要重定向 settings.json 的测试显式调用 setSettingsPath
 * （全仓测试惯例）；读不再 invalidateSettingsCache——JsonStore 指纹校验让 pi 子进程
 * 的直接落盘（set_auto_retry）在下一次 read 的 stat 失配中立即可见，全局失效只会
 * 绕空指纹缓存让每次读全量触盘。
 */

import type { LlmRetryConfig } from '@taiji/shared'
import type { ILlmRetrySettings, LlmRetryConfigSnapshot } from '../../services/ports/llm-retry-settings.js'
import { mergeRetryConfig, resolveRetryConfig, validateRetryConfigForWrite } from '../../services/llm-retry-config-helper.js'
import { readSettings, updateSettingsFields } from './pi-settings-store.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * ILlmRetrySettings 实现。settings.json 路径由 pi-settings-store 模块级单一所有者
 * 决定（D17；生产 = getSettingsPath()，测试重定向经 setSettingsPath 显式注入）。
 */
export class PiRetrySettings implements ILlmRetrySettings {
  getRetryConfig(): LlmRetryConfigSnapshot {
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
