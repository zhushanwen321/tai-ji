/**
 * 升级 bash 脚本「真实执行」集成测试（u1a：staging 状态机版）。
 *
 * 覆盖目标（设计 .tmp/update-reliability.tech-design.md §3.3.1 状态机 + §4.2 验收语义，
 * 验收条款②：S1/S2/S3/S4 中断注入与磁盘满场景）
 * ------------------------------------------------------------------
 * 字符串正确 ≠ bash 真的能跑通。本文件构造迷你 .app bundle + 真实 dmg，
 * 把 buildUpdaterScript 生成脚本写到磁盘真实执行，断言 exit code / 落盘文件 /
 * 回滚行为。核心用例（对应 §4.2 场景语义，脚本侧状态断言）：
 *
 *   - happy path（M1 脚本侧）：S0→S5 全链路走通，终态无 .old/.new/staging 残留
 *   - S1 中断注入（M2 脚本侧）：S1 完成后 kill 脚本 → 正式位置零接触 + staging 残留
 *   - S3→S4 残余窗口中断（M3b 脚本侧）：备份与换装之间 kill → $APP 缺失 +
 *     .old/.new 双份完整（手动恢复出口的前提）
 *   - S4 后 done 前中断（M3a 脚本侧）：换装完成、done 未写 → $APP 完整新版 +
 *     .old 在（状态留给 app 内 self-healer，安全侧回滚）
 *   - 磁盘满（M4/P10）：小容量 HFS+ 镜像触发 ENOSPC → extract failed + 旧 app 完好
 *   - 等待超时 abort（M6）：父进程不退 → failed(app still running)，不拆运行中进程底座
 *   - 备份失败 abort（RM7）：备份 mv 失败 → failed(backup failed)，旧版完好
 *   - 换装失败回滚：swap mv 失败 → 回滚 .old → failed(swap failed)
 *   - 只读卷拒装（M5）：appBundle 在 /Volumes 下 → failed(read-only volume)
 *
 * 中断注入手段（诚实可复现）：在生成脚本的 [stage] 标记行后注入「flag 文件暂停
 * 循环」（while [ -e flag ]; do sleep 0.05; done，测试夹具变换、脚本决策逻辑不变），
 * 测试轮询到目标状态后 kill 进程组（SIGKILL）或删 flag 放行。
 *
 * Mock 策略
 * ------------------------------------------------------------------
 * - 文件系统：每用例 mkdtempSync 独立临时目录，afterEach 清理。
 * - dmg：hdiutil create -srcfolder 生成真实 dmg（让 attach/ditto/detach 段真实
 *   执行，批次 3 §3.3.3-B 解包原语）；缺 hdiutil/ditto 则 it.skipIf 跳过。
 * - open 重启行：测试前替换为 echo（避免真启动 GUI），文档化确定性变换。
 * - parentPid：默认 '9999999'（超过 macOS/linux pid_max，kill -0 立即失败 =
 *   模拟「app 已退出」）；超时用例用真实存活进程模拟「app 未退出」。
 *
 * 与 updater-script.test.ts 的边界：那边字符串视角（守卫片段在不在），本文件
 * 执行视角（bash 跑不跑得通、分支真不真触发、终态对不对）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/updater-script-integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 文件级超时预算：用例构造真实 dmg 并经 hdiutil/ditto/shasum 全链执行，
// CI 的 mac runner 上 hdiutil 比本地慢约 3 倍（happy path 本地 ~7s、CI 实测 21-23s），
// vitest 默认 20s 在 CI 必撞线（2026-09-07 v0.9.15 post-merge CI 两连挂）；
// 60s = CI 最慢观测的 2.6 倍余量，M6（本地 17s 的固定等待窗口）同受覆盖
// 注意：用例级第三参显式超时会覆盖本预算——曾漂移出 13 处显式 20_000，
// 让 happy path 在 CI 仍撞 20s 线（2026-09-10）；本文件用例一律不写显式超时，
// 统一由这行管辖，新增用例也不要补第三参。
vi.setConfig({ testTimeout: 60_000 })
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import {
  buildUpdaterScript,
  buildLinuxUpdaterScript,
  type UpdaterScriptVars,
  type LinuxUpdaterScriptVars,
} from '../update/updater-script.js'

// ──────────────────────────────────────────────────────────────────
// 环境探测：哪些系统命令可用（决定哪些用例能真实跑）
// ──────────────────────────────────────────────────────────────────

/** 安全的 which：命令存在返回 true，否则 false（不抛异常）。 */
function hasCommand(cmd: string): boolean {
  // bash -c 单字符串形式避免「spawn shell:true + args」的 DEP0190 弃用警告；
  // 命令名是测试内常量、无注入风险。
  const r = spawnSync('bash', ['-c', `command -v ${cmd}`])
  return r.status === 0
}

const HAS_HDIUTIL = hasCommand('hdiutil') // 生成 dmg + 脚本挂载/卸载 + 磁盘满用例的小容量镜像
const HAS_DITTO = hasCommand('ditto')     // 脚本 dmg→staging 拷贝用（批次 3 解包原语）
const HAS_SHASUM = hasCommand('shasum')  // mac 脚本 sha256 用
const IS_MAC = process.platform === 'darwin'

// ──────────────────────────────────────────────────────────────────
// 临时目录生命周期
// ──────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'updater-int-'))
})

