#!/usr/bin/env node
/**
 * dev 模式 Electron 启动器：用自制 app bundle 替代默认 Electron.app，让 macOS
 * dock「一打开就是太极图标」（而非先闪蓝色 Electron logo 再被 app.dock.setIcon 替换）。
 *
 * 原理：
 *   macOS dock 图标在进程 spawn 时由 LaunchServices 按 bundle 的
 *   Info.plist/CFBundleIconFile 注册。JS 层 app.dock.setIcon() 必须等
 *   NSApplication 启动后才能异步替换 → 必然先闪默认图标。唯一可靠做法是
 *   让 dev 跑的 bundle 自身就用太极 icns。
 *
 * 做法（仅 macOS）：
 *   1. cp -Rc（APFS clonefile COW，秒级、不占额外空间）复制源 Electron.app
 *      到 .dev-electron/Taiji.app
 *   2. PlistBuddy 改 CFBundleIconFile → taiji.icns、CFBundleName/DisplayName → 太极 dev
 *      （显示名带 dev 后缀：与打包版「太极」在 Dock/菜单栏/Cmd-Tab 切换器中可区分）
 *   3. 拷 build/icon.icns → Contents/Resources/taiji.icns
 *   4. 删 _CodeSignature（Info.plist 改动后主签名失效，本地直接 spawn 二进制不走
 *      Gatekeeper，frameworks 未改签名仍有效）
 *   5. spawn Contents/MacOS/Electron，参数原样透传（等价 electron .）
 *
 * 非 macOS / prepare 失败：fallback 到原始 electron 二进制（main.ts 的
 * app.dock.setIcon 兜底，仍会闪但至少有图标）。
 *
 * 缓存：.dev-electron/.stamp 记录源 app version + mtime + icns mtime，命中则跳过重建。
 */

