/**
 * sandbox 插件 CJS require 拦截（fork 子进程经 initSandbox 装配；Worker 形态同函数复用）。
 *
 * 当前 sandbox 插件宿主一律 fork 子进程（plugin-host.ts sandbox 分支转子进程宿主），
 * CJS 拦截经 initSandbox 在 fork 子进程装配（plugin-bootstrap-process.ts）；本模块
 * 同时被 Worker 版 bootstrap 复用（同函数两形态）。在插件进程内拦截 require 调用，
 * 阻止访问危险的 Node.js 内置模块（fs、child_process 等），按 manifest 能力声明
 * 放行对应模块（D3：TAIJI_PLUGIN_ALLOWED_MODULES env → computeBlockedBuiltins 计算
 * 有效黑名单——与 ESM loader 消费同一词表，声明能力在两条加载通道一致生效），
 * 同时允许安全模块（path、url、util 等）通过。
 *
 * CJS 通道与 ESM loader（plugin-esm-loader.cjs）的执法分工：ESM hooks 不覆盖
 * CJS require，本拦截器是 CJS 通道的第一道防线（S-36 观察期结论 = 接线保留，
 * 原登记文档已退役、沿革见 git 历史）。fs 系两通道执法形态一致
 * （fs.read-user-data 的只读导出子集代理）：ESM 走 resolve 改写 sentinel + load
 * 短路返回代理模块源码；CJS 通道拦截器按能力声明两态放行——声明含 fs / fs/promises
 * → 放行（由 initSandbox 的 Module._load patch 返回只读代理对象，同语义），未声明
 * → PERMISSION_DENIED（fail-closed）。fs 系不走 computeBlockedBuiltins 的普通
 * 模块级放行——CJS 模块级放行 = 完整 fs，与只读子集承诺冲突。
 *
 * 同时替换 process.env 为空 Proxy，防止环境变量泄露。
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { errorWithCode } from '../../utils/errors.js'
// 黑名单 SSOT（S1-W3）：default import 取 module.exports 整体（named import 在
// vitest/esbuild/node 的 CJS interop 下行为不一，属性访问在所有实现下安全）。
// 修改黑名单只改 plugin-blocked-builtins.cjs（与 plugin-esm-loader.cjs 共享同一份）。
import blockedBuiltinsModule from './plugin-blocked-builtins.cjs'

/** 被阻止的 Node.js 内置模块列表（单一来源 plugin-blocked-builtins.cjs 的 re-export） */
export const BLOCKED_BUILTINS: readonly string[] = blockedBuiltinsModule.BLOCKED_BUILTINS

/**
 * CJS 通道走只读代理对象的 fs 系模块（fs.read-user-data 的放行面，与 ESM loader
 * resolve/load 的 FS_PROXY_MODULES 同一词表）：拦截器按能力声明两态放行——声明
 * 含该名 → 放行（不抛错，由 initSandbox 的 Module._load patch 返回只读代理对象，
 * 行为语义与 ESM 通道对齐）；未声明 → PERMISSION_DENIED（fail-closed）。fs 系
 * 不进 effectiveBlocked 的普通放行分支——模块级放行 = 完整 fs，破坏只读子集承诺，
 * 故在黑名单检查前显式分流（不依赖基线数据现状，词表演进不改变本契约）。
 * 导出供 plugin-bootstrap.ts 的 Module._load patch 消费（同一放行面两处判定同源）。
 */
export const FS_PROXY_MODULES: readonly string[] = ['fs', 'fs/promises']

/**
 * require 请求的解析结果是否在插件目录内。
 *
 * CJS `_resolveFilename` 的返回值形态：
 * - 内置模块：原样返回（'path' / 'node:path'，非绝对路径）→ 不适用本判定（调用方分流）
 * - 文件类请求：绝对路径，或（file: 前缀场景）file:// URL——先转路径再判界
 */
function isResolvedInsidePluginDir(resolvedPath: string, normalizedPluginDir: string): boolean {
  let filePath = resolvedPath
  if (filePath.startsWith('file:')) {
    try {
      filePath = fileURLToPath(filePath)
    } catch {
      return false
    }
  }
  if (!filePath.startsWith('/')) return false
  return filePath.startsWith(normalizedPluginDir)
}

/** 路径类请求（相对 / 绝对 / file: URL）：解析结果必须在 pluginDir 内（拦截规则第一分支）。 */
function isPathLikeRequest(request: string): boolean {
  return request.startsWith('./') || request.startsWith('../') || request.startsWith('/') || request.startsWith('file:')
}

/**
 * 解析结果判界（fail-closed）：文件形态（绝对路径 / file: URL）且出 pluginDir →
 * PERMISSION_DENIED。路径类请求分支与裸名解析结果分支共用同一出界裁决。
 */
function assertResolvedInsidePluginDir(request: string, resolvedPath: string, normalizedPluginDir: string): void {
  if (!isResolvedInsidePluginDir(resolvedPath, normalizedPluginDir)) {
    throw errorWithCode(`Sandbox: require('${request}') resolves outside plugin directory`, 'PERMISSION_DENIED')
  }
}