afterEach(() => {
  if (!tmpDir || !existsSync(tmpDir)) return
  // 磁盘镜像用例可能留下挂载点：先尝试卸载再删目录（失败仅告警，不让 teardown 掩盖用例结果）
  const mnt = path.join(tmpDir, 'mnt')
  if (existsSync(mnt) && IS_MAC && HAS_HDIUTIL) {
    spawnSync('hdiutil', ['detach', mnt, '-force'])
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch (e) {
    console.warn('[warn] tmpDir 清理失败（可能挂载点残留）:', e)
  }
})

// ──────────────────────────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────────────────────────

/** 计算文件 sha256 hex（64 位），与脚本里 shasum -a 256 等价。 */
function sha256OfFile(filePath: string): string {
  const h = crypto.createHash('sha256')
  h.update(readFileSync(filePath))
  return h.digest('hex')
}

/**
 * 构造最小 .app bundle（Contents/MacOS/<binaryName> + Info.plist）并打成真实 dmg。
 *
 * - dmg 根含 .app（hdiutil create -srcfolder <buildRoot>：镜像根 = 源目录内容），
 *   与脚本 S1 的 `ls -d "$MOUNT_DIR"/*.app` 定位链一致。
 * - 主二进制 chmod 755：脚本对解包产物做 `-x` 可执行检查（RI1 守卫），
 *   hdiutil 镜像保留 POSIX 权限位。writeFileSync 默认 0644，必须显式 chmod。
 */
function buildMinimalAppDmg(opts: {
  appBundleName?: string
  binaryName?: string
  /** 塞进 .app 根的版本标记文件内容（如 'NEW-V-B'），中断用例断言残留物完整性 */
  versionMarker?: string
  /** 主二进制填充大小（字节，随机不可压内容），磁盘满用例用 5MB 撑爆小卷 */
  binarySize?: number
  /** true = 空壳 .app（无 Contents/MacOS/<binary>），主二进制检查拦截用例用 */
  hollow?: boolean
} = {}): { dmgPath: string; appBundleName: string; binaryName: string; sha256: string } {
  const appBundleName = opts.appBundleName ?? 'TaiJi.app'
  const binaryName = opts.binaryName ?? 'TaiJi'
  const buildRoot = path.join(tmpDir, opts.hollow ? 'build-hollow' : 'build')
  const appDir = path.join(buildRoot, appBundleName)
  if (opts.hollow) {
    // 空壳：只有 Contents/Info.plist，无 MacOS/<binary>（RI1 误判成功防护用例）
    mkdirSync(path.join(appDir, 'Contents'), { recursive: true })
    writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), '{}\n')
  } else {
    mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), '{}\n')
    const binaryPath = path.join(appDir, 'Contents', 'MacOS', binaryName)
    if (opts.binarySize) {
      writeFileSync(binaryPath, crypto.randomBytes(opts.binarySize))
    } else {
      writeFileSync(binaryPath, '#!/bin/bash\necho fake app\n')
    }
    chmodSync(binaryPath, 0o755)
  }
  if (opts.versionMarker) {
    writeFileSync(path.join(appDir, 'VERSION_MARKER'), opts.versionMarker)
  }

  const dmgPath = path.join(tmpDir, `${appBundleName}.dmg`)
  const r = spawnSync('hdiutil', [
    'create', '-srcfolder', buildRoot, '-format', 'UDZO', '-ov', dmgPath,
  ])
  if (r.status !== 0) {
    throw new Error(`hdiutil create 失败 status=${r.status} stderr=${r.stderr?.toString()}`)
  }
  return { dmgPath, appBundleName, binaryName, sha256: sha256OfFile(dmgPath) }
}

function writeScriptToTmp(script: string, name = 'updater.sh'): string {
  const p = path.join(tmpDir, name)
  writeFileSync(p, script, { mode: 0o755 })
  return p
}

/**
 * 同步执行 bash 脚本（spawnSync，timeout 硬上限）。
 * 超时（SIGTERM）明确抛错——避免被当成正常 exit 误判为通过（假绿）。
 */
const BASH_TIMEOUT_MS = 15_000

function runBash(scriptPath: string, timeoutMs = BASH_TIMEOUT_MS): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [scriptPath], { cwd: tmpDir, encoding: 'utf8', timeout: timeoutMs })
  if (r.signal === 'SIGTERM') {
    throw new Error(
      `bash 脚本超时（${timeoutMs}ms）：${scriptPath}\nstdout: ${r.stdout ?? ''}\nstderr: ${r.stderr ?? ''}`,
    )
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * detached 执行 bash 脚本（中断注入用）：返回子进程与 exit Promise。
 * 后续用 process.kill(-pid, SIGKILL) 杀整个进程组（bash + 注入的暂停 sleep）。
 */
function runBashDetached(scriptPath: string): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn('bash', [scriptPath], { cwd: tmpDir, stdio: 'ignore', detached: true })
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code))
  })
  return { child, exited }
}

/** 杀整个进程组（bash + 暂停循环的 sleep），双保险兜底子进程自身。 */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
  } catch { /* 进程组已不存在 */ }
  try {
    child.kill('SIGKILL')
  } catch { /* 已退出 */ }
}

/**
 * 轮询等条件成立，超时抛错（快速失败暴露问题，不挂死整个 run）。
 * 默认 15s：dmg 解包链（hdiutil create/attach/ditto，批次 3）单用例实测 ~8s，
 * 全量 run 并发负载下 8s 会误报超时（成功路径立即返回，超时只影响失败路径速度）。
 */
async function waitFor(desc: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor 超时: ${desc}`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * 在生成脚本的 [stage] 标记行后注入「flag 文件暂停循环」（测试夹具变换）：
 *   while [ -e "<flagPath>" ]; do sleep 0.05; done
 * 测试轮询到目标状态后：删 flag = 放行继续执行；kill 进程组 = 模拟中断。
 * 脚本决策逻辑（守卫/mv 顺序/回滚）零改动。
 */
function pauseAfterStage(script: string, stage: string, flagPath: string): string {
  const anchor = `[stage] ${stage} begin"`
  if (!script.includes(anchor)) {
    throw new Error(`stage 锚点不存在: ${anchor}`)
  }
  return script.replace(
    anchor,
    `${anchor}\nwhile [ -e "${flagPath}" ]; do sleep 0.05; done  # [test] 中断注入暂停（flag 文件存在即暂停）`,
  )
}

