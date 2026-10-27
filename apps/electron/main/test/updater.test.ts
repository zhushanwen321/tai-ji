// updater.test.ts —— electron-main-test C08 簇合并产物（round5-G）。
// 共同被测业务模块：`update/updater-script.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - test/updater-script-integration.test.ts（23 用例，skip 18）
//   - test/updater-script.test.ts（12 用例，skip 0）

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../test-guard/integration-gate.ts'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, statSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { buildUpdaterScript, buildLinuxUpdaterScript, type UpdaterScriptVars, type LinuxUpdaterScriptVars } from '../update/updater-script'

// ======== 来源：updater-script-integration.test.ts ========
describe("updater-script-integration", () => {
  // 文件级超时预算：管辖四段集成门控 describe 的真执行用例（本地默认跳过时不生效）。
  // 用例构造真实 dmg 并经 hdiutil/ditto/shasum 全链执行，
  // CI 的 mac runner 上 hdiutil 比本地慢约 3 倍（happy path 本地 ~7s、CI 实测 21-23s），
  // vitest 默认 20s 在 CI 必撞线（2026-09-07 v0.9.15 post-merge CI 两连挂）；
  // 60s = CI 最慢观测的 2.6 倍余量，M6（本地 17s 的固定等待窗口）同受覆盖
  // 注意：用例级第三参显式超时会覆盖本预算——曾漂移出 13 处显式 20_000，
  // 让 happy path 在 CI 仍撞 20s 线（2026-09-10）；除既有存量外不要补第三参，
  // 统一由这行管辖，新增用例也不要写显式超时。
  //
  // maxConcurrency=3：concurrent 段的并发度封顶（默认 5）。该上限是文件级全局
  // 封顶——多个 concurrent 段之间会交叠（后段用例在前段长用例占槽时即开跑，
  // 探针实测），全部并发用例共享同一 3 槽池。3 的依据：round3-a 探针实测并发 3
  // 下独立副本 attach 零失败、总墙钟低于串行和（磁盘与 diskimages-helper 均未见
  // 全局串行化）；再高对 waitFor 链（30s 预算）的负载膨胀不可控（探针并发 3 尖峰
  // 轮单次 attach 已可至 3.65x）。另注意槽排队时间计入用例耗时（60s 预算内）。
  vi.setConfig({ testTimeout: 60_000, maxConcurrency: 3 })

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

  // mac 三段（端到端/中断注入/磁盘满）共用的环境就绪条件（原 describe.skipIf 条件收编）
  const MAC_SUITE_READY = IS_MAC && HAS_HDIUTIL && HAS_DITTO && HAS_SHASUM

  // P10（mac 磁盘满）专属 E2E 档门控：env TAIJI_E2E_UPDATER——不随 TAIJI_TEST_INTEGRATION
  // 走（CI test-main job 设了集成 env 但不设本 env，故 P10 在 CI 不跑），按 e2e-map
  // E2E-UPDATER-01 触发或手动跑。理由：它是本文件最重单点（双缩前满并发 34.1s /
  // 安静单跑 11.06s，占 updater 文件墙钟 91%），不适合随 CI 常驻；档位语义登记 =
  // docs/TEST-STRATEGY.md「集成测试门控约定」节。
  const E2E_UPDATER_ENV = 'TAIJI_E2E_UPDATER'
  const E2E_UPDATER_ENABLED =
    process.env[E2E_UPDATER_ENV] === '1' || process.env[E2E_UPDATER_ENV] === 'true'
  const E2E_UPDATER_SKIP_REASON = E2E_UPDATER_ENABLED
    ? ''
    : `env ${E2E_UPDATER_ENV} 未设置或取值非 '1'/'true'（E2E 档：CI 不跑，按 e2e-map E2E-UPDATER-01 触发或手动跑，见 docs/TEST-STRATEGY.md「集成测试门控约定」）`

  /** 门控 describe 名：跳过时显式携带理由（env 未设置 = 本地默认跳过），不静默消失。
   *  skipReason 默认走集成门控理由；P10 段传 E2E 档理由（E2E_UPDATER_SKIP_REASON）。 */
  function gatedTitle(name: string, skipReason: string = INTEGRATION_TESTS_ENABLED ? '' : INTEGRATION_TESTS_SKIP_REASON): string {
    return name + (skipReason ? `｜skip：${skipReason}` : '')
  }

  // ──────────────────────────────────────────────────────────────────
  // 临时目录生命周期（per-test：vitest 可扩展 test context 传递，用例间零共享变量）
  // ──────────────────────────────────────────────────────────────────

  /** 用例级作用域：beforeEach 写入 tmpDir，用例体与 afterEach 经同一 context 对象读回。 */
  interface TestScope { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    tmpDir: string
  }

  beforeEach<TestScope>((ctx) => {
    ctx.tmpDir = mkdtempSync(path.join(tmpdir(), 'updater-int-'))
  })

  afterEach<TestScope>(async (ctx) => {
    const t = ctx.tmpDir
    if (!t || !existsSync(t)) return
    // 磁盘镜像用例可能留下挂载点：先尝试卸载再删目录（失败仅告警，不让 teardown 掩盖用例结果）
    const mnt = path.join(t, 'mnt')
    if (existsSync(mnt) && IS_MAC && HAS_HDIUTIL) {
      await detachQuiet(mnt)
    }
    try {
      rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch (e) {
      console.warn('[warn] tmpDir 清理失败（可能挂载点残留）:', e)
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // 共享 dmg 资产（五元组惰性缓存 + 首造互斥；见文件头「dmg 资产复用」节）
  // ──────────────────────────────────────────────────────────────────

  /**
 * 共享 dmg 资产目录：惰性创建 + 文件级生命周期。
 *
 * - 惰性：buildMinimalAppDmg 首次真构造时才 mkdtemp（该函数只被集成门控用例触达）
 *   ——门控关闭（默认口径）时零构造零落盘。因此禁止把创建上提为无条件 beforeAll：
 *   那会让默认口径的 skip 路径白付 3 次 create（≈18s）。
 * - 独立于任何用例私有 tmpDir：RM7 / linux 只读用例的 chmod 555 与 afterEach
 *   清理都波及不到这里；afterAll 统一清理。
 */
  let sharedDmgAssetsDir: string | undefined

  /** 五元组缓存键 → 已构造共享 dmg（路径 + 首次预计算 sha）。 */
  const sharedDmgCache = new Map<string, { dmgPath: string; sha256: string }>()

  /**
 * 同键首造在途 promise：并发首跑时第二个到达者复用在途构造（等待完成拿到同一份
 * dmg），不得 double-create——两个 hdiutil create 同路径并发会互相覆写/产损坏 dmg。
 */
  const sharedDmgCreateInFlight = new Map<string, Promise<{ dmgPath: string; sha256: string }>>()

  afterAll(() => {
    if (sharedDmgAssetsDir && existsSync(sharedDmgAssetsDir)) {
      try {
        rmSync(sharedDmgAssetsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      } catch (e) {
        console.warn('[warn] 共享 dmg 资产目录清理失败（可能挂载点残留）:', e)
      }
    }
    sharedDmgAssetsDir = undefined
    sharedDmgCache.clear()
  })

  // ──────────────────────────────────────────────────────────────────
  // 辅助函数
  // ──────────────────────────────────────────────────────────────────

  /**
 * 异步执行外部命令并采集 stdio（promisify spawn；用 close 事件保证管道排空后才返回，
 * 与 spawnSync 的 { encoding: 'utf8' } 采集语义等价）。
 * timeoutMs 到点向子进程发 SIGTERM（spawnSync 默认 killSignal 同款），超时判定
 * 由调用方按 signal === 'SIGTERM' 完成。
 */
  function execCapture(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      const timer = opts.timeoutMs !== undefined
        ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
        : undefined
      child.on('error', (e) => {
        if (timer !== undefined) clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code, signal) => {
        if (timer !== undefined) clearTimeout(timer)
        resolve({ status: code, signal, stdout, stderr })
      })
    })
  }

  /** 安静卸载挂载点（teardown 兜底路径：结果不关心、不抛错、异步不阻塞事件循环）。 */
  function detachQuiet(mountPoint: string): Promise<void> {
    return new Promise((resolve) => {
      const c = spawn('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'ignore' })
      c.on('close', () => resolve())
      c.on('error', () => resolve())
    })
  }

  /** 计算文件 sha256 hex（64 位），与脚本里 shasum -a 256 等价。 */
  function sha256OfFile(filePath: string): string {
    const h = crypto.createHash('sha256')
    h.update(readFileSync(filePath))
    return h.digest('hex')
  }

  /** buildMinimalAppDmg 的构造参数（五元组即缓存键）。 */
  interface DmgSpec { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    appBundleName?: string
    binaryName?: string
    /** 塞进 .app 根的版本标记文件内容（如 'NEW-V-B'），中断用例断言残留物完整性 */
    versionMarker?: string
    /** 主二进制填充大小（字节，随机不可压内容），磁盘满用例用 2MB 撑爆小卷 */
    binarySize?: number
    /** true = 空壳 .app（无 Contents/MacOS/<binary>），主二进制检查拦截用例用 */
    hollow?: boolean
  }

  /**
 * 构造最小 .app bundle（Contents/MacOS/<binaryName> + Info.plist）并打成真实 dmg。
 *
 * - dmg 根含 .app（hdiutil create -srcfolder <buildRoot>：镜像根 = 源目录内容），
 *   与脚本 S1 的 `ls -d "$MOUNT_DIR"/*.app` 定位链一致。
 * - 主二进制 chmod 755：脚本对解包产物做 `-x` 可执行检查（RI1 检查），
 *   hdiutil 镜像保留 POSIX 权限位。writeFileSync 默认 0644，必须显式 chmod。
 * - 按五元组惰性缓存（方案乙）：同键命中/首造互斥后取共享 dmg 与首次预计算
 *   sha，再复制一份到调用方私有 tmpDir 返回。共享缓存文件从不被脚本挂载
 *   （同 inode 并发/残留挂载竞态结构性消除，见文件头）；副本字节不变故 sha
 *   沿用预计算值。返回的 dmgPath 属调用方私有，可任意处置。
 */
  async function buildMinimalAppDmg(tmpDir: string, opts: DmgSpec = {}): Promise<{ dmgPath: string; appBundleName: string; binaryName: string; sha256: string }> {
    const appBundleName = opts.appBundleName ?? 'TaiJi.app'
    const binaryName = opts.binaryName ?? 'TaiJi'
    // 缓存键 = 五元组。正确性前提：「同五元组 → 同 dmg 字节 → 同 sha」——默认路径
    // binary 内容是下方固定字符串字面量，天然满足；binarySize 分支（crypto.randomBytes）
    // 内容随机，但该键仅磁盘满一例、无第二消费者。未来给夹具加新随机源时必须把
    // 随机源纳入键，否则命中方拿到的 sha 与其期望漂移 → 假红。
    const cacheKey = JSON.stringify([appBundleName, binaryName, opts.versionMarker ?? null, opts.binarySize ?? null, opts.hollow ?? false])
    // 共享目录内文件名用键哈希：appBundleName 跨五元组重名（TaiJi.app ×3 组），不能直接命名
    const keyTag = crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 10)
    let entry = sharedDmgCache.get(cacheKey)
    if (!entry) {
      // 首造互斥：同键并发首跑时，后到者 await 在途 promise（拿到与首造者同一份），
      // 不 double-create——两个 hdiutil create 同路径并发会互相覆写。await 必须包住
      // 整个 ?? 表达式：漏包会把 Promise 对象当 entry 用（dmgPath 恒 undefined）。
      entry = await (sharedDmgCreateInFlight.get(cacheKey) ?? createSharedDmg(cacheKey, keyTag, appBundleName, binaryName, opts))
    }
    // 完整性自检：共享资产被意外删除时快速失败并指向缓存机制，不让后续用例
    // 连锁假红难归因（共享的隔离性损失排查成本，审计风险清单第 7 项）
    if (!existsSync(entry.dmgPath)) {
      throw new Error(`共享 dmg 资产丢失: ${entry.dmgPath}（cacheKey=${cacheKey}）`)
    }
    const localDmg = path.join(tmpDir, `asset-${keyTag}.dmg`)
    copyFileSync(entry.dmgPath, localDmg)
    return { dmgPath: localDmg, appBundleName, binaryName, sha256: entry.sha256 }
  }

  /** 真实构造共享 dmg（首造路径）：构建 .app 源目录 → hdiutil create → 预计算 sha → 写缓存。 */
  async function createSharedDmg(cacheKey: string, keyTag: string, appBundleName: string, binaryName: string, opts: DmgSpec): Promise<{ dmgPath: string; sha256: string }> {
    const build = (async () => {
      // 惰性创建共享目录（不是 beforeAll：门控关闭的默认口径必须零构造，见声明处注释）
      sharedDmgAssetsDir ??= mkdtempSync(path.join(tmpdir(), 'updater-int-assets-'))
      const buildRoot = path.join(sharedDmgAssetsDir, `build-${keyTag}`)
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

      const dmgPath = path.join(sharedDmgAssetsDir, `app-${keyTag}.dmg`)
      const r = await execCapture('hdiutil', [
        'create', '-srcfolder', buildRoot, '-format', 'UDZO', '-ov', dmgPath,
      ])
      rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) // 构建中间目录用完即清，共享目录只留 dmg
      if (r.status !== 0) {
        throw new Error(`hdiutil create 失败 status=${r.status} stderr=${r.stderr}`)
      }
      const sha256 = sha256OfFile(dmgPath)
      return { dmgPath, sha256 }
    })()
    sharedDmgCreateInFlight.set(cacheKey, build)
    try {
      const entry = await build
      sharedDmgCache.set(cacheKey, entry)
      return entry
    } finally {
      sharedDmgCreateInFlight.delete(cacheKey)
    }
  }

  function writeScriptToTmp(tmpDir: string, script: string, name = 'updater.sh'): string {
    const p = path.join(tmpDir, name)
    writeFileSync(p, script, { mode: 0o755 })
    return p
  }

  /**
 * 异步执行 bash 脚本（spawn + close 采集，timeout 硬上限）。
 * 超时（SIGTERM）明确抛错——避免被当成正常 exit 误判为通过（假绿）。
 */
  const BASH_TIMEOUT_MS = 15_000

  async function runBash(tmpDir: string, scriptPath: string, timeoutMs = BASH_TIMEOUT_MS): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const r = await execCapture('bash', [scriptPath], { cwd: tmpDir, timeoutMs })
    if (r.signal === 'SIGTERM') {
      throw new Error(
        `bash 脚本超时（${timeoutMs}ms）：${scriptPath}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      )
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  /**
 * detached 执行 bash 脚本（中断注入用）：返回子进程与 exit Promise。
 * 后续用 process.kill(-pid, SIGKILL) 杀整个进程组（bash + 注入的暂停 sleep）。
 */
  function runBashDetached(tmpDir: string, scriptPath: string): { child: ChildProcess; exited: Promise<number | null> } {
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
 * 默认 30s：本文件 waitFor 目标全部是 hdiutil/ ditto 真实进程链。实测就位耗时分布
 * （2026-10-14，TAIJI_WAIT_DEBUG 采集）：空载与包级全量满载（89 文件并发）均在 2-6s
 * （S1 staging 就位：空载 5.3s / 满载 3.7s）。曾发生 15s 超时 flake（实测分布 2.5x+
 * 偏离）→ 归因系统级瞬态卡顿（hdiutil 排队/换页类），非包内并发所致；预算取 5x 实测
 * 上界吸收尖峰。成本仅真死锁时失败报告晚 15s（成功路径立即返回，超时只影响失败速度）；
 * 超时错误消息携带实际等待时长，未来 flake 可即时归因（贴预算 = 系统尖峰再现；数量级
 * 偏离 = 真退化另查）。
 */
  async function waitFor(desc: string, cond: () => boolean, timeoutMs = 30_000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        // 超时错误携带实际等待时长：满载 flake 归因需要分布数据，只有预算数字无法区分「贴近预算的偶发」与「数量级偏离的真退化」
        throw new Error(`waitFor 超时: ${desc}（等待 ${( (Date.now() - start) / 1000).toFixed(1)}s > 预算 ${timeoutMs / 1000}s）`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    // 采集模式：TAIJI_WAIT_DEBUG=1 时打印每个 waitFor 的实际耗时（供满载耗时分布采集；
    // 平时零输出不污染 CI 日志。预算校准依据与 flake 归因见 docs/TROUBLESHOOTING.md 常见问题 §30）
    if (process.env.TAIJI_WAIT_DEBUG) {
      console.log(`[waitFor] ${desc}: ${((Date.now() - start) / 1000).toFixed(2)}s（预算 ${timeoutMs / 1000}s）`)
    }
  }

  /**
 * 在生成脚本的 [stage] 标记行后注入「flag 文件暂停循环」（测试夹具变换）：
 *   while [ -e "<flagPath>" ]; do sleep 0.05; done
 * 测试轮询到目标状态后：删 flag = 放行继续执行；kill 进程组 = 模拟中断。
 * 脚本决策逻辑（检查/mv 顺序/回滚）零改动。
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

  /**
 * 把 60s 超时（120 轮）压成 6 轮（3s），让超时 abort 用例快速出结果。
 * [HISTORICAL] 曾压成 2 轮（1s）：CI runner 高负载下 bash spawn + 脚本前置步骤的
 * 调度抖动可吃掉大半窗口，v0.10.8 post-merge macOS job 实测 flaky（2/23，rerun 绿）。
 * 3s 对抖动容忍 ×3，代价仅超时用例时长 +2s。
 */
  function shortenWaitLimit(script: string): string {
    if (!script.includes('-gt 120')) throw new Error('未找到等待上限 -gt 120（模板变了？）')
    return script.replace('-gt 120', '-gt 6')
  }

  /** mac 用标准 vars（parentPid 默认死 PID：kill -0 立即失败 = 模拟 app 已退出）。 */
  function makeMacVars(tmpDir: string, opts: {
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
    it<TestScope>('mac 脚本：buildUpdaterScript 产物 bash -n 通过（语法正确、无残留占位符炸）', ({ tmpDir }) => {
      const script = buildUpdaterScript(makeMacVars(tmpDir, { dmgPath: '/tmp/x.dmg', sha256: 'a'.repeat(64) }))
      const scriptPath = writeScriptToTmp(tmpDir, script)

      expect(script, '执行产物不应残留 {{...}} 占位符').not.toMatch(/\{\{[^}]+\}\}/)
      const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
      expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
    })

    it<TestScope>('linux 脚本：buildLinuxUpdaterScript 产物 bash -n 通过', ({ tmpDir }) => {
      const script = buildLinuxUpdaterScript({
        appImagePath: path.join(tmpDir, 'x.appimage'),
        newFilePath: path.join(tmpDir, 'y.appimage'),
        sha256: 'a'.repeat(64),
        logPath: path.join(tmpDir, 'l.log'),
        resultPath: path.join(tmpDir, 'r.json'),
        targetVersion: '0.9.0-int',
        parentPid: '9999999',
      })
      const scriptPath = writeScriptToTmp(tmpDir, script, 'linux-updater.sh')
      expect(script).not.toMatch(/\{\{[^}]+\}\}/)

      const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
      expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
    })

    it<TestScope>('mac 脚本：sha256 含特殊字符也不破坏 bash 语法（防御注入）', ({ tmpDir }) => {
      const weirdButHex = '0'.repeat(64)
      const script = buildUpdaterScript(makeMacVars(tmpDir, { dmgPath: '/tmp/x.dmg', sha256: weirdButHex }))
      const r = spawnSync('bash', ['-n', writeScriptToTmp(tmpDir, script)], { encoding: 'utf8' })
      expect(r.status).toBe(0)
    })
  })

  // ════════════════════════════════════════════════════════════════
  // MAC 脚本：端到端 happy path（真 .app + 真 dmg + 真 attach/ditto/detach）【集成门控】
  // 本段 { concurrent: true }：与中断注入 / 磁盘满段交叠共享全局 3 槽并发池
  // （见文件头 vi.setConfig 注释）；happy path 与 hollow 首造（不同键）可并发进行。
  // ════════════════════════════════════════════════════════════════
  describe.skipIf(!INTEGRATION_TESTS_ENABLED || !MAC_SUITE_READY)(gatedTitle('updater-script integration: mac 端到端'), { concurrent: true }, () => {
    it<TestScope>(
      'happy path（M1 脚本侧）：S0→S5 走通 → exit 0、新 .app 就位、result done（合法 JSON）、无任何残留',
      async ({ tmpDir }) => {
        const { dmgPath, sha256, appBundleName, binaryName } = await buildMinimalAppDmg(tmpDir, {
          versionMarker: 'NEW-V-B',
        })
        const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName })
        const appDir = path.dirname(vars.appBundle)
        mkdirSync(appDir, { recursive: true })
        // 预置：旧 .app（OLD_MARKER）+ 上次残留的过期 .old（$APP 在位时应被清掉）
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')
        mkdirSync(`${vars.appBundle}.old`, { recursive: true })
        writeFileSync(path.join(`${vars.appBundle}.old`, 'STALE'), 'stale-backup')

        const script = stripOpenLine(buildUpdaterScript(vars))
        const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))

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

    it<TestScope>(
      'sha mismatch：exit 1、旧 .app 完好、不产生 .old/staging、result failed 且为合法 JSON',
      async ({ tmpDir }) => {
        // 白造消除（方案乙）：期望 sha 是假值（'0'×64），真 dmg 的实际 sha 从不参与
        // 比较——脚本只需 shasum 读到一个文件即失配，几十字节假文件语义等价
        // （省一次 hdiutil create ≈5.5-6s）。
        const fakeDmg = path.join(tmpDir, 'payload-not-a-dmg.bin')
        writeFileSync(fakeDmg, 'not a dmg; only needs to be shasum-able')
        const vars = makeMacVars(tmpDir, { dmgPath: fakeDmg, sha256: '0'.repeat(64) })
        mkdirSync(path.dirname(vars.appBundle), { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'preserved')

        const script = stripOpenLine(buildUpdaterScript(vars))
        const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))

        expect(r.status, 'sha 失败应 exit 1').toBe(1)
        expect(existsSync(vars.appBundle)).toBe(true)
        expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(true)
        expect(existsSync(`${vars.appBundle}.old`)).toBe(false)

        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
        expect(result.status).toBe('failed')
        expect(result.error).toBe('sha mismatch')
      },
    )

    it<TestScope>(
      '版本号含引号污染 → result 仍是合法 JSON 且结构不被注入（printf %s 参数通道回归）',
      async ({ tmpDir }) => {
        // write_result 的 printf format 曾把版本号放 format 字符串（printf 会处理 \"
        // 转义 → 污染值可注入 JSON 结构字段）。回归断言：污染版本只能成为字符串内容。
        const evilVersion = '0.9.0","injected":"pwned'
        const payload = path.join(tmpDir, 'payload.bin')
        writeFileSync(payload, 'tampered')
        const vars = makeMacVars(tmpDir, { dmgPath: payload, sha256: '0'.repeat(64), targetVersion: evilVersion })

        const script = stripOpenLine(buildUpdaterScript(vars))
        const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))

        expect(r.status).toBe(1)
        const raw = readFileSync(vars.resultPath, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        expect(Object.keys(parsed).sort()).toEqual(['at', 'error', 'status', 'version'])
        expect(parsed.version).toBe(evilVersion)
        expect(parsed.injected).toBeUndefined()
      },
    )

    it<TestScope>(
      'dmg 挂载失败（伪 dmg，sha 对）：exit 1、旧 .app 完好、error=dmg mount failed（含恢复指引）',
      async ({ tmpDir }) => {
        // sha 对、但内容不是合法 dmg：让校验段过、挂载段炸（attach 失败分支，§3.3.3-B）。
        // 白造消除（方案乙）：shasum 需要真值，但内容本就不必是 dmg——小假文件 +
        // 预计算其 sha，与「真 dmg 覆写伪内容」语义等价，且完全不触碰共享缓存
        // （无需 copy-on-write 副本）。
        const appBundleName = 'TaiJi.app'
        const fakeDmg = path.join(tmpDir, 'not-a-valid-dmg.bin')
        writeFileSync(fakeDmg, 'this is not a valid dmg file content')
        const realSha = sha256OfFile(fakeDmg)

        const vars = makeMacVars(tmpDir, { dmgPath: fakeDmg, sha256: realSha, appBundleName })
        mkdirSync(path.dirname(vars.appBundle), { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'untouched')

        const script = stripOpenLine(buildUpdaterScript(vars))
        const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))

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

    it<TestScope>(
      '解包产物缺主二进制（dmg 内只有空壳 .app）→ exit 1、error=extract failed、旧 .app 完好（RI1 误判成功防护）',
      async ({ tmpDir }) => {
        // 构造「合法 dmg 但 .app 没有 Contents/MacOS/<bin>」：attach/ditto 成功、主二进制检查拦截。
        const appBundleName = 'TaiJi.app'
        const { dmgPath, sha256 } = await buildMinimalAppDmg(tmpDir, { appBundleName, hollow: true })

        const vars = makeMacVars(tmpDir, {
          dmgPath,
          sha256,
          appBundleName,
          binaryName: 'TaiJi',
        })
        mkdirSync(path.dirname(vars.appBundle), { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'untouched')

        const script = stripOpenLine(buildUpdaterScript(vars))
        const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))

        expect(r.status, '主二进制缺失应 exit 1').toBe(1)
        expect(existsSync(path.join(vars.appBundle, 'OLD_MARKER'))).toBe(true)
        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
        expect(result.error).toBe('extract failed')
      },
    )
  })

  // ════════════════════════════════════════════════════════════════
  // MAC 脚本：状态机中断注入（kill 进程组）与失败分支【集成门控】
  // 本段 { concurrent: true }：段内用例受控并发（maxConcurrency=3，见文件头
  // vi.setConfig 注释）。安全前提（round3-a 探针）：每用例独立 dmg 副本 +
  // 独立挂载点（脚本侧 mktemp）+ per-test tmpDir + 同键首造互斥。
  // 注意并发声明必须走 suite options 第三参——vitest 4.1.9 的
  // describe.concurrent.skipIf(cond) 链会静默丢并发语义（探针实测并发度 1，
  // /tmp/round3a-probe skipif-probe2）。
  // ════════════════════════════════════════════════════════════════
  describe.skipIf(!INTEGRATION_TESTS_ENABLED || !MAC_SUITE_READY)(gatedTitle('updater-script integration: mac 状态机中断注入'), { concurrent: true }, () => {
    it<TestScope>(
      'S1 中断（M2 脚本侧）：staging 解压完成后 kill → 正式位置零接触 + staging 残留 + result 未写',
      async ({ tmpDir }) => {
        const { dmgPath, sha256, appBundleName, binaryName } = await buildMinimalAppDmg(tmpDir, { versionMarker: 'NEW-V-B' })
        const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName })
        const appDir = path.dirname(vars.appBundle)
        const stagingDir = path.join(appDir, `.staging.${appBundleName}`)
        mkdirSync(appDir, { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

        const flag = path.join(tmpDir, 'pause-S2.flag')
        writeFileSync(flag, '')
        const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S2 promote', flag)
        const { child, exited } = runBashDetached(tmpDir, writeScriptToTmp(tmpDir, script))

        // 等 S1 完成（含 detach 已执行）且脚本停在 S2 前的注入暂停循环：触发条件用
        // 「S2 begin 日志行已写」而非「staging 二进制就位」——后者会让 kill 落进
        // attach→detach 窗口，孤儿挂载持有脚本要挂载的 dmg。同 inode dmg 前次挂载
        // 未 detach 时重挂载可报资源忙/失败（updater-script.ts S1 注释 r2 实测；
        // round3-a 探针 A2 同 inode 并发 attach 2/6 失败）。kill 点仍在 M2 语义
        // 窗口内（S1 完成 → S2 动作前，flag 暂停循环保证 S2 mv 零执行）。
        const logText = () => (existsSync(vars.logPath) ? readFileSync(vars.logPath, 'utf8') : '')
        await waitFor('S1 完成（S2 begin 已记日志，脚本暂停中）', () =>
          logText().includes('[stage] S2 promote begin'))
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

    it<TestScope>(
      'S3→S4 残余窗口中断（M3b 脚本侧）：备份与换装之间 kill → $APP 缺失 + .old/.new 双份完整',
      async ({ tmpDir }) => {
        const { dmgPath, sha256, appBundleName, binaryName } = await buildMinimalAppDmg(tmpDir, { versionMarker: 'NEW-V-B' })
        const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName })
        const appDir = path.dirname(vars.appBundle)
        mkdirSync(appDir, { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

        const flag = path.join(tmpDir, 'pause-S4.flag')
        writeFileSync(flag, '')
        const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S4 swap', flag)
        const { child, exited } = runBashDetached(tmpDir, writeScriptToTmp(tmpDir, script))

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

    it<TestScope>(
      'S4 后 done 前中断（M3a 脚本侧）：换装完成 kill → $APP 完整新版 + .old 在（self-healer 可判定状态）',
      async ({ tmpDir }) => {
        const { dmgPath, sha256, appBundleName, binaryName } = await buildMinimalAppDmg(tmpDir, { versionMarker: 'NEW-V-B' })
        const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName })
        mkdirSync(path.dirname(vars.appBundle), { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

        const flag = path.join(tmpDir, 'pause-S5.flag')
        writeFileSync(flag, '')
        const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S5 finalize', flag)
        const { child, exited } = runBashDetached(tmpDir, writeScriptToTmp(tmpDir, script))

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

    it<TestScope>(
      '等待超时 abort（M6）：父进程不退 → failed(app still running)、旧 .app 完好、运行中进程不被打扰',
      async ({ tmpDir }) => {
        // 白造消除（方案乙）：脚本阶段顺序 = 只读检测 → 等待 → sha → attach（本用例
        // 死在等待段：父进程不退 → 3s 超时 abort），dmg 从未被读——假路径 + 任意 sha。
        const dmgPath = path.join(tmpDir, 'never-read.dmg')
        // 真实存活的「父进程」：sleep 30 模拟挂住不退的 app。
        // noop exit listener 必须挂：否则 sleep 退出后成为 vitest 进程的僵尸（未收割），
        // bash kill -0 对僵尸恒真，等待循环永远不 break。
        const parent = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
        parent.once('exit', () => {})
        const vars = makeMacVars(tmpDir, {
          dmgPath,
          sha256: '0'.repeat(64),
          appBundleName: 'TaiJi.app',
          binaryName: 'TaiJi',
          parentPid: String(parent.pid),
        })
        mkdirSync(path.dirname(vars.appBundle), { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'untouched')

        try {
          // 120 轮压成 2 轮（1s），1s 出超时结论
          const script = shortenWaitLimit(stripOpenLine(buildUpdaterScript(vars)))
          const started = Date.now()
          const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))
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

    it<TestScope>(
      '等待退出正向路径：父进程 1s 后退出 → 脚本等到再继续 → 升级完成（kill -0 立即返回语义，P12）',
      async ({ tmpDir }) => {
        const { dmgPath, sha256, appBundleName, binaryName } = await buildMinimalAppDmg(tmpDir, { versionMarker: 'NEW-V-B' })
        // 父进程用「孤儿化」模式：sleep 的 stdout/stderr 必须全部重定向 —— 否则
        // stderr 仍持有 spawnSync 的管道写端，spawnSync 会阻塞到 sleep 死亡才返回
        // （捕获到的 pid 已死，等待语义完全测不到）。父 bash 立即退出 → sleep 归
        // launchd 收割，无僵尸 → kill -0 语义真实。
        const parentPid = spawnSync('bash', ['-c', 'sleep 1 >/dev/null 2>&1 & pid=$!; echo $pid'])
          .stdout.toString().trim()
        const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName, parentPid })
        mkdirSync(path.dirname(vars.appBundle), { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')

        const script = stripOpenLine(buildUpdaterScript(vars))
        const started = Date.now()
        const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))
        const elapsed = Date.now() - started

        expect(r.status, `期望 exit 0，stderr 见 log：${existsSync(vars.logPath) ? readFileSync(vars.logPath, 'utf8').slice(-400) : ''}`).toBe(0)
        // 脚本确实等了父进程（不是秒过）：父进程 1s 后才退出
        expect(elapsed, '应等待父进程退出（≥900ms）').toBeGreaterThanOrEqual(900)
        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string }
        expect(result.status).toBe('done')
      },
    )

    it<TestScope>(
      '备份失败 abort（RM7）：APP_DIR 只读 → failed(backup failed)、旧 .app 完好、.old 不被破坏',
      async ({ tmpDir }) => {
        const { dmgPath, sha256, appBundleName, binaryName } = await buildMinimalAppDmg(tmpDir, { versionMarker: 'NEW-V-B' })
        const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName })
        const appDir = path.dirname(vars.appBundle)
        mkdirSync(appDir, { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA')
        // 预置 .old 为普通文件：S3 会先 rm -rf 它（被只读目录挡住）→ 备份 mv 也失败
        writeFileSync(`${vars.appBundle}.old`, 'cannot-be-replaced')

        const flag = path.join(tmpDir, 'pause-S3.flag')
        writeFileSync(flag, '')
        const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S3 backup', flag)
        const { child, exited } = runBashDetached(tmpDir, writeScriptToTmp(tmpDir, script))

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

    it<TestScope>(
      '换装失败回滚：S4 mv 失败 → 回滚 .old 成功 → failed(swap failed) + 旧 .app 完整恢复',
      async ({ tmpDir }) => {
        const { dmgPath, sha256, appBundleName, binaryName } = await buildMinimalAppDmg(tmpDir, { versionMarker: 'NEW-V-B' })
        const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName })
        mkdirSync(path.dirname(vars.appBundle), { recursive: true })
        mkdirSync(vars.appBundle, { recursive: true })
        writeFileSync(path.join(vars.appBundle, 'OLD_MARKER'), 'old-vA-rollback')

        const flag = path.join(tmpDir, 'pause-S4b.flag')
        writeFileSync(flag, '')
        const script = pauseAfterStage(stripOpenLine(buildUpdaterScript(vars)), 'S4 swap', flag)
        const { child, exited } = runBashDetached(tmpDir, writeScriptToTmp(tmpDir, script))

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

    it<TestScope>(
      '只读卷拒装（M5）：appBundle 位于 /Volumes → failed(read-only volume)、不触碰任何路径',
      async ({ tmpDir }) => {
        // 只读检测是脚本第一步（case /Volumes/*），在任何文件系统操作前退出——
        // 因此可以用 /Volumes 下的虚拟路径真实执行而不需要真挂载。
        // 白造消除（方案乙）：dmg 在第一步就被短路、从未被读——假路径 + 任意 sha。
        const vars = makeMacVars(tmpDir, {
          dmgPath: path.join(tmpDir, 'never-read.dmg'),
          sha256: '0'.repeat(64),
          appBundle: '/Volumes/TaiJi-Integration-Test/TaiJi.app',
          binaryName: 'TaiJi',
        })

        const script = stripOpenLine(buildUpdaterScript(vars))
        const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script))

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
  // MAC 脚本：磁盘满（M4 + P10：ditto 磁盘满必须非 0 退出）【E2E 档】
  // 门控 = TAIJI_E2E_UPDATER（非 TAIJI_TEST_INTEGRATION）：CI 不跑，按 e2e-map
  // E2E-UPDATER-01 触发或手动跑（见文件头 E2E_UPDATER_* 常量注释）。
  // 本段 { concurrent: true }：段内并发声明（现仅 1 用例，标记统一并发契约、
  // 后续新增用例自动受限控并发管辖；语义同上两段）。
  // ════════════════════════════════════════════════════════════════
  describe.skipIf(!E2E_UPDATER_ENABLED || !MAC_SUITE_READY)(gatedTitle('updater-script integration: mac 磁盘满（P10）', E2E_UPDATER_SKIP_REASON), { concurrent: true }, () => {
    it<TestScope>(
      '小容量卷上 ditto 拷入 2MB 不可压产物 → ENOSPC → ditto 非零退出、error=ditto copy failed、旧 app 完好',
      async (ctx) => {
        const { tmpDir } = ctx
        // 1MB HFS+ 镜像当「应用卷」；2MB 随机字节二进制 > 卷总容量 1MB，必撑爆
        //（ditto 无压缩，ENOSPC 语义保留）。旧 app 仅 OLD_MARKER 小文件，
        // 1MB 卷可用空间足够容纳，「装得下旧版、装不下新版」约束不变。
        // 更新 dmg 挂载在 $TMPDIR（S1 选址约束），只有 ditto 落 staging 在小卷上。
        const imgPath = path.join(tmpDir, 'tiny.dmg')
        const mountDir = path.join(tmpDir, 'mnt')
        mkdirSync(mountDir, { recursive: true })

        const cr = await execCapture('hdiutil', ['create', '-size', '1m', '-fs', 'HFS+', '-volname', 'UPDTEST', '-ov', imgPath])
        if (cr.status !== 0) ctx.skip(`hdiutil create 失败: ${cr.stderr}`)
        const at = await execCapture('hdiutil', ['attach', imgPath, '-mountpoint', mountDir, '-nobrowse'])
        if (at.status !== 0) ctx.skip(`hdiutil attach 失败: ${at.stderr}`)

        try {
          // 旧 app（小，能装下）挂在卷上
          const appBundleName = 'TaiJi.app'
          const appBundle = path.join(mountDir, appBundleName)
          mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true })
          writeFileSync(path.join(appBundle, 'OLD_MARKER'), 'old-vA-on-tiny-vol')

          const { dmgPath, sha256, binaryName } = await buildMinimalAppDmg(tmpDir, { appBundleName, binaryName: 'TaiJi', binarySize: 2 * 1024 * 1024 })
          const vars = makeMacVars(tmpDir, { dmgPath, sha256, appBundleName, binaryName, appBundle })

          const script = stripOpenLine(buildUpdaterScript(vars))
          const r = await runBash(tmpDir, writeScriptToTmp(tmpDir, script), 30_000)

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
          await detachQuiet(mountDir)
        }
      },
      60_000,
    )
  })

  // ════════════════════════════════════════════════════════════════
  // LINUX 脚本：mv 备份/回滚决策树 + 检查（不真 spawn AppImage）【集成门控】
  // 真真 bash 子进程执行整脚本（含压缩后的真实等待窗），与 mac 三段同属「代码 + OS
  // 组合行为」——retry:2 与 bash 预算 15s 正是本段负载敏感症状，一并挂门控。
  // ════════════════════════════════════════════════════════════════
  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(gatedTitle('updater-script integration: linux mv 备份/回滚'), () => {
    function makeLinuxVars(tmpDir: string, opts: { appImagePath?: string; newFilePath?: string } = {}): LinuxUpdaterScriptVars {
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

    it<TestScope>('happy path：备份 + 换装 + chmod 755 + status=done + .old 清理', async ({ tmpDir }) => {
      const vars = makeLinuxVars(tmpDir)
      writeFileSync(vars.appImagePath, 'OLD AppImage content')
      mkdirSync(path.dirname(vars.newFilePath), { recursive: true })
      writeFileSync(vars.newFilePath, 'NEW AppImage content')

      const scriptPath = writeScriptToTmp(tmpDir, buildLinuxBodyScript(vars), 'linux-updater.sh')
      const r = await runBash(tmpDir, scriptPath)

      expect(r.status, `期望 exit 0，stderr=${r.stderr}`).toBe(0)
      expect(existsSync(vars.appImagePath)).toBe(true)
      expect(readFileSync(vars.appImagePath, 'utf8')).toBe('NEW AppImage content')
      expect(existsSync(`${vars.appImagePath}.old`)).toBe(false)
      const mode = statSync(vars.appImagePath).mode & 0o777
      expect(mode, `chmod 应为 755，实际=${mode.toString(8)}`).toBe(0o755)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string }
      expect(result.status).toBe('done')
    })

    it<TestScope>('mv 失败回滚：新文件不存在 → exit 1、旧 AppImage 恢复、error=mv failed', async ({ tmpDir }) => {
      const vars = makeLinuxVars(tmpDir)
      writeFileSync(vars.appImagePath, 'OLD AppImage content')
      // 不创建 newFilePath → S4 mv 必失败 → 回滚

      const scriptPath = writeScriptToTmp(tmpDir, buildLinuxBodyScript(vars), 'linux-updater.sh')
      const r = await runBash(tmpDir, scriptPath)

      expect(r.status, 'mv 失败应 exit 1').toBe(1)
      expect(existsSync(vars.appImagePath), '旧 AppImage 应被回滚恢复').toBe(true)
      expect(readFileSync(vars.appImagePath, 'utf8')).toBe('OLD AppImage content')
      expect(existsSync(`${vars.appImagePath}.old`), '回滚后 .old 应被 mv 走').toBe(false)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.error).toBe('mv failed')
    })

    // retry: 2 —— CI macOS runner 高负载下实测 flaky（v0.10.8 post-merge 2/23，rerun 绿），
    // chmod 语义与负载的耦合无法在 JS 侧消除，retry 兜底环境敏感性
    it<TestScope>('只读检测：APP_DIR 不可写 → exit 1、error=read-only volume、不动任何文件', { retry: 2 }, async ({ tmpDir }) => {
      const appDir = path.join(tmpDir, 'readonly-mount')
      mkdirSync(appDir, { recursive: true })
      const vars = makeLinuxVars(tmpDir, { appImagePath: path.join(appDir, 'TaiJi-x86_64.AppImage') })
      writeFileSync(vars.appImagePath, 'OLD content')

      chmodSync(appDir, 0o555)
      try {
        const scriptPath = writeScriptToTmp(tmpDir, buildLinuxBodyScript(vars), 'linux-updater.sh')
        const r = await runBash(tmpDir, scriptPath)
        expect(r.status, '只读目录应 exit 1').toBe(1)
        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
        expect(result.error).toBe('read-only volume')
        // 只读检测在等待/sha/备份之前 → .old 不应产生
        expect(existsSync(`${vars.appImagePath}.old`)).toBe(false)
      } finally {
        chmodSync(appDir, 0o755)
      }
    })

    // retry: 2 —— 等待窗已放宽到 3s（见 shortenWaitLimit），retry 再兜一层极端调度抖动
    it<TestScope>('等待超时 abort：父进程不退 → failed(app still running)', { retry: 2 }, async ({ tmpDir }) => {
      const vars = makeLinuxVars(tmpDir)
      writeFileSync(vars.appImagePath, 'OLD AppImage content')
      mkdirSync(path.dirname(vars.newFilePath), { recursive: true })
      writeFileSync(vars.newFilePath, 'NEW AppImage content')

      const parent = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
      parent.once('exit', () => {})
      const timedVars: LinuxUpdaterScriptVars = { ...vars, parentPid: String(parent.pid) }
      try {
        const script = shortenWaitLimit(buildLinuxBodyScript(timedVars))
        const scriptPath = writeScriptToTmp(tmpDir, script, 'linux-updater.sh')
        const r = await runBash(tmpDir, scriptPath)
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
});

// ======== 来源：updater-script.test.ts ========
describe("updater-script", () => {
  /** 标准变量 fixture（parentPid 用不存在的 PID——9999999 超过 macOS/linux pid_max） */
  const MAC_VARS = {
    appBundle: '/Applications/TaiJi.app',
    dmgPath: '/Users/test/.taiji/update/TaiJi-mac-arm64.dmg',
    sha256: 'a'.repeat(64),
    logPath: '/Users/test/.taiji/update/updater.log',
    resultPath: '/Users/test/.taiji/update/update-result.json',
    appName: 'TaiJi',
    targetVersion: '0.9.0',
    parentPid: '9999999',
  }

  const LINUX_VARS = {
    appImagePath: '/home/test/TaiJi-x86_64.AppImage',
    newFilePath: '/home/test/.taiji/update/TaiJi-x86_64.AppImage',
    sha256: 'a'.repeat(64),
    logPath: '/Users/test/.taiji/update/updater-linux.log',
    resultPath: '/Users/test/.taiji/update/update-result.json',
    targetVersion: '0.9.0',
    parentPid: '9999999',
  }

  describe('u1a: mac 脚本模板（staging 状态机 + §3.3.2 全检查）', () => {
    it('生成脚本含 §3.3.2 全部命令级检查且占位符全替换', () => {
      const script = buildUpdaterScript(MAC_VARS)

      // ── 验收条款①逐项检查（grep 级断言，验收对照）─────────────────
      const guards: Array<[string, string]> = [
        // dmg 解包链退出码显式检查（批次 3 §3.3.3-B：hdiutil attach + ditto）
        ['attach 退出码检查', 'if ! hdiutil attach -nobrowse -readonly "{{DMG_PATH}}"'],
        ['挂载失败错误码', 'fail "dmg mount failed'],
        ['ditto 退出码检查', 'if ! ditto "$SRC_APP" "$STAGED_APP"'],
        ['ditto 失败错误码', 'fail "ditto copy failed"'],
        // 主二进制缺失错误码（RI1 检查，S8：解包后主二进制存在检查保留）
        ['主二进制缺失错误码', 'fail "extract failed"'],
        // 备份 mv 失败 abort（RM7：不吞错）
        ['备份 mv 失败检查', 'if ! mv "$APP" "$APP_OLD"'],
        ['备份失败错误码', 'fail "backup failed"'],
        // 60s 超时 abort（PID 制 kill -0，120 轮 × 0.5s）
        ['PID 制等待', 'while kill -0 "$PARENT_PID" 2>/dev/null'],
        ['60s 上限（120 轮）', '-gt 120'],
        ['轮询步长 0.5s', 'sleep 0.5'],
        ['等待超时错误码', 'fail "app still running"'],
        // /Volumes 只读拒装（RM7 循环场景）
        ['只读卷检测', '/Volumes/*)'],
        ['只读卷错误码', 'fail "read-only volume"'],
        // 换装失败回滚（S4：回滚 .old 后写 failed）
        ['换装 mv 失败检查', 'if ! mv "$APP_NEW" "$APP"'],
        ['回滚备份', 'mv "$APP_OLD" "$APP"'],
        ['换装失败错误码', 'fail "swap failed"'],
        // sha256 校验（verify-before-replace 保持现状）
        ['sha256 校验', 'shasum -a 256'],
        ['sha 错误码', 'fail "sha mismatch"'],
      ]
      for (const [name, frag] of guards) {
        // guards 里的 {{DMG_PATH}} 片段是模板源形态，比对前替换为实际注入值
        const expected = frag.replaceAll('{{DMG_PATH}}', MAC_VARS.dmgPath)
        expect(script, `应包含检查: ${name} (${expected})`).toContain(expected)
      }

      // ── tmp + rename 原子写 result（m12）───────────────────────────
      expect(script).toContain(`RESULT_TMP="${MAC_VARS.resultPath}.tmp"`)
      expect(script).toContain('> "$RESULT_TMP"')
      expect(script).toContain(`mv -f "$RESULT_TMP" "${MAC_VARS.resultPath}"`)

      // ── 状态机结构（S1-S5 stage 标记 + 两步中转）───────────────────
      for (const stage of ['S1 extract begin', 'S2 promote begin', 'S3 backup begin', 'S4 swap begin', 'S5 finalize begin']) {
        expect(script, `应包含 stage 标记: ${stage}`).toContain(`[stage] ${stage}`)
      }
      // 两步中转：先 ditto 拷贝到 STAGING_DIR、成功后 mv 为 .app.new
      // （dmg 内 .app 经 ditto 拷到 staging，再同卷 mv 为 .app.new）
      expect(script).toContain('STAGING_DIR=')
      expect(script).toContain('mv "$STAGED_APP" "$APP_NEW"')
      // S1/S2 残留清理（状态机恢复方：上次中断残留本次解包前清除）
      expect(script).toContain('rm -rf "$STAGING_DIR" "$APP_NEW"')
      // 主二进制存在检查（可运行 app，Contents/MacOS/<appName>）
      expect(script).toContain('[ ! -x "$MAIN_BINARY" ]')
      expect(script).toContain(`Contents/MacOS/${MAC_VARS.appName}`)

      // ── 契约与重启语义 ─────────────────────────────────────────────
      // PARENT_PID 注入（u1a 模板侧契约；u1b 注入 process.pid）
      expect(script).toContain(`PARENT_PID="${MAC_VARS.parentPid}"`)
      // open 无 -n（open -n 强制新实例会被单实例锁弹掉 = 重启静默失败，RM6）。
      // 断言命令形态 `open -n "`，避免命中模板注释里的说明文字。
      expect(script).toContain('open "$APP"')
      expect(script, '不得再使用 open -n 命令').not.toContain('open -n "')
      // pgrep pattern 匹配已废弃（PID 制 by construction，RM9）
      expect(script, '不得再使用 pgrep').not.toContain('pgrep')
      // 旧 rm-then-mv「.old 预恢复」已删除：S3 残余窗口态禁止脚本动 .old（手动恢复出口）
      expect(script, 'S0 检查段不得预恢复 .old').not.toContain('restored from .old')

      // ── 占位符全替换 + 实际值注入 ──────────────────────────────────
      expect(script, '不应残留 {{ 占位符').not.toMatch(/\{\{[^}]+\}\}/)
      expect(script).toContain('/Applications/TaiJi.app')
      expect(script).toContain('a'.repeat(64))
      expect(script).toContain('0.9.0')
      expect(script, '成功标记').toContain('write_result "done"')
    })

    it('parentPid 缺失 → throw（契约：无父 PID 就没有可靠等待检查，禁止静默跳过）', () => {
      expect(() =>
        buildUpdaterScript({ ...MAC_VARS, parentPid: '' } as unknown as typeof MAC_VARS),
      ).toThrow(/parentPid is required/)
      expect(() =>
        buildUpdaterScript({ ...MAC_VARS, parentPid: undefined } as unknown as typeof MAC_VARS),
      ).toThrow(/parentPid is required/)
    })

    it('sha256 为 64 位 hex 全替换后比较行语法正确（防御注入回归）', () => {
      const script = buildUpdaterScript({ ...MAC_VARS, sha256: 'f'.repeat(64) })
      expect(script).toContain('f'.repeat(64))
      expect(script).toMatch(/"\$ACTUAL" != "f{64}"/)
    })

    it('appBundle 含 shell 危险字符（" $ ` \\）时逐字符转义，不破坏引号配对', () => {
      const evil = '/Applications/evil"$(rm -rf ~).app'
      const script = buildUpdaterScript({ ...MAC_VARS, appBundle: evil })
      // 双引号上下文危险字符被反斜杠转义（shellEscapeDoubleQuote）
      expect(script).toContain('evil\\"\\$(rm -rf ~).app')
      // 注入点均落在双引号内，原始未转义序列不得出现
      expect(script).not.toContain('evil"$(rm')
    })
  })

  describe('批次 3 S8: mac S1 段 dmg 解包原语（设计 §3.3.3-B）', () => {
    it('mountpoint 在 $TMPDIR 下 mktemp，且独立于 STAGING_DIR / 不放 /Volumes', () => {
      const script = buildUpdaterScript(MAC_VARS)
      const lines = script.split('\n')
      const mktempLine = lines.find((l) => l.includes('MOUNT_DIR=$(mktemp -d'))
      expect(mktempLine, '应有 MOUNT_DIR mktemp 赋值行').toBeDefined()
      // 用户可写目录：$TMPDIR 下 mktemp（/Volumes 是 root:wheel 755，普通用户必败——r1 探针实证）
      expect(mktempLine!).toContain('"${TMPDIR:-/tmp}/taiji-dmg.')
      expect(mktempLine!).toContain('XXXXXX')
      expect(mktempLine!, 'mountpoint 不得放 /Volumes').not.toContain('/Volumes')
      // 独立于 STAGING_DIR：detach 失败滞留挂载时 staging 清理不得波及活跃挂载卷
      expect(mktempLine!, 'mountpoint 推导不得引用 STAGING_DIR').not.toContain('STAGING_DIR')
    })

    it('解包命令序列 = hdiutil attach(-mountpoint) → ditto → detach(eject 降级)', () => {
      const script = buildUpdaterScript(MAC_VARS)
      // attach 显式挂载点（dmg 路径注入值）
      expect(script).toContain(
        `hdiutil attach -nobrowse -readonly "${MAC_VARS.dmgPath}" -mountpoint "$MOUNT_DIR"`,
      )
      // dmg 内 .app 定位（ls -d 通配 + head 取首个）
      expect(script).toContain('SRC_APP=$(ls -d "$MOUNT_DIR"/*.app')
      // ditto 拷贝到 staging（保签名/xattr，不用 cp -R）
      expect(script).toContain('ditto "$SRC_APP" "$STAGED_APP"')
      // 最终 detach 带 eject 降级，且该行无 fail 调用（detach 失败不阻断，S2-S4 换装继续）
      const finalDetachLine = script
        .split('\n')
        .find((l) => l.replace(/^hdiutil detach /, '').startsWith('"$MOUNT_DIR"') && l.includes('hdiutil eject'))
      expect(finalDetachLine, '最终 detach 行应为 detach || eject 降级').toBeDefined()
      expect(finalDetachLine!, 'detach 失败不得阻断（无 fail 调用）').not.toContain('fail')
    })

    it('attach 失败 → fail 分支且错误信息带恢复动作（重启/手动 detach 后重试）', () => {
      const script = buildUpdaterScript(MAC_VARS)
      expect(script, 'attach 应显式判退出码').toContain('if ! hdiutil attach')
      expect(script, '挂载失败错误码 + 恢复指引').toContain(
        'fail "dmg mount failed (reboot the system or run hdiutil detach manually, then retry)"',
      )
    })

    it('unzip 解包原语已被整体替换（不再出现）', () => {
      const script = buildUpdaterScript(MAC_VARS)
      expect(script, '批次 3 后 mac 脚本不得再使用 unzip').not.toContain('unzip')
    })

    it('S2-S5 换装/回滚/finalize 段未被解包改造波及', () => {
      const script = buildUpdaterScript(MAC_VARS)
      // stage 标记齐全（S1 改造只动解包原语，状态机骨架不变）
      for (const stage of ['S1 extract begin', 'S2 promote begin', 'S3 backup begin', 'S4 swap begin', 'S5 finalize begin']) {
        expect(script, `应包含 stage 标记: ${stage}`).toContain(`[stage] ${stage}`)
      }
      // S2 两步中转 / S3 备份不吞错 / S4 原子换装 + 回滚 / S5 xattr + done
      expect(script).toContain('mv "$STAGED_APP" "$APP_NEW"')
      expect(script).toContain('if ! mv "$APP" "$APP_OLD"')
      expect(script).toContain('if ! mv "$APP_NEW" "$APP"')
      expect(script).toContain('mv "$APP_OLD" "$APP"')
      expect(script).toContain('xattr -cr "$APP"')
      expect(script).toContain('write_result "done"')
    })
  })

  describe('u1a: linux 脚本模板（PID 等待 + 只读检测 + 原子 result，无 staging）', () => {
    it('生成脚本含 §3.3.3 检查（PID 等待/超时/只读/原子 result）且占位符全替换', () => {
      const script = buildLinuxUpdaterScript(LINUX_VARS)

      const guards: Array<[string, string]> = [
        ['PID 制等待', 'while kill -0 "$PARENT_PID" 2>/dev/null'],
        ['60s 上限（120 轮）', '-gt 120'],
        ['等待超时错误码', 'fail "app still running"'],
        // 只读检测：APP_DIR 不可写（rename 权限看父目录写权限）
        ['只读检测', '[ ! -w "$APP_DIR" ]'],
        ['只读错误码', 'fail "read-only volume"'],
        // 备份/换装失败不吞错 + 回滚
        ['备份 mv 失败检查', 'if ! mv "$APP" "$APP_OLD"'],
        ['备份失败错误码', 'fail "backup failed"'],
        ['换装 mv 失败检查', 'if ! mv "$APP_NEW_FILE" "$APP"'],
        ['回滚备份', 'mv "$APP_OLD" "$APP"'],
        ['换装失败错误码', 'fail "mv failed"'],
        // sha256 校验（sha256sum）
        ['sha256 校验', 'sha256sum'],
        ['sha 错误码', 'fail "sha mismatch"'],
        // tmp + rename 原子写
        ['result tmp 变量', `RESULT_TMP="${LINUX_VARS.resultPath}.tmp"`],
        ['tmp 写入', '> "$RESULT_TMP"'],
        ['tmp rename', `mv -f "$RESULT_TMP" "${LINUX_VARS.resultPath}"`],
        // 权限 + 备份清理
        ['chmod 755', 'chmod 755'],
        ['残留 .old 清理', 'rm -f "$APP_OLD"'],
      ]
      for (const [name, frag] of guards) {
        expect(script, `应包含检查: ${name} (${frag})`).toContain(frag)
      }

      // 后台重启（& 放后台；P9 探针覆盖稳定性）
      expect(script).toContain(`"${LINUX_VARS.appImagePath}" &`)
      // PARENT_PID 注入
      expect(script).toContain(`PARENT_PID="${LINUX_VARS.parentPid}"`)
      // pgrep 已废弃；无 staging（AppImage 单文件 mv 原子）
      expect(script, '不得再使用 pgrep').not.toContain('pgrep')
      expect(script, 'linux 无 staging 目录').not.toContain('STAGING_DIR')
      // 占位符全替换
      expect(script).not.toMatch(/\{\{[^}]+\}\}/)
      expect(script).toContain('/home/test/TaiJi-x86_64.AppImage')
      expect(script).toContain('0.9.0')
      expect(script, '成功标记').toContain('write_result "done"')
    })

    it('parentPid 缺失 → throw（与 mac 同契约）', () => {
      expect(() =>
        buildLinuxUpdaterScript({ ...LINUX_VARS, parentPid: '' } as unknown as typeof LINUX_VARS),
      ).toThrow(/parentPid is required/)
    })
  })

  describe('u5a: 跨进程互斥 pid 文件（批次 5 §3.7.1）', () => {
    it('mac/linux 脚本启动即写 updater.pid（结果路径同目录）+ trap 退出清理', () => {
      const mac = buildUpdaterScript({ ...MAC_VARS })
      const linux = buildLinuxUpdaterScript({ ...LINUX_VARS })

      // pid 文件路径：由 resultPath 同目录推导（零新增注入点）
      expect(mac, 'mac 应写 pid 文件').toContain(
        `PID_FILE="$(dirname "${MAC_VARS.resultPath}")/updater.pid"`,
      )
      expect(linux, 'linux 应写 pid 文件').toContain(
        `PID_FILE="$(dirname "${LINUX_VARS.resultPath}")/updater.pid"`,
      )
      // 写自身 pid + trap EXIT 清理（覆盖成功/失败/意外错误退出路径）
      expect(mac, 'mac 应写自身 pid').toMatch(/echo \$\$ > "\$PID_FILE"/)
      expect(linux, 'linux 应写自身 pid').toMatch(/echo \$\$ > "\$PID_FILE"/)
      expect(mac, 'mac 应 trap EXIT 清理 pid').toContain(
        "trap 'rm -f \"$PID_FILE\"' EXIT",
      )
      expect(linux, 'linux 应 trap EXIT 清理 pid').toContain(
        "trap 'rm -f \"$PID_FILE\"' EXIT",
      )
    })
  })
});
