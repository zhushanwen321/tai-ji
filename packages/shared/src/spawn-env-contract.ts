/**
 * 出站 env 契约 SSOT（runtime 及 main 孵化子进程时「给什么 / 不给什么」）。
 *
 * 与入站白名单的关系（双向边界契约，详见 docs/architecture/env-propagation-boundary.md §3.2/§3.5-D2）：
 * - 入站白名单 SSOT ENV_WHITELIST_PREFIXES（constants.ts:72，pre-commit
 *   check_env_whitelist_sync.py 守卫其唯一性）回答「外部环境哪些东西准许进来」——管准入；
 * - 本文件的出站契约回答「我（runtime/main）身上的东西哪些允许跟随 spawn 出去」——管出站。
 *   两问不同维度、正交共存；出站侧不改变入站白名单任何内容。
 *
 * 治理原则（设计文档 §3.1 第一原则）：一个变量能否出站，取决于它在 pi 子树内有没有
 * 消费证据；没有任何消费证据的产品变量，默认不许出站（deny-by-default 起步 + forward
 * 须附消费锚点）。扩展 deny 或 forward 清单前必读该文档 §3.5 决策 D1/D3 的证据要求。
 */

/**
 * 出站剥除清单：无论下游如何组装，这些键绝不允许出现在 runtime/main 主动孵化的
 * 子进程 env 中。成员只增不减、增删须过评审（危害证据入档，见附录 A 探针记录）。
 *
 * 首版恰为两个实证害项（设计文档 D3），对应受害案例 §1.2：
 */
export const SPAWN_ENV_OUTBOUND_DENY_LIST: readonly string[] = [
  /**
   * 进程自身生命周期标志（「我是怎么被拉起来的」），生产消费者全部位于 runtime 进程
   * 自身（isPackaged() 判定六处），pi 子树零消费。泄漏危害有探针 P1 实锤：
   * `XYZ_AGENT_PACKAGED=1 bash scripts/validate-runtime-bundle.sh` → exit 1，
   * `[6/6] [runtime] fatal: relay server init failed: Bundled pi binary not found`
   * ——隔离 runtime 继承污染标志后 boot 即按打包态 findPackagedPi 解析不存在的捆绑
   * 二进制，直接挡死产品内的 git commit（设计文档 §1.2 受害链全文）。
   */
  'XYZ_AGENT_PACKAGED',
  /**
   * WS 鉴权令牌（main 注入给 runtime 的凭证）。pi 子树零消费；凭证暴露 P2 活体取证：
   * 打包版会话 bash 内 `printenv | grep XYZ_RUNTIME_TOKEN` 直见 hex 令牌——任意
   * git hook / npm script 等后代进程均可读取 WS 凭证（安全级危害）。
   */
  'XYZ_RUNTIME_TOKEN',
]

// ─────────────────────────────────────────────────────────────────────────────
// 出站子进程 env 构建器（docs/architecture/env-propagation-boundary.md §5-U2 的唯一实现点）。
// U3 主链路接线起，实现从 runtime infra/spawn-env.ts 归位本契约文件：main 进程 B2
// 边界（safe-env 薄封装）需要同款过滤/extras 组合能力但不吃 deny 兜底（见
// composeChildEnvBase JSDoc 的边界分层说明），跨包复用的唯一合理归属地是契约 SSOT 同文件。
// runtime 的 infra/spawn-env.ts 是本实现的门面 re-export（保持既有 import 路径）。
//
// 三步语义：
// 1. prefixes 过滤父 env 为基座（缺省 = shared 入站白名单 SSOT）——R2：Node spawn 的
//    env 是整体替换语义，必须以过滤后的父 env 为基座、禁止从空对象起拼，否则
//    PATH/HOME 静默丢失（故障形态远距离爆炸：hooks 里 `git: command not found`）；
// 2. merge extras——undefined 值 = 显式删除语义，对齐 main 侧 safe-env.ts 既有约定
//    （dev 清理 shell 残留标志的既有行为）；
// 3. apply SPAWN_ENV_OUTBOUND_DENY_LIST 剔除——deny-by-default 兜底，与调用方怎么
//    组装无关地保证生命周期标志 / 凭证不出产品边界。
//
// 红线 R1/R3：纯函数，绝不读写 process.env 本体——一切输入经参数注入（runtime 自身
// 有六处 isPackaged() 消费点读本进程 env，污染本体即全局事故；CJS bundle 约束下也无
// 任何 import.meta/静态路径依赖）。不 mutate 入参对象，返回全新对象（「spread 副本上
// 删」范式的函数化，参照 relay-registry buildChildEnv）。
//
// prefix 匹配语义与各进程既有 buildSafeEnv 一致：仅 key.startsWith(prefix)。
// [S4] 该判定已覆盖 key === prefix 的精确匹配场景（s.startsWith(s) === true）。
import { ENV_WHITELIST_PREFIXES } from './constants'