/**
 * 替换 mac 脚本重启行 `open "$APP"`（真执行会拉 GUI，与测试 purity 冲突；
 * 重启语义由字符串断言覆盖——open 无 -n 已在单测断言）。
 */
function stripOpenLine(script: string): string {
  return script.replace(/^open "\$APP"$/m, 'echo "[test] skip open (would launch GUI)"')
}

/** 剥掉 linux 脚本 sha256 校验段（聚焦 mv 决策树的用例用；sha 语义由 mac 侧覆盖）。 */
function stripLinuxSha(script: string): string {
  return script.replace(/\nACTUAL="\$\(sha256sum[\s\S]*?\nfi\n/, '\necho "[test] skip sha check (covered by mac integration suite)"\n')
}

/** 剥掉 linux 脚本末尾后台重启行（不真启动 AppImage）。 */
function stripLinuxRestart(script: string): string {
  return script.replace(/^"[^"]+" &\s*$/m, 'echo "[test] skip AppImage spawn"')
}

/** 把 60s 超时（120 轮）压成 2 轮（1s），让超时 abort 用例 1s 出结果。 */
function shortenWaitLimit(script: string): string {
  if (!script.includes('-gt 120')) throw new Error('未找到等待上限 -gt 120（模板变了？）')
  return script.replace('-gt 120', '-gt 2')
}

/** mac 用标准 vars（parentPid 默认死 PID：kill -0 立即失败 = 模拟 app 已退出）。 */
function makeMacVars(opts: {
  dmgPath: string
  sha256: string
  appBundleName?: string
  binaryName?: string
  appBundle?: string
  parentPid?: string
  targetVersion?: string
}): UpdaterScriptVars {
  const appBundleName = opts.appBundleName ?? 'TaiJi.app'
  const binaryName = opts.binaryName ?? 'TaiJi'
  return {
    appBundle: opts.appBundle ?? path.join(tmpDir, 'installed', appBundleName),
    dmgPath: opts.dmgPath,
    sha256: opts.sha256,
    logPath: path.join(tmpDir, 'updater.log'),
    resultPath: path.join(tmpDir, 'update-result.json'),
    appName: binaryName,
    targetVersion: opts.targetVersion ?? '0.9.0-integration',
    parentPid: opts.parentPid ?? '9999999',
  }
}

// ════════════════════════════════════════════════════════════════
// bash 语法检查（不依赖 hdiutil/ditto，最稳）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: bash 语法检查', () => {
  it('mac 脚本：buildUpdaterScript 产物 bash -n 通过（语法正确、无残留占位符炸）', () => {
    const script = buildUpdaterScript(makeMacVars({ dmgPath: '/tmp/x.dmg', sha256: 'a'.repeat(64) }))
    const scriptPath = writeScriptToTmp(script)

    expect(script, '执行产物不应残留 {{...}} 占位符').not.toMatch(/\{\{[^}]+\}\}/)
    const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
    expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
  })

  it('linux 脚本：buildLinuxUpdaterScript 产物 bash -n 通过', () => {
    const script = buildLinuxUpdaterScript({
      appImagePath: path.join(tmpDir, 'x.appimage'),
      newFilePath: path.join(tmpDir, 'y.appimage'),
      sha256: 'a'.repeat(64),
      logPath: path.join(tmpDir, 'l.log'),
      resultPath: path.join(tmpDir, 'r.json'),
      targetVersion: '0.9.0-int',
      parentPid: '9999999',
    })
    const scriptPath = writeScriptToTmp(script, 'linux-updater.sh')
    expect(script).not.toMatch(/\{\{[^}]+\}\}/)

    const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
    expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
  })

  it('mac 脚本：sha256 含特殊字符也不破坏 bash 语法（防御注入）', () => {
    const weirdButHex = '0'.repeat(64)
    const script = buildUpdaterScript(makeMacVars({ dmgPath: '/tmp/x.dmg', sha256: weirdButHex }))
    const r = spawnSync('bash', ['-n', writeScriptToTmp(script)], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════
// MAC 脚本：端到端 happy path（真 .app + 真 dmg + 真 attach/ditto/detach）
// ════════════════════════════════════════════════════════════════
describe.skipIf(!IS_MAC || !HAS_HDIUTIL || !HAS_DITTO || !HAS_SHASUM)('updater-script integration: mac 端到端', () => {
  it(
    'happy path（M1 脚本侧）：S0→S5 走通 → exit 0、新 .app 就位、result done（合法 JSON）、无任何残留',
    () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg({
        versionMarker: 'NEW-V-B',
      })
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName })
      const appDir = path.dirname(vars.appBundle)
      mkdirSync(appDir, { recursive: true })
      // 预置：旧 .app（OLD_MARKER）+ 上次残留的过期 .old（$APP 在位时应被清掉）
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')
      mkdirSync(`${vars.appBundle}.old`, { recursive: true })
      writeFileSync(path.join(`${vars.appBundle}.old`, 'STALE'), 'stale-backup')

      const script = stripOpenLine(buildUpdaterScript(vars))
      const r = runBash(writeScriptToTmp(script))

      expect(r.status, `期望 exit 0，stderr=${r.stderr}`).toBe(0)

      // 新 .app 就位且是完整新版
      expect(existsSync(vars.appBundle), '新 .app 应就位').toBe(true)
      expect(existsSync(path.join(vars.appBundle, 'Contents', 'Info.plist'))).toBe(true)
      expect(readFileSync(path.join(vars.appBundle, 'VERSION_MARKER'), 'utf8')).toBe('NEW-V-B')
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(false)
      // 可执行位保留（-x 检查的对象）
      const mode = statSync(path.join(vars.appBundle, 'Contents', 'MacOS', binaryName)).mode & 0o777
      expect(mode & 0o111, '主二进制应可执行').toBeTruthy()

      // 终态无残留（M1：ls /Applications 无 .old/.new 残留）
      expect(existsSync(`${vars.appBundle}.old`), '.old 应被清理').toBe(false)
      expect(existsSync(`${vars.appBundle}.new`), '.new 不应残留').toBe(false)
      expect(existsSync(path.join(appDir, `.staging.${appBundleName}`)), 'staging 不应残留').toBe(false)

      // result done 且是合法 JSON（printf 原子写产出有效性）
      expect(existsSync(vars.resultPath)).toBe(true)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; version: string }
      expect(result.status).toBe('done')
      expect(result.version).toBe('0.9.0-integration')
      // tmp 文件已被 rename 走
      expect(existsSync(`${vars.resultPath}.tmp`), 'result .tmp 不应残留').toBe(false)

      // log 含完整 stage 轨迹
      const log = readFileSync(vars.logPath, 'utf8')
      expect(log).toContain('start update')
      for (const stage of ['S1 extract', 'S2 promote', 'S3 backup', 'S4 swap', 'S5 finalize']) {
        expect(log, `log 应含 ${stage}`).toContain(`[stage] ${stage}`)
      }
      expect(log).toContain('update done')

      // 批次 5 互斥：退出时 pid 文件被 trap 清理（验收①退出侧）
      expect(existsSync(path.join(tmpDir, 'updater.pid')), '退出后 pid 文件应被清理').toBe(false)
    },
  )

  it(
    'sha mismatch：exit 1、旧 .app 完好、不产生 .old/staging、result failed 且为合法 JSON',
    () => {
      const { dmgPath, appBundleName } = buildMinimalAppDmg()
      const vars = makeMacVars({ dmgPath, sha256: '0'.repeat(64) })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'preserved')

      const script = stripOpenLine(buildUpdaterScript(vars))
      const r = runBash(writeScriptToTmp(script))

      expect(r.status, 'sha 失败应 exit 1').toBe(1)
      expect(existsSync(vars.appBundle)).toBe(true)
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(true)
      expect(existsSync(`${vars.appBundle}.old`)).toBe(false)

      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.status).toBe('failed')
      expect(result.error).toBe('sha mismatch')
    },
  )

  it(
    '版本号含引号污染 → result 仍是合法 JSON 且结构不被注入（printf %s 参数通道回归）',
    () => {
      // write_result 的 printf format 曾把版本号放 format 字符串（printf 会处理 \"
      // 转义 → 污染值可注入 JSON 结构字段）。回归断言：污染版本只能成为字符串内容。
      const evilVersion = '0.9.0","injected":"pwned'
      const payload = path.join(tmpDir, 'payload.bin')
      writeFileSync(payload, 'tampered')
      const vars = makeMacVars({ dmgPath: payload, sha256: '0'.repeat(64), targetVersion: evilVersion })

      const script = stripOpenLine(buildUpdaterScript(vars))
      const r = runBash(writeScriptToTmp(script))

      expect(r.status).toBe(1)
      const raw = readFileSync(vars.resultPath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(Object.keys(parsed).sort()).toEqual(['at', 'error', 'status', 'version'])
      expect(parsed.version).toBe(evilVersion)
      expect(parsed.injected).toBeUndefined()
    },
  )

  it(
    'dmg 挂载失败（伪 dmg，sha 对）：exit 1、旧 .app 完好、error=dmg mount failed（含恢复指引）',
    () => {
      // sha 对、但内容不是合法 dmg：让校验段过、挂载段炸（attach 失败分支，§3.3.3-B）
      const { dmgPath, appBundleName } = buildMinimalAppDmg()
      writeFileSync(dmgPath, 'this is not a valid dmg file content')
      const realSha = sha256OfFile(dmgPath)

      const vars = makeMacVars({ dmgPath, sha256: realSha, appBundleName })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'untouched')

      const script = stripOpenLine(buildUpdaterScript(vars))
      const r = runBash(writeScriptToTmp(script))

      expect(r.status, 'dmg 挂载失败应 exit 1').toBe(1)
      // 正式位置零接触（G1：S4 前失败 = 旧版完好）
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(true)
      // staging 未产生（挂载失败在 ditto 之前；S1 前残留清理后保持空）
      expect(existsSync(path.join(tmpDir, 'installed', `.staging.${appBundleName}`))).toBe(false)

      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.status).toBe('failed')
      // 错误码 + 恢复动作（r2 审查边界：同 inode dmg 滞留挂载 → 资源忙，指引重启/手动 detach）
      expect(result.error).toContain('dmg mount failed')
      expect(result.error).toContain('hdiutil detach')
    },
  )

  it(
    '解包产物缺主二进制（dmg 内只有空壳 .app）→ exit 1、error=extract failed、旧 .app 完好（RI1 误判成功防护）',
    () => {
      // 构造「合法 dmg 但 .app 没有 Contents/MacOS/<bin>」：attach/ditto 成功、主二进制检查拦截。
      const appBundleName = 'TaiJi.app'
      const { dmgPath, sha256 } = buildMinimalAppDmg({ appBundleName, hollow: true })

      const vars = makeMacVars({
        dmgPath,
        sha256,
        appBundleName,
        binaryName: 'TaiJi',
      })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'untouched')

      const script = stripOpenLine(buildUpdaterScript(vars))
      const r = runBash(writeScriptToTmp(script))

      expect(r.status, '主二进制缺失应 exit 1').toBe(1)
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(true)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.error).toBe('extract failed')
    },
  )
})

