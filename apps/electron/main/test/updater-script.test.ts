/**
 * u1a 单元测试：updater-script（bash 脚本生成器，纯函数）。
 *
 * 覆盖目标（设计 .tmp/update-reliability.tech-design.md §3.3.2 命令级守卫，验收条款①）：
 *   - mac 脚本 staging 状态机全守卫 grep 级断言：dmg 解包链退出码检查（hdiutil
 *     attach / ditto，批次 3 设计 §3.3.3-B）、主二进制存在检查、
 *     备份 mv 失败 abort、换装失败回滚、60s 超时 abort（PID 制 kill -0）、
 *     /Volumes 只读拒装、tmp+rename result 原子写、open 无 -n
 *   - linux 脚本：PID 等待 + 超时 abort + 只读检测 + 原子 result（无 staging，
 *     mv 单文件替换本身原子，设计 §3.3.3）
 *   - parentPid 契约（u1a 模板侧 / u1b 注入侧）：缺失即 throw，禁止静默跳过等待
 *   - shell 注入防御：路径/版本号含危险字符时转义不破坏脚本与 JSON 结构
 *   - 占位符全替换（无 {{ 残留）
 *   - 批次 3 S8：dmg 解包原语断言（mountpoint 选址 / detach 失败不阻断 /
 *     S2-S5 换装回滚段未被解包改造波及）
 *
 * 「字符串断言」的边界说明：本文件只验证脚本内容含守卫片段（生成器视角）；
 * 脚本真实执行行为（bash 能跑通、分支真的触发）由 updater-script-integration.test.ts 覆盖。
 *
 * 运行：cd apps/electron/main && npx vitest run test/updater-script.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  buildUpdaterScript,
  buildLinuxUpdaterScript,
} from '../update/updater-script.js'

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

describe('u1a: mac 脚本模板（staging 状态机 + §3.3.2 全守卫）', () => {
  it('生成脚本含 §3.3.2 全部命令级守卫且占位符全替换', () => {
    const script = buildUpdaterScript(MAC_VARS)

    // ── 验收条款①逐项守卫（grep 级断言，验收对照）─────────────────
    const guards: Array<[string, string]> = [
      // dmg 解包链退出码显式检查（批次 3 §3.3.3-B：hdiutil attach + ditto）
      ['attach 退出码检查', 'if ! hdiutil attach -nobrowse -readonly "{{DMG_PATH}}"'],
      ['挂载失败错误码', 'fail "dmg mount failed'],
      ['ditto 退出码检查', 'if ! ditto "$SRC_APP" "$STAGED_APP"'],
      ['ditto 失败错误码', 'fail "ditto copy failed"'],
      // 主二进制缺失错误码（RI1 守卫，S8：解包后主二进制存在检查保留）
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
      expect(script, `应包含守卫: ${name} (${expected})`).toContain(expected)
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
    expect(script, 'S0 守卫段不得预恢复 .old').not.toContain('restored from .old')

    // ── 占位符全替换 + 实际值注入 ──────────────────────────────────
    expect(script, '不应残留 {{ 占位符').not.toMatch(/\{\{[^}]+\}\}/)
    expect(script).toContain('/Applications/TaiJi.app')
    expect(script).toContain('a'.repeat(64))
    expect(script).toContain('0.9.0')
    expect(script, '成功标记').toContain('write_result "done"')
  })

  it('parentPid 缺失 → throw（契约：无父 PID 就没有可靠等待守卫，禁止静默跳过）', () => {
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
  it('生成脚本含 §3.3.3 守卫（PID 等待/超时/只读/原子 result）且占位符全替换', () => {
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
      expect(script, `应包含守卫: ${name} (${frag})`).toContain(frag)
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
