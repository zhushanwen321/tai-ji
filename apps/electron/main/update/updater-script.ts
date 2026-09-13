/**
 * 升级 bash 脚本生成器（纯函数，无副作用）。
 *
 * 生成 mac/linux detached bash 脚本字符串，由 platform-updater 写到磁盘 +
 * chmod 755 + spawn detached 执行。
 *
 * 纯函数设计：输入变量对象 → 输出脚本字符串。便于单元测试（断言关键片段 +
 * 占位符全替换无 {{ 残留）。
 *
 * [HISTORICAL] mac staging 状态机（设计 .tmp/update-reliability.tech-design.md §3.3，
 * 2026-08 自动升级可靠性优化批次 1）：
 * - 核心不变量（G1 安装中断不装坏）：S4 换装成功前正式位置零接触——任一失败点上
 *   .app 要么是完整新版、要么是完整旧版。
 * - 状态机：S0 守卫（只读卷检测 → PID 等待退出 → sha256）→ S1 staging 解包
 *   （dmg 挂载 + ditto 拷贝到同卷临时目录）→ S2 mv 内层 .app 为 .app.new
 *   → S3 备份 mv（.app → .app.old）→ S4 原子换装（.app.new → .app，失败回滚
 *   .old）→ S5 xattr / rm .old / 写 done → open 重启。
 * - 残余窗口（诚实边界，无法自愈）：S3→S4 两条同目录 rename 之间中断 = .app 缺失 +
 *   .old/.new 双份完整，自愈代码运行在 app 内无执行机会。手动恢复出口见
 *   docs/TROUBLESHOOTING.md「升级中断手动恢复」。
 * - .old 处置规则：仅当 .app 在位（完整可用）时才清残留 .old（此时 .old 无恢复价值）；
 *   .app 缺失 + .old 在 = 残余窗口态，禁止动 .old（手动恢复唯一出口），fail abort。
 * - xattr -cr 清 quarantine（未签名发布场景：CI 产物本就未签名，无需 ad-hoc 重签名；
 *   xattr 清 quarantine 已足够绕过 Gatekeeper，原 codesign 段已删除）。删除理由：
 *   (1) 本项目是未签名/ad-hoc 签名发布，CI 产物本就无 Developer ID，重签无意义；
 *   (2) `--deep` 在 macOS 13+ 已弃用；(3) xattr -cr 已清 quarantine。
 * - 所有命令显式判退出码 + 失败写 update-result.json status='failed' + 退出非 0。
 * - 等待退出为 PID 制（kill -0 "$PARENT_PID"），废弃 pgrep pattern——pgrep -f 的
 *   ERE 元字符与子串误匹配问题 by construction 消除（RM9）。main 侧必须注入
 *   process.pid（parentPid 变量），缺失/为空时脚本 fail-fast 拒绝继续（宁可不升级）。
 * - 重启 `open "$APP"` 无 -n：已有实例则激活之、无实例则启动，与单实例锁语义一致
 *   （open -n 强制新实例会被 requestSingleInstanceLock 弹掉 = 重启静默失败，RM6）。
 * - result 原子写（tmp + mv，m12）：先写 result.json.tmp 再 mv，避免读到半截 JSON。
 *
 * [HISTORICAL] linux 脚本：AppImage 为单文件，mv 替换本身原子，无 staging 必要；
 * 与 mac 同步获得 PID 等待 + 超时 abort + 只读检测 + 原子 result 写。
 * `&` 后台重启在无终端环境的稳定性由探针 P9 验证（降级路径：setsid/nohup 包装）。
 *
 * 占位符用 {{...}} 双花括号（避免 bash ${} 冲突）；所有注入到双引号上下文的值经
 * shellEscapeDoubleQuote 转义（防 shell 注入：路径/版本号若含 `"`、`` ` ``、`$`、
 * `\` 会破坏引号配对或注入命令）。
 *
 * 依赖方向：updater-script → 无外部依赖（纯字符串拼接）
 */

