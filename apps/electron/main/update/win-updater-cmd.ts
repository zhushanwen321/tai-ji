/**
 * win wrapper cmd 模板生成器（纯函数，无副作用）。
 *
 * 对应设计 .tmp/update-reliability.tech-design.md §3.4 批次 2：WinUpdater 从
 * 「返回参数由 orchestrator 延迟 spawn」改为与 mac/linux 同构——prepareUpdate 内
 * 写 updater.cmd 到升级工作目录（getUpdateDir()）并 detached spawn（cmd /c，detached + ignore stdio）；
 * orchestrator 的 spawn-installer 延迟分支由批次 2 u2b 删除（win 返回
 * detached-script，三平台统一语义）。
 *
 * wrapper 轮询语义（§3.4.1 五步）：
 *   1. tasklist /FI "PID eq N" | find 轮询等待父进程退出，上限 60 次
 *      （ping -n 2 ≈ 1s/次 ≈ 60s）；超时写 failed(app did not exit) 退出，
 *      不启动安装器——宁可不升级也不拆运行中进程的底座
 *   2. certutil -hashfile SHA256 复验（大小写不敏感比较）；不符写 failed(sha mismatch)。
 *      download 期已验，此处独立再验一层（RM4 纵深）；P4 探针失败时降级去掉本步
 *   3. start /wait "" "<installer>" /S --updated /D=<installDir>：NSIS 是 GUI 子系统
 *      程序，cmd 直接调用不会等待，必须 start /wait（P13）；空 title "" 占位防含空格
 *      安装器路径被误当窗口标题；/D= 值不加引号——NSIS 约定，cmd 逐字传递，
 *      绕开自动加引号，解 m16（含空格路径 P3 探针）
 *   4. errorlevel = 安装器真实退出码（start /wait 语义）；非 0 →
 *      failed(installer exited <code>) 跳过重启。NSIS 半装失败由安装器自身 rollback；
 *      孤儿 runtime 进程持有文件锁 → errorlevel 非 0 → 写 failed 可重试，
 *      兜底语义内建（S-9/P14），wrapper 不清理孤儿
 *   5. 成功 → tmp+move 原子写 done(version) → start "" "<exe>" 重启
 *
 * [HISTORICAL] 探针依赖（Windows 真机实施期门，失败降级路径均已在设计登记，
 * 本实现不预置降级）：P1 ping sleep 原语（降级 PowerShell Start-Sleep）、
 * P2 tasklist+find 语义（降级 PowerShell Get-Process）、P3 /D= 含空格路径落位、
 * P4 certutil 输出解析（降级去掉复验）、P13 start /wait 完成等待语义
 * （降级 PowerShell Start-Process -Wait）。
 *
 * cmd 转义模型与 bash 不同（无反斜杠转义引号；unquoted /D= 上下文无法安全传递
 * shell 元字符）：注入值含 " % & | < > ^ ! 任一字符时直接 throw（fail-fast），
 * 不做有损转义。注入值来自 main 侧 process.execPath / 升级工作目录（getUpdateDir()）
 * 推导（非外部输入），正常不会命中；命中 = 路径异常，拒绝升级比静默坏安全。
 *
 * [批次 5 互斥（§3.7.1）win 侧实现]：cmd 无内建变量可廉价自取进程 PID
 * （PowerShell $PID 是其自身进程而非 wrapper），updater.pid 由 main 侧
 * platform-updater.ts 在 spawn 后写 child.pid；wrapper 退出后由 self-healer
 * 的 isUpdaterInFlight 检查回收。mac/linux 侧由 bash $$ 自写 + trap 清理，
 * 见 updater-script.ts。
 *
 * 占位符用 {{...}} 双花括号（与 mac/linux bash 生成器一致）。
 *
 * 依赖方向：win-updater-cmd → 无外部依赖（纯字符串拼接）
 */

/** win updater cmd 脚本的变量替换入参 */
export interface WinUpdaterCmdVars {
  /** 下载的 NSIS 安装器路径 */
  installerPath: string
  /** 安装目录（main 侧 path.dirname(process.execPath) 推导，NSIS /D= 值） */
  installDir: string
  /** 升级完成后重启的可执行文件路径（installDir 下同名 exe） */
  targetExePath: string
  /** update-result.json 路径（跨进程状态 SSOT，与 mac/linux 同一文件） */
  resultPath: string
  /** wrapper 日志路径 */
  logPath: string
  /** 升级发起方 main 进程 PID（wrapper tasklist 轮询等待其退出；u1b 同契约） */
  parentPid: string
  /** 64 位 hex sha256（certutil 复验用） */
  sha256: string
  /** 目标版本号（写日志 + result） */
  targetVersion: string
}

/**
 * cmd 注入值校验：含 cmd 危险字符直接 throw。
 *
 * `"` 破坏 set "VAR=..." 与 "%VAR%" 的引号配对；`%` 触发批处理变量展开；
 * `& | < > ^` 在 unquoted /D= 上下文是命令分隔/重定向/转义符；`!` 在
 * enabledelayedexpansion 下是延迟展开符（防御未来改动）。
 */
