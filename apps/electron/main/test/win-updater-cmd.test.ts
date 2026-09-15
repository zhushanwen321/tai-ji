/**
 * u2a 单元测试：win-updater-cmd（cmd wrapper 模板生成器，纯函数）。
 *
 * 覆盖目标（设计 .tmp/update-reliability.tech-design.md §3.4.1 wrapper 五步，
 * 验收条款①：tasklist 轮询 / 60s 超时 / start /wait+空 title / errorlevel 检查 /
 * tmp+rename result 的 grep+单测断言）：
 *   - 五步全守卫 grep 级断言（含 certutil 复验、ping sleep 原语、/D= 不加引号、重启行）
 *   - 变量注入：PARENT_PID（u1b 同契约）/sha256/version 等实际值落进 set 行
 *   - cmd 注入值校验：含 " % & | < > ^ ! 危险字符 → throw（cmd 无法等价 bash 转义模型）
 *   - parentPid 缺失 → throw（无可靠等待守卫宁可不升级）
 *
 * 字符串断言边界：本文件验证生成器产物内容；cmd 在 Windows 真机的运行时行为
 * （ping sleep 原语 P1 / tasklist+find 语义 P2 / certutil 解析 P4 / start /wait P13）
 * 由探针在真机验证，本机（macOS）无法复现，不写假执行测试。
 *
 * 运行：cd apps/electron/main && npx vitest run test/win-updater-cmd.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buildWinUpdaterCmd } from '../update/win-updater-cmd.js'

/** 标准变量 fixture（模拟 electron-builder 默认 per-user 布局） */
const VARS = {
  installerPath: 'C:\\Users\\test\\AppData\\Local\\taiji\\update\\TaiJi-setup-x64.exe',
  installDir: 'C:\\Users\\test\\AppData\\Local\\Programs\\taiji',
  targetExePath: 'C:\\Users\\test\\AppData\\Local\\Programs\\taiji\\TaiJi.exe',
  resultPath: 'C:\\Users\\test\\AppData\\Roaming\\taiji\\update\\update-result.json',
  logPath: 'C:\\Users\\test\\AppData\\Roaming\\taiji\\update\\updater-win.log',
  parentPid: '424242',
  sha256: 'c'.repeat(64),
  targetVersion: '0.9.11',
}

describe('u2a: win wrapper cmd 模板（§3.4.1 五步全守卫）', () => {
  it('生成脚本含五步全部守卫且占位符全替换', () => {
    const script = buildWinUpdaterCmd(VARS)

    // ── 验收条款①逐项守卫（grep 级断言）────────────────────────────
    const guards: Array<[string, string]> = [
      // 1. tasklist 轮询等待父退出 + 60s 超时 abort
      ['tasklist 轮询', 'tasklist /FI "PID eq %PARENT_PID%"'],
      ['find 命中判断', 'find "%PARENT_PID%" >nul'],
      ['60s 上限（60 次）', 'GTR 60'],
      ['ping sleep 原语（P1）', 'ping -n 2 127.0.0.1 >nul'],
      ['等待超时错误码', 'call :write_result failed "app did not exit"'],
      // 2. certutil sha256 复验
      ['certutil 复验', 'certutil -hashfile "%INSTALLER%" SHA256'],
      ['sha 错误码', 'call :write_result failed "sha mismatch"'],
      // 3. start /wait + 空 title + /D= 不加引号
      ['start /wait + 空 title', 'start /wait "" "%INSTALLER%" /S --updated /D=%INSTALL_DIR%'],
      // 4. errorlevel（安装器真实退出码）检查
      ['安装器退出码错误码', 'call :write_result failed "installer exited %EXITCODE%"'],
      // 5. tmp+move 原子写 result + 重启
      ['result tmp 写入', '> "%RESULT%.tmp"'],
      ['tmp rename（m12）', 'move /y "%RESULT%.tmp" "%RESULT%"'],
      ['done 标记', 'call :write_result done ""'],
      ['重启行', 'start "" "%TARGET_EXE%"'],
    ]
    for (const [name, frag] of guards) {
      expect(script, `应包含守卫: ${name} (${frag})`).toContain(frag)
    }

    // /D= 值不加引号（NSIS 约定，m16）：不得出现引号包裹的 /D=
    expect(script, '/D= 值不得加引号').not.toContain('/D="')

    // ── 变量注入（实际值落进 set 行）───────────────────────────────
    expect(script, 'PARENT_PID 注入').toContain(`set "PARENT_PID=${VARS.parentPid}"`)
    expect(script, 'sha256 注入').toContain(`set "EXPECTED_SHA=${VARS.sha256}"`)
    expect(script, 'version 注入').toContain(`set "VERSION=${VARS.targetVersion}"`)
    expect(script, 'installerPath 注入').toContain(`set "INSTALLER=${VARS.installerPath}"`)
    expect(script, 'installDir 注入').toContain(`set "INSTALL_DIR=${VARS.installDir}"`)
    expect(script, 'resultPath 注入').toContain(`set "RESULT=${VARS.resultPath}"`)
    expect(script, 'logPath 注入').toContain(`set "LOG=${VARS.logPath}"`)
    expect(script, '重启目标注入').toContain(`set "TARGET_EXE=${VARS.targetExePath}"`)

    // ── 占位符全替换 ───────────────────────────────────────────────
    expect(script, '不应残留 {{ 占位符').not.toMatch(/\{\{[^}]+\}\}/)
  })

  it('注入值含 cmd 危险字符（" % & | < > ^ !）→ throw（cmd 无法等价 bash 转义，fail-fast）', () => {
    for (const evil of ['"', '%', '&', '|', '<', '>', '^', '!']) {
      expect(
        () => buildWinUpdaterCmd({ ...VARS, installDir: `C:\\Prog${evil}ram\\taiji` }),
        `installDir 含 ${JSON.stringify(evil)} 应 throw`,
      ).toThrow(/cmd 危险字符/)
    }
    // 非法字符在任意注入位都拦（以 version 为例）
    expect(() => buildWinUpdaterCmd({ ...VARS, targetVersion: '0.9.11&calc' })).toThrow(/cmd 危险字符/)
  })

  it('parentPid 缺失 → throw（与 mac/linux 同契约：无可靠等待守卫宁可不升级）', () => {
    expect(() =>
      buildWinUpdaterCmd({ ...VARS, parentPid: '' } as unknown as typeof VARS),
    ).toThrow(/parentPid/)
  })
})