// ════════════════════════════════════════════════════════════════
// MAC 脚本：状态机中断注入（kill 进程组）与失败分支
// ════════════════════════════════════════════════════════════════
describe.skipIf(!IS_MAC || !HAS_HDIUTIL || !HAS_DITTO || !HAS_SHASUM)('updater-script integration: mac 状态机中断注入', () => {
  it(
    'S1 中断（M2 脚本侧）：staging 解压完成后 kill → 正式位置零接触 + staging 残留 + result 未写',
    async () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg({ versionMarker: 'NEW-V-B' })
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName })
      const appDir = path.dirname(vars.appBundle)
      const stagingDir = path.join(appDir, `.staging.${appBundleName}`)
      mkdirSync(appDir, { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

      const flag = path.join(tmpDir, 'pause-S2.flag')
      writeFileSync(flag, '')
      const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S2 promote', flag)
      const { child, exited } = runBashDetached(writeScriptToTmp(script))

      // 等 S1 完成（staging 内出现完整新 .app），此时脚本停在 S2 前的暂停循环
      await waitFor('staging 主二进制就位', () => existsSync(path.join(stagingDir, appBundleName, 'Contents', 'MacOS', binaryName)))
      killGroup(child)
      await exited

      // 正式位置零接触（G1 结构不变量：S4 前 $APP 完整旧版）
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER')), '旧 .app 必须完好').toBe(true)
      // 批次 5 互斥（验收①运行侧）：脚本运行中 pid 文件存在（新实例据此 defer 清理）
      const pidFile = path.join(tmpDir, 'updater.pid')
      expect(existsSync(pidFile), '运行中应有 pid 文件').toBe(true)
      // S1 中断后果（状态机表）：残留 staging，正式位置无损
      expect(existsSync(stagingDir), 'staging 应残留（下次启动清理）').toBe(true)
      expect(existsSync(`${vars.appBundle}.new`), '.new 不应产生').toBe(false)
      expect(existsSync(`${vars.appBundle}.old`), '.old 不应产生').toBe(false)
      // result 未写（脚本被杀，任何状态都未落盘）
      expect(existsSync(vars.resultPath), 'result 不应被写').toBe(false)
    },
  )

  it(
    'S3→S4 残余窗口中断（M3b 脚本侧）：备份与换装之间 kill → $APP 缺失 + .old/.new 双份完整',
    async () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg({ versionMarker: 'NEW-V-B' })
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName })
      const appDir = path.dirname(vars.appBundle)
      mkdirSync(appDir, { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

      const flag = path.join(tmpDir, 'pause-S4.flag')
      writeFileSync(flag, '')
      const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S4 swap', flag)
      const { child, exited } = runBashDetached(writeScriptToTmp(script))

      // 等 S3 完成（$APP 已 mv 到 .old），脚本停在 S4 前的暂停循环
      await waitFor('S3 备份完成（.old 就位 + $APP 缺失）', () =>
        existsSync(`${vars.appBundle}.old`) && !existsSync(vars.appBundle))
      killGroup(child)
      await exited

      // 诚实边界（§3.3.4）：$APP 缺失、app 无法启动——但残留物必须双份完整
      expect(existsSync(vars.appBundle), '残余窗口内 $APP 缺失（预期内）').toBe(false)
      expect(existsSync(path.join(`${vars.appBundle}.old`, 'OLD_MARKER')), '.old = 完整 vA').toBe(true)
      expect(existsSync(path.join(`${vars.appBundle}.new`, 'VERSION_MARKER')), '.new = 完整 vB').toBe(true)
      expect(readFileSync(path.join(`${vars.appBundle}.old`, 'OLD_MARKER'), 'utf8')).toBe('old-vA')
      expect(readFileSync(path.join(`${vars.appBundle}.new`, 'VERSION_MARKER'), 'utf8')).toBe('NEW-V-B')
      // 手动恢复出口存在的前提：staging 已消费完（只剩 .old/.new 两份）
      expect(existsSync(path.join(appDir, `.staging.${appBundleName}`))).toBe(false)
      // result 未写（脚本死在写 done 之前）
      expect(existsSync(vars.resultPath)).toBe(false)
    },
  )

  it(
    'S4 后 done 前中断（M3a 脚本侧）：换装完成 kill → $APP 完整新版 + .old 在（self-healer 可判定状态）',
    async () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg({ versionMarker: 'NEW-V-B' })
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

      const flag = path.join(tmpDir, 'pause-S5.flag')
      writeFileSync(flag, '')
      const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S5 finalize', flag)
      const { child, exited } = runBashDetached(writeScriptToTmp(script))

      // 等 S4 完成（$APP 已是新版），脚本停在 S5 前的暂停循环
      await waitFor('S4 换装完成（$APP 出现新版标记）', () =>
        existsSync(path.join(vars.appBundle, 'VERSION_MARKER')))
      killGroup(child)
      await exited

      // $APP 完整新版（S4 原子换装已生效，无半截 bundle）
      expect(readFileSync(path.join(vars.appBundle, 'VERSION_MARKER'), 'utf8')).toBe('NEW-V-B')
      expect(existsSync(path.join(vars.appBundle, 'Contents', 'MacOS', binaryName))).toBe(true)
      // .old 未及清理（S5 没跑）→ replacing + .old 在 + $APP 完整 → app 内 self-healer
      // 按 M3a 语义安全侧处理（回滚到 vA 或保留新版，属批次 5 app 侧行为）
      expect(existsSync(`${vars.appBundle}.old`), '.old 应残留（done 未写，状态留给 self-healer）').toBe(true)
      // done 未写
      expect(existsSync(vars.resultPath), 'result 不应被写').toBe(false)
    },
  )

  it(
    '等待超时 abort（M6）：父进程不退 → failed(app still running)、旧 .app 完好、运行中进程不被打扰',
    async () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg()
      // 真实存活的「父进程」：sleep 30 模拟挂住不退的 app。
      // noop exit listener 必须挂：否则 sleep 退出后成为 vitest 进程的僵尸（未收割），
      // bash kill -0 对僵尸恒真，等待循环永远不 break。
      const parent = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
      parent.once('exit', () => {})
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName, parentPid: String(parent.pid) })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'untouched')

      try {
        // 120 轮压成 2 轮（1s），1s 出超时结论
        const script = shortenWaitLimit(stripOpenLine(buildUpdaterScript(vars)))
        const started = Date.now()
        const r = runBash(writeScriptToTmp(script))
        const elapsed = Date.now() - started

        expect(r.status, '超时应 exit 1').toBe(1)
        expect(elapsed, '应在压缩后的等待上限附近 abort（≈1s）而不是秒过').toBeGreaterThanOrEqual(900)
        expect(() => process.kill(parent.pid!, 0), '父进程应仍存活（脚本不得杀/伤运行中进程）').not.toThrow()
        expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER')), '运行中 app 的底座不被拆').toBe(true)

        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
        expect(result.status).toBe('failed')
        expect(result.error).toBe('app still running')
      } finally {
        try { if (parent.pid) process.kill(parent.pid, 'SIGKILL') } catch { /* 已退 */ }
      }
    },
  )

  it(
    '等待退出正向路径：父进程 1s 后退出 → 脚本等到再继续 → 升级完成（kill -0 立即返回语义，P12）',
    async () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg({ versionMarker: 'NEW-V-B' })
      // 父进程用「孤儿化」模式：sleep 的 stdout/stderr 必须全部重定向 —— 否则
      // stderr 仍持有 spawnSync 的管道写端，spawnSync 会阻塞到 sleep 死亡才返回
      // （捕获到的 pid 已死，等待语义完全测不到）。父 bash 立即退出 → sleep 归
      // launchd 收割，无僵尸 → kill -0 语义真实。
      const parentPid = spawnSync('bash', ['-c', 'sleep 1 >/dev/null 2>&1 & pid=$!; echo $pid'])
        .stdout.toString().trim()
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName, parentPid })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

      const script = stripOpenLine(buildUpdaterScript(vars))
      const started = Date.now()
      const r = runBash(writeScriptToTmp(script))
      const elapsed = Date.now() - started

      expect(r.status, `期望 exit 0，stderr 见 log：${existsSync(vars.logPath) ? readFileSync(vars.logPath, 'utf8').slice(-400) : ''}`).toBe(0)
      // 脚本确实等了父进程（不是秒过）：父进程 1s 后才退出
      expect(elapsed, '应等待父进程退出（≥900ms）').toBeGreaterThanOrEqual(900)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string }
      expect(result.status).toBe('done')
    },
  )

  it(
    '备份失败 abort（RM7）：APP_DIR 只读 → failed(backup failed)、旧 .app 完好、.old 不被破坏',
    async () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg({ versionMarker: 'NEW-V-B' })
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName })
      const appDir = path.dirname(vars.appBundle)
      mkdirSync(appDir, { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')
      // 预置 .old 为普通文件：S3 会先 rm -rf 它（被只读目录挡住）→ 备份 mv 也失败
      writeFileSync(`${vars.appBundle}.old`, 'cannot-be-replaced')

      const flag = path.join(tmpDir, 'pause-S3.flag')
      writeFileSync(flag, '')
      const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S3 backup', flag)
      const { child, exited } = runBashDetached(writeScriptToTmp(script))

      // 等 S2 完成（.new 就位），趁暂停把 APP_DIR 改只读（owner 555：不可建/删条目）
      await waitFor('S2 完成（.new 就位）', () => existsSync(`${vars.appBundle}.new`))
      chmodSync(appDir, 0o555)
      rmSync(flag) // 放行 → S3 rm/mv 双双 EACCES → backup failed
      await exited

      chmodSync(appDir, 0o755) // 先恢复权限，保证 afterEach 能清理

      // 预置的 .old 文件未被破坏（rm/mv 均被只读目录拦下，内容原样）
      expect(readFileSync(`${vars.appBundle}.old`, 'utf8')).toBe('cannot-be-replaced')
      // 旧 .app 完好（备份失败 → 绝不进入换装）
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER')), '备份失败后旧 .app 必须完好').toBe(true)
      expect(existsSync(`${vars.appBundle}.new`), '.new 残留（留待下次清理，不致命）').toBe(true)

      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.status).toBe('failed')
      expect(result.error).toBe('backup failed')
    },
  )

  it(
    '换装失败回滚：S4 mv 失败 → 回滚 .old 成功 → failed(swap failed) + 旧 .app 完整恢复',
    async () => {
      const { dmgPath, sha256, appBundleName, binaryName } = buildMinimalAppDmg({ versionMarker: 'NEW-V-B' })
      const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName })
      mkdirSync(path.dirname(vars.appBundle), { recursive: true })
      mkdirSync(vars.appBundle, { recursive: true })
      writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA-rollback')

      const flag = path.join(tmpDir, 'pause-S4b.flag')
      writeFileSync(flag, '')
      const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S4 swap', flag)
      const { child, exited } = runBashDetached(writeScriptToTmp(script))

      // 等 S3 完成，趁暂停删掉 .new（模拟 staging 内容消失 → S4 mv 必失败）
      await waitFor('S3 完成', () => existsSync(`${vars.appBundle}.old`) && !existsSync(vars.appBundle))
      rmSync(`${vars.appBundle}.new`, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(flag) // 放行 → S4 mv 源缺失失败 → 回滚 .old
      await exited

      // 回滚成功：旧 .app 完整回到正式位置
      expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER')), '回滚后旧 .app 必须在位').toBe(true)
      expect(readFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'utf8')).toBe('old-vA-rollback')
      expect(existsSync(`${vars.appBundle}.old`), '回滚 mv 后 .old 应被消费').toBe(false)

      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.status).toBe('failed')
      expect(result.error).toBe('swap failed')
    },
  )

  it(
    '只读卷拒装（M5）：appBundle 位于 /Volumes → failed(read-only volume)、不触碰任何路径',
    () => {
      // 只读检测是脚本第一步（case /Volumes/*），在任何文件系统操作前退出——
      // 因此可以用 /Volumes 下的虚拟路径真实执行而不需要真挂载。
      const { dmgPath, sha256, binaryName } = buildMinimalAppDmg()
      const vars = makeMacVars({
        dmgPath,
        sha256,
        appBundle: '/Volumes/TaiJi-Integration-Test/TaiJi.app',
        binaryName,
      })

      const script = stripOpenLine(buildUpdaterScript(vars))
      const r = runBash(writeScriptToTmp(script))

      expect(r.status, '只读卷应 exit 1').toBe(1)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.status).toBe('failed')
      expect(result.error).toBe('read-only volume')
      const log = readFileSync(vars.logPath, 'utf8')
      expect(log).toContain('read-only volume')
      // 不应进入后续阶段（等待/解压都没跑）
      expect(log).not.toContain('[stage] S1 extract')
    },
  )
})

