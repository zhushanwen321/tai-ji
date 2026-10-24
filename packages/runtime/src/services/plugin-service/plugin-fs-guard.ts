/**
 * fs 能力放行的宿主侧门面（provider-plugin-access D3）。
 *
 * 分工：核心执法逻辑（路径检查 / 只读导出子集代理 / 代理源码生成）在
 * plugin-fs-guard.cjs（fork 子进程 ESM loader 同目录 require 的 CJS，无法 import
 * TS 源，形态同 plugin-blocked-builtins.cjs + .d.cts 先例）；本文件是宿主（TS）
 * 侧唯一入口——把 manifest 能力声明编码为 fork env 键值（buildPluginCapabilityForkEnv，
 * 由 plugin-host-process.ts 经 buildPluginHostChildEnv 注入，C-proc-09）。
 *
 * env 编码 = JSON 数组字符串：键名 SSOT 在 plugin-fs-guard.cjs（ENV_* 常量，
 * loader 解码与 TS 编码同源）；JSON 形态对含路径分隔符/特殊字符的 readPaths 安全。
 * 解码 fail-closed：loader 侧解析失败/缺失 → 空放行（基线黑名单全拦）。
 */

import { resolveAllowedModules } from '@taiji/shared/plugin-capability-map'
import fsGuardModule from './plugin-fs-guard.cjs'

/** 宿主登记的插件能力声明输入（来源 = manifest taijiPlugin.capabilities / readPaths） */
export interface PluginCapabilityForkEnvInput { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  /** manifest 声明的业务能力词（词表 = PluginCapabilityConstants） */
  capabilities: readonly string[]
  /** fs.read-user-data 的读取路径白名单（家目录相对路径）；缺省 = 无可读路径 */
  readPaths?: readonly string[]
}

/** fork env 键（值 = JSON 数组字符串；SSOT 在 plugin-fs-guard.cjs） */
export const PLUGIN_CAPABILITY_ENV_KEYS = { // oe-exempt:20261024:wip:分步提交中间态——wiring 接线属后续单元/集成阶段，30 天内接线或删除
  allowedModules: fsGuardModule.ENV_ALLOWED_MODULES_KEY,
  readPaths: fsGuardModule.ENV_READ_PATHS_KEY,
} as const

/**
 * 按 manifest 能力声明构建 fork env 键值（buildPluginHostChildEnv 的 capabilityEnv 入参）。
 *
 * 能力词 → 放行模块集的映射 = @taiji/shared plugin-capability-map（resolveAllowedModules）；
 * 未知能力词不参与放行，console.warn 留可观测性（安装期校验是安装器的职责，
 * 本函数只忠实计算）。
 */
export function buildPluginCapabilityForkEnv(input: PluginCapabilityForkEnvInput): Record<string, string> {
  const { allowed, unknown } = resolveAllowedModules(input.capabilities)
  if (unknown.length > 0) {
    console.warn(
      `[plugin-fs-guard] unknown capability words ignored in fork allowlist: ${unknown.join(', ')} ` +
      `(install-time validation should have caught these)`,
    )
  }
  return {
    [fsGuardModule.ENV_ALLOWED_MODULES_KEY]: JSON.stringify(allowed),
    [fsGuardModule.ENV_READ_PATHS_KEY]: JSON.stringify([...(input.readPaths ?? [])]),
  }
}
