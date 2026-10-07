/**
 * remote token 读侧（remote-access D2/E10）——runtime 侧 remote-access.json 消费模块。
 *
 * 层位说明（分层 SSOT runtime-layering.md §2）：文件 IO 属 infra 领地，本模块居 infra；
 * 组合根（index.ts）仅在 --remote-access 开态把 readRemoteAccessToken 装配为
 * ConnectionManager 的 remoteTokenProvider——transport 只持注入的 provider 引用，
 * 每次握手回调进入本模块，transport 层自身零文件 IO。
 *
 * 读取通道形态与 index.ts resolveRuntimeToken 同构（fs.readFileSync + getDataDir() 推导），
 * 但触发时机不同：runtime-token 是启动期一次解析，remote token 是每次 WS auth 握手热读——
 * token 轮换 = main 重写 remote-access.json，下一次新握手即生效，无 runtime 重启（D2）。
 * 独立成模块而非内联组合根：index.ts import 即执行 main() 不可直测，
 * E10 三态（缺失/坏 JSON/坏字段）的 fail-closed 语义由本模块单测守卫。
 */
import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  isRemoteAccessConfigShape,
  REMOTE_ACCESS_FILENAME,
  REMOTE_TOKEN_HEX64,
} from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { errorCodeOf } from '../utils/errors.js'

// ── 热读失败频控（code-harden P2：重连风暴降噪）────────────────────────────
// 热读每次握手调用；文件持续缺失/损坏 + 移动壳客户端自动重连会逐次刷 error 放大
// 噪音。频控语义：每进程**同因**首次失败响亮 error（含恢复指引），此后同因失败降为
// debug 不再刷屏；任一次读取成功（解析出合法 token）即重置回「首次响亮」态——故障
// 自愈后复发会再响亮，防长期降级掩盖复发。因变化（如 ENOENT → 坏 JSON）各自首次
// 响亮：失败原因变化本身是值得注意的信号。
let lastRemoteReadFailureCause: string | null = null

/** 频控出口：同因首次响亮 console.error，重复降为 console.debug（语义见上方注释）。 */
function reportRemoteReadFailure(cause: string, loudMessage: string): void {
  if (lastRemoteReadFailureCause === cause) {
    console.debug(
      `[runtime] remote access: ${REMOTE_ACCESS_FILENAME} 同因失败重复发生（${cause}），降为 debug——首次 error 已含恢复指引`,
    )
    return
  }
  lastRemoteReadFailureCause = cause
  console.error(loudMessage)
}

/** 读取成功（解析出合法 token）后重置频控，下次失败重新响亮。 */
function markRemoteReadSuccess(): void {
  lastRemoteReadFailureCause = null
}

/** 测试隔离用：重置频控状态（对齐 utils/warn-once.ts 的 _resetWarnOnceForTest 先例）。 */
export function _resetRemoteReadGateForTest(): void {
  lastRemoteReadFailureCause = null
}

/**
 * 解析 remote-access.json 内容为 remote token（E10 处置：任何不合法形态返回 null，
 * remote 集合退化为空——仅 spawn token 可认证，fail-closed）。
 *
 * - 坏 JSON / 非对象 / 字段不合法 → 频控 error 日志（首次响亮含恢复指引，同因重复
 *   降 debug，语义见上方频控注释）+ null；
 * - enabled=false → 关态文件留存是设计内合法产出（D2 配套规格③），console.log（注明
 *   debug 性质——prod 日志可观测，且非错误不刷 error）+ null（计算器分层：设计内
 *   合法产出不是错误）；
 * - 返回非 null token = 读取成功，重置失败频控。
 */
export function parseRemoteAccessToken(raw: string): string | null {
  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    reportRemoteReadFailure(
      'bad-json',
      `[runtime] remote access: ${REMOTE_ACCESS_FILENAME} 不是合法 JSON — remote token 不可用` +
        '（fail-closed：仅 spawn token 可认证，远程客户端将全部被拒）。' +
        '恢复：回桌面端 设置 → 远程访问面板 执行轮换（重写配置文件），或检查该文件内容',
    )
    return null
  }
  // shape 判据单源 = shared 的 isRemoteAccessConfigShape（main 写侧守卫 import 同一
  // 谓词，判据不可能分叉）；本侧从宽策略（enabled=false 早退跳过 hex、enabled=true 才
  // 校验 hex、任何不合法形态 fail-closed 返回 null）刻意保留在本地——与 main 写侧
  // 从严恒校验的不对称是文档化的双侧策略差异，不上收、不参数化。
  if (!isRemoteAccessConfigShape(config)) {
    reportRemoteReadFailure(
      'bad-shape',
      `[runtime] remote access: ${REMOTE_ACCESS_FILENAME} 字段不合法（缺 enabled/token 或类型不符）— ` +
        'remote token 不可用（fail-closed：仅 spawn token 可认证）。' +
        '恢复：回桌面端 设置 → 远程访问面板 执行轮换（重写配置文件），或删除该文件后在面板重新开启',
    )
    return null
  }
  // 关态文件留存（D2 配套规格③）：开关关闭但文件还在，token 不入集合。这是开关切换
  // 触发 runtime 重启前的正常窗口态，非错误。console.log（非 debug）使 prod 日志可
  // 观测——关态入集合判定是安全相关事实，消息内注明其 debug 性质防误读为错误。
  if (config.enabled === false) {
    console.log(`[runtime] remote access: ${REMOTE_ACCESS_FILENAME} enabled=false（关态文件留存，debug 信息），remote token 不入鉴权集合`)
    return null
  }
  if (!REMOTE_TOKEN_HEX64.test(config.token)) {
    reportRemoteReadFailure(
      'bad-token-format',
      `[runtime] remote access: ${REMOTE_ACCESS_FILENAME} token 字段不符合契约（须为 64 位 hex 小写）— ` +
        'remote token 不可用（fail-closed：仅 spawn token 可认证）。' +
        '恢复：回桌面端 设置 → 远程访问面板 执行轮换（重新生成 token 并重写配置文件）',
    )
    return null
  }
  markRemoteReadSuccess()
  return config.token
}

/**
 * 热读 `<getDataDir()>/<REMOTE_ACCESS_FILENAME>` 取 remote token（remote-access D2）。
 * 每次握手调用一次（auth 是低频事件），文件缺失/不可读按 E10 fail-closed 返回 null +
 * 频控 error 日志（首次响亮含恢复指引，同因重复降 debug——语义见上方频控注释）。
 * 组合根仅在 `--remote-access` 开态把本函数装配为 remoteTokenProvider——关态不装配，
 * 本函数不被调用（关态零 IO）。
 */
export function readRemoteAccessToken(): string | null {
  const filePath = join(getDataDir(), REMOTE_ACCESS_FILENAME)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    // cause 含 fs error code（ENOENT/EACCES 等）——不含 error.message，其内嵌文件
    // 绝对路径不重复落日志（filePath 已在首次响亮消息中）。
    reportRemoteReadFailure(
      `read-${errorCodeOf(error) ?? 'unknown'}`,
      `[runtime] remote access: 读取 ${filePath} 失败（fs error code: ${errorCodeOf(error) ?? 'unknown'}）— ` +
        'remote token 不可用（fail-closed：仅 spawn token 可认证，远程客户端将全部被拒）。' +
        '恢复：回桌面端 设置 → 远程访问面板 确认开关并执行轮换（重新生成 token 并写回文件），或检查文件权限',
    )
    return null
  }
  return parseRemoteAccessToken(raw)
}