function assertCmdSafe(name: string, value: string): void {
  if (/["%&|<>^!]/.test(value)) {
    throw new TypeError(
      `buildWinUpdaterCmd: ${name} 含 cmd 危险字符（" % & | < > ^ !），拒绝生成脚本：${value}`,
    )
  }
  if (!value) {
    throw new TypeError(`buildWinUpdaterCmd: ${name} 不能为空`)
  }
}

/**
 * 生成 win wrapper cmd 脚本。
 *
 * @throws TypeError 注入值含 cmd 危险字符或 parentPid 缺失（与 mac/linux 同契约：
 *         无父 PID 就没有可靠的「等 app 退出」守卫，宁可不升级）
 */
export function buildWinUpdaterCmd(vars: WinUpdaterCmdVars): string {
  assertCmdSafe('installerPath', vars.installerPath)
  assertCmdSafe('installDir', vars.installDir)
  assertCmdSafe('targetExePath', vars.targetExePath)
  assertCmdSafe('resultPath', vars.resultPath)
  assertCmdSafe('logPath', vars.logPath)
  assertCmdSafe('parentPid', vars.parentPid)
  assertCmdSafe('sha256', vars.sha256)
  assertCmdSafe('targetVersion', vars.targetVersion)
  return WIN_UPDATER_CMD_TEMPLATE
    .replace(/\{\{INSTALLER_PATH\}\}/g, vars.installerPath)
    .replace(/\{\{INSTALL_DIR\}\}/g, vars.installDir)
    .replace(/\{\{TARGET_EXE_PATH\}\}/g, vars.targetExePath)
    .replace(/\{\{RESULT_PATH\}\}/g, vars.resultPath)
    .replace(/\{\{LOG_PATH\}\}/g, vars.logPath)
    .replace(/\{\{PARENT_PID\}\}/g, vars.parentPid)
    .replace(/\{\{SHA256\}\}/g, vars.sha256)
    .replace(/\{\{TARGET_VERSION\}\}/g, vars.targetVersion)
}

// ── win wrapper cmd 模板（§3.4.1 五步）──────────────────────────
// 结构要点：
// - goto 式流程（非圆括号块）：unquoted /D= 值可能含括号（如 Program Files (x86)），
//   圆括号块内的 `)` 会提前闭合块；顶层行内括号是字面量，goto 流程规避该解析坑。
// - call :main >> "%LOG%" 2>&1：单点重定向收集全程日志（cmd 无 exec 重定向等价物）。
// - result 经 :write_result 子例程写：> tmp + move /y 同卷 rename（m12 原子写语义）。
// - "at" 用 %DATE% %TIME% 本地格式：cmd 无内建 ISO 时间，不引入 PowerShell 依赖；
//   字段为信息性，消费者仅透传展示。
const WIN_UPDATER_CMD_TEMPLATE = `@echo off
rem taiji win upgrade wrapper（设计 .tmp/update-reliability.tech-design.md §3.4.1）
rem 流程：tasklist 轮询等父退出（60s 上限）→ certutil sha256 复验 → start /wait 静默安装
rem → errorlevel 检查 → tmp+move 原子写 result → start 重启
setlocal
set "INSTALLER={{INSTALLER_PATH}}"
set "INSTALL_DIR={{INSTALL_DIR}}"
set "TARGET_EXE={{TARGET_EXE_PATH}}"
set "RESULT={{RESULT_PATH}}"
set "LOG={{LOG_PATH}}"
set "PARENT_PID={{PARENT_PID}}"
set "EXPECTED_SHA={{SHA256}}"
set "VERSION={{TARGET_VERSION}}"

call :main >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:main
echo [%DATE% %TIME%] start update to %VERSION%

rem -- 1. 等待父进程退出（tasklist 轮询，60 次 x ping -n 2 约 60s 上限；超时不启动安装器）--
set /a WAITED=0
:wait_loop
tasklist /FI "PID eq %PARENT_PID%" 2>nul | find "%PARENT_PID%" >nul
if errorlevel 1 goto wait_done
set /a WAITED+=1
if %WAITED% GTR 60 goto wait_timeout
ping -n 2 127.0.0.1 >nul
goto wait_loop
:wait_timeout
echo [%DATE% %TIME%] FAILED: app did not exit
call :write_result failed "app did not exit"
exit /b 1
:wait_done
echo [%DATE% %TIME%] parent process (pid %PARENT_PID%) exited

rem -- 2. sha256 复验（certutil 输出 skip=1 后首行为 hash；大小写不敏感比较）--
set "ACTUAL_SHA="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "%INSTALLER%" SHA256 2^>nul') do if not defined ACTUAL_SHA set "ACTUAL_SHA=%%H"
if /i "%ACTUAL_SHA%"=="%EXPECTED_SHA%" goto sha_ok
echo [%DATE% %TIME%] FAILED: sha mismatch
call :write_result failed "sha mismatch"
exit /b 1
:sha_ok
echo [%DATE% %TIME%] sha ok

rem -- 3/4. start /wait 静默安装 + 退出码检查（start /wait 下 errorlevel=安装器真实退出码）--
start /wait "" "%INSTALLER%" /S --updated /D=%INSTALL_DIR%
set "EXITCODE=%ERRORLEVEL%"
if "%EXITCODE%"=="0" goto install_ok
echo [%DATE% %TIME%] FAILED: installer exited %EXITCODE%
call :write_result failed "installer exited %EXITCODE%"
exit /b 1
:install_ok
echo [%DATE% %TIME%] installer exited 0

rem -- 5. done（tmp+move 原子写）→ 重启 --
call :write_result done ""
echo [%DATE% %TIME%] update done, restarting
start "" "%TARGET_EXE%"
exit /b 0

:write_result
rem %1=status %2=error（可空）。tmp+move 同卷 rename 原子写（m12）。
> "%RESULT%.tmp" echo {"status":"%~1","version":"%VERSION%","at":"%DATE% %TIME%","error":"%~2"}
move /y "%RESULT%.tmp" "%RESULT%" >nul
exit /b 0
`