/** mac updater 脚本的变量替换入参 */
export interface UpdaterScriptVars {
  /** app bundle 路径（如 /Applications/太极.app） */
  appBundle: string
  /** 下载的 dmg 路径 */
  dmgPath: string
  /** 64 位 hex sha256（verify-before-replace 用） */
  sha256: string
  /** 日志输出路径 */
  logPath: string
  /** update-result.json 路径（跨进程状态 SSOT） */
  resultPath: string
  /** app 主二进制名（Contents/MacOS/<appName>，如 'TaiJi'；staging 主二进制存在检查 + 日志用） */
  appName: string
  /** 目标版本号（写日志 + result） */
  targetVersion: string
  /** 升级发起方 main 进程 PID（脚本 kill -0 等待其退出；u1b 契约：platform-updater 注入 process.pid） */
  parentPid: string
}

/** linux updater 脚本的变量替换入参 */
export interface LinuxUpdaterScriptVars {
  /** 当前 AppImage 路径（process.env.APPIMAGE） */
  appImagePath: string
  /** 下载的新 AppImage 文件路径 */
  newFilePath: string
  /** 64 位 hex sha256（verify-before-replace 用，与 mac 一致） */
  sha256: string
  /** 日志输出路径 */
  logPath: string
  /** update-result.json 路径 */
  resultPath: string
  /** 目标版本号 */
  targetVersion: string
  /** 升级发起方 main 进程 PID（与 mac 同契约：platform-updater 注入 process.pid） */
  parentPid: string
}

/**
 * Shell 转义：把值安全地注入 bash 双引号上下文。
 *
 * 双引号上下文里 `$`、`` ` ``、`\`、`"` 是危险字符（前两个触发命令/变量展开，
 * `\` 是转义符，`"` 闭合引号），需反斜杠转义。其它字符（含空格、`;`、`&`、`<`、
 * `>`、`|`、`'`）在双引号内为字面量，无需处理。
 *
 * 防御对象：路径 / 版本号 / sha256 等来自外部（manifest/用户环境）的值若被污染
 * （如版本号 `0.9.0"; rm -rf ~ #`），原 replace 会破坏脚本结构 → 注入任意命令。
 * sha256 虽已被 release-checker 的 `/^[0-9a-f]{64}$/i` 校验，但为 defense-in-depth
 * 一并转义（hex 无危险字符，转义为 no-op，无害）。
 */