// ════════════════════════════════════════════════════════════════
// MAC 脚本：磁盘满（M4 + P10：ditto 磁盘满必须非 0 退出）
// ════════════════════════════════════════════════════════════════
describe.skipIf(!IS_MAC || !HAS_HDIUTIL || !HAS_DITTO || !HAS_SHASUM)('updater-script integration: mac 磁盘满（P10）', () => {
  it(
    '小容量卷上 ditto 拷入 5MB 不可压产物 → ENOSPC → ditto 非零退出、error=ditto copy failed、旧 app 完好',
    (ctx) => {
      // 3MB HFS+ 镜像当「应用卷」；5MB 随机字节二进制必撑爆（ditto 无压缩）。
      // 更新 dmg 挂载在 $TMPDIR（S1 选址约束），只有 ditto 落 staging 在小卷上。
      const imgPath = path.join(tmpDir, 'tiny.dmg')
      const mountDir = path.join(tmpDir, 'mnt')
      mkdirSync(mountDir, { recursive: true })

      const cr = spawnSync('hdiutil', ['create', '-size', '3m', '-fs', 'HFS+', '-volname', 'UPDTEST', '-ov', imgPath])
      if (cr.status !== 0) ctx.skip(`hdiutil create 失败: ${cr.stderr?.toString()}`)
      const at = spawnSync('hdiutil', ['attach', imgPath, '-mountpoint', mountDir, '-nobrowse'])
      if (at.status !== 0) ctx.skip(`hdiutil attach 失败: ${at.stderr?.toString()}`)

      try {
        // 旧 app（小，能装下）挂在卷上
        const appBundleName = 'TaiJi.app'
        const appBundle = path.join(mountDir, appBundleName)
        mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true })
        writeFileSync(path.join(appBundle, 'OLD_MARKER'), 'old-vA-on-tiny-vol')

        const { dmgPath, sha256, binaryName } = buildMinimalAppDmg({ appBundleName, binaryName: 'TaiJi', binarySize: 5 * 1024 * 1024 })
        const vars = makeMacVars({ dmgPath, sha256, appBundleName, binaryName, appBundle })

        const script = stripOpenLine(buildUpdaterScript(vars))
        const r = runBash(writeScriptToTmp(script), 30_000)

        expect(r.status, '磁盘满应 exit 1').toBe(1)
        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
        expect(result.status).toBe('failed')
        expect(result.error).toBe('ditto copy failed')
        // 旧 app 完好（G1：失败路径上正式位置是完整旧版）
        expect(existsSync(path.join(appBundle, 'OLD_MARKER')), '旧 app 必须完好').toBe(true)

        // P10 本体断言：ditto 自己必须报错（日志含 ditto 错误输出），而不是靠
        // 主二进制检查兜底——若 ditto 静默返回 0，主二进制检查才兜底拦截。
        const log = readFileSync(vars.logPath, 'utf8')
        expect(log, 'ditto 应在磁盘满时输出错误（P10）').toMatch(/ditto:|No space left|Disk Full|I\/O error|error/i)
      } finally {
        spawnSync('hdiutil', ['detach', mountDir, '-force'])
      }
    },
    60_000,
  )
})

