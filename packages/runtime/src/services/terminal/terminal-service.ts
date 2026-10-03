/**
 * TerminalService 实现 —— drawer 集成终端的 PTY 生命周期管理（Phase 2）。
 *
 * 🔒 三层架构：services/terminal/terminal-service.ts 实现 ports/terminal-service.ts。
 *
 * 职责：
 * 1. 实例注册表（ptyMap: Map<terminalId, IPty>，terminalId = `term:<sessionId>:<序号>`）
 *    ——**键集即存活实例全集**，不另建平行注册结构（spawn 写入、onExit 即删）
 * 2. spawn：node-pty spawn shell → onData 发布 terminal.data（transient）→ onExit 发布
 *    terminal.exit + 清理 → 发布 terminal.alive（wave:perf-w07 接 MessageBus）
 * 3. write/resize/kill/attach：按实例编号转发（实例不存在 = unknown_terminal_id 明确错误，
 *    退役「静默 no-op」语义）
 * 4. 会话级序号计数器（单次 runtime 生命周期内单调递增、实例关闭后不回填，设计 §2.3 不变量①）
 * 5. destroySessionPties / destroyAllPties / destroyPty：实例回收
 *
 * shell 解析（Phase 6）：
 *   config.terminal.json 的 shell 字段（deps.configService 注入）→ fallback 登录 shell
 *   （macOS: dscl 读 UserShell；Linux: $SHELL）→ '/bin/bash'（win: 'powershell.exe'）。
 *   仅对新 spawn 的 PTY 生效。
 *
 * 错误模式：扁平 `Object.assign(new Error(msg), { code })`（仿 worktree-service），
 * code 为 TerminalErrorCode：未知实例 = unknown_terminal_id，会话段不一致 =
 * terminal_id_session_mismatch（两码互斥，见设计 §3.3「网络消息」末条）。
 *
 * 日志：直接用 console.*（initLogger 已 patch 全局，tee 到文件，见架构约定 #4）。
 */
import * as pty from 'node-pty'
import { execFileSync } from 'node:child_process'
import { buildOutboundChildEnv } from '../../infra/spawn-env.js'
import type { ServerMessage, TerminalInstanceSummary } from '@taiji/shared'
import type { ITerminalService } from '../ports/terminal-service.js'
import { toErrorMessage } from '../../utils/errors.js'

/** TerminalService 依赖。 */
export interface TerminalServiceDeps {
  /**
   * session 级消息发布通道（wave:perf-w07 D1-1，R-05）：terminal.* 三类消息接 MessageBus。
   * 组合根注入 bus.publish 封装——topicOf 三分类自动分流：terminal.data=transient（不占
   * seq 不入 ring 直传）、terminal.alive/exit=stream（分配 seq 入 ring，可回放）。
   *
   * [终态语义：publish-only，不叠加 broker.broadcast] terminal.data 是 transient 无 seq，
   * 若叠加盲广播，已订阅 renderer 会双 dispatch（evalSeqGap 对无 seq 消息不去重，
   * core/coordination/subscription-state.ts 分支 3 直通）
   * → 终端输出重复渲染。与 02 文档 D1-1 对 plugin:viewUpdate（同为 transient）的
   * 「publish 且不再 broadcast」定案同判据。renderer 侧 useSessionStreamSync 对 list 内
   * session 全量订阅（terminal 只在 session panel 打开时 spawn，该 session 必然已订阅）。
   * W09（D1-2）删双写已落地——bus.publish 是 session 级消息唯一通道，publish-only 即终态。
   */
  publish: (sessionId: string, msg: ServerMessage) => void
  /**
   * Phase 6：terminal 配置（shell/shellArgs 偏好）。可选——Phase 6 前的测试构造时不传，
   * resolveShell 走环境变量 fallback。生产路径由 index.ts 注入（configService 同源）。
   */
  configService?: { getTerminalConfig(): { config: { shell: string; shellArgs: string[] }; corrupted: boolean } }
}