function shellEscapeDoubleQuote(s: string): string {
  return s.replace(/[\\$`"]/g, '\\$&')
}

/**
 * JSON 字符串转义（去外层引号）：把值安全地放进 JSON 字符串字面量。
 *
 * 为什么需要双层转义（JSON 层 + shell 层）：注入 result.json 的值（版本号）先经
 * bash 双引号上下文——bash 解析时会消费掉 shellEscapeDoubleQuote 的 `\"` 转义，
 * 值里的真实引号会原样进入 printf 输出 → 污染 result.json 结构（如把 failed
 * 伪造成 done，破坏 G3 结果可信度）。先做 JSON 转义（`"` → `\"`），再做 shell
 * 转义（`\` → `\\`），bash 消费掉 shell 层后剩下的正是 JSON 层转义字节，
 * printf %s 原样落盘 → JSON.parse 还原出原始值，结构不可注入。
 * 普通版本号（如 0.9.11）两层转义均为 no-op，行为不变。
 */
function jsonEscapeString(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/**
 * 生成 mac updater bash 脚本（staging 状态机，见文件头 [HISTORICAL] 说明）。
 *
 * @throws TypeError parentPid 为空/未传时（脚本会拒绝在无父 PID 下运行——
 *         等待退出是「不拆运行中进程底座」的守卫，模板侧同样 fail-fast 兜底）
 */
export function buildUpdaterScript(vars: UpdaterScriptVars): string {
  const { appBundle, dmgPath, sha256, logPath, resultPath, appName, targetVersion, parentPid } = vars
  if (!parentPid) {
    // 模板契约：无 PARENT_PID 就没有可靠的「等待 app 退出」守卫，宁可拒绝升级
    // 也不静默跳过等待（静默跳过 = 升级脚本可能拆掉运行中进程的底座）。
    throw new TypeError('buildUpdaterScript: parentPid is required (main process pid)')
  }
  // 全部经 shellEscapeDoubleQuote 转义：模板里这些值都注入到 bash 双引号上下文，
  // 防止路径/版本号含危险字符（" ` $ \）导致引号破坏或命令注入。
  // 版本号额外做 JSON 层转义（见 jsonEscapeString 注释），因为它还落在 result.json。
  const safeVersion = shellEscapeDoubleQuote(jsonEscapeString(targetVersion))
  return MAC_UPDATER_TEMPLATE
    .replace(/\{\{APP_BUNDLE\}\}/g, shellEscapeDoubleQuote(appBundle))
    .replace(/\{\{DMG_PATH\}\}/g, shellEscapeDoubleQuote(dmgPath))
    .replace(/\{\{SHA256\}\}/g, shellEscapeDoubleQuote(sha256))
    .replace(/\{\{LOG_PATH\}\}/g, shellEscapeDoubleQuote(logPath))
    .replace(/\{\{RESULT_PATH\}\}/g, shellEscapeDoubleQuote(resultPath))
    .replace(/\{\{APP_NAME\}\}/g, shellEscapeDoubleQuote(appName))
    .replace(/\{\{TARGET_VERSION\}\}/g, safeVersion)
    .replace(/\{\{PARENT_PID\}\}/g, shellEscapeDoubleQuote(parentPid))
}

/**
 * 生成 linux AppImage updater bash 脚本（detached）。
 *
 * 流程：只读检测（APP_DIR 不可写即拒）→ 等 app 退出（PID 制，同 mac）→ sha256 校验
 *       → 备份 mv 旧 AppImage 到 .old（失败不吞错）→ mv 新到位（单文件 rename 原子）
 *       → mv 失败回滚 .old → chmod 755 → 清 .old → 写 result（tmp+rename 原子）
 *       → spawn 新 AppImage 重启
 *
 * [HISTORICAL] mv 而非 unlink：避免 mv 新文件失败（跨设备/ENOSPC/EACCES）时用户
 * 处于"无 app"状态。AppImage 单文件 mv 本身原子，无 staging 必要（设计 §3.3.3）。
 */
export function buildLinuxUpdaterScript(vars: LinuxUpdaterScriptVars): string {
  const { appImagePath, newFilePath, sha256, logPath, resultPath, targetVersion, parentPid } = vars
  if (!parentPid) {
    throw new TypeError('buildLinuxUpdaterScript: parentPid is required (main process pid)')
  }
  // 版本号双层转义（JSON + shell），与 mac 同理由（见 jsonEscapeString 注释）
  const safeVersion = shellEscapeDoubleQuote(jsonEscapeString(targetVersion))
  return LINUX_UPDATER_TEMPLATE
    .replace(/\{\{APP_IMAGE_PATH\}\}/g, shellEscapeDoubleQuote(appImagePath))
    .replace(/\{\{NEW_FILE_PATH\}\}/g, shellEscapeDoubleQuote(newFilePath))
    .replace(/\{\{SHA256\}\}/g, shellEscapeDoubleQuote(sha256))
    .replace(/\{\{LOG_PATH\}\}/g, shellEscapeDoubleQuote(logPath))
    .replace(/\{\{RESULT_PATH\}\}/g, shellEscapeDoubleQuote(resultPath))
    .replace(/\{\{TARGET_VERSION\}\}/g, safeVersion)
    .replace(/\{\{PARENT_PID\}\}/g, shellEscapeDoubleQuote(parentPid))
}

// ── mac updater 脚本模板（staging 状态机）────────────────────────
// 关键：S4 换装成功前正式位置零接触（G1 结构不变量）。所有命令显式判退出码，
// 任一失败写 update-result.json status=failed 后退出（错误码 = 错误分类 SSOT，
// 与渲染层 toast 文案映射对齐）。stage 标记行同时服务排障（updater.log 时间戳
// 连续可读）与 integration 测试的中断注入锚点。
//
// STAGING_DIR 与 $APP 同目录（同卷保证 mv 是 rename、原子成立）；固定名字
// （.staging.<basename>）使「S1 前清残留」可寻址（上次中断残留的 staging/.new
// 在本次解包前统一清除）。S1 解包原语 = dmg 挂载 + ditto（保签名/xattr，批次 3
// 设计 §3.3.3-B）：mountpoint 建在 $TMPDIR（/Volumes 是 root:wheel 755 普通用户
// 不可写）且独立于 $STAGING_DIR（detach 失败滞留挂载时 staging 清理不得波及挂载卷）。
const MAC_UPDATER_TEMPLATE = `#!/bin/bash
# mac 升级脚本：staging 状态机（设计 .tmp/update-reliability.tech-design.md §3.3）
# S0 守卫（只读卷 → PID 等待退出 → sha256）→ S1 staging 解压 → S2 mv 为 .app.new
# → S3 备份 mv → S4 原子换装 → S5 xattr/清理/写 done → open 重启（无 -n）
set -uo pipefail
exec > "{{LOG_PATH}}" 2>&1
echo "[$(date)] start update to {{TARGET_VERSION}} (updater pid $$)"

# ── 跨进程互斥（设计 §3.7.1）：启动即写 pid 文件，退出（含失败路径）时清理 ──
# 检查方：新实例启动序列读此文件判断 updater 存活 → defer 回滚清理。
# PID 文件与 update-result.json 同目录（升级工作目录），由结果路径推导零新增注入点。
PID_FILE="$(dirname "{{RESULT_PATH}}")/updater.pid"
echo $$ > "$PID_FILE"
# trap EXIT 覆盖所有退出路径（成功/fail/意外错误）；kill -9 不触发 → 残留 pid
# 由新实例存活检查自愈（进程已死 → 不 defer + 清理残留）。
trap 'rm -f "$PID_FILE"' EXIT

APP="{{APP_BUNDLE}}"
APP_DIR="$(dirname "$APP")"
APP_BASENAME="$(basename "$APP")"
APP_NEW="$APP.new"
APP_OLD="$APP.old"
STAGING_DIR="$APP_DIR/.staging.$APP_BASENAME"
STAGED_APP="$STAGING_DIR/$APP_BASENAME"
MAIN_BINARY="$STAGED_APP/Contents/MacOS/{{APP_NAME}}"
RESULT_TMP="{{RESULT_PATH}}.tmp"
PARENT_PID="{{PARENT_PID}}"

# result 原子写（tmp + mv，m12）：避免读到半截 JSON。
# {{TARGET_VERSION}} 经 printf %s 参数传递（不经 format 转义），已做 shell 转义的
# 污染值只会成为 JSON 字符串内容，无法破坏 JSON 结构。
write_result() {
  local at
  at="$(date -u +%FT%TZ)"
  if [ -n "\${2:-}" ]; then
    printf '{"status":"%s","version":"%s","at":"%s","error":"%s"}\\n' \\
      "$1" "{{TARGET_VERSION}}" "$at" "\$2" > "$RESULT_TMP" \\
      && mv -f "$RESULT_TMP" "{{RESULT_PATH}}"
  else
    printf '{"status":"%s","version":"%s","at":"%s"}\\n' \\
      "$1" "{{TARGET_VERSION}}" "$at" > "$RESULT_TMP" \\
      && mv -f "$RESULT_TMP" "{{RESULT_PATH}}"
  fi
}

# 失败出口：日志 + result(failed) + 非零退出。$1 = 错误码（进 result.json error 字段）
fail() {
  echo "[$(date)] FAILED: \$1"
  write_result "failed" "\$1"
  exit 1
}

# ── S0a: 只读卷检测（RM7：从 DMG 安装映像运行时拒绝安装，防「拆镜像内 app → 失败」循环）──
case "$APP" in
  /Volumes/*)
    fail "read-only volume"
    ;;
esac

# ── S0b: 等待主进程退出（RM9+RM6：PID 制 kill -0，上限 60s；超时宁可不升级，
#    不拆运行中进程的底座）──
if [ -z "$PARENT_PID" ]; then
  echo "[\$(date)] FATAL: PARENT_PID not injected (main-side contract violation)"
  fail "internal error"
fi
wait_loops=0
while kill -0 "$PARENT_PID" 2>/dev/null; do
  wait_loops=\$((wait_loops + 1))
  if [ "\$wait_loops" -gt 120 ]; then
    fail "app still running"
  fi
  sleep 0.5
done
echo "[\$(date)] parent process (pid \$PARENT_PID) exited"

# ── S0c: sha256 校验（verify-before-replace：download 期已验，detached 独立再验一次）──
ACTUAL="\$(shasum -a 256 "{{DMG_PATH}}" | awk '{print \$1}')"
if [ "\$ACTUAL" != "{{SHA256}}" ]; then
  fail "sha mismatch"
fi
echo "[\$(date)] sha ok"

# ── S1/S2 残留清理（状态机恢复方：上次中断残留的 staging/.new 本次解包前清除；
#    不触碰 .app / .old）──
rm -rf "\$STAGING_DIR" "\$APP_NEW"

# ── S1: staging 解包（dmg 挂载 + ditto 拷贝，同卷临时目录，正式位置零接触）──
echo "[\$(date)] [stage] S1 extract begin"
# mountpoint 选址约束（设计 §3.3.3）：必须建在用户可写目录（/Volumes 是
# root:wheel 755，普通用户 mktemp 必败）；且必须独立于 \$STAGING_DIR——
# detach 失败不阻断的语义下挂载卷可能滞留，staging 清理不得波及活跃挂载卷。
MOUNT_DIR=\$(mktemp -d "\${TMPDIR:-/tmp}/taiji-dmg.XXXXXX") || fail "mktemp mountpoint failed"
# 挂载中失败路径的统一出口：先卸载再走 fail（错误码进 result.json），
# 孤儿挂载点由系统重启回收
detach_and_fail() {
  hdiutil detach "\$MOUNT_DIR" 2>/dev/null
  fail "\$1"
}
# attach 失败 → 卸载刚建的空挂载点后 fail。同 inode dmg 在前次挂载未 detach 时
# 重挂载会报「资源忙」exit 1（r2 审查实测，触发需双重罕见叠加），错误信息带
# 恢复动作（重启系统或手动 hdiutil detach 后重试，设计 §3.3.3-B）。
if ! hdiutil attach -nobrowse -readonly "{{DMG_PATH}}" -mountpoint "\$MOUNT_DIR"; then
  hdiutil detach "\$MOUNT_DIR" 2>/dev/null
  fail "dmg mount failed (reboot the system or run hdiutil detach manually, then retry)"
fi
SRC_APP=\$(ls -d "\$MOUNT_DIR"/*.app 2>/dev/null | head -1)
if [ -z "\$SRC_APP" ]; then
  detach_and_fail "no .app in dmg"
fi
# ditto 保签名/xattr/权限（Electron app 换装标准做法，不用 cp -R）
if ! ditto "\$SRC_APP" "\$STAGED_APP"; then
  # S7：清 staging 残留（部分拷贝可达数百 MB），再卸载挂载卷走 fail
  rm -rf "\$STAGING_DIR"
  detach_and_fail "ditto copy failed"
fi
# 主二进制存在检查（RI1：不再用 [ -d .app ] 误判成功；解包产物必须是可运行 app）
if [ ! -x "\$MAIN_BINARY" ]; then
  rm -rf "\$STAGING_DIR"
  detach_and_fail "extract failed"
fi
# detach 失败不阻断（无 fail 调用）：卷句柄滞留不影响已拷出的 .app，S2-S4 换装
# 继续；孤儿挂载点由系统重启回收，不构成更新失败理由
hdiutil detach "\$MOUNT_DIR" || hdiutil eject "\$MOUNT_DIR" 2>/dev/null

# ── S2: 两步中转——staging 内层 .app mv 为 .app.new（同卷 rename，原子）──
echo "[\$(date)] [stage] S2 promote begin"
if ! mv "\$STAGED_APP" "\$APP_NEW"; then
  rm -rf "\$STAGING_DIR" "\$APP_NEW"
  fail "extract failed"
fi
rm -rf "\$STAGING_DIR"

# ── S3: 备份（RM7：mv 失败不吞错——abort 保旧版，绝不进入换装）──
echo "[\$(date)] [stage] S3 backup begin"
if [ -d "\$APP" ]; then
  # 仅当 .app 在位（完整可用）时才清残留 .old（旧 .old 已无恢复价值）。
  # .app 缺失 + .old 在 = S3→S4 残余窗口态，禁止动 .old（手动恢复唯一出口，
  # 见 docs/TROUBLESHOOTING.md「升级中断手动恢复」）。
  rm -rf "\$APP_OLD"
  if ! mv "\$APP" "\$APP_OLD"; then
    fail "backup failed"
  fi
else
  # .app 缺失：保 .old/.new 完整（手动恢复出口），如实写失败。
  fail "backup failed"
fi

# ── S4: 原子换装（同卷 rename）。失败 → 回滚 .old → 写 failed(swap failed) ──
echo "[\$(date)] [stage] S4 swap begin"
if ! mv "\$APP_NEW" "\$APP"; then
  if [ -d "\$APP_OLD" ]; then
    mv "\$APP_OLD" "\$APP" || true
  fi
  fail "swap failed"
fi

# ── S5: 清 quarantine（未签名发布：xattr -cr 绕 Gatekeeper，command -v 守卫 +
#    || true 不致命）→ 删 .old → 写 done（原子）→ open 重启（无 -n：已有实例则
#    激活，open -n 强制新实例会被单实例锁弹掉 = 重启静默失败，RM6）──
echo "[\$(date)] [stage] S5 finalize begin"
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "\$APP" || true
fi
rm -rf "\$APP_OLD"
write_result "done" ""
echo "[\$(date)] update done, restarting"
open "\$APP"
`

// ── linux updater 脚本模板（detached，避免双实例）──────────────────
// 关键：AppImage 单文件 mv 替换本身原子（无 staging 必要，设计 §3.3.3），但
// 备份+换装两条 rename 之间仍是毫秒级残余窗口（与 mac S3→S4 同型，.old/.new
// 双份完整时手动恢复同 docs/TROUBLESHOOTING.md）。与 mac 同步：PID 等待 +
// 60s 超时 abort + 只读检测 + 原子 result 写 + mv 失败不吞错。
const LINUX_UPDATER_TEMPLATE = `#!/bin/bash
# linux AppImage 升级脚本（设计 §3.3.3）：只读检测 → PID 等待退出 → sha256
# → 备份 mv → 换装 mv（失败回滚）→ chmod → 写 done → 后台重启
set -uo pipefail
exec > "{{LOG_PATH}}" 2>&1
echo "[\$(date)] start AppImage update to {{TARGET_VERSION}} (updater pid \$\$)"

# ── 跨进程互斥（设计 §3.7.1）：启动即写 pid 文件，退出时清理（与 mac 同语义）──
# PID 文件与 update-result.json 同目录（升级工作目录），由结果路径推导零新增注入点
PID_FILE="\$(dirname "{{RESULT_PATH}}")/updater.pid"
echo \$\$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

APP="{{APP_IMAGE_PATH}}"
APP_DIR="\$(dirname "$APP")"
APP_OLD="$APP.old"
APP_NEW_FILE="{{NEW_FILE_PATH}}"
RESULT_TMP="{{RESULT_PATH}}.tmp"
PARENT_PID="{{PARENT_PID}}"

# result 原子写（tmp + mv，m12；与 mac 同实现）
write_result() {
  local at
  at="\$(date -u +%FT%TZ)"
  if [ -n "\${2:-}" ]; then
    printf '{"status":"%s","version":"%s","at":"%s","error":"%s"}\\n' \\
      "\$1" "{{TARGET_VERSION}}" "\$at" "\$2" > "$RESULT_TMP" \\
      && mv -f "$RESULT_TMP" "{{RESULT_PATH}}"
  else
    printf '{"status":"%s","version":"%s","at":"%s"}\\n' \\
      "\$1" "{{TARGET_VERSION}}" "\$at" > "$RESULT_TMP" \\
      && mv -f "$RESULT_TMP" "{{RESULT_PATH}}"
  fi
}

fail() {
  echo "[\$(date)] FAILED: \$1"
  write_result "failed" "\$1"
  exit 1
}

# ── 只读检测：APP_DIR 不可写（只读挂载/安装介质）拒绝原地替换。
#    rename 权限看的是父目录写权限，[ -w $APP_DIR ] 即 mv 能否成立的前置条件 ──
if [ ! -w "$APP_DIR" ]; then
  fail "read-only volume"
fi

# ── PID 等待退出（同 mac：kill -0，60s 上限，超时宁可不升级）──
if [ -z "$PARENT_PID" ]; then
  echo "[\$(date)] FATAL: PARENT_PID not injected (main-side contract violation)"
  fail "internal error"
fi
wait_loops=0
while kill -0 "$PARENT_PID" 2>/dev/null; do
  wait_loops=\$((wait_loops + 1))
  if [ "\$wait_loops" -gt 120 ]; then
    fail "app still running"
  fi
  sleep 0.5
done
echo "[\$(date)] parent process (pid \$PARENT_PID) exited"

# ── sha256 校验（verify-before-replace，防下载后篡改/损坏）──
ACTUAL="\$(sha256sum "{{NEW_FILE_PATH}}" | awk '{print \$1}')"
if [ "\$ACTUAL" != "{{SHA256}}" ]; then
  fail "sha mismatch"
fi
echo "[\$(date)] sha ok"

# ── 备份（与 mac S3 同语义：失败不吞错；仅 .app 在位时才清残留 .old；
#    .app 缺失 + .old 在 = 残余窗口态，禁止动 .old，保手动恢复出口）──
echo "[\$(date)] [stage] backup begin"
if [ -f "$APP" ]; then
  rm -f "$APP_OLD"
  if ! mv "$APP" "$APP_OLD"; then
    fail "backup failed"
  fi
else
  fail "backup failed"
fi

# ── 换装（单文件 rename 原子）。失败 → 回滚 .old → 写 failed(mv failed) ──
echo "[\$(date)] [stage] swap begin"
if ! mv "$APP_NEW_FILE" "$APP"; then
  if [ -f "$APP_OLD" ]; then
    mv "$APP_OLD" "$APP" || true
  fi
  fail "mv failed"
fi

chmod 755 "$APP"
rm -f "$APP_OLD"

write_result "done" ""
echo "[\$(date)] update done, restarting"

# spawn 重启（detached，& 放后台；无终端环境稳定性由探针 P9 验证）
"{{APP_IMAGE_PATH}}" &
`
