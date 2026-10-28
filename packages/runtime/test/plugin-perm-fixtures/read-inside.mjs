'use strict'

/**
 * P-perm fixture：声明内读取成功（provider-plugin-access D3，readPaths 白名单内）。
 *
 * 由测试动态复制到 mkdtemp 的 pluginDir 内执行（真实 fork + 真实 ESM loader）：
 * 放行清单 = [fs, fs/promises]，readPaths = ['data/in.txt']，目标 =
 * $TAIJI_PERM_TARGET（readPaths 内文件）——readFileSync 与 fs.promises.readFile
 * 都应成功返回文件内容。结果经 fork IPC 的 perm-result 消息回传，进程保持存活
 * 由宿主 kill（IPC send flush 语义，对齐 sandbox-escape-runner 注释）。
 */

const target = process.env.TAIJI_PERM_TARGET
const out = {}

try {
  const fs = await import('node:fs')
  const content = fs.readFileSync(target, 'utf-8')
  out.sync = { ok: true, content }
} catch (e) {
  out.sync = { ok: false, code: e && e.code, message: String(e && e.message) }
}

try {
  const fsp = await import('node:fs/promises')
  const content = await fsp.readFile(target, 'utf-8')
  out.promises = { ok: true, content }
} catch (e) {
  out.promises = { ok: false, code: e && e.code, message: String(e && e.message) }
}

process.send({ type: 'perm-result', label: 'read-inside', out })
