'use strict'

/**
 * P-perm fixture：五类写操作变体全拒（provider-plugin-access D3 只读导出子集，
 * S9 ④写变体点名清单）。
 *
 * 放行清单 = [fs, fs/promises]，目标 = $TAIJI_PERM_TARGET（readPaths 内的
 * 「声明内路径」——写被拒与路径无关，只读性独立生效）。五变体：
 *   v1 writeFileSync（同步/回调面）
 *   v2 fs.promises.writeFile（promises API）
 *   v3 promises.open('w')（open 写 flags）
 *   v4 promises.open('r') 后 handle.write()（读 flags 打开、FileHandle 写方法）
 *   v5 createWriteStream（流）
 * 全部应 PERMISSION_DENIED；任一 'LEAKED' 即只读防线失效。
 */

const target = process.env.TAIJI_PERM_TARGET
const out = {}

try {
  const fs = await import('node:fs')
  fs.writeFileSync(target, 'x')
  out.writeFileSync = 'LEAKED'
} catch (e) {
  out.writeFileSync = (e && e.code) || 'ERR'
}

try {
  const fsp = await import('node:fs/promises')
  await fsp.writeFile(target, 'x')
  out.promisesWriteFile = 'LEAKED'
} catch (e) {
  out.promisesWriteFile = (e && e.code) || 'ERR'
}

try {
  const fsp = await import('node:fs/promises')
  const handle = await fsp.open(target, 'w')
  await handle.close()
  out.openWriteFlags = 'LEAKED'
} catch (e) {
  out.openWriteFlags = (e && e.code) || 'ERR'
}

try {
  const fsp = await import('node:fs/promises')
  const handle = await fsp.open(target, 'r')
  try {
    await handle.write('x')
    out.handleWrite = 'LEAKED'
  } catch (e) {
    out.handleWrite = (e && e.code) || 'ERR'
  }
  await handle.close()
} catch (e) {
  out.handleWrite = 'OPEN_FAILED:' + ((e && e.code) || 'ERR')
}

try {
  const fs = await import('node:fs')
  fs.createWriteStream(target)
  out.createWriteStream = 'LEAKED'
} catch (e) {
  out.createWriteStream = (e && e.code) || 'ERR'
}

process.send({ type: 'perm-result', label: 'write-denied', out })
