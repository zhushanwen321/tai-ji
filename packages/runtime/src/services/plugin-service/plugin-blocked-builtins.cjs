'use strict'

/**
 * sandbox 黑名单内置模块 SSOT（S1-W3，spec §3.3 D2-④）
 *
 * 两个运行环境不同的拦截器必须消费同一份数据：
 *   - plugin-esm-loader.cjs（fork 子进程，--import 注入的 CJS，无法 import TS 源）
 *     → require 本文件
 *   - plugin-sandbox.ts（Worker / 主线程，TS，经 vitest 与 tsup bundle 两种形态）
 *     → import 本文件（default import 取 module.exports 整体，任何 CJS interop
 *       实现下属性访问都安全）
 *
 * 修改黑名单只改本文件（两消费方自动同步）。plugin-sandbox-escape.test.ts
 * 有防退化断言：plugin-sandbox.ts 的导出数组与直接 require 本文件逐元素相等
 * （抓住「有人把 plugin-sandbox.ts 改回内联」的漂移）。
 *
 * 写法约束：`exports.X = [...]` 静态赋值形态（cjs-module-lexer 可识别；
 * `module.exports = {...}` 对象字面量在某些 interop 下 named export 推导失败）。
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
  'os',
  'readline',
  'tls',
  'v8',
  'vm',
  'worker_threads',
  // module：node:module 暴露 createRequire，可构造绕过 sandbox 拦截的 require（M6a-01）
  'module',
]
