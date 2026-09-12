/**
 * runtime 侧 staged 引擎根推导 + pi 子进程 env 注入（W9，设计 §3.7 Electron 打包态
 * 「路径传递」：runtime 推 resources/ 位置 → env XYZ_AGENT_ENGINE_ROOTS 注入 pi 子进程
 * → 扩展发现器 HostServices.discoveryRoots engines kind 之外的 L1 主通道）。
 *
 * 安全立场（设计 §3.7）：**显式注入绝对路径，不 cwd 探测**（防用户 repo 预置同名
 * 目录冒充）——本模块是 runtime（宿主）侧的唯一推导点，推导完成后以 env 值传递，
 * 引擎根只读 manifest 不执行用户 repo 内同名目录。staged 位置双形态与 relay-paths.ts
 * 的既有先例同款：打包 = <cwd>/engines（runtime sidecar 的 cwd = Resources，由
 * runtime-manager 设定）；dev = <projectRoot>/resources/engines。
 *
 * 注入面（pi 子进程 env）：
 *  - XYZ_AGENT_ENGINE_ROOTS：staged 引擎根绝对路径（目录存在才注入——dev 未跑
 *    bundle-extensions 时不注入，发现回落 L2/L3 常规通道；2026-09 起 dev 启动链
 *    已前置 bundle-extensions.mjs 恒重建 staged 引擎（F7 修复），正常 dev 形态
 *    目录恒存在且新鲜，此回落仅覆盖绕过 dev 链直接起 Electron 的形态）；
 *  - XYZ_AGENT_ENGINE_NODE + ELECTRON_RUN_AS_NODE=1：仅打包态注入（矩阵①：pi 扩展
 *    宿主的 process.execPath 是 pi binary，必须用注入执行器跑引擎 CLI；执行器 =
 *    runtime 自身 execPath，打包态即宿主 Electron 二进制，故同点带 RUN_AS_NODE）。
 *    dev 态 PATH node 可用，刻意不注入——保持 standalone ③ 语义。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { ENGINE_LAUNCH_ENV_KEYS } from '@xyz-agent/shared'

import { isPackaged } from '../../utils/runtime-env.js'

/** L1 引擎发现根 env（SSOT = shared constants ENGINE_LAUNCH_ENV_KEYS.ROOTS；core 侧读取同名字面量）。 */
export const ENGINE_ROOTS_ENV = ENGINE_LAUNCH_ENV_KEYS.ROOTS
/** 引擎 node 执行器 env（SSOT 同上；SDK node-executor.ts 字面量镜像——SDK 不 import shared，F9）。 */
export const ENGINE_NODE_ENV = ENGINE_LAUNCH_ENV_KEYS.NODE

/**
 * staged 引擎根绝对路径（双形态：打包 = <cwd>/engines；dev = <projectRoot>/resources/engines）。
 * 目录不存在返回 undefined——调用方据此决定是否注入（缺省不注入，见文件头）。
 */
/** 打包态 staged 缺失 warn 的 once 守卫（注入面每次 pi spawn 都会调用，防刷屏）。 */
let warnedPackagedStagedMissing = false

export function getStagedEnginesDir(projectRoot: string): string | undefined {
  const dir = isPackaged() ? join(process.cwd(), 'engines') : join(projectRoot, 'resources', 'engines')
  if (!existsSync(dir)) {
    // 打包态 staged 目录缺失是异常形态（L1 主通道缺失 → 引擎发现回落 L2/L3，打包态
    // 通常全空 → 派发期 engine_not_found）。推导逻辑刻意保持不变（「显式绝对路径不
    // cwd 探测」立场），只留痕诊断信号。
    if (isPackaged() && !warnedPackagedStagedMissing) {
      warnedPackagedStagedMissing = true
      console.warn(
        `[engine-roots] staged engines dir missing at packaged location '${dir}' (cwd-based); ` +
          `engine discovery L1 will be empty — expected injection: ${ENGINE_ROOTS_ENV}=<absolute engines root>`,
      )
    }
    return undefined
  }
  return dir
}

/** 注入 pi 子进程的引擎 env（ROOTS + 打包态执行器两键）；无可注入面返回空对象。 */
export function getEngineRootsSpawnEnv(projectRoot: string): Record<string, string> {
  const env: Record<string, string> = {}
  const stagedDir = getStagedEnginesDir(projectRoot)
  if (stagedDir !== undefined) env[ENGINE_ROOTS_ENV] = stagedDir
  if (isPackaged()) {
    env[ENGINE_NODE_ENV] = process.execPath
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  return env
}

/**
 * runtime 自身发现面的 env 补齐（幂等）：staged 引擎根存在且 env 未设时写入
 * process.env——core 侧 discoverAndRegisterEngines 缺省读 process.env 的 L1 通道，
 * 打包态无 node_modules（L2 空），不补齐则 runtime ①级读引擎零命中。
 * 已有显式值永不覆盖（用户/上游显式配置优先）。
 */
export function ensureRuntimeEngineRootsEnv(projectRoot: string): boolean {
  const stagedDir = getStagedEnginesDir(projectRoot)
  if (stagedDir === undefined) return false
  if (process.env[ENGINE_ROOTS_ENV] !== undefined && process.env[ENGINE_ROOTS_ENV] !== '') return false
  process.env[ENGINE_ROOTS_ENV] = stagedDir
  return true
}
