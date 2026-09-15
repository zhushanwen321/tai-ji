/**
 * Worker Sandbox: require 拦截和进程环境保护
 *
 * 在 sandbox 模式的 Worker 中拦截 require 调用，阻止访问
 * 危险的 Node.js 内置模块（fs、child_process 等），
 * 同时允许安全模块（path、url、util 等）通过。
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

/**
 * 创建 require 拦截函数。
 *
 * 拦截规则：
 * - 路径类请求（./ ../ / file:）：解析结果必须在 pluginDir 内（出界即拒，
 *   含 / 绝对路径——S1-W3 前该前缀不落入边界分支直接放行，是 CJS 沙箱逃逸口）
 * - npm 裸名：黑名单检查；非黑名单裸名解析结果（绝对路径形态）也必须在
 *   pluginDir 内——CJS 与 ESM 同样从当前目录向上遍历 node_modules，可命中
 *   pluginDir 外的沙箱外副本（对齐 ESM loader 裸名解析后校验）
 * - 内置模块裸名（path/util 等）：resolvedPath 非绝对路径，黑名单未命中即放行
 * - 不满足条件: throw Error(code: 'PERMISSION_DENIED')
 *
 * @param pluginDir 插件根目录（目录形态；initSandbox 调用方负责传 dirname(pluginPath)），
 *   用于路径边界检查
 * @returns 拦截函数，返回允许的模块标识符或抛出 PERMISSION_DENIED
 */
export function createRequireInterceptor(pluginDir: string): (request: string, resolvedPath?: string) => string {
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
    if (
      request.startsWith('./') ||
      request.startsWith('../') ||
      request.startsWith('/') ||
      request.startsWith('file:')
    ) {
      if (resolvedPath !== undefined) {
        if (!isResolvedInsidePluginDir(resolvedPath, normalizedPluginDir)) {
          throw errorWithCode(`Sandbox: require('${request}') resolves outside plugin directory`, 'PERMISSION_DENIED')
        }
      }
      return resolvedPath ?? request
    }

    // npm 包名 / 内置模块：检查 blocklist
    // node: 前缀剥离后查黑名单（M6a-01）：require('node:fs') 与 require('fs') 等价，
    // 不剥离则 node: 前缀绕过黑名单（ESM loader 侧已有同样剥离，两侧必须对称）。
    const bareName = request.startsWith('node:') ? request.slice('node:'.length) : request
    if (BLOCKED_BUILTINS.includes(bareName)) {
      throw errorWithCode(`Sandbox: require('${request}') is blocked`, 'PERMISSION_DENIED')
    }

    // 非黑名单裸名：文件类解析结果（绝对路径 / file: URL）必须在 pluginDir 内——
    // CJS 与 ESM 同样从当前目录向上遍历 node_modules，可命中 pluginDir 外的
    // 沙箱外副本（对齐 ESM loader 裸名解析后校验）。内置裸名（'path' 等）
    // resolvedPath 非文件形态，无界可判，放行；resolvedPath 缺失（无解析信息）
    // 不拦截，由调用方（initSandbox 的 _resolveFilename patch 总是传真实解析结果）保证。
    if (
      resolvedPath !== undefined &&
      (resolvedPath.startsWith('/') || resolvedPath.startsWith('file:')) &&
      !isResolvedInsidePluginDir(resolvedPath, normalizedPluginDir)
    ) {
      throw errorWithCode(`Sandbox: require('${request}') resolves outside plugin directory`, 'PERMISSION_DENIED')
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
