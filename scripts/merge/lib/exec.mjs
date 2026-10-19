/**
 * 子进程执行封装。参数数组形态（不经 shell），从结构上消灭 bash 引号/变量界定整类
 * 缺陷（全角括号吞变量名、空格分词等历史事故的载体）。
 *
 * 同步语义：merge 管线阶段命令是串行脚本，等待即阻塞，无需异步编排。
 */
import { spawnSync } from 'node:child_process'

/**
 * 运行子命令。不抛异常——退出码交调用方裁决（管线语义：失败 = 打印指引 + 非零退出）。
 *
 * opts.stdio: 'inherit'（默认，实时透传）| 'capture'（捕获 stdout/stderr）| 'ignore'（静默）
 * opts.timeoutMs: 可选墙钟超时（超时进程被杀，code 为 null）
 */
export function run(cmd, args, opts = {}) {
  const stdio = opts.stdio === 'capture' || opts.stdio === 'ignore' ? [`ignore`, opts.stdio === 'capture' ? 'pipe' : 'ignore', opts.stdio === 'capture' ? 'pipe' : 'ignore'] : 'inherit'
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    encoding: 'utf8',
    stdio,
    timeout: opts.timeoutMs,
  })
  return {
    code: res.status,
    ok: res.status === 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ?? null,
  }
}
