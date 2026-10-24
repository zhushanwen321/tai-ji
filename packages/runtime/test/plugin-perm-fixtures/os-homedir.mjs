'use strict'

/**
 * P-perm fixture：os 免声明可用（provider-plugin-access D3——os 移出基线黑名单，
 * 无需任何 capabilities 声明即可 import，羊毛拼 IDE 配置路径依赖 homedir()）。
 *
 * 放行清单 = []（空），node:os 的 import 与 os.homedir() 调用都应成功；
 * 对照组 node:fs 同样无声明 → 应 PERMISSION_DENIED（空放行 = 基线全拦仍成立）。
 */

const out = {}

try {
  const os = await import('node:os')
  const home = os.homedir()
  out.homedir = { ok: typeof home === 'string' && home.length > 0, isHomeEnv: home === process.env.HOME }
} catch (e) {
  out.homedir = { ok: false, code: (e && e.code) || 'ERR' }
}

try {
  await import('node:fs')
  out.fsControl = 'LEAKED'
} catch (e) {
  out.fsControl = (e && e.code) || 'ERR'
}

process.send({ type: 'perm-result', label: 'os-homedir', out })