/** terminal 业务错误工厂（扁平模式，仿 worktreeError）。 */
function terminalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * 实例编号的会话段前缀（精确前缀枚举口径，设计 §0.5 P7）：
 * 判归属 / 枚举 / 交叉校验一律用 `startsWith(prefix)`，**禁按冒号切分取段**——
 * 该口径仅在 sid 域不含冒号时无歧义（否则 `term:a:` 会吞 sid 为 `a:1` 的键）。
 */
function sessionPrefix(sid: string): string {
  return `term:${sid}:`
}

/** 把 Error 序列化为 plain object，避免 logger 的 JSON.stringify 把 Error 实例变成 {}。
 *  Error 的 message/stack 在原型链上（非 own-enumerable），JSON.stringify 丢掉它们，
 *  导致 catch 块直接打印错误实例时日志只剩 {}，看不出真实错误。 */
function serializeError(e: unknown): { message: string; stack?: string; code?: unknown } | { value: string } {
  if (e instanceof Error) {
    return {
      message: e.message,
      stack: e.stack,
      ...('code' in e ? { code: (e as Error & { code: unknown }).code } : {}),
    }
  }
  return { value: String(e) }
}

/** 生成唯一广播消息 id（高频 terminal.data 需单调递增，避免同毫秒碰撞）。 */
let pushCounter = 0
function nextPushId(): string {
  pushCounter += 1
  return `terminal_push_${Date.now()}_${pushCounter}`
}

/**
 * kill 的 SIGKILL 升级延迟（RT-8#10）。超时量级按被保护对象的粒度校准（AGENTS 架构约定
 * #19）：这里是单个 PTY 进程的回收兜底——控制面/单对象粒级，秒级即可（对齐 shell-runner
 * 的 ESCALATION_DELAY_MS=5s 惯例），不是任务级墙钟。SIGTERM 可被 shell trap 捕获/忽略，
 * 无升级则 ignore trap 的 shell + 其子进程成为孤儿，fd 永久残留。
 */
const KILL_ESCALATION_MS = 5000

export class TerminalService implements ITerminalService {
  /** 实例注册表：键 = terminalId（`term:<sid>:<n>`），值 = PTY 句柄。键集即存活实例全集。 */
  private readonly ptyMap = new Map<string, pty.IPty>()
  /**
   * 已发过 terminal.writeFailed 的 terminalId（RT-8#10）。write 失败几乎总是「PTY 已死/
   * 管道关闭」，之后每次击键都会再失败——若逐次 publish 会被击键流刷屏。每 PTY 生命周期
   * 至多报一次：spawn（新周期）与 onExit/回收（周期结束）时清除该实例键。
   * [多实例] 按实例分键（原按 sid）——同会话两实例各自可上报一次，跨实例互不吞。
   */
  private readonly writeFailedReported = new Set<string>()
  /**
   * 会话级序号计数器（设计 §3.3「实例注册表与恢复」）：pure memory、单次 runtime 生命周期内
   * 只增不减——实例关闭后序号不回填、实例死绝也不回落（不变量①）。
   * **否决「live 键 max+1 纯函数派生」**：实例死绝后 max 回落会复用「终端 1」，同号键无隔离，
   * 迟到 exit 帧会误清新实例分区。会话删除时**不清计数**（同 id 会话不会重现，删了反而给
   * 「假想重现」留回落口子）。
   */
  private readonly terminalCounters = new Map<string, number>()

  constructor(private deps: TerminalServiceDeps) {}