/** buildOutboundChildEnv / composeChildEnvBase 入参。 */
export interface BuildOutboundChildEnvOptions {
  /** 父进程 env 快照（调用方显式注入；约定可传 process.env 引用但本函数绝不改写它） */
  parentEnv: Record<string, string | undefined>
  /** 强制注入/覆盖的键；值为 undefined 时执行删除语义 */
  extras?: Record<string, string | undefined>
  /** 基座前缀白名单（main 进程 B2 边界传 [...SSOT, 'ELECTRON_'] 扩展）；缺省用 shared SSOT */
  prefixes?: readonly string[]
}

/**
 * 基座组装层（三步语义的前两步）：prefixes 过滤父 env → merge extras（undefined=删除）。
 * 【不含 deny 兜底】——供「deny 键本身是下游合法输入」的产品内部边界专用：唯一使用方是
 * main→runtime 边界（apps/electron/main/supervisor/safe-env.ts），其 extras 注入的
 * XYZ_AGENT_PACKAGED / XYZ_RUNTIME_TOKEN 正是 runtime 进程自身的合法输入（isPackaged()
 * 六处判定消费 + WS 鉴权），直调完整构建器会在打包态把它们剥掉导致应用瘫痪。
 * 出站对外孵化路径一律走 buildOutboundChildEnv（含 deny 步骤 3），不得直接消费本函数。
 */
export function composeChildEnvBase(opts: BuildOutboundChildEnvOptions): Record<string, string> {
  const prefixes = opts.prefixes ?? ENV_WHITELIST_PREFIXES
  // 大小写不敏感匹配：Windows 进程 env 键形如 SystemRoot / ComSpec / ProgramFiles，
  // 而白名单登记的是大写形——大小写敏感的 startsWith 会把这些 Windows ambient 键
  // 静默剥掉，导致新收编的 spawn 调用点（git schannel / cmd wrapper 等）在 Windows
  // 上失败。env 键在 Windows 语义本就不区分大小写，故统一 lower-case 比较。
  const loweredPrefixes = prefixes.map(p => p.toLowerCase())

  // 步骤 1：白名单过滤父 env 为基座（undefined 值天然不放行）
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(opts.parentEnv)) {
    if (value === undefined) continue
    const loweredKey = key.toLowerCase()
    if (loweredPrefixes.some(prefix => loweredKey.startsWith(prefix))) out[key] = value
  }

  // 步骤 2：merge extras——undefined = 显式删除（safe-env.ts 同款语义）
  if (opts.extras !== undefined) {
    for (const [key, value] of Object.entries(opts.extras)) {
      if (value !== undefined) out[key] = value
      else delete out[key]
    }
  }

  return out
}

/**
 * 在已构建的 env 副本上执行 deny 清单兜底剥除（原地删键）。模块私有分层：唯一调用方
 * 是本文件 buildOutboundChildEnv；对外不暴露——外部接线点必须走含兜底的完整终态接口，
 * 禁止单独消费 deny 步骤造成半成品出站面。
 */
function applyOutboundDenyList(env: Record<string, string>): void {
  for (const denied of SPAWN_ENV_OUTBOUND_DENY_LIST) {
    delete env[denied]
  }
}

/** 构建可直接作为 spawn/execFile/fork options.env 使用出站环境（含 deny 兜底终态）。 */
export function buildOutboundChildEnv(opts: BuildOutboundChildEnvOptions): Record<string, string> {
  const out = composeChildEnvBase(opts)
  applyOutboundDenyList(out)
  return out
}

/** forward 参考清单的单条目形态：只作文档性登记，不参与任何运行时过滤。 */
export interface SpawnEnvForwardEntry {
  /** 变量名（relay 三件套类多变量以基名 + 通配说明登记） */
  name: string
  /** 进入 pi 子树的途径（哪个边界注入，或依赖入站白名单继承） */
  injectionPath: string
  /** pi 子树内消费锚点（forward 依据；行号为本分支 grep 复核值，源码漂移后须回查） */
  piConsumerAnchors: readonly string[]
}

/**
 * forward 参考清单（B 组五项 + U0 核实增补一项）：合法跨界功能契约变量的证据档案。
 *
 * 【参考文档性质导出】本清单不参与过滤——runtime→pi 的实际放行仍由入站白名单前缀
 * 匹配决定（白名单含裸前缀，凡消费锚点成立的变量天然在列）；本清单的价值是把
 * 「为什么这个变量允许跨界」的证据集中在一处，供未来审计与 deny 扩容评审引用。
 *
 * U0-② 结论（维持原判，LOG_LEVEL 族不入本清单）：XYZ_LOG_LEVEL / XYZ_LOG_MAX_BYTES /
 * XYZ_LOG_KEEP_DAYS 在 extensions/ 全目录生产代码零命中（extension-logger 仅读
 * XYZ_AGENT_DEBUG），消费者仅 runtime 进程自身（infra/logger.ts:53/:55/:119）——
 * 属 runtime 自身行为开关，无跨界消费证据。
 */
