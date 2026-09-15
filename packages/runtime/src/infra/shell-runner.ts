/**
 * IShellRunner 的真实实现 —— `child_process.spawn` 流式执行（W1 worktree setup 钩子）。
 *
 * 🔒 三层架构：infra 层实现 services/ports/shell-runner.ts 的 IShellRunner port。
 * 真引 node:child_process 的 spawn（Tier 2 证伪：编译器对依赖声明验签）。
 *
 * 注入：构造函数 `{ spawn }`，production 由 index.ts 传真实 spawn，测试传 mock spawn。
 * 此模式让 ShellRunner 单测无需真 spawn —— vi.doMock('node:child_process') 后把 mock 注入。
 *
 * 关键时序处理（SR-3 timeout + escalation）：
 * - timeout 到期 → child.kill('SIGTERM') + 设 `timedOut=true` 标记 + 启动 reject +
 *   启动 escalation timer（ESCALATION_DELAY_MS）。
 * - escalation：SIGTERM 后 5s 仍未 close 则 SIGKILL（防脚本 trap 忽略 SIGTERM / npm install
 *   子进程不在同一进程组导致孤儿进程）。
 * - 之后 child 必然 emit 'close'（被 kill 的进程会发 exit+close）—— 若不标记，close handler
 *   会 resolve 一个已 reject 的 promise（无效但易混淆）。故 close handler 先判 timedOut，
 *   已超时则不 resolve（保留 timeout reject）。
 * - 同理 error handler 也判 timedOut（极端：kill 后子进程 error 而非 close）。
 *
 * 行切分策略：Buffer → utf8 → 按 \n split。**跨 chunk 缓冲**——每个 stream 维护独立
 * lineBuffer，chunk 进来后先 append，再 split('\n')，最后一段（不含 \n）回写 lineBuffer
 * 留给下次。这样子进程输出 'installing pack' + 'age done\n' 两个 chunk 时，onOutput 只收到
 * 一行 'installing package done'（契约：逐行回调），不会先收到半行 'installing pack'。
 * close 时 flush 各 buffer 的剩余半行（若有）。累积 stdout/stderr 保留原始字符（含 \n），
 * 但经 CappedStreamAccumulator 字节帽（G3：10MB 对齐 git-executor，超限截断保留头尾）。
 */
import { EventEmitter } from 'node:events'
import { buildOutboundChildEnv } from './spawn-env.js'
import { pickProxyExtras } from './installers/npm-git-installer.js'
import { ShellRunnerError } from '../services/ports/shell-runner.js'
import type { IShellRunner, ShellRunnerExecuteOptions, ShellRunnerResult, SpawnFn } from '../services/ports/shell-runner.js'

/**
 * SIGTERM 后等待 SIGKILL 的升级延迟。
 * SIGTERM 可被脚本捕获/忽略（trap），npm install 子进程可能不在同一进程组——
 * 若 SIGTERM 后子进程不退出会变孤儿。给 5s 缓冲让 graceful shutdown 跑完，
 * 仍未 close 则 SIGKILL 强制终止。
 */
const ESCALATION_DELAY_MS = 5000

/**
 * stdout/stderr 累积字节帽（G3 峰值治理，memory-leak-remediation §3.4）：对齐
 * git-executor 的 GIT_MAX_BUFFER_BYTES（10MB）——失控脚本（如死循环 echo）的输出累积
 * 不得无界钉死 runtime 堆。超限截断保留头尾：头部保留脚本输出起点（错误上下文），
 * 尾部保留最终结论（错误摘要通常在末尾），中段丢弃并留截断标记（丢弃字节数可观测）。
 *
 * 仅帽「累积结果串」（resolve 返回的 stdout/stderr）——onOutput 逐行流式回调是消费即
 * 释散的增量通道，不在帽内（行为不变）。
 */
// eslint-disable-next-line no-magic-numbers -- 10MB = 10 * 1024 * 1024 bytes，对齐 git-executor
const SHELL_MAX_BUFFER_BYTES = 10 * 1024 * 1024
/** 尾部保留窗口（头部保留 = 总帽 - 尾窗口）。头 8MB / 尾 2MB：错误摘要在末尾、上下文在开头。 */
// eslint-disable-next-line no-magic-numbers -- 2MB 尾窗，头部 = 10MB - 2MB = 8MB
const SHELL_TAIL_RETAIN_BYTES = 2 * 1024 * 1024