  /**
   * spawn 双形态（设计 §3.3「网络消息」）：
   * - 不带 terminalId = 新建：分配编号 → spawn → 返回分配的 terminalId（编号收口 runtime）
   * - 带 terminalId = 指定：实例存活则幂等 no-op；不存在 → unknown_terminal_id
   * 两形态都先做会话段交叉校验（不一致 → terminal_id_session_mismatch）。
   */
  async spawn(sid: string, cwd: string | undefined, cols: number, rows: number, terminalId?: string): Promise<string> {
    if (terminalId !== undefined) {
      // 会话段不一致 → terminal_id_session_mismatch；会话段一致但实例不在注册表 → unknown_terminal_id
      if (this.requireInstance(sid, terminalId) === null) {
        throw terminalError('unknown_terminal_id', `Unknown terminal instance: terminalId=${terminalId}`)
      }
      console.log(`[terminal] spawn no-op (already alive): terminalId=${terminalId}`)
      return terminalId
    }

    const allocated = this.allocateTerminalId(sid)
    const { shell, shellArgs } = this.resolveShell()
    const spawnCwd = cwd ?? process.cwd()
    console.log(
      `[terminal] spawn: sid=${sid} terminalId=${allocated} shell=${shell} cwd=${spawnCwd} cols=${cols} rows=${rows}`,
    )

    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spawnCwd,
        env: this.buildEnv(),
      })
    } catch (e) {
      const msg = toErrorMessage(e)
      console.error(`[terminal] spawn failed: sid=${sid} terminalId=${allocated} shell=${shell}`, serializeError(e))
      throw terminalError('spawn_failed', `Failed to spawn terminal: ${msg}`)
    }

    this.ptyMap.set(allocated, proc)
    this.writeFailedReported.delete(allocated)

    // PTY 输出 → 发布 terminal.data（transient 高频流：不占 seq 不入 ring）
    proc.onData((data) => {
      this.deps.publish(sid, {
        type: 'terminal.data',
        id: nextPushId(),
        payload: { sessionId: sid, terminalId: allocated, data },
      })
    })

    // PTY 退出 → 发布 terminal.exit（stream：入 ring 可回放）+ 清理注册表
    proc.onExit(({ exitCode }) => {
      console.log(`[terminal] exit: terminalId=${allocated} exitCode=${exitCode}`)
      this.ptyMap.delete(allocated)
      this.writeFailedReported.delete(allocated)
      this.deps.publish(sid, {
        type: 'terminal.exit',
        id: nextPushId(),
        payload: { sessionId: sid, terminalId: allocated, exitCode },
      })
    })

    // 就绪信号（stream：renderer flush 写队列——联动 2 异步写时序）
    this.deps.publish(sid, {
      type: 'terminal.alive',
      id: nextPushId(),
      payload: { sessionId: sid, terminalId: allocated },
    })

    return allocated
  }

  write(sid: string, terminalId: string, data: string): void {
    const proc = this.requireInstanceOrThrow(sid, terminalId)
    try {
      proc.write(data)
    } catch (e) {
      // 进程已退出/管道关闭时 write 失败属预期竞态，onExit 回调会清理——本地不抛
      //（ack 语义保持：击键流不该被单个失败打断）。但输入字节已丢，必须让前端知道
      //（RT-8#10）：每实例生命周期 publish 一次 terminal.writeFailed（防击键流刷屏，
      // spawn/onExit/回收 清该实例键），renderer 收到后按实例 toast「输入可能丢失」。
      // publish 是唯一上报通道（不再叠加本地 console.error——publish 帧已含 message，
      // 根因由 terminal.exit 广播 + onExit 日志独立承载，避免双通道重复记录同事件）。
      if (!this.writeFailedReported.has(terminalId)) {
        this.writeFailedReported.add(terminalId)
        this.deps.publish(sid, {
          type: 'terminal.writeFailed',
          id: nextPushId(),
          payload: { sessionId: sid, terminalId, message: toErrorMessage(e) },
        })
      }
    }
  }

  resize(sid: string, terminalId: string, cols: number, rows: number): void {
    const proc = this.requireInstanceOrThrow(sid, terminalId)
    try {
      proc.resize(cols, rows)
    } catch (e) {
      // best-effort：进程已退出时 resize 抛错属预期竞态，下次 spawn 会重建，不传播
      console.error(`[terminal] resize failed: terminalId=${terminalId}`, serializeError(e))
    }
  }

  kill(sid: string, terminalId: string): void {
    const proc = this.requireInstanceOrThrow(sid, terminalId)
    try {
      proc.kill()
    } catch (e) {
      // 重复 kill 或进程已退出时抛错，onExit 回调幂等清理注册表 + 广播 terminal.exit
      console.error(`[terminal] kill failed: terminalId=${terminalId}`, serializeError(e))
      return
    }
    // onExit 回调会清理注册表 + 广播 terminal.exit；SIGTERM 被忽略时升级兜底
    this.scheduleKillEscalation(terminalId, proc, 'kill')
  }

  attach(sid: string, terminalId: string): void {
    // 成员资格校验是本帧的实质职责：renderer 以 unknown_terminal_id 否定回执回收幽灵条目
    //（attach 是回收触发入口之一，见设计 §3.3）。预留给流量控制（高频 terminal.data
    // 拥塞时仅推活跃实例），当前无额外动作。
    this.requireInstanceOrThrow(sid, terminalId)
  }

  listInstances(sid: string): TerminalInstanceSummary[] {
    const prefix = sessionPrefix(sid)
    const instances: TerminalInstanceSummary[] = []
    for (const terminalId of this.ptyMap.keys()) {
      // 精确前缀匹配（设计 §0.5 P7）：`term:<sid>:` 后必须紧邻序号——
      // 不做冒号切分取段，避免含冒号 sid 形态跨会话误匹配。
      if (terminalId.startsWith(prefix)) {
        instances.push({ terminalId, alive: true })
      }
    }
    return instances
  }

  destroySessionPties(sid: string): void {
    const prefix = sessionPrefix(sid)
    const targets: Array<[string, pty.IPty]> = []
    for (const [terminalId, proc] of this.ptyMap) {
      if (terminalId.startsWith(prefix)) targets.push([terminalId, proc])
    }
    if (targets.length === 0) return
    console.log(`[terminal] destroySessionPties: sid=${sid} count=${targets.length}`)
    for (const [terminalId, proc] of targets) {
      this.destroyInstance(terminalId, proc)
    }
  }

  destroyAllPties(): void {
    const targets = [...this.ptyMap.entries()]
    if (targets.length === 0) return
    console.log(`[terminal] destroyAllPties: count=${targets.length}`)
    for (const [terminalId, proc] of targets) {
      this.destroyInstance(terminalId, proc)
    }
  }

  /**
   * 兼容旧名（u4 把 index.ts 调用点切到 destroySessionPties 前保留可编译可调用）。
   * 多实例语义下 = 该会话**全实例**杀（不再只杀一个）。
   */
  destroyPty(sid: string): void {
    this.destroySessionPties(sid)
  }

  /** 分配会话内下一个编号并推进计数器（实例关闭后不回填；分配即消耗，spawn 失败也不复用）。 */
  private allocateTerminalId(sid: string): string {
    const next = (this.terminalCounters.get(sid) ?? 0) + 1
    this.terminalCounters.set(sid, next)
    return `${sessionPrefix(sid)}${next}`
  }

  /**
   * 实例路由校验（顺序钉死：交叉校验先于注册表查存——若先查存，`term:<他会话>:1` 会命中
   * 他会话的存活实例并被错误写入）。返回 PTY 句柄；不存在 / 会话段不一致抛扁平错误。
   */
  private requireInstanceOrThrow(sid: string, terminalId: string): pty.IPty {
    const proc = this.requireInstance(sid, terminalId)
    if (proc === null) {
      throw terminalError('unknown_terminal_id', `Unknown terminal instance: terminalId=${terminalId}`)
    }
    return proc
  }

  /**
   * 校验并查注册表：会话段不一致 → terminal_id_session_mismatch（**独立码**，不触发 renderer
   * 回收）；会话段一致但不在注册表 → 返回 null（调用方按语义抛 unknown_terminal_id 或走幂等分支）。
   */
  private requireInstance(sid: string, terminalId: string): pty.IPty | null {
    if (!terminalId.startsWith(sessionPrefix(sid))) {
      throw terminalError(
        'terminal_id_session_mismatch',
        `terminalId session segment mismatch: terminalId=${terminalId} sessionId=${sid}`,
      )
    }
    return this.ptyMap.get(terminalId) ?? null
  }

  /** 回收单个实例：kill + 清注册表 + 清写失败标记 + SIGKILL 升级兜底（untracked）。 */
  private destroyInstance(terminalId: string, proc: pty.IPty): void {
    try {
      proc.kill()
    } catch (e) {
      // 进程已退出时 kill 抛错，紧接的 ptyMap.delete 会兜底清理，不阻塞销毁
      console.error(`[terminal] destroyPty kill failed: terminalId=${terminalId}`, serializeError(e))
    }
    this.ptyMap.delete(terminalId)
    this.writeFailedReported.delete(terminalId)
    // 销毁不广播 terminal.exit（renderer 已在 session.deleted / 关闭沿清理分区）。
    // SIGTERM 被忽略时仍需升级（fd 残留与销毁原因无关）。此时注册表已删，升级 timer 不能靠
    // map 判活——untracked 模式下进程已退出时 kill 会抛错被吞（无害）；误杀风险不存在：
    // terminalId 永不复用，同 id 不会 re-spawn。
    this.scheduleKillEscalation(terminalId, proc, 'destroyPty', { untracked: true })
  }

  /**
   * kill 的 SIGKILL 升级兜底（RT-8#10）：SIGTERM 后 KILL_ESCALATION_MS 仍未退出
   * （shell trap 捕获/忽略 SIGTERM、子进程不在同进程组）时强杀，防孤儿进程 + fd 残留。
   * tracked 模式（用户 kill）：onExit 清理注册表后本 timer 自然 no-op——同 terminalId 是
   * 绝不复用的，守卫 `ptyMap.get(terminalId) !== proc` 只作防御式兜背（防实现漂移）。
   */
  private scheduleKillEscalation(
    terminalId: string,
    proc: pty.IPty,
    label: string,
    opts?: { untracked?: boolean },
  ): void {
    const timer = setTimeout(() => {
      if (!opts?.untracked && this.ptyMap.get(terminalId) !== proc) return
      try {
        proc.kill('SIGKILL')
        console.warn(
          `[terminal] ${label}: SIGTERM 后 ${KILL_ESCALATION_MS}ms 未退出，已升级 SIGKILL: terminalId=${terminalId}`,
        )
      } catch (e) {
        // SIGKILL 也失败（极罕见：进程已死时 node-pty 抛错属预期 no-op；真失败则子进程/fd
        // 残留）——上报带恢复动作，不留静默断链
        console.error(
          `[terminal] ${label}: SIGKILL 升级失败，子进程/fd 可能残留（恢复动作：重启应用回收）: terminalId=${terminalId}`,
          serializeError(e),
        )
      }
    }, KILL_ESCALATION_MS)
    // 兜底 timer 不得拖延 runtime 进程退出
    timer.unref()
  }

  /**
   * 解析 shell：优先 config.terminal.json 的 shell 字段，其次用户真实登录 shell，最后平台默认。
   * 登录 shell（非 config 路径）加 -l（加载 ~/.zshrc / ~/.bash_profile，让别名/PATH 生效）。
   *
   * [HISTORICAL] 不信 $SHELL 环境变量：Electron 从 GUI（Dock/Finder）启动时，process.env.SHELL
   * 继承自 launchd，是 macOS 历史默认的 /bin/bash，不反映用户 chsh 后的登录 shell。导致用户
   * 明明 chsh 成了 zsh，drawer 终端仍启动 bash 3.2，触发 bash 4+ 脚本（如 sdkman）报
   * bad substitution。macOS 正确做法是用 dscl 读 /Users/$USER 的 UserShell 记录。
   */
  private resolveShell(): { shell: string; shellArgs: string[] } {
    // Phase 6：读 terminal config（config 缺失或读取失败时 fallback 登录 shell）。
    // configService 可选——测试构造时不传，走 fallback。
    try {
      const cfg = this.deps.configService?.getTerminalConfig()
      if (cfg && cfg.config.shell.trim() !== '') {
        // config 提供 shell（用户显式设置）+ shellArgs（用户指定参数，原样透传不加 -l）
        return { shell: cfg.config.shell, shellArgs: cfg.config.shellArgs }
      }
    } catch (e) {
      // best-effort：config 读取失败（文件损坏/IO 错误）降级到登录 shell——不阻塞 PTY 启动
      console.warn('[terminal] read terminal config failed, falling back to login shell', e)
    }
    if (process.platform === 'win32') {
      return { shell: 'powershell.exe', shellArgs: [] }
    }
    // macOS：用 dscl 读真实登录 shell（不信 GUI 继承的 $SHELL，见方法注释 [HISTORICAL]）
    if (process.platform === 'darwin') {
      const loginShell = readDarwinLoginShell()
      if (loginShell) {
        return { shell: loginShell, shellArgs: ['-l'] }
      }
    }
    // Linux / dscl 失败：fallback $SHELL
    const shell = process.env.SHELL
    if (shell && shell.trim() !== '') {
      return { shell, shellArgs: ['-l'] }
    }
    return { shell: '/bin/bash', shellArgs: ['-l'] }
  }

  /**
   * 构造子进程 env（B7 出站接线，docs/architecture/env-propagation-boundary.md §5-U4）。
   *
   * D5 决策：用户终端身份是「用户的 shell」，比 pi 更外部——跟随最小剥离（不走入站
   * 白名单基座过滤，shell 需要 PATH/HOME/SHELL 等全量系统变量）：pass-all 前缀 ''
   * 承载全量拷贝拓扑（任意 key 都满足 startsWith('')，builder 步骤 1 即不过滤），
   * 自有语义全部经 extras 承载：TERM fallback 保持 + PR #105 三项显式删除；出站 deny
   * 两键由构建器末步兜底。纯函数副本操作，绝不 mutate process.env 本体（R1）。
   */
  private buildEnv(): Record<string, string> {
    return buildOutboundChildEnv({
      parentEnv: process.env,
      prefixes: [''],
      extras: {
        // TERM 让终端应用（vim/htop）正确渲染（原 env.TERM || 'xterm-256color' 语义不变）
        TERM: process.env.TERM || 'xterm-256color',
        // [HISTORICAL] 清除 Electron sidecar 内部变量，避免污染用户 terminal。
        // ⚠️ 此修复与 quota 功能无关，是顺带修复的 terminal env 污染 bug（PR #105 一同提交）。
        // runtime 进程是 Electron 主进程用 ELECTRON_RUN_AS_NODE=1 spawn 出来的 sidecar（打包模式，
        // 见 process-control.ts:202-205），这些变量会随 process.env 继承到 terminal shell。
        // 用户在 terminal 里跑 `electron .` / `npm run dev` 等命令时，Electron 会因该变量退化为
        // 纯 Node 运行，require('electron').app 为 undefined → 'Cannot read properties of
        // undefined (reading isPackaged)' 崩溃。terminal 是给用户跑命令的，不是 sidecar 下游，
        // 必须切断这类 Electron 实现细节变量的继承。undefined 值 = 构建器显式删除语义。
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ASAR: undefined,
        ELECTRON_OVERRIDE_DIST_PATH: undefined,
      },
    })
  }
}

/**
 * 读取 macOS 当前用户的真实登录 shell（chsh 后的设置）。
 * 用 dscl 查 UserShell 记录，而非信 GUI 应用继承的 $SHELL（launchd 历史默认 /bin/bash）。
 * 失败（dscl 不存在/非 macOS/记录缺失）返回空串，由调用方走 $SHELL fallback。
 */
function readDarwinLoginShell(): string {
  try {
    const out = execFileSync('dscl', ['.', '-read', `/Users/${process.env.USER}`, 'UserShell'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      // C-proc-09 出站契约：不传 env = 隐式全量继承父环境（含 TAIJI_RUNTIME_TOKEN），
      // 泄漏给 dscl 后代进程；只读查询仅需 PATH/HOME，白名单基座 + deny 兜底（RT-8#9）。
      env: buildOutboundChildEnv({ parentEnv: process.env }),
    })
    // 输出形如 "UserShell: /bin/zsh"
    const match = out.match(/UserShell:\s*(\S+)/)
    const shell = match?.[1]?.trim() ?? ''
    return shell
  } catch {
    return ''
  }
}
