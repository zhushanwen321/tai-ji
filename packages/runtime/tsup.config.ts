import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// XYZ_AGENT_VERSION 展示应用版本（与 electron 包一致），读 apps/electron/package.json。
// runtime 自己的 package.json version（0.4.7-beta）是包内部版本，不对外展示。
const pkgPath = resolve(__dirname, '../../apps/electron/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugin-bootstrap': 'src/services/plugin-service/plugin-bootstrap.ts',
    // 子进程版 bootstrap + ESM loader（sandbox 真隔离，重构 3）：
    // fork 子进程入口（host-process resolveAndValidateFile('plugin-bootstrap-process.cjs') 定位）
    // + ESM loader 经 execArgv --import 注入（沙箱进程启动时加载）
    'plugin-bootstrap-process': 'src/services/plugin-service/plugin-bootstrap-process.ts',
    'plugin-esm-loader': 'src/services/plugin-service/plugin-esm-loader.cjs',
    cli: 'src/cli/index.ts',  // xyz-settings CLI 入口（打包后 dist/runtime/cli.cjs）
  },
  // 输出到 apps/electron/dist/runtime（与 main/preload dist 同级，供 electron-builder 打包）
  outDir: '../../apps/electron/dist/runtime',
  format: ['cjs'],
  platform: 'node',  // 自动将所有 Node.js 内置模块标为 external
  target: 'node24',   // 匹配 Electron 42.3.3 内置 Node 24.15.0（ELECTRON_RUN_AS_NODE 实测）
  bundle: true,
  clean: true,
  // ══════════════════════════════════════════════════════════════
  // 打包规则（违反必出 bug）
  // ──────────────────────────────────────────────────────────────
  // noExternal：纯 JS 包、无 native addon、体积合理，必须打包
  // 规则：新增 npm 依赖时必须加入此列表，否则 asar.unpacked 运行时找不到
  // 检查：scripts/validate-runtime-bundle.sh（pre-commit 自动触发）
  // ══════════════════════════════════════════════════════════════
  // @xyz-agent/shared：workspace 包（纯 TS 类型 + 工具函数），必须打包进 bundle，
  // 否则打包后 require('@xyz-agent/shared') 找不到（runtime 子进程无 node_modules）
  // @zhushanwen/subagent-core：只消费双端复用的无状态模块（D8 复用链切换，原
  // pi-subagent-workflow 深路径改走语义子入口）：engines/zcode/reader + constants +
  // engine/paths + relay-env（E-2 relay env 名/协议版本常量 SSOT，纯常量+纯函数，
  // 设计 §3.3.1 例外条款），运行时闭包 = node:fs + 纯常量；import 链其余均为
  // type-only（bundle 后消失）。禁止扩大消费面到 launcher/preparer/parser/EnginePort
  // （依赖方向纪律）。require 条件解析到该包 dist CJS——core dist 未 build 时打包失败
  // 属预期（build 前置）
  // @earendil-works/pi-ai：能力注册表（pi-boundary-reliability U5）pi 同源档位计算——
  // 「根声明、runtime 不可 import」格局的首次反转，声明见 services/model-capability.ts 头注；
  // pin 与根 pin 双副本一致性由 D6 版本门禁机器保证
  // @zhushanwen/pi-file-lock：统一锁原语（D1-A，file-lock-unification-and-reaper-sink.md
  // §3.2）——utils/file-lock.ts 经 ./core 子入口复用自实现 mkdir 锁（纯 TS 源码包，
  // exports 直指 src，esbuild 直接编译无需 build 前置）。替换原 proper-lockfile
  //（本地封装已删；package.json 依赖保留仅供测试作对端持锁者，不进 bundle）
  // xyz-agent-plugin-sdk：插件契约 SSOT（D28 方向反转）——runtime 的 plugin-types
  // 薄壳 re-export 其类型与 PermissionConstants 常量值。纯 TS 源码包（main 直指
  // src/index.ts，零 dependencies），esbuild 直接编译，同 pi-file-lock 先例
  // @zhushanwen/subagent-engine-sdk [W11/A5]：runtime 经 subagent-core 协议面传递消费
  // SDK 原语（buildEngineChildEnv / spawnEngineChild 等），workspace TS 源码包无 dist
  // 解析面，必须内联进 bundle（否则打包态 Cannot find module）
  // @zhushanwen/pi-rpc [U1 subagent-permanent-session-model]：pi 进程 RPC 公共层
  // （argv 构造 / LF-only 分帧 / pending 表 / 命令帧组装 / 杀链 / 出站 env 组装），
  // rpc-client 薄壳消费——同 pi-file-lock 形态（exports 直指 src 的纯 TS 源码包，
  // esbuild 直接编译无需 build 前置）
  noExternal: ['ws', 'semver', 'fast-glob', 'tar', '@xyz-agent/shared', '@xyz-agent/extension-protocol', '@xyz-agent/session-delivery', '@xyz-agent/core', '@zhushanwen/subagent-core', '@zhushanwen/subagent-engine-sdk', '@zhushanwen/pi-file-lock', '@zhushanwen/pi-rpc', '@earendil-works/pi-ai', 'chokidar', '@iarna/toml', 'xyz-agent-plugin-sdk'],
  // platform: 'node' 已自动处理所有 node:* 内置模块，无需手动 external
  // node-pty 是 native module（含 .node 二进制），不能打包进 JS bundle：
  // 其 JS 入口用 node-gyp-build 动态 require prebuilds/<platform>/*.node，
  // bundle 后 __dirname 变 dist/runtime，找不到 prebuilds。
  // 保持 external，靠 electron-builder asarUnpack 解包 native binary（见 electron-builder.yml）。
  external: ['node-pty'],
  splitting: false,
  sourcemap: false,
  minify: false,
  define: {
    'process.env.XYZ_AGENT_VERSION': JSON.stringify(pkg.version),
  },
  // 打包后验证：检查产物存在 + 体积合理（不执行模块，避免启动 runtime）
  onSuccess: async () => {
    const { existsSync, statSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')

    // 验证主 bundle（与 outDir 一致：../../apps/electron/dist/runtime）
    const bundlePath = path.join('..', '..', 'apps', 'electron', 'dist', 'runtime', 'index.cjs')
    if (!existsSync(bundlePath)) {
      throw new Error(`Runtime bundle not found: ${bundlePath}`)
    }
    const BYTES_PER_KB = 1024
    const sizeKB = Math.round(statSync(bundlePath).size / BYTES_PER_KB)
    console.log(`[tsup] Runtime bundle: ${bundlePath} (${sizeKB}KB)`)
    const MIN_BUNDLE_SIZE_KB = 100
    if (sizeKB < MIN_BUNDLE_SIZE_KB) {
      throw new Error(`Runtime bundle too small (${sizeKB}KB), likely missing dependencies`)
    }

    // esbuild 前缀剥离守卫（P5，2026-08-25）：CJS 输出会把字面量 import("node:sqlite")
    // 规约成裸名 import("sqlite")——Node 动态 import 裸名不走内置 fallback，zcode
    // reader①级在打包环境恒降级。reader 已改变量间接规避；此处拦截 esbuild 升级后
    // 输出形态变化导致的静默回归
    const bundleSrc = readFileSync(bundlePath, 'utf-8')
    if (/import\(["']sqlite["']\)/.test(bundleSrc)) {
      throw new Error(
        'Runtime bundle contains bare dynamic import("sqlite") — esbuild stripped the node: prefix ' +
        '(zcode reader tier1 would always fail). Fix: keep the variable-indirected dynamic import in ' +
        'packages/subagent-core/src/execution/engine/engines/zcode/reader.ts.',
      )
    }

    // 验证 Worker bootstrap（plugin-host.ts 运行时依赖）
    const bootstrapPath = path.join('..', '..', 'apps', 'electron', 'dist', 'runtime', 'plugin-bootstrap.cjs')
    if (!existsSync(bootstrapPath)) {
      throw new Error(`Plugin bootstrap not found: ${bootstrapPath}`)
    }
    const bootstrapSizeKB = Math.round(statSync(bootstrapPath).size / BYTES_PER_KB)
    console.log(`[tsup] Plugin bootstrap: ${bootstrapPath} (${bootstrapSizeKB}KB)`)

    // 验证 CLI bundle（xyz-settings）
    const cliPath = path.join('..', '..', 'apps', 'electron', 'dist', 'runtime', 'cli.cjs')
    if (!existsSync(cliPath)) {
      throw new Error(`CLI bundle not found: ${cliPath}`)
    }
    const cliSizeKB = Math.round(statSync(cliPath).size / BYTES_PER_KB)
    console.log(`[tsup] CLI bundle: ${cliPath} (${cliSizeKB}KB)`)

    console.log('[tsup] Runtime bundle validated ✓')
  },
})
