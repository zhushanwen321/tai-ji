/**
 * p1-plugin-a19-oauth-interrupt —— D3 验收场景 A19（设计 S19：OAuth 授权中断与回调端口被占）。
 *
 * 通道裁决：S19 的「渲染区显示」属插件授权 UI（真实羊毛家族人机交互，归 A2 L4 窗口）；
 * 本剧本按 impl-plan A19 行「可脚本化」口径直接驱动宿主 OAuth 通道（config.oauthLogin /
 * config.oauthCancel RPC + auth.* 广播事件），中断/端口/残留三段全部机器可判。
 *
 * 选型事实（源码核对）：anthropic 是唯一 flow=callback + 固定 callbackPort 的内置 provider
 * （generated/builtin-providers.json → callbackPort 53692；openrouter 动态端口、其余 device
 * flow 不绑端口）——回调端口类断言全部锚定 53692。授权全程零真实上游：本剧本的三个中断
 * 形态都发生在本地回调服务（runtime/services/auth/callback-server.ts）生命周期内，从不
 * fetch claude.ai；真实授权成功链路归 A2（L4 真实凭据窗口）。
 *
 * 三段断言：
 *   ① 中断可恢复：a) 关授权页（回调永不到达）→ 用户取消 → 端口释放、可重新发起（无永久
 *      pending）；b) 浏览器回调中断（授权页拒绝 → provider 回跳 ?error=access_denied）→
 *      auth.error 文案可理解 → 可重新发起；
 *   ② 回调端口预占：本地 socket 先占 53692 → login → auth.error 文案含「端口 53692 被占用」
 *      与恢复动作（describeListenError），宿主不崩溃（后续 RPC 往返正常）、不抢占者的端口；
 *   ③ 无残留监听：每段结束后 lsof 轮询 53692 清零；auth.json 无 anthropic 凭据残留
 *      （中断路径绝不写盘——auth-service S-7/S-8 早退语义）。
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { portOwners } from '../scripts/lib/instance.mjs'

const PROVIDER = 'anthropic'
const CALLBACK_PORT = 53692 // builtin-providers.json anthropic oauthConfig.callbackPort（唯一固定端口 callback provider）
const AUTHORIZE_HOST_ANCHOR = 'claude.ai/oauth/authorize'
const ERROR_PORT_TEXT = `端口 ${CALLBACK_PORT} 被占用`

export const meta = {
  id: 'p1-plugin-a19-oauth-interrupt',
  priority: 'P1',
  title: 'S19 OAuth 授权中断与回调端口被占：可恢复、文案可理解、无残留监听（宿主通道）',
  covers: ['settings.provider'],
  requires: [],
  estimateSec: 180,
  env: undefined, // 本剧本不注入实例 env（无 registry / 无 LLM 需求）

  provable: [
    '①a 关授权页中断：auth.authUrl 回调端口=53692 → oauthCancel cancelled:true → 端口释放（lsof 清零）→ 立即重新发起 started:true（无永久 pending）',
    '①b 回调中断（provider 回跳 error）：宿主收到 ?error=access_denied 回调 → auth.error 文案 = "Provider error: access_denied" → 端口释放 → 可重新发起',
    '② 端口预占：本地 socket 占住 53692 后发起授权 → auth.error 文案含「端口 53692 被占用」+ 重试指引；宿主不崩溃（RPC 往返正常）、不抢走占者端口；占者释放后重新授权可正常绑定',
    '③ 无残留监听：全部流程结束后 53692 lsof 清零 + config.hasOAuth=false + auth.json 无 anthropic 凭据（中断路径零落盘）',
  ],
  notProvable: [
    '「渲染区显示授权未完成」的插件授权 UI 呈现（真实羊毛家族人机交互，归 A2 L4 真实凭据窗口；本剧本用宿主通道同源驱动）',
    '真实授权成功链路与 token 交换（属 A2；本剧本一切中断都发生在本地回调生命周期内，零真实上游请求）',
    '「用户关闭浏览器」这一物理动作本身不可脚本化——以「回调永不到达 + 用户主动取消」的宿主侧等价形态承载',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir } = ctx
  const gotchas = [
    '端口值 53692 读自 runtime 源码链：generated/builtin-providers.json anthropic oauthConfig.callbackPort → oauth-flow runCallbackFlow startCallbackServer({ port: callbackPort })',
    '重新发起断言带 8s 轮询窗：auth.error 广播先于 runFlow finally 清 activeFlows 到达客户端（broadcast 在 catch、delete 在 finally），立即重试可能撞「已有进行中的 OAuth 授权流程」收尾竞态',
  ]

  const authJsonPath = path.join(dataDir, 'agent', 'auth.json')
  const readAuthJson = () => {
    try {
      return JSON.parse(fs.readFileSync(authJsonPath, 'utf8'))
    } catch {
      return null
    }
  }
  const authBaseline = readAuthJson()
  ev.assert('C: 基线——auth.json 无 anthropic 凭据（中断路径的对照起点）', !authBaseline?.[PROVIDER], {
    channel: 'C',
    expected: `auth.json 无 ${PROVIDER} 键`,
    actual: authBaseline ? `keys=${Object.keys(authBaseline).join(',')}` : 'auth.json 不存在（空态）',
  })

  // ── 段①a：关授权页（回调永不到达）→ 用户取消 → 可恢复 ──────────
  const mark1a = protocol.events.length
  const started1a = await loginWithRetry(protocol)
  ev.assert('B: 发起 OAuth 授权（anthropic callback flow）started:true', started1a?.started === true, {
    channel: 'B',
    expected: '{ started: true }',
    actual: JSON.stringify(started1a ?? null),
  })
  const authUrl1 = await waitAuthEvent(protocol, mark1a, 'auth.authUrl')
  ev.assert('B: auth.authUrl 广播到达且回调端口=53692（授权页 URL 生成、本地回调服务已绑定）',
    authUrl1?.payload?.callbackPort === CALLBACK_PORT && String(authUrl1?.payload?.url ?? '').includes(AUTHORIZE_HOST_ANCHOR), {
      channel: 'B',
      expected: `callbackPort=${CALLBACK_PORT} 且 url 含 ${AUTHORIZE_HOST_ANCHOR}`,
      actual: authUrl1 ? `callbackPort=${authUrl1.payload?.callbackPort} url=${String(authUrl1.payload?.url ?? '').slice(0, 80)}…` : '事件未到达',
    })
  ev.assert('C: 授权进行中 53692 由实例监听（回调服务在场）', owners(portOwners(CALLBACK_PORT)).length > 0, {
    channel: 'C',
    expected: '53692 有监听',
    actual: owners(portOwners(CALLBACK_PORT)).join(',') || '无监听',
  })

  // 用户关闭授权页：回调永不到达；宿主侧恢复动作 = 取消（OAuthDialog 取消按钮同通道）
  const cancelled1 = await protocol.call('config.oauthCancel', { providerId: PROVIDER })
  ev.assert('B: 用户取消授权 → cancelled:true（无永久 pending 的第一半）', cancelled1?.cancelled === true, {
    channel: 'B',
    expected: '{ cancelled: true }',
    actual: JSON.stringify(cancelled1 ?? null),
  })
  const freed1 = await pollPortFree(protocol, CALLBACK_PORT)
  ev.assert('C: 取消后回调端口释放（无残留监听·段①a）', freed1, {
    channel: 'C',
    expected: '53692 lsof 清零',
    actual: freed1 ? '已清零' : `残留 PID ${owners(portOwners(CALLBACK_PORT)).join(',')}`,
  })
  await assertRelaunchable(protocol, ev, '①a')
  const hasOAuth1 = await protocol.call('config.hasOAuth', { providerId: PROVIDER })
  ev.assert('B: 中断后无凭据落盘（config.hasOAuth=false）', hasOAuth1?.hasOAuth === false, {
    channel: 'B',
    expected: 'hasOAuth=false',
    actual: JSON.stringify(hasOAuth1 ?? null),
  })
  const shot1 = await ctx.ui.screenshot('a19-phase1a-cancelled-recovered')
  ev.attach('a19-phase1a-cancelled-recovered', shot1)

  // ── 段①b：浏览器回调中断（授权页拒绝 → provider 回跳 ?error=access_denied）──
  const mark1b = protocol.events.length
  const started1b = await loginWithRetry(protocol)
  ev.assert('B: 重新发起授权 started:true（段①a 可恢复的落地）', started1b?.started === true, {
    channel: 'B',
    expected: '{ started: true }',
    actual: JSON.stringify(started1b ?? null),
  })
  await waitAuthEvent(protocol, mark1b, 'auth.authUrl')
  // 模拟浏览器行为：用户在授权页点拒绝 → provider 302 回跳 ?error=access_denied（state 校验前，
  // callback-server 先分流 error 分支）——即「回调中断」的宿主侧等价形态
  const cbStatus = await httpGetStatus(`http://127.0.0.1:${CALLBACK_PORT}/callback?error=access_denied&error_description=user+denied`)
  ev.assert('C: 回调端点对 error 回跳返回 400（ERROR_HTML 语义）', cbStatus === 400, {
    channel: 'C',
    expected: 'HTTP 400',
    actual: `HTTP ${cbStatus ?? '无响应'}`,
  })
  const err1b = await waitAuthEvent(protocol, mark1b, 'auth.error')
  ev.assert('B: 回调中断 → auth.error 文案可理解（Provider error: access_denied）',
    String(err1b?.payload?.message ?? '').includes('Provider error: access_denied'), {
      channel: 'B',
      expected: 'message 含 "Provider error: access_denied"',
      actual: JSON.stringify(err1b?.payload ?? err1b?.type ?? null),
    })
  const freed1b = await pollPortFree(protocol, CALLBACK_PORT)
  ev.assert('C: 回调中断后端口释放（provider_error 分支 finally close）', freed1b, {
    channel: 'C',
    expected: '53692 lsof 清零',
    actual: freed1b ? '已清零' : `残留 PID ${owners(portOwners(CALLBACK_PORT)).join(',')}`,
  })
  await assertRelaunchable(protocol, ev, '①b')

  // ── 段②：回调端口预占 → 失败文案可理解、不崩溃、不抢占者端口 ────
  const occupier = net.createServer(() => {})
  await new Promise((resolve, reject) => {
    occupier.once('error', reject)
    occupier.listen(CALLBACK_PORT, '127.0.0.1', resolve)
  })
  ev.step({ step: 'occupier.bound', channel: 'C', exitCode: 0, stats: { port: CALLBACK_PORT } })
  const mark2 = protocol.events.length
  const started2 = await loginWithRetry(protocol)
  ev.assert('B: 端口被占下发起授权（login 立即受理，listen 失败在异步 flow 内暴露）', started2?.started === true, {
    channel: 'B',
    expected: '{ started: true }',
    actual: JSON.stringify(started2 ?? null),
  })
  const err2 = await waitAuthEvent(protocol, mark2, 'auth.error')
  const msg2 = String(err2?.payload?.message ?? '')
  ev.assert('B: 端口被占 → auth.error 文案可理解（「端口 53692 被占用」+ 重试恢复动作）',
    msg2.includes(ERROR_PORT_TEXT) && msg2.includes('重试'), {
      channel: 'B',
      expected: `message 含 "${ERROR_PORT_TEXT}" 且含恢复动作「重试」`,
      actual: msg2 || '事件未到达',
    })
  const alive = await protocol.call('plugin.list', {})
  ev.assert('B: 宿主不崩溃——auth.error 后 RPC 往返正常', Array.isArray(alive?.plugins), {
    channel: 'B',
    expected: 'plugin.list 正常应答',
    actual: `plugins=${(alive?.plugins ?? []).length}`,
  })
  ev.assert('C: 宿主不抢占者端口（53692 仍由本剧本 socket 持有，无第二监听者）',
    owners(portOwners(CALLBACK_PORT)).length === 1, {
      channel: 'C',
      expected: '53692 监听者仅剩占者 1 个',
      actual: `listeners=${owners(portOwners(CALLBACK_PORT)).length}`,
    })
  const shot2 = await ctx.ui.screenshot('a19-phase2-port-occupied-error')
  ev.attach('a19-phase2-port-occupied-error', shot2)

  // 占者让位 → 重新授权可正常绑定（S19 ②「换端口重试走通」的宿主侧等价：端口恢复后重试走通）
  await new Promise((resolve) => occupier.close(resolve))
  const freedOcc = await pollPortFree(protocol, CALLBACK_PORT)
  ev.assert('C: 占者释放后端口清零', freedOcc, {
    channel: 'C',
    expected: '53692 lsof 清零',
    actual: freedOcc ? '已清零' : `残留 PID ${owners(portOwners(CALLBACK_PORT)).join(',')}`,
  })
  const mark2b = protocol.events.length
  const started2b = await loginWithRetry(protocol)
  const authUrl2b = started2b?.started === true ? await waitAuthEvent(protocol, mark2b, 'auth.authUrl') : null
  ev.assert('B: 端口恢复后重新授权可正常绑定（auth.authUrl 再到达）', Boolean(authUrl2b), {
    channel: 'B',
    expected: 'auth.authUrl 到达（listen 成功）',
    actual: authUrl2b ? `callbackPort=${authUrl2b.payload?.callbackPort}` : `started=${JSON.stringify(started2b ?? null)}`,
  })
  await protocol.call('config.oauthCancel', { providerId: PROVIDER })
  await pollPortFree(protocol, CALLBACK_PORT)

  // ── 段③：终态无残留 ─────────────────────────────────────────
  const finalFree = await pollPortFree(protocol, CALLBACK_PORT)
  const authFinal = readAuthJson()
  ev.assert('③ 终态无残留监听（53692 lsof 清零）', finalFree, {
    channel: 'C',
    expected: '53692 lsof 清零',
    actual: finalFree ? '已清零' : `残留 PID ${owners(portOwners(CALLBACK_PORT)).join(',')}`,
  })
  ev.assert('③ 终态无凭据残留（auth.json 无 anthropic + hasOAuth=false）',
    !authFinal?.[PROVIDER] && (await protocol.call('config.hasOAuth', { providerId: PROVIDER }))?.hasOAuth === false, {
      channel: 'C',
      expected: `auth.json 无 ${PROVIDER} 且 hasOAuth=false`,
      actual: `auth.json=${authFinal ? Object.keys(authFinal).join(',') || '(空对象)' : '不存在'} hasOAuth=${JSON.stringify((await protocol.call('config.hasOAuth', { providerId: PROVIDER }))?.hasOAuth)}`,
    })
  await ctx.ui.screenshot('a19-final-clean')

  log('A19 done')
  return { uncovered: [], gotchas }
}

// ── 局部辅助（scenario 进程内，零全局副作用）──────────────────────

/** lsof PID 列表（字符串化，便于断言 actual 展示）。 */
function owners(pids) {
  return pids.map(String)
}

