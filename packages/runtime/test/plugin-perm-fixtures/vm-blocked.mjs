'use strict'

/**
 * P-perm fixture：放行 network.http 后 node:vm 仍被拒（provider-plugin-access D3
 * 永久封禁不受放行清单影响；设计 §4 对 sandbox 逃逸测试族的新增断言）。
 *
 * 放行清单 = [http, https, net, dns, tls]（network.http 的放行集）：
 *   - node:https 应 import 成功（放行生效的对照面）
 *   - node:vm 应 PERMISSION_DENIED（永久封禁 7 项不参与放行计算）
 */

const out = {}

try {
  await import('node:https')
  out.https = 'ok'
} catch (e) {
  out.https = (e && e.code) || 'ERR'
}

try {
  await import('node:vm')
  out.vm = 'LEAKED'
} catch (e) {
  out.vm = (e && e.code) || 'ERR'
}

process.send({ type: 'perm-result', label: 'vm-blocked', out })
