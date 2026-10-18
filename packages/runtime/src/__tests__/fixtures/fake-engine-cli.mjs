/**
 * 假引擎 CLI fixture（u-m3-control 集成/单测专用，设计 relay-spawn-transport §3.4.3
 * runtime 侧验收形态）。
 *
 * territory 自足：不追 pi-subagent-cli 工作副本（真实引擎联测登记 A4，DC-1 推迟到
 * W2 全部单元完成后）。本 fixture 只承载 control server 需要的引擎侧行为：
 * - NDJSON stdin/stdout（engine_frame 信封的 `line` 载荷是不透明字符串，server 不理解
 *   引擎协议语义——fixture 按请求回 response 即可贯通双向转发）；
 * - `--spawn-child`：spawn 一个长驻子进程（模拟引擎拉起的假 pi，组杀收割对象）；
 * - `--exit-on <token> [--exit-code <n>]`：stdin 行含 token 即退出（正常/非正常退出）；
 * - `--die-parent-only`：父进程自杀（exit 0）留子进程残活——unexpected-exit → 组杀
 *   兜底链（POSIX 负 pid 组杀覆盖已死组长）的收割对象；
 * - `--hang`：忽略 stdin 永不退出（engine_close 有界等待超时 → killed_by_control）；
 * - `--stderr <text>`：启动即写一行 stderr（engine_closed.stderrTail 采集验证）；
 * - `--emit <json>`：启动即向 stdout 写一行（unsolicited 引擎帧下发验证）。
 *
 * 临时文件纪律：fixture 文件在仓内（territory 内自足），运行期不写任何数据目录；
 * server 侧 socket/pid 文件由测试注入 mkdtemp 目录。
 */

const args = process.argv.slice(2)
function argOf(name) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const has = (name) => args.includes(name)

// stderr 先行（--stderr 时）：在 stdout 任何输出前落，stderrTail 采集时序稳定
const stderrText = argOf('--stderr')
if (stderrText !== undefined) process.stderr.write(`${stderrText}\n`)

// unsolicited 引擎帧（server 视角：引擎 stdout 不请自来的行照常封装 engine_frame 下发）
const emitRaw = argOf('--emit')
if (emitRaw !== undefined) process.stdout.write(`${emitRaw}\n`)
// 巨行发射（上行帧超限用例；尺寸不经 launch spec 传递——那会撑爆 engine_open 信封）
const emitSize = Number(argOf('--emit-size') ?? '0')
if (emitSize > 0) process.stdout.write(`w${'w'.repeat(emitSize)}\n`)

// 模拟引擎拉起的假 pi 子进程（同进程组——spawnEngineChild 契约 detached:false；
// server 组杀负 pid 覆盖本进程与该子进程）
let child = null
if (has('--spawn-child')) {
  const { spawn } = await import('node:child_process')
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
  })
  // 子进程 pid 上报（server 视角不透明行；测试经 engine_frame 解析收割断言用）
  process.stdout.write(`${JSON.stringify({ type: 'event', childPid: child.pid })}\n`)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let nl = buf.indexOf('\n')
  while (nl !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    nl = buf.indexOf('\n')
    if (line.trim().length === 0) continue
    handleLine(line)
  }
})
process.stdin.on('end', () => {
  // 保持与真实引擎同语义：stdin EOF 不自动退出（EOF 自灭是 SDK armEngineSelfDestruct
  // 的职责，宿主测试用显式 exit/kill 驱动终局）
})

function handleLine(line) {
  // --exit-on 判定先于回包（退出语义优先）
  const exitToken = argOf('--exit-on')
  if (exitToken !== undefined && line.includes(exitToken)) {
    const code = Number(argOf('--exit-code') ?? '0')
    process.exit(code)
  }
  if (has('--hang')) return
  // 请求/响应回显：任何带 id 的 JSON 行回一行 response（engine-protocol 形态近似）
  try {
    const parsed = JSON.parse(line)
    if (parsed !== null && typeof parsed === 'object' && parsed.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ type: 'response', id: parsed.id, ok: true })}\n`)
    }
  } catch {
    process.stdout.write(`${JSON.stringify({ type: 'event', raw: line })}\n`)
  }
}

if (has('--die-parent-only')) {
  // 父进程自杀留子进程残活（unexpected-exit 组杀兜底链的测试入口）
  setTimeout(() => process.exit(0), 50)
}
