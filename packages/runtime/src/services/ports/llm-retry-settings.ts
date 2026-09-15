/**
 * LLM 重试配置域 port —— pi settings.json 的 retry 字段（设计 docs/design/llm-retry-settings.md §3.4）。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/pi-retry-settings.ts 实现（经
 * pi-settings-store 统一读写层 + retry 字段域 scope 访问 settings.json）。
 *
 * 为什么单独一个 port（同 IExtensionSettings 分域理由）：
 * settings.json 被多个域（model/extension/retry）读写，物理同文件、逻辑分区。
 * 给每个域一个窄 port，各实现都经 pi-settings-store（唯一读写层 + 跨进程锁 +
 * 字段域 merge），杜绝跨域 RMW 竞态（D17）。
 */

import type { LlmRetryConfig } from '@taiji/shared'

/** LLM 重试配置 port 的读写结果形状。 */
export interface LlmRetryConfigSnapshot {
  config: LlmRetryConfig
  /** 六已知键任一在文件 retry 域显式存在即 true（键在值坏仍计 true，D7 configured 语义）。 */
  configured: boolean
}

export interface ILlmRetrySettings {
  /** 读 retry 域：缺省键合并为 pi 默认值（D7），坏值回落默认、configured 如实标注。 */
  getRetryConfig(): LlmRetryConfigSnapshot
  /** 写 retry 域：先经 shared validateLlmRetryConfig 全量校验（D8），失败 ok:false + error 不落盘；
   *  成功经 updateSettingsFields('retry', …) 做 D3 嵌套键级 merge。 */
  setRetryConfig(config: LlmRetryConfig): { ok: boolean; error?: string }
}
