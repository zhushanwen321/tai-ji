'use strict'

/**
 * sandbox 内置模块基线黑名单 + 放行计算 SSOT（provider-plugin-access D3）
 *
 * 两个运行环境不同的拦截器必须消费同一份数据：
 *   - plugin-esm-loader.cjs（fork 子进程，--import 注入的 CJS，无法 import TS 源）
 *     → require 本文件
 *   - plugin-sandbox.ts（Worker / 主线程，TS，经 vitest 与 tsup bundle 两种形态）
 *     → import 本文件（default import 取 module.exports 整体，任何 CJS interop
 *       实现下属性访问都安全）
 *
 * D3 形态：静态黑名单改为「基线数组 + 放行计算」——
 *   - BLOCKED_BUILTINS = 基线（未声明任何业务能力时的默认封禁集）。D3 裁决移出
 *     `os`（17 → 16 项）：os 只暴露主机名 / 用户名 / 平台 / 家目录等环境信息，
 *     封禁价值低于「已允许插件读用户目录文件」这一既成事实；羊毛拼 IDE 配置路径
 *     需要 homedir()，封禁它会使 fs.read-user-data 无法落地。
 *   - computeBlockedBuiltins(allowed) = 插件 manifest 能力声明（经
 *     @taiji/shared plugin-capability-map 的 resolveAllowedModules 计算为模块集，
 *     fork env 注入）生效后的实际黑名单：allowed 与基线的交集放行，永久封禁
 *     7 项（PERMANENTLY_BLOCKED_BUILTINS）无条件保留——即使 env 被错误注入
 *     'vm' 等永久封禁名也不放行（fail-closed）。
 *
 * 修改基线只改本文件（两消费方自动同步）。plugin-sandbox-escape.test.ts
 * 有防退化断言：基线 16 项、os 不在基线、永久封禁 7 项都在基线、放行计算
 * 对永久封禁免疫（抓住「有人把本文件改回静态数组 / 移出永久封禁」的漂移）。
 *
 * 写法约束：`exports.X = [...]` 静态赋值形态（cjs-module-lexer 可识别；
 * `module.exports = {...}` 对象字面量在某些 interop 下 named export 推导失败）。
 */

/**
 * 永久封禁清单（D3）：任何能力词都不可放行。
 * vm / module 可构造逃逸（node:module.createRequire 绕过 sandbox 拦截，M6a-01）；
 * worker_threads / cluster 可绕开本 loader 的单进程 hook 注册；
 * dgram / readline / v8 无业务需求方，保守封禁。
 */
exports.PERMANENTLY_BLOCKED_BUILTINS = [
  'cluster',
  'dgram',
  'readline',
  'v8',
  'vm',
  'worker_threads',
  // module：node:module 暴露 createRequire，可构造绕过 sandbox 拦截的 require（M6a-01）
  'module',
]

/**
 * 基线黑名单（未声明业务能力时的默认封禁集，16 项）：
 * 可放行 9 项（fs / fs/promises / child_process / crypto / dns / http / https /
 * net / tls——与 @taiji/shared plugin-capability-map 的能力词映射对齐）+
 * 永久封禁 7 项。os 已移出（D3，见头注释）。
 */
exports.BLOCKED_BUILTINS = [
  'fs',
  'fs/promises',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'http',
  'https',
  'net',
  'readline',
  'tls',
  'v8',
  'vm',
  'worker_threads',
  'module',
]

/**
 * 放行计算：按插件能力声明得到的有效黑名单 = 基线 −（allowed ∩ 可放行项）。
 *
 * 永久封禁项无条件保留（allowed 含 'vm' 等永久封禁名不生效——防 env 注入错误
 * 或上游词表演进把封禁项误入放行集）；allowed 中基线外的名字（如 'path'）本就
 * 不在黑名单，无影响。纯函数，不 mutate 入参。
 */
exports.computeBlockedBuiltins = function computeBlockedBuiltins(allowed) {
  const permanent = new Set(exports.PERMANENTLY_BLOCKED_BUILTINS)
  const allowSet = new Set(Array.isArray(allowed) ? allowed : [])
  return exports.BLOCKED_BUILTINS.filter((name) => !allowSet.has(name) || permanent.has(name))
}