// ════════════════════════════════════════════════════════════════
// LINUX 脚本：mv 备份/回滚决策树 + 守卫（不真 spawn AppImage）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: linux mv 备份/回滚', () => {
  function makeLinuxVars(opts: { appImagePath?: string; newFilePath?: string } = {}): LinuxUpdaterScriptVars {
    return {
      appImagePath: opts.appImagePath ?? path.join(tmpDir, 'TaiJi-x86_64.AppImage'),
      newFilePath: opts.newFilePath ?? path.join(tmpDir, 'update', 'TaiJi-x86_64.AppImage'),
      sha256: 'a'.repeat(64), // mv 决策树用例剥离 sha 段，占位满足类型
      logPath: path.join(tmpDir, 'updater-linux.log'),
      resultPath: path.join(tmpDir, 'update-result.json'),
      targetVersion: '0.9.0-int',
      parentPid: '9999999',
    }
  }

  /** linux 主体脚本：剥 sha 段（sha 语义由 mac 侧覆盖）+ 剥后台重启行。 */
  function buildLinuxBodyScript(vars: LinuxUpdaterScriptVars): string {
    return stripLinuxRestart(stripLinuxSha(buildLinuxUpdaterScript(vars)))
  }

  it('happy path：备份 + 换装 + chmod 755 + status=done + .old 清理', () => {
    const vars = makeLinuxVars()
    writeFileSync(vars.appImagePath, 'OLD AppImage content')
    mkdirSync(path.dirname(vars.newFilePath), { recursive: true })
    writeFileSync(vars.newFilePath, 'NEW AppImage content')

    const scriptPath = writeScriptToTmp(buildLinuxBodyScript(vars), 'linux-updater.sh')
    const r = runBash(scriptPath)

    expect(r.status, `期望 exit 0，stderr=${r.stderr}`).toBe(0)
    expect(existsSync(vars.appImagePath)).toBe(true)
    expect(readFileSync(vars.appImagePath, 'utf8')).toBe('NEW AppImage content')
    expect(existsSync(`${vars.appImagePath}.old`)).toBe(false)
    const mode = statSync(vars.appImagePath).mode & 0o777
    expect(mode, `chmod 应为 755，实际=${mode.toString(8)}`).toBe(0o755)
    const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string }
    expect(result.status).toBe('done')
  })

  it('mv 失败回滚：新文件不存在 → exit 1、旧 AppImage 恢复、error=mv failed', () => {
    const vars = makeLinuxVars()
    writeFileSync(vars.appImagePath, 'OLD AppImage content')
    // 不创建 newFilePath → S4 mv 必失败 → 回滚

    const scriptPath = writeScriptToTmp(buildLinuxBodyScript(vars), 'linux-updater.sh')
    const r = runBash(scriptPath)

    expect(r.status, 'mv 失败应 exit 1').toBe(1)
    expect(existsSync(vars.appImagePath), '旧 AppImage 应被回滚恢复').toBe(true)
    expect(readFileSync(vars.appImagePath, 'utf8')).toBe('OLD AppImage content')
    expect(existsSync(`${vars.appImagePath}.old`), '回滚后 .old 应被 mv 走').toBe(false)
    const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
    expect(result.error).toBe('mv failed')
  })

  it('只读检测：APP_DIR 不可写 → exit 1、error=read-only volume、不动任何文件', () => {
    const appDir = path.join(tmpDir, 'readonly-mount')
    mkdirSync(appDir, { recursive: true })
    const vars = makeLinuxVars({ appImagePath: path.join(appDir, 'TaiJi-x86_64.AppImage') })
    writeFileSync(vars.appImagePath, 'OLD content')

    chmodSync(appDir, 0o555)
    try {
      const scriptPath = writeScriptToTmp(buildLinuxBodyScript(vars), 'linux-updater.sh')
      const r = runBash(scriptPath)
      expect(r.status, '只读目录应 exit 1').toBe(1)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.error).toBe('read-only volume')
      // 只读检测在等待/sha/备份之前 → .old 不应产生
      expect(existsSync(`${vars.appImagePath}.old`)).toBe(false)
    } finally {
      chmodSync(appDir, 0o755)
    }
  })

  it('等待超时 abort：父进程不退 → failed(app still running)', async () => {
    const vars = makeLinuxVars()
    writeFileSync(vars.appImagePath, 'OLD AppImage content')
    mkdirSync(path.dirname(vars.newFilePath), { recursive: true })
    writeFileSync(vars.newFilePath, 'NEW AppImage content')

    const parent = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    parent.once('exit', () => {})
    const timedVars: LinuxUpdaterScriptVars = { ...vars, parentPid: String(parent.pid) }
    try {
      const script = shortenWaitLimit(buildLinuxBodyScript(timedVars))
      const scriptPath = writeScriptToTmp(script, 'linux-updater.sh')
      const r = runBash(scriptPath)
      expect(r.status, '超时应 exit 1').toBe(1)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.error).toBe('app still running')
      expect(readFileSync(vars.appImagePath, 'utf8')).toBe('OLD AppImage content')
    } finally {
      try { if (parent.pid) process.kill(parent.pid, 'SIGKILL') } catch { /* 已退 */ }
    }
  })
})

