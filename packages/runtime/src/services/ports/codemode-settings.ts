/**
 * Codemode 开关域 port —— pi settings.json 的 defaultTools 字段（tools 域）。
 *
 * 🔒 三层架构：services 定义 port，infra/pi-codemode-settings.ts 的 PiCodemodeSettings 实现（组合
 * infra/pi/pi-codemode-settings.ts 字段域函数 + pi-settings-store 损坏检测单点）。
 *
 * 为什么单独一个 port（同 ILlmRetrySettings 分域理由）：
 * settings.json 被多个域（model/skills/extension/retry/tools）读写，物理同文件、
 * 逻辑分区。tools 域的读写编排 + 损坏错误态映射收在窄 port 后，ConfigService 与
 * transport handler 不直接触碰字段域函数与损坏检测单点（A1 判定入口唯一）。
 *
 * 返回形状与 shared WS 协议类型直接对齐（codemode 设计 D1/A1）：
 * get 回 CodemodeEnabledResult（损坏错误态经 corruption 字段表达），set 回
 * CodemodeSetEnabledResult 两态信封（损坏拒入不走 throw / error envelope——协议
 * 定死错误数据在信封内，renderer 以 corruption 字段渲染 D3 错误态）。
 */

import type { CodemodeEnabledResult, CodemodeSetEnabledResult } from '@taiji/shared'

export interface ICodemodeSettings { // oe-exempt:20261004:framework:services port 契约接口（infra PiCodemodeSettings 实现后组合根注入，PiRetrySettings 同款分层）
  /**
   * 读 codemode 开关激活态：先查损坏单点（每次现查）——损坏 → 返回错误态
   * （enabled=false + corruption 有值），不走默认读路径（避免 get 自身触发 JsonStore
   * 读时隔离改名，A1 读侧约束）；未损坏 → 按 pi 解析语义计算激活集是否含 codemode。
   */
  getEnabled(): CodemodeEnabledResult
  /**
   * 写 codemode 开关（defaultTools 增量条目，D2 语义表）：进字段域写入前先查损坏
   * 单点——损坏 → 拒绝写入（ok:false 信封 + 结构化告警日志），未损坏 → setCodemodeEntry
   * 并回读写后落盘终态（写入含幂等不动 / 负条目占位等规范化分支）。
   */
  setEnabled(enabled: boolean): CodemodeSetEnabledResult
}
