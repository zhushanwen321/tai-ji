'use strict'

/**
 * P-perm fixture：声明外读取拒绝 + 符号链接绕过拒绝（provider-plugin-access D3）。
 *
 * 声明 readPaths = ['data/in.txt']；$TAIJI_PERM_TARGET 指向白名单外文件，
 * $TAIJI_PERM_LINK 指向白名单目录内、解析目标在白名单外的符号链接——
 * 三面（readFileSync / fs.promises.readFile / symlink）都应 PERMISSION_DENIED
 * （realpath 归一后判界，symlink 指向声明外即拒）。
 */

const target = process.env.TAIJI_PERM_TARGET
const link = process.env.TAIJI_PERM_LINK
const out = {}

try {
  const fs = await import('node:fs')
  fs.readFileSync(target, 'utf-8')
  out.syncOutside = 'LEAKED'
} catch (e) {
  out.syncOutside = (e && e.code) || 'ERR'
}

try {
  const fs = await import('node:fs')
  fs.readFileSync(link, 'utf-8')
  out.symlink = 'LEAKED'
} catch (e) {
  out.symlink = (e && e.code) || 'ERR'
}

try {
  const fsp = await import('node:fs/promises')
  await fsp.readFile(target, 'utf-8')
  out.promisesOutside = 'LEAKED'
} catch (e) {
  out.promisesOutside = (e && e.code) || 'ERR'
}

process.send({ type: 'perm-result', label: 'read-outside', out })