// ════════════════════════════════════════════════════════════════
// 脚本依赖的 CLI 工具可用性（失败原因可读性）
// ════════════════════════════════════════════════════════════════
describe('updater-script integration: 脚本依赖的 CLI 工具', () => {
  it('shasum 可用（mac 脚本 sha256 校验依赖）', () => {
    expect(HAS_SHASUM, 'shasum 应在 PATH 中（macOS 标配）').toBe(true)
  })

  // hdiutil/ditto 是 macOS-only 工具：test-main job 在 ubuntu（ci.yml「只跑 ubuntu
  // 上能跑的子集」）上必然缺失，非 mac 跳过；mac 上仍实跑守护解包原语依赖。
  it.skipIf(!IS_MAC)('hdiutil + ditto 可用（mac 脚本 dmg 挂载/拷贝/卸载依赖，批次 3 解包原语）', () => {
    if (!HAS_HDIUTIL || !HAS_DITTO) {
      console.warn('[warn] hdiutil/ditto 不在 PATH，mac 端到端用例已跳过')
    }
    expect(HAS_HDIUTIL, 'hdiutil 应在 PATH 中（macOS 标配）').toBe(true)
    expect(HAS_DITTO, 'ditto 应在 PATH 中（macOS 标配）').toBe(true)
  })
})
