/**
 * 假引擎 CLI fixture（u-m3-control 集成/单测专用，设计 relay-spawn-transport §3.4.3
 * runtime 侧验收形态）。
 *
 * 定位：本 fixture 覆盖 control server 的**传输/生命周期**面（帧不透明转发、组杀、
 * 背压、超时），不追 pi-subagent-cli 的引擎协议语义。真实的「control server ×
 * pi-subagent-cli 引擎 × 假 pi 子进程」跨包集成见
 * __tests__/infra/subagent-control/real-engine-integration.test.ts（A4/DC-1 承接）。
 *
 * 承载的引擎侧行为：
 * - NDJSON stdin/stdout（engine_frame 信封的 `line` 载荷是不透明字符串，server 不理解
 *   引擎协议语义——fixture 按请求回 response 即可贯通双向转发）；
 * - `--spawn-child`：spawn 一个长驻子进程（模拟引擎拉起的假 pi，组杀收割对象）；
 * - `--exit-on <token> [--exit-code <n>] [--exit-delay-ms <n>]`：stdin 行含 token 即退出
 *   （正常/非正常退出；delay 用于「engine_close 先受理、引擎在 grace 窗内退出」的
 *   确定性时序用例）；
 * - `--die-parent-only`：父进程自杀（exit 0）留子进程残活——unexpected-exit → 组杀
 *   兜底链（POSIX 负 pid 组杀覆盖已死组长）的收割对象；
 * - `--hang`：忽略 stdin 内容永不退出（engine_close 有界等待超时 → killed_by_control）；
 * - `--no-read-stdin`：不消费 stdin（管道写满 → 背压 → down 队列累积，聚合上限用例）；
 * - `--stdin-pause-ms <n>`：先不消费 stdin（管道写满 → 背压），n ms 后恢复读取
 *   （慢读者恢复 → drain → down 队列冲刷；每帧恰好投递一次的回归用例）；
 * - `--stderr <text>`：启动即写一行 stderr（engine_closed.stderrTail 采集验证）；
 * - `--emit <json>`：启动即向 stdout 写一行（unsolicited 引擎帧下发验证）；
 * - `--emit-size <n>`：启动即发一行 n 字节巨帧（上行帧超限用例）；
 * - `--emit-lines <count> <bytes>`：启动即发 count 行、每行 bytes 字节（上行背压/顺序）；
 * - `--emit-lines-on <token> <count> <bytes>`：stdin 行含 token 时发多行巨帧（
 *   背压下控制帧 FIFO 顺序 / 连接级 overflow flush 用例的确定性入口）；
 * - `--emit-split-utf8`：把「中\n」的 3 字节字符拆成 1+2 两次写出（R→C 解码回归）；
 * - `--ack-stdin-bytes`：每行 stdin 回 `{type:'ack', bytes}`（A8 大 prompt 字节回执）；
 * - `--echo-line`：每行 stdin 回 `{type:'echo', line}`（C→R 跨 chunk 解码回显）；
 * - `--emit-host-child-frames`：随 `--spawn-child` 发 host/childSpawned 反向信封
 *   （Windows child pid 集合登记用例）。
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
// 多行巨帧（上行背压/顺序用例）：--emit-lines <count> <bytes>
const emitLinesIdx = args.indexOf('--emit-lines')
if (emitLinesIdx !== -1) {
  const count = Number(args[emitLinesIdx + 1] ?? '0')
  const size = Number(args[emitLinesIdx + 2] ?? '0')
  for (let i = 0; i < count; i++) process.stdout.write(`${'w'.repeat(size)}\n`)
}
// UTF-8 跨 chunk 边界（R→C 解码回归）：把「中\n」的 3 字节字符拆成 1+2 写出
if (has('--emit-split-utf8')) {
  const bytes = Buffer.from('中\n', 'utf8')
  process.stdout.write(bytes.subarray(0, 1))
  setTimeout(() => process.stdout.write(bytes.subarray(1)), 30)
}

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
  // 真实引擎的 D7 反向通道信封形态（runtime 只读解析这两个 method 维护 pidSet）
  if (has('--emit-host-child-frames')) {
    process.stdout.write(`${JSON.stringify({
      id: 'rev-child-1',
      method: 'host/childSpawned',
      params: { pid: child.pid, recordId: 'rec-1' },
    })}\n`)
  }
}

let buf = ''
// --no-read-stdin：不消费 stdin（管道写满后 server 侧 down 队列开始累积——连接级
// 聚合上限用例的确定性入口；进程仍常驻，由 engine_close/组杀收尾）。
// --stdin-pause-ms：延迟 n ms 再挂 data 监听（此前 stdin 保持 paused → 管道写满、
// server 侧进入背压；到点恢复读取触发 drain 冲刷队列，供「恰好投递一次」用例）。
function startReadingStdin() {
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
}
const stdinPauseMs = Number(argOf('--stdin-pause-ms') ?? '0')
if (!has('--no-read-stdin')) {
  if (stdinPauseMs > 0) setTimeout(startReadingStdin, stdinPauseMs)
  else startReadingStdin()
} else {
  // 不消费 stdin 时进程需自持活跃（否则 Node 无活动句柄即正常退出）
  setInterval(() => {}, 1000)
}

function handleLine(line) {
  // 按 token 触发多行巨帧（背压/顺序用例）：先于 exit-on（同 token 场景由调用方避免）
  const emitOnIdx = args.indexOf('--emit-lines-on')
  if (emitOnIdx !== -1 && line.includes(args[emitOnIdx + 1])) {
    const count = Number(args[emitOnIdx + 2] ?? '0')
    const size = Number(args[emitOnIdx + 3] ?? '0')
    for (let i = 0; i < count; i++) process.stdout.write(`${'w'.repeat(size)}\n`)
    return
  }
  // --exit-on 判定先于回包（退出语义优先）
  const exitToken = argOf('--exit-on')
  if (exitToken !== undefined && line.includes(exitToken)) {
    const code = Number(argOf('--exit-code') ?? '0')
    const delayMs = Number(argOf('--exit-delay-ms') ?? '0')
    if (delayMs > 0) {
      setTimeout(() => process.exit(code), delayMs)
      return
    }
    process.exit(code)
  }
  if (has('--hang')) return
  // A8：大 prompt 送达字节数回执（200KB 正向直测；只回字节数，不放大响应）
  if (has('--ack-stdin-bytes')) {
    process.stdout.write(`${JSON.stringify({ type: 'ack', bytes: Buffer.byteLength(line, 'utf8') })}\n`)
    return
  }
  // UTF-8 逐字回显（C→R 跨 chunk 解码回归）：原样 JSON 编码回一行
  if (has('--echo-line')) {
    process.stdout.write(`${JSON.stringify({ type: 'echo', line })}\n`)
    return
  }
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
