/**
 * fork 子进程（execArgv ['--import','tsx']）专用的临时 tsconfig 工厂。
 *
 * 问题：tsx 加载 plugin-bootstrap.ts 源码时，其依赖链经 plugin-sdk 的运行时
 * re-export（`export { PROTOCOL_VERSION } from '@zhushanwen/extension-protocol'`）
 * 触发对 @zhushanwen/extension-protocol 的 CJS require 解析。该包 exports 只声明
 * types/import 条件（workspace 内 TS 源码直连形态，供 bundler resolution 消费），
 * 无 require/default 条件 → ERR_PACKAGE_PATH_NOT_EXPORTED。子进程崩溃 stderr 带
 * 文件路径的 stack 进入 vitest 的 parseErrorStacktrace → extractSourcemapFromFile
 * 读取解析，产生 "Unexpected token" sourcemap artifact，整个 test run 被判
 * unhandled error。
 *
 * 修复：tsx 的 resolver 中 tsconfig paths 优先于 node_modules exports 解析——
 * fork env 注入 TSX_TSCONFIG_PATH 指向本工厂生成的临时 tsconfig，将协议包直接
 * 映射到其 TS 源码入口，require 链即跳过 exports 解析。仅影响 fork 子进程，
 * 不改生产 tsconfig / 包 manifests。目录 mkdtemp 自建自删（测试红线）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库 packages/ 目录（test/helpers/ → runtime/test/ → runtime/ → packages/） */
const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export interface TsxPathsTsconfig {
  /** 传给 fork 子进程 env.TSX_TSCONFIG_PATH 的绝对路径 */
  tsconfigPath: string
  /** 删除临时目录（afterAll / 用例收尾调用） */
  dispose: () => void
}

export function createTsxPathsTsconfig(): TsxPathsTsconfig {
  const dir = mkdtempSync(join(tmpdir(), 'tsx-fork-tsconfig-'))
  const tsconfigPath = join(dir, 'tsconfig.json')
  // paths target 必须绝对路径：临时 tsconfig 位于 os.tmpdir()，相对 target 会相对
  // 它解析而失效（tsx paths 命中后直接解析到文件，跳过 node_modules exports）
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        paths: {
          '@taiji/shared': [join(PACKAGES_ROOT, 'shared', 'src', 'index.ts')],
          '@zhushanwen/extension-protocol': [join(PACKAGES_ROOT, 'extension-protocol', 'src', 'index.ts')],
        },
      },
    }),
  )
  return {
    tsconfigPath,
    dispose: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  }
}