/**
 * 创建 require 拦截函数。
 *
 * 拦截规则：
 * - 路径类请求（./ ../ / file:）：解析结果必须在 pluginDir 内（出界即拒，
 *   含 / 绝对路径——S1-W3 前该前缀不落入边界分支直接放行，是 CJS 沙箱逃逸口）
 * - npm 裸名：有效黑名单检查（基线按能力声明放行集过滤——F1-9 裁决接入
 *   computeBlockedBuiltins，与 ESM loader 同词表同计算，声明能力两通道一致生效；
 *   fs 系不在此列，见 FS_PROXY_MODULES 两态分流）；非黑名单裸名解析结果（绝对路径
 *   形态）也必须在 pluginDir 内——CJS 与 ESM 同样从当前目录向上遍历 node_modules，
 *   可命中 pluginDir 外的沙箱外副本（对齐 ESM loader 裸名解析后校验）
 * - 内置模块裸名（path/util 等）：resolvedPath 非绝对路径，黑名单未命中即放行
 * - 不满足条件: throw Error(code: 'PERMISSION_DENIED')
 *
 * @param pluginDir 插件根目录（目录形态；initSandbox 调用方负责传 dirname(pluginPath)），
 *   用于路径边界检查
 * @param allowedModules 能力声明放行集（resolveAllowedModules 产出、宿主经
 *   TAIJI_PLUGIN_ALLOWED_MODULES 注入的模块名数组）；缺省空集 = 基线全拦
 *   （fail-closed，与 ESM loader 的 env 缺失语义一致）
 * @returns 拦截函数，返回允许的模块标识符或抛出 PERMISSION_DENIED
 */
export function createRequireInterceptor(pluginDir: string, allowedModules: readonly string[] = []): (request: string, resolvedPath?: string) => string {
  // 有效黑名单（创建期一次计算）：基线 −（allowed ∩ 可放行项）。永久封禁免疫与
  // 「allowed 含基线外名字无影响」由 computeBlockedBuiltins 承载（与 ESM loader
  // 消费同一纯函数，两侧不漂移）。fs 系的放行不经此——模块级放行 = 完整 fs，
  // 只走下方 FS_PROXY_MODULES 两态分支（只读代理对象）。
  const effectiveBlocked = new Set(blockedBuiltinsModule.computeBlockedBuiltins(allowedModules))
  // realpath 规范化（对齐 ESM loader initialize 的同款处理）：CJS resolver 返回
  // realpath（macOS /tmp → /private/var|tmp symlink），pluginDir 不规范化则
  // startsWith 判界恒 false——合法插件自带的 .cjs 模块（ESM import CJS 走本拦截器）
  // 会被整体误杀。realpath 失败（目录消失）保持原值，后续判界 fail-closed。
  let normalizedDir = pluginDir
  try {
    normalizedDir = realpathSync(pluginDir)
  } catch (e) {
    // 保持原值（无更优选择；目录不存在时插件 load 本就会失败）——
    // 记 warn 保留可观测性：realpath 失败意味着目录异常，后续判界将 fail-closed 拒绝全部路径请求
    console.warn('[plugin-sandbox] realpath failed for plugin dir, keeping unresolved path:', e)
  }
  const normalizedPluginDir = normalizedDir.endsWith('/') ? normalizedDir : normalizedDir + '/'

  return (request: string, resolvedPath?: string): string => {
    // 路径类请求（相对 / 绝对 / file: URL）：解析结果必须在 pluginDir 内
    if (isPathLikeRequest(request)) {
      if (resolvedPath !== undefined) {
        assertResolvedInsidePluginDir(request, resolvedPath, normalizedPluginDir)
      }
      return resolvedPath ?? request
    }

    // npm 包名 / 内置模块：有效黑名单检查（基线按能力声明放行集过滤，F1-9 接线）
    // node: 前缀剥离后查黑名单（M6a-01）：require('node:fs') 与 require('fs') 等价，
    // 不剥离则 node: 前缀绕过黑名单（ESM loader 侧已有同样剥离，两侧必须对称）。
    const bareName = request.startsWith('node:') ? request.slice('node:'.length) : request

    // fs 系两态放行（fs.read-user-data 的 CJS 只读执法，与 ESM 通道对齐）：声明含
    // 该名 → 放行（initSandbox 的 Module._load patch 返回只读代理对象）；未声明 →
    // PERMISSION_DENIED。先于 effectiveBlocked 检查：fs 系在基线黑名单内，普通放行
    // 分支对 fs 系不适用（模块级放行 = 完整 fs，破坏只读子集承诺）。
    if (FS_PROXY_MODULES.includes(bareName)) {
      if (!allowedModules.includes(bareName)) {
        throw errorWithCode(
          `Sandbox: require('${request}') is blocked (readonly fs proxy requires the fs.read-user-data capability)`,
          'PERMISSION_DENIED',
        )
      }
      return request
    }

    if (effectiveBlocked.has(bareName)) {
      throw errorWithCode(`Sandbox: require('${request}') is blocked`, 'PERMISSION_DENIED')
    }

    // 非黑名单裸名：文件类解析结果（绝对路径 / file: URL）必须在 pluginDir 内——
    // CJS 与 ESM 同样从当前目录向上遍历 node_modules，可命中 pluginDir 外的
    // 沙箱外副本（对齐 ESM loader 裸名解析后校验）。内置裸名（'path' 等）
    // resolvedPath 非文件形态，无界可判，放行；resolvedPath 缺失（无解析信息）
    // 不拦截，由调用方（initSandbox 的 _resolveFilename patch 总是传真实解析结果）保证。
    if (
      resolvedPath !== undefined &&
      (resolvedPath.startsWith('/') || resolvedPath.startsWith('file:'))
    ) {
      assertResolvedInsidePluginDir(request, resolvedPath, normalizedPluginDir)
    }

    return request
  }
}

/**
 * 替换 process.env 为空 Proxy，防止插件读取宿主环境变量。
 * 所有 get 返回 undefined，所有 set 静默失败。
 */
export function createEnvProxy(): NodeJS.ProcessEnv {
  return new Proxy({} as NodeJS.ProcessEnv, {
    get: () => undefined,
    set: () => true,
    has: () => false,
    deleteProperty: () => true,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  })
}