/**
 * 帽内流累积器：字节记账（Buffer.byteLength，与 execFile maxBuffer 同计数口径）。
 * 两阶段：头段直累积，越过头部保留窗（总帽 - 尾窗）后切换尾段滚动窗（丢旧留新，
 * 中段丢弃计数）。单次 append 超调一个 chunk（管道 chunk 通常 ≤64KB，有界）——不做
 * 字节精确回切（UTF-8 多字节字符的串内字节定位代价大于收益）；尾段滚动按字符近似
 * 切（UTF-8 每字符 1-4 字节 → 切 excess 字符必丢 ≥ excess 字节，ASCII 恰精确）。
 */
class CappedStreamAccumulator {
  private head = ''
  private tail = ''
  private headBytes = 0
  private tailBytes = 0
  private droppedBytes = 0
  private tailMode = false

  constructor(private readonly stream: 'stdout' | 'stderr') {}

  append(text: string): void {
    const bytes = Buffer.byteLength(text)
    if (!this.tailMode) {
      this.head += text
      this.headBytes += bytes
      if (this.headBytes > SHELL_MAX_BUFFER_BYTES - SHELL_TAIL_RETAIN_BYTES) {
        // 头段满（本次 append 已入头段，超调 ≤ 一个 chunk）：后续进尾段滚动窗
        this.tailMode = true
      }
      return
    }
    this.tail += text
    this.tailBytes += bytes
    if (this.tailBytes > SHELL_TAIL_RETAIN_BYTES) {
      const excess = this.tailBytes - SHELL_TAIL_RETAIN_BYTES
      const cut = Math.min(this.tail.length, excess)
      const dropped = this.tail.slice(0, cut)
      const droppedByteLen = Buffer.byteLength(dropped)
      this.droppedBytes += droppedByteLen
      this.tail = this.tail.slice(cut)
      this.tailBytes -= droppedByteLen
    }
  }

  /** 关闭收尾：无丢弃返回原样；有丢弃返回 头 + 截断标记 + 尾。 */
  finish(): string {
    if (!this.tailMode) return this.head
    const marker =
      `\n...[shell-runner] ${this.stream} truncated: dropped ${this.droppedBytes} bytes ` +
      `(cap ${SHELL_MAX_BUFFER_BYTES} bytes, head+tail retained)...\n`
    return this.head + marker + this.tail
  }
}

/**
 * ShellRunner infra 适配器。spawn 经依赖注入，可替换为 mock 做单测。
 *
 * child 形状契约（与 node:child_process.ChildProcess 一致）：
 * - extends EventEmitter：emit 'close'(exitCode) / 'error'(Error)
 * - stdout/stderr: EventEmitter（emit 'data'(Buffer)）
 * - kill(signal): 终止子进程
 * - killed: boolean（kill 后置 true）
 */
export class ShellRunner implements IShellRunner {
  constructor(private deps: { spawn: SpawnFn }) {}

