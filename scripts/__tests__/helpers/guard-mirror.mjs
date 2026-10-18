/**
 * guard-mirror.mjs —— 检查脚本 tmp-mirror 集成用例的共享装置。
 *
 * 检查的 ROOT 由 `import.meta.url` 推导：把检查脚本（及其依赖的 scripts/lib 共享库）
 * 复制进 mirror 后运行副本，ROOT 落在 mirror 内——篡改 fixture 才真正改到检查读的文件，
 * 「篡改即红、还原即绿」的差分才成立（跑真实仓库脚本时 ROOT 指向真实仓库，篡改 mirror
 * 永不生效、恒 exit 0）。
 */
import { expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(TEST_DIR, '..', '..')

/**
 * 建 mirror 根 + 落盘器 + 清理器。root 取 realpath：Node 对入口模块 import.meta.url 做
 * realpath，而 process.argv[1] 保留调用方路径——macOS os.tmpdir() 是 /var/folders →
 * /private/var/folders 符号链接，两者不一致会让检查的 isMain 判定
 * （`import.meta.url === pathToFileURL(resolve(process.argv[1]))`）为 false，脚本被
 * import 而不执行 main（恒 exit 0）。realpath 后两条路径同源。
 */
export function createMirrorRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const writeAt = (rel, content) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  return { root, writeAt, cleanup }
}

/**
 * 把检查脚本 + scripts/lib/guard-report.mjs 复制进 mirror（检查脚本是单文件依赖 lib 的
 * 相对 import，lib 必须随行）。返回 run()：以 mirror 为 cwd 运行检查副本。
 */
export function installGuardIntoMirror(root, scriptPath) {
  const guardCopy = join(root, 'scripts', basename(scriptPath))
  mkdirSync(dirname(guardCopy), { recursive: true })
  copyFileSync(scriptPath, guardCopy)
  const libDir = join(root, 'scripts', 'lib')
  mkdirSync(libDir, { recursive: true })
  copyFileSync(join(dirname(scriptPath), 'lib', 'guard-report.mjs'), join(libDir, 'guard-report.mjs'))
  return () => spawnSync(process.execPath, [guardCopy], { cwd: root, encoding: 'utf-8' })
}

/**
 * 检查镜像夹具一步装配：源文件写入（missing 名单跳过）+ 检查装入镜像，返回 root/run/cleanup。
 * 各 check-*-sync 测试的 makeMirror 骨架单源（files/missing/script 由调用方给）。
 */
export function makeGuardMirror({ prefix, files, missing = [], script }) {
  const { root, writeAt, cleanup } = createMirrorRoot(prefix)
  for (const [rel, content] of Object.entries(files)) {
    if (missing.includes(rel)) continue
    writeAt(rel, content)
  }
  const run = installGuardIntoMirror(root, script)
  return { root, run, cleanup }
}

/**
 * 「直跑真实检查 → exit 0 + 成功文案」断言单源（真实仓库源文件的三方一致冒烟）。
 */
export function expectGuardDirectRunPasses(script, successText) {
  const r = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, encoding: 'utf-8' })
  expect(r.status).toBe(0)
  expect(r.stdout).toContain(successText)
}

/**
 * files 落盘（missing 名单跳过）+ 检查装入镜像。各 check-*-sync 测试 makeMirror
 * 的循环骨架单源（files 构造与签名差异留在调用方）。
 */
export function writeFilesAndInstallGuard(root, writeAt, files, { missing = [], script }) {
  for (const [rel, content] of Object.entries(files)) {
    if (missing.includes(rel)) continue
    writeAt(rel, content)
  }
  return installGuardIntoMirror(root, script)
}