/** 条件轮询（判定每轮重算；禁固定 sleep 后断言）。 */
async function poll(predicate, { timeoutMs, intervalMs = 400 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 发起登录；「已有进行中」为前序 flow 收尾竞态（broadcast 先于 finally delete），8s 内重试。 */
async function loginWithRetry(protocol) {
  const deadline = Date.now() + 8_000
  for (;;) {
    const result = await protocol.call('config.oauthLogin', { providerId: PROVIDER })
    if (result?.started === true || !String(result?.error ?? '').includes('已有进行中')) return result
    if (Date.now() >= deadline) return result
    await new Promise((r) => setTimeout(r, 400))
  }
}

/** 等待 auth.* 广播事件（since 游标防误吃前段事件）。 */
async function waitAuthEvent(protocol, since, type) {
  return protocol.waitFor((e) => e.type === type && e.payload?.providerId === PROVIDER, {
    timeoutMs: 20_000,
    since,
  })
}

/** 端口释放轮询（lsof 清零；12s 预算覆盖 server.close 异步收尾）。 */
async function pollPortFree(protocol, port) {
  return poll(() => portOwners(port).length === 0, { timeoutMs: 12_000 })
}

/** 「可重新发起，无永久 pending」：重新 login started:true（再取消清场）。 */
async function assertRelaunchable(protocol, ev, tag) {
  const relogin = await loginWithRetry(protocol)
  ev.assert(`B: 段${tag} 中断后可重新发起（无永久 pending）`, relogin?.started === true, {
    channel: 'B',
    expected: '重新 login started:true（activeFlows 已清）',
    actual: JSON.stringify(relogin ?? null),
  })
  await protocol.call('config.oauthCancel', { providerId: PROVIDER })
  await pollPortFree(protocol, CALLBACK_PORT)
}

/** 本地回调端点 GET（模拟浏览器 302 回跳；只读状态码）。 */
function httpGetStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5_000 }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
      res.on('error', () => resolve(null))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}