  execute(opts: ShellRunnerExecuteOptions): Promise<ShellRunnerResult> {
    const { scriptPath, args, cwd, onOutput } = opts
    // timeout 为 port 层必传（无暗默认）：用户配置值唯一决定量级，超时决策显式留给调用方。
    const timeout = opts.timeout

    // 用 bash 执行脚本而非直接 spawn(scriptPath)：git 跟踪的脚本默认 644（无 +x 位），
    // 直接 spawn 会 EACCES。bash 只需文件可读即可执行，跨平台一致且不依赖文件权限位。
    // [HISTORICAL] 事故：ShellRunner 原直接 spawn(scriptPath, args)，setup-worktree.sh 无
    // +x → spawn 报 EACCES，用户在非 xyz-agent workspace（如 xyz-pi-extensions-workspace）
    // 创建 worktree 时「新建 worktree」功能整体失败。根因不是路径写死（detector 正确动态
    // 查找 .bare），而是 spawn 对脚本权限位的隐式依赖。
    const child = this.deps.spawn('bash', [scriptPath, ...(args ?? [])], {
      cwd,
      // B8 出站边界显式化（docs/architecture/env-propagation-boundary.md §5-U4）：此前不传 env
      // ＝隐式全量继承父进程环境；改传构建器输出——默认白名单前缀作基座保住 PATH/HOME
      // （红线 R2：env 整体替换语义，禁从空对象起拼），deny 清单兜底剥生命周期标志与凭证。
      // extras 转发 git/pnpm 代理键与 SSH_AUTH_SOCK：setup-worktree.sh 内嵌 pnpm install
      // 与 git 操作，corporate 代理 / ssh-agent 环境下缺这些键会直接回归（与
      // npm-git-installer 共用 pickProxyExtras，键集同源）。
      env: buildOutboundChildEnv({ parentEnv: process.env, extras: pickProxyExtras(process.env) }),
      // stdin 显式 ignore：setup-worktree.sh 若 read stdin 会立即得 EOF，避免卡到 timeout。
      // stdout/stderr 仍 pipe 出来给 onOutput 流式回调。
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: (signal?: string) => void
      killed: boolean
    }

    let stdout = ''
    let stderr = ''
    // 跨 chunk 行缓冲：stdout / stderr 各自独立，避免两个流的半行互相拼接（stream 标识必须正确）。
    let stdoutBuffer = ''
    let stderrBuffer = ''
    // G3 累积帽：结果串经 CappedStreamAccumulator 记账（>10MB 截断保留头尾）；
    // 行缓冲 lineBuffer 不在帽内（单行有界于行长，流式语义不受影响）。
    const stdoutAcc = new CappedStreamAccumulator('stdout')
    const stderrAcc = new CappedStreamAccumulator('stderr')
    let timedOut = false
    let closed = false
    let timer: NodeJS.Timeout | undefined
    let escalationTimer: NodeJS.Timeout | undefined

    return new Promise<ShellRunnerResult>((resolve, reject) => {
      /**
       * 把 chunk 追加到对应 stream 的 lineBuffer，按 \n 切出完整行回调 onOutput；
       * 末段（不含 \n）留回 buffer 等下个 chunk 补全。空行不发（与原 splitLines 语义一致）。
       */
      const emitLines = (text: string, stream: 'stdout' | 'stderr'): void => {
        const merged = (stream === 'stdout' ? stdoutBuffer : stderrBuffer) + text
        const lines = merged.split('\n')
        // 最后一段不含 \n，回写 buffer 留给下次（若以 \n 结尾，最后一段是空串，buffer 清空）
        if (stream === 'stdout') stdoutBuffer = lines.pop() ?? ''
        else stderrBuffer = lines.pop() ?? ''
        if (onOutput) {
          for (const line of lines) {
            if (line.length > 0) onOutput(line, stream)
          }
        }
      }
      const onStdoutData = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stdoutAcc.append(text)
        emitLines(text, 'stdout')
      }
      const onStderrData = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stderrAcc.append(text)
        emitLines(text, 'stderr')
      }
      const cleanupTimers = (): void => {
        if (timer) clearTimeout(timer)
        if (escalationTimer) clearTimeout(escalationTimer)
      }
      const onClose = (exitCode: number | null): void => {
        closed = true
        cleanupTimers()
        // timeout 路径已 reject；后续 close 不再 resolve（保留 timeout 语义，避免 SR-3 失败）。
        if (timedOut) return
        child.stdout.removeListener('data', onStdoutData)
        child.stderr.removeListener('data', onStderrData)
        // flush 两个 stream 残留的半行（子进程输出未以 \n 结尾时）。
        if (onOutput) {
          if (stdoutBuffer.length > 0) onOutput(stdoutBuffer, 'stdout')
          if (stderrBuffer.length > 0) onOutput(stderrBuffer, 'stderr')
        }
        stdoutBuffer = ''
        stderrBuffer = ''
        stdout = stdoutAcc.finish()
        stderr = stderrAcc.finish()
        resolve({ exitCode: exitCode ?? 0, stdout, stderr })
      }
      const onError = (err: NodeJS.ErrnoException): void => {
        cleanupTimers()
        if (timedOut) return
        child.stdout.removeListener('data', onStdoutData)
        child.stderr.removeListener('data', onStderrData)
        // 脚本不存在（ENOENT）→ not_found；其余 errno 也归 not_found（语义上都是「找不到可执行文件」）
        if (err.code === 'ENOENT') {
          reject(new ShellRunnerError('not_found', `脚本不存在或不可执行: ${scriptPath}`))
        } else {
          reject(new ShellRunnerError('not_found', `脚本执行失败: ${err.message}`))
        }
      }

      child.stdout.on('data', onStdoutData)
      child.stderr.on('data', onStderrData)
      child.on('close', onClose)
      child.on('error', onError)

      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          // escalation：SIGTERM 后 5s 仍未 close 则 SIGKILL（防 SIGTERM 被捕获/忽略导致孤儿进程）
          escalationTimer = setTimeout(() => {
            if (!closed) child.kill('SIGKILL')
          }, ESCALATION_DELAY_MS)
          reject(new ShellRunnerError('timeout', `脚本执行超时（${timeout}ms）: ${scriptPath}`))
        }, timeout)
      }
    })
  }
}