export const SPAWN_ENV_FORWARD_REFERENCE: readonly SpawnEnvForwardEntry[] = [
  {
    name: 'PI_CODING_AGENT_DIR',
    // 非 XYZ_ 前缀，故不走白名单侥幸，靠 B3 显式追加兜底数据隔离根目录同源
    injectionPath: 'B3 显式追加（rpc-client.ts:168 env.PI_CODING_AGENT_DIR = getPiAgentDir()）',
    piConsumerAnchors: [
      'extensions/taiji/system-prompt/src/index.ts:77（process.env.PI_CODING_AGENT_DIR 直读，上推两级同源推导 dataDir）',
      '全 extensions 面经 pi 导出的 getAgentDir() 间接消费（如 llm-shared/src/config.ts:8 注释点名禁止自实现路径推导，须尊重 PI_CODING_AGENT_DIR）',
    ],
  },
  {
    name: 'XYZ_AGENT_DEBUG',
    injectionPath: 'B3 白名单放行（裸 XYZ_ 前缀）',
    piConsumerAnchors: [
      'extensions/shared/extension-logger/src/index.ts:342（fileLog gate：process.env.XYZ_AGENT_DEBUG !== "1" 即 no-op）',
      'extensions/universal/subagent-workflow/src/execution/subagent-service.ts:392（debug 分支启用）',
    ],
  },
  {
    name: 'XYZ_GLOBAL_AGENTS_DIR',
    injectionPath: 'B3 白名单放行（裸 XYZ_ 前缀）',
    piConsumerAnchors: [
      'extensions/taiji/system-prompt/src/index.ts:91（resolveGlobalAgentsDir 全局 agents 目录 override）',
    ],
  },
  {
    name: 'XYZ_SUBAGENT_RELAY_SOCKET/_NODE/_SCRIPT',
    injectionPath:
      'B3 经 getRelaySpawnEnv() 显式注入（infra/pi/process-manager.ts:123；常量定义 extensions/universal/subagent-workflow/src/execution/relay-env.ts:13-15，构建于 runtime infra/relay/relay-env.ts，未激活返回空对象「全有或全无」降级）；'
      + '嵌套 spawn 方向由 relay-registry buildChildEnv 剥五键防旧值误导（relay-registry.ts:178）',
    piConsumerAnchors: [
      'subagent-workflow relay 代理链三基础设施（session-runner.ts isRelayActive 判定齐备后经代理转交 spawn）',
    ],
  },
  {
    name: 'XYZ_ZCODE_CLI',
    injectionPath: 'B3 白名单放行（裸 XYZ_ 前缀）',
    // [W11] 锚点回写（W12 拖尾子项①）：core 内建 engines/zcode 已删，生产消费点
    // 迁引擎包（registration.ts 的缺省 deps 组装）+ core D8 薄壳 createZcodeEngine
    // 的 deps.cliPath 等价通道（原 inproc 回退分支的 env 读取已删）。
    piConsumerAnchors: [
      'packages/zcode-subagent-cli/src/registration.ts:40（zcode CLI 路径 override，引擎孵化外部 CLI）',
      'packages/subagent-core/src/execution/engine/d8-compat.ts createZcodeEngine deps.cliPath（D8 薄壳等价通道）',
    ],
  },
  {
    // U0-① 增补项：核实结论为「依赖 B3 白名单继承，无自注入通路」。
    //
    // 命中分类（rg subagent-workflow/src）：生产读取唯一 lifecycle-manager.ts:57
    // （主 pi 进程内 extension 直接读自身 process.env 取全局缺省 idle timeout）；
    // 其余命中均为注释/工具描述文本（lifecycle-manager.ts:46/:102/:109、types.ts:392/:589、
    // subagent-tool.ts:280）与测试（resource-policy.test.ts）。
    // 「设置进嵌套 frame.env」通路不存在：嵌套注入仅写 RELAY_ENV_SESSION_ID/_RECORD_ID
    // 两键（session-runner.ts:987-988），故通道唯一 = B3 入站白名单继承。
    name: 'XYZ_SUBAGENT_IDLE_TIMEOUT_MS',
    injectionPath: 'B3 白名单放行（裸 XYZ_ 前缀）；extension 无 frame.env 自注入通路（U0① 核实）',
    piConsumerAnchors: [
      'extensions/universal/subagent-workflow/src/execution/lifecycle-manager.ts:57（armIdleTimer 三层优先级中的全局缺省来源）',
    ],
  },
  {
    // git ssh remote（git@github.com:…）的 ssh-agent 认证通道：OpenSSH 经
    // SSH_AUTH_SOCK 连接 agent。不在白名单前缀内，故由 npm-git-installer /
    // shell-runner / git-executor 的 extras 显式 forward（值守卫：父 env 未设置
    // 时不注入）；消费锚点 = git 的 ssh 子进程（libssh2/OpenSSH 标准行为）。
    name: 'SSH_AUTH_SOCK',
    injectionPath:
      'extras 显式转发（infra/installers/npm-git-installer.ts pickProxyExtras，'
      + 'shell-runner.ts / git-executor.ts 同源复用）',
    piConsumerAnchors: [
      'git clone git@… / git fetch / git push 的 ssh 子进程（OpenSSH agent 协议标准消费）',
    ],
  },
]