import { spawn, execSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..') // apps/electron
const require = createRequire(import.meta.url)

/** 源 Electron 二进制路径（require('electron') 在 node 下返回路径字符串） */
const SOURCE_BINARY = require('electron')
const SOURCE_APP = path.resolve(SOURCE_BINARY, '..', '..', '..') // .../Electron.app

const DEV_APP_DIR = path.join(APP_ROOT, '.dev-electron')
const DEV_APP = path.join(DEV_APP_DIR, 'Taiji.app')
const DEV_BINARY = path.join(DEV_APP, 'Contents/MacOS/Electron')
const STAMP_FILE = path.join(DEV_APP_DIR, '.stamp')

const ICNS_SRC = path.join(APP_ROOT, 'build', 'icon.icns')
const PLIST_BUDDY = '/usr/libexec/PlistBuddy'

/**
 * 生成或复用自制 dev app bundle。返回要启动的二进制路径。
 * 失败时返回 SOURCE_BINARY（fallback）。
 */
function resolveDevBinary() {
  if (process.platform !== 'darwin') return SOURCE_BINARY
  if (!fs.existsSync(SOURCE_APP)) return SOURCE_BINARY
  if (!fs.existsSync(ICNS_SRC)) {
    console.warn('[dev-electron] build/icon.icns 不存在，跳过自制 bundle，使用默认 electron')
    return SOURCE_BINARY
  }

  // stamp：源 app version + 源 app mtime + icns mtime。
  // v2 = 显示名加 dev 后缀（CFBundleName/DisplayName → 太极 dev）。stamp 不含脚本自身逻辑，
  // 不 bump 版本号则缓存命中时复用旧 bundle（plist 仍是「太极」），改名不生效。
  const srcVersion = readPlist(SOURCE_APP, 'CFBundleVersion') || ''
  const srcMtime = safeMtime(SOURCE_APP)
  const icnsMtime = safeMtime(ICNS_SRC)
  const stamp = `v2|${srcVersion}|${srcMtime}|${icnsMtime}|${path.basename(SOURCE_APP)}`

  if (fs.existsSync(DEV_BINARY) && fs.existsSync(STAMP_FILE) &&
      fs.readFileSync(STAMP_FILE, 'utf8') === stamp) {
    return DEV_BINARY
  }

  try {
    console.log('[dev-electron] 准备 dev app bundle（太极图标）...')
    fs.rmSync(DEV_APP, { recursive: true, force: true })
    fs.mkdirSync(DEV_APP_DIR, { recursive: true })

    // 1. 复制（优先 clonefile COW；fallback ditto / 普通 cp）
    copyApp(SOURCE_APP, DEV_APP)

    const plist = path.join(DEV_APP, 'Contents/Info.plist')
    const resourcesDir = path.join(DEV_APP, 'Contents/Resources')

    // 2. 改 plist（图标 + 显示名）
    setPlist(plist, 'CFBundleIconFile', 'taiji.icns')
    setPlist(plist, 'CFBundleName', '太极 dev')
    setPlist(plist, 'CFBundleDisplayName', '太极 dev')

    // 3. 拷 icns
    fs.copyFileSync(ICNS_SRC, path.join(resourcesDir, 'taiji.icns'))

    // 4. 删失效签名（Info.plist 已改，主签名失效；本地直接 spawn 二进制不走 Gatekeeper）
    fs.rmSync(path.join(DEV_APP, 'Contents/_CodeSignature'), { recursive: true, force: true })

    // 5. 写 stamp
    fs.writeFileSync(STAMP_FILE, stamp)
    console.log('[dev-electron] ✅ dev app bundle 就绪:', DEV_APP)
    return DEV_BINARY
  } catch (err) {
    console.warn('[dev-electron] 自制 bundle 生成失败，fallback 到默认 electron:', err.message)
    // 清理半成品，避免下次 stamp 误判
    fs.rmSync(DEV_APP, { recursive: true, force: true })
    return SOURCE_BINARY
  }
}

/** 复制 .app bundle，优先用 clonefile（COW，不占额外空间） */
function copyApp(src, dst) {
  // 优先 cp -Rc（APFS clonefile）。-c 在 macOS 10.13+ 可用，失败 fallback。
  try {
    execSync(`cp -Rc ${shellQuote(src)} ${shellQuote(dst)}`, { stdio: 'pipe' })
    return
  } catch {
    // clonefile 不可用（非 APFS / 跨卷 / 旧系统）—— 落到 ditto
  }
  try {
    execSync(`ditto ${shellQuote(src)} ${shellQuote(dst)}`, { stdio: 'pipe' })
    return
  } catch {
    // ditto 不可用（极罕见）—— 普通 cp -R（慢、占满空间，但保证可用）
  }
  execSync(`cp -R ${shellQuote(src)} ${shellQuote(dst)}`, { stdio: 'pipe' })
}

function shellQuote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`
}

function safeMtime(p) {
  try { return fs.statSync(p).mtimeMs } catch { return 0 }
}

function readPlist(appBundle, key) {
  try {
    return execSync(`${PLIST_BUDDY} -c "Print :${key}" "${path.join(appBundle, 'Contents/Info.plist')}"`,
      { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}

function setPlist(plistPath, key, value) {
  // 先尝试 Set（key 已存在），失败则 Add（key 不存在）。
  // execFileSync 数组传参（无 shell 解析层）：shellQuote 的引号直达 PlistBuddy 由其解析。
  // 原先 execSync 双引号嵌套会把内层引号吃掉，值含空格（如「太极 dev」）时被 shell
  // 拆成多个 argv 导致 Set/Add 双失败 → bundle 生成 fallback，plist 显示名不生效。
  try {
    execFileSync(PLIST_BUDDY, ['-c', `Set :${key} ${shellQuote(value)}`, plistPath], { stdio: 'pipe' })
  } catch {
    execFileSync(PLIST_BUDDY, ['-c', `Add :${key} string ${shellQuote(value)}`, plistPath], { stdio: 'pipe' })
  }
}

// ─── 启动 ────────────────────────────────────────────────
const binary = resolveDevBinary()
const args = process.argv.slice(2) // 透传给 electron（如 ['.']）
// CDP 端口：per-worktree 派生（dev-instance.mjs 注入 XYZ_CDP_PORT，C-dev-01），
// 未注入保持 9222（裸启动兼容）。argv 显式传了 --remote-debugging-port 则尊重不覆盖。
if (!args.some((a) => a.startsWith('--remote-debugging-port'))) {
  args.push(`--remote-debugging-port=${process.env.XYZ_CDP_PORT ?? '9222'}`)
}

if (process.env.XYZ_DEV_ELECTRON_VERBOSE === '1') {
  console.log('[dev-electron] binary:', binary)
  console.log('[dev-electron] args:', args)
}

// 用自制 bundle 时标记，让 main.ts 跳过 app.dock.setIcon（bundle 已带太极图标）。
// fallback 到默认 electron 时不设，main.ts 的 setIcon 兜底（会闪但至少有图标）。
const env = { ...process.env }
if (binary !== SOURCE_BINARY) env.XYZ_DEV_BUNDLE_ICON = '1'

const child = spawn(binary, args, { stdio: 'inherit', env })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
