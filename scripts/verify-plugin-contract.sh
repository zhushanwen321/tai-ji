#!/usr/bin/env bash
# verify-plugin-contract.sh — 插件 API 契约硬化端到端验收（S3-W1/W2，spec
# 2026-08-17-plugin-trust-boundary-hardening §4 D1/D2 场景，contract-spec CT-D1/CT-D2）
#
# 非 mock 端到端：隔离 runtime（随机端口 + 独立 TAIJI_AGENT_DATA_DIR + WS token 认证）
# + builtin trusted fixture 插件，覆盖：
#
#   CT-D2 命令执行链端到端 + 复合键防劫持（真实链路）：
#     插件 A register('x')（handler 驻留 Worker）→ 脚本经 WS 走 renderer 消费的同一
#     `plugin.executeCommand` RPC（分离 pluginId + commandId 参数）→ 断言：
#     ① A 的 handler 真实收到 args（Worker console → runtime stdout 证据）
#     ② 执行结果经 plugin.commands.invoke.result 回传闭环——成功路径 reply 非
#        error；错误路径（handler throw）毫秒级回传 error message（非 10s 超时）
#     ③ 插件 B register 同名 'x' 不覆盖 A:x（复合键 `pluginId:commandId` 隔离——
#        A:x 两次执行均路由 A 的 handler，B 的 handler 仅被 B:x 触发）
#     ④ B 注销自身 'x' 后 B:x 报 Command not found、A:x 仍可执行（B 的注销 no-op
#        于 A:x）；B 以 'A:x' 注入形态注销被 INVALID_COMMAND_ID 拒（asSafeKey
#        白名单不含 ':'，复合键注入在入口即断）
#
#   CT-D1 sessions 事件端到端 + events 降级报错：
#     插件 C register onDidCreateSession/onDidDestroySession → 脚本经 WS 真实
#     session.create（spawn 真实 pi 子进程）→ 断言回调触发且收到的事件含该
#     sessionId；session.delete 同理（didDestroy 定向投递）；插件内调
#     api.events.on/emit 即抛 NOT_IMPLEMENTED（错误文本含 issue 指引 URL——
#     G4 显式失败优于静默失效）；plugin-sdk types.ts events 段 @stable 标注
#     已清零（grep -c 断言为 0，events 面是 @experimental）。
#
# 输出协议（cw e2e-sh 标记行）：每个场景以**行首** `CT-D2 PASS/FAIL`、`CT-D1 PASS/FAIL`
# 纯文本标记行输出（上方 [OK]/[FAIL]/PASS [step] 明细行保留）；脚本 exit code 与
# 标记行一致。
#
# 运行形态：tsx 源码直跑（cwd=repo 根），自含 pnpm install（全新 checkout 可跑），
# 不占用正在跑的 dev app。
#
# 用法: bash scripts/verify-plugin-contract.sh
# 依赖: node >= 22（全局 WebSocket）、curl、lsof、pgrep、pnpm、pi（PATH 或
#       ~/.nvm/versions/*/bin/pi——session.create spawn 真实 pi 子进程）
# 耗时: ~25s

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

fail() {
  echo -e "${RED}[FAIL] $1${NC}" >&2
  if [ -f "${RUNTIME_STDOUT:-}" ]; then
    echo -e "${YELLOW}── runtime stdout 尾部（${RUNTIME_STDOUT}）──${NC}" >&2
    tail -30 "$RUNTIME_STDOUT" >&2
  fi
  # 失败保留现场（进程照常清理，临时目录保留供排查；成功路径才全量清理）
  PRESERVE_ON_FAIL=1
  echo -e "${YELLOW}[定位] 现场保留于: ${WORK_DIR:-<未创建>}（排查后手动删除）${NC}" >&2
  exit 1
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 0.1 依赖自含（幂等；cw verify 在干净 clone 里跑，必须可自举）─────────────
(cd "$REPO_ROOT" && pnpm install --prefer-offline --silent) \
  || fail "pnpm install 失败（cwd=${REPO_ROOT}；检查 registry 可达性或手动 pnpm install 后重试）"

# ── 0. 环境前置 ─────────────────────────────────────────────────
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo -e "${RED}[ERROR] 需要 node >= 22（全局 WebSocket 客户端），当前 $(node --version)${NC}" >&2
  exit 1
fi

# tsx 解析对齐 process-control.ts：从 apps/electron（tsx 声明方）按 Node 解析算法定位
TSX_PKG="$(node -e "console.log(require.resolve('tsx/package.json', { paths: ['$REPO_ROOT/apps/electron'] }))")" \
  || fail "tsx 不可解析——先 pnpm install（解析基准: $REPO_ROOT/apps/electron）"
TSX_CLI="$(dirname "$TSX_PKG")/dist/cli.mjs"
[ -f "$TSX_CLI" ] || fail "tsx cli 不存在: ${TSX_CLI}（先 pnpm install）"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Plugin Contract E2E 验收]（CT-D2 命令链+复合键 / CT-D1 session 事件+events 降级）${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ── 1. 隔离环境准备 ─────────────────────────────────────────────
WORK_DIR="$(mktemp -d /tmp/taiji-contract-e2e.XXXXXX)"
DATA_DIR="$WORK_DIR/data"
BUILTIN_DIR="$WORK_DIR/builtin-plugins"
SESSION_CWD="$WORK_DIR/session-cwd"
RUNTIME_STDOUT="$WORK_DIR/runtime.log"
RUNTIME_PID=""
# 真实 runtime 进程（tsx wrapper 的唯一子进程）——SIGTERM 必须发给它：wrapper 对
# 信号的转发不保证（verify-lifecycle-e2e.sh 同款结论）。
RUNTIME_CHILD=""
PRESERVE_ON_FAIL=0

cleanup() {
  if [ -n "$RUNTIME_PID" ]; then
    local children
    children="$(pgrep -P "${RUNTIME_CHILD:-$RUNTIME_PID}" 2>/dev/null || true)"
    for pid in "${RUNTIME_CHILD:-}" "$RUNTIME_PID"; do
      [ -z "$pid" ] && continue
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 20); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.5
        done
        if kill -0 "$pid" 2>/dev/null; then
          echo -e "${YELLOW}[WARN] 进程 $pid 未在 10s 内退出，SIGKILL${NC}" >&2
          kill -9 "$pid" 2>/dev/null || true
        fi
      fi
    done
    for c in $children; do
      if kill -0 "$c" 2>/dev/null; then
        echo -e "${YELLOW}[WARN] 孤儿子进程 ${c}，终止${NC}" >&2
        kill "$c" 2>/dev/null || true
      fi
    done
  fi
  if [ "$PRESERVE_ON_FAIL" = "1" ]; then
    echo -e "${YELLOW}[WARN] 失败现场保留: ${WORK_DIR}（排查后手动删除）${NC}" >&2
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$DATA_DIR/agent" "$BUILTIN_DIR/ct-a" "$BUILTIN_DIR/ct-b" "$BUILTIN_DIR/ct-c" "$SESSION_CWD"

# models.json 预写：session.create 前置检查 getDefaultModel()（读
# <dataDir>/agent/models.json），且 runtime 把 defaultModel 作为 --model 传给
# pi 子进程（pi 侧 PI_CODING_AGENT_DIR=<dataDir>/agent，同读此文件）。e2e 假
# provider 需带 api/baseUrl（pi 模型校验要求，缺 api 整个 provider 被丢弃）；
# baseUrl 指向不可达端口——本脚本不发 LLM 请求，永不触达。
cat > "$DATA_DIR/agent/models.json" <<'EOF'
{ "providers": { "ct-e2e": { "api": "openai", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": "dummy", "models": [ { "id": "ct-e2e-model", "name": "CT E2E Model", "contextWindow": 128000, "maxTokens": 8192 } ] } } }
EOF

# ── fixture：builtin trusted 插件（trusted Worker 线程，console 共享 runtime stdout）──

# ct-a：命令宿主 A（CT-D2 断言目标）。register 'x'（记录收到的 args 并返回
# 标记结果）+ 'x-throw'（handler throw——错误回传闭环的观测点）。
cat > "$BUILTIN_DIR/ct-a/package.json" <<'EOF'
{
  "name": "ct-a",
  "version": "1.0.0",
  "type": "module",
  "taijiPlugin": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"] }
}
EOF
cat > "$BUILTIN_DIR/ct-a/index.js" <<'EOF'
export async function activate(context) {
  console.log('[ct-a] activate called')
  await context.api.commands.register({ id: 'x', title: 'CT A x' }, async (args) => {
    console.log('[ct-a] handler-x called args=' + JSON.stringify(args ?? null))
    return { echoed: (args && args.n) || null, by: 'ct-a' }
  })
  await context.api.commands.register({ id: 'x-throw', title: 'CT A throw' }, async () => {
    throw new Error('CT_BOOM_MARKER')
  })
}
export async function deactivate() {}
EOF

# ct-b：防劫持样本 B（CT-D2 断言目标）。register 同名 'x'（复合键下与 A:x 互不
# 干扰）+ 两个受控命令：ctrl-unreg-x（注销自身 x）、ctrl-unreg-forge（以 'ct-a:x'
# 注入形态尝试注销 A 的命令——asSafeKey 白名单不含 ':'，预期 INVALID_COMMAND_ID）。
cat > "$BUILTIN_DIR/ct-b/package.json" <<'EOF'
{
  "name": "ct-b",
  "version": "1.0.0",
  "type": "module",
  "taijiPlugin": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"] }
}
EOF
cat > "$BUILTIN_DIR/ct-b/index.js" <<'EOF'
let api
export async function activate(context) {
  api = context.api
  console.log('[ct-b] activate called')
  await api.commands.register({ id: 'x', title: 'CT B x' }, async (args) => {
    console.log('[ct-b] handler-x called args=' + JSON.stringify(args ?? null))
    return { echoed: (args && args.n) || null, by: 'ct-b' }
  })
  await api.commands.register({ id: 'ctrl-unreg-x' }, async () => {
    await api.commands.unregister('x')
    console.log('[ct-b] unregistered own x')
  })
  await api.commands.register({ id: 'ctrl-unreg-forge' }, async () => {
    try {
      await api.commands.unregister('ct-a:x')
      console.log('[ct-b] FORGE-UNREG-ACCEPTED')
    } catch (e) {
      console.log('[ct-b] forge-unreg rejected: ' + ((e && e.message) || String(e)))
    }
  })
}
export async function deactivate() {}
EOF

# ct-c：session 事件订阅 + events 降级探针（CT-D1 断言目标）。
# didCreate/didDestroy handler 打印收到的 sessionId；events.on/emit 的 throw
# 被 catch 后打印完整错误文本（NOT_IMPLEMENTED + issue 指引 URL 的观测点）。
cat > "$BUILTIN_DIR/ct-c/package.json" <<'EOF'
{
  "name": "ct-c",
  "version": "1.0.0",
  "type": "module",
  "taijiPlugin": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"] }
}
EOF
cat > "$BUILTIN_DIR/ct-c/index.js" <<'EOF'
export async function activate(context) {
  console.log('[ct-c] activate called')
  context.api.sessions.onDidCreateSession((s) => {
    console.log('[ct-c] didCreate sid=' + (s && s.id))
  })
  context.api.sessions.onDidDestroySession((s) => {
    console.log('[ct-c] didDestroy sid=' + (s && s.id))
  })
  try {
    context.api.events.on('ct-ev', () => {})
    console.log('[ct-c] EVENTS-ON-NO-THROW')
  } catch (e) {
    console.log('[ct-c] events-on rejected: ' + ((e && e.message) || String(e)))
  }
  try {
    context.api.events.emit('ct-ev', { a: 1 })
    console.log('[ct-c] EVENTS-EMIT-NO-THROW')
  } catch (e) {
    console.log('[ct-c] events-emit rejected: ' + ((e && e.message) || String(e)))
  }
}
export async function deactivate() {}
EOF

# ── 2. 起隔离 runtime（--builtin-plugins-dir 指向 fixture，trusted 形态）──────
PORT=""
for _ in $(seq 1 10); do
  CANDIDATE=$(( (RANDOM % 3000) + 41000 ))
  if ! lsof -n -P -i :$CANDIDATE 2>/dev/null | grep -q LISTEN; then
    PORT=$CANDIDATE
    break
  fi
done
[ -n "$PORT" ] || fail "10 次随机端口均被占用（41000-43999），检查端口占用: lsof -nP -i :41000-43999"

# S1-W1（spec §3.3 D4）：WS auth token——模拟 Electron 主进程 spawn 注入（env 通道）。
WS_AUTH_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
cd "$REPO_ROOT"
TAIJI_RUNTIME_TOKEN="$WS_AUTH_TOKEN" TAIJI_AGENT_DATA_DIR="$DATA_DIR" \
  node "$TSX_CLI" "$REPO_ROOT/packages/runtime/src/index.ts" --port "$PORT" --builtin-plugins-dir "$BUILTIN_DIR" \
  > "$RUNTIME_STDOUT" 2>&1 &
RUNTIME_PID=$!

READY=false
for _ in $(seq 1 40); do
  if curl -s --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
    READY=true
    break
  fi
  kill -0 "$RUNTIME_PID" 2>/dev/null || break
  sleep 0.5
done
[ "$READY" = true ] || fail "runtime 未在 20s 内就绪（port=${PORT}, pid=${RUNTIME_PID}, log=${RUNTIME_STDOUT}）"
RUNTIME_CHILD="$(pgrep -P "$RUNTIME_PID" 2>/dev/null | head -1 || true)"
[ -n "$RUNTIME_CHILD" ] || fail "未找到 runtime 子进程（wrapper=${RUNTIME_PID} 的 pgrep -P 为空——tsx 拓扑变化？）"
echo -e "${GREEN}[OK] 隔离 runtime 就绪（port=${PORT}, wrapper=${RUNTIME_PID}, runtime=${RUNTIME_CHILD}）${NC}"

# ── 3. WS 编排：CT-D2 命令链 + CT-D1 session 生命周期 ───────────
# 单个 node 编排脚本完成全部 WS 交互，逐步打印 PASS/FAIL（行首锚定），任一步失败
# exitCode=1（继续跑完剩余 step 保留证据）；createSid 写 summary json 供 bash 比对。
cat > "$WORK_DIR/ct-flow.mjs" <<'EOF'
// CT 契约 e2e WS 编排：等 3 插件 active → CT-D2 命令链（执行/错误回传/防劫持）→
// CT-D1 session.create/delete（真实 pi 子进程）
import { writeFileSync } from 'node:fs'
const port = process.argv[2]
const token = process.argv[3] ?? ''
const sessionCwd = process.argv[4]
const summaryPath = process.argv[5]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
const pending = new Map()
let nextId = 1

const send = (type, payload) => new Promise((resolve, reject) => {
  const id = `ct-${nextId++}`
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ type, id, payload }))
  setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id)
      reject(new Error(`RPC 超时: ${type}`))
    }
  }, 30000)
})

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'auth.result') {
    if (msg.payload?.ok !== true) {
      console.error(`FAIL [WS auth 被拒] ${msg.payload?.reason ?? 'unknown'}`)
      process.exit(1)
    }
    void runFlow()
    return
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg)
  }
}
ws.onopen = () => {
  // S1-W1：首条消息必须是 auth（runtime 对 pre-auth 业务消息静默丢弃）
  ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
}
ws.onerror = () => {
  console.error(`FAIL [WS 连接失败] ws://127.0.0.1:${port}`)
  process.exit(1)
}

const results = []
const step = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}]${detail ? ' ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

const runFlow = async () => {
  let createSid = ''
  try {
    // ── 前置：等 ct-a/ct-b/ct-c boot 自动激活（最多 30s）──
    let plugins = []
    for (let i = 0; i < 30; i++) {
      const m = await send('plugin.list', {})
      plugins = m.payload?.plugins ?? []
      const ids = ['ct-a', 'ct-b', 'ct-c']
      const allActive = ids.every((id) => plugins.find((p) => p.pluginId === id)?.status === 'active')
      if (allActive) break
      await sleep(1000)
    }
    for (const id of ['ct-a', 'ct-b', 'ct-c']) {
      const p = plugins.find((x) => x.pluginId === id)
      step(`CT 前置 ${id} 激活`, p?.status === 'active', `status=${p?.status ?? 'MISSING'}`)
    }
    if (results.some((r) => !r.ok)) throw new Error('fixture 插件未全部激活，中止后续编排')

    // ── CT-D2：命令执行链（走 renderer 消费的同一 plugin.executeCommand RPC）──
    // S1: A:x 正常执行——成功回传闭环（回传断链则 10s 超时 error）
    const s1 = await send('plugin.executeCommand', { pluginId: 'ct-a', commandId: 'x', args: { n: 'first' } })
    step('CT-D2-S1 executeCommand A:x 成功（结果回传 resolve pending）', s1.type !== 'error', `reply=${s1.type}${s1.type === 'error' ? ' msg=' + s1.payload?.message : ''}`)

    // S2: A:x-throw——错误回传闭环（毫秒级 error message，非 10s 超时）
    const t0 = Date.now()
    const s2 = await send('plugin.executeCommand', { pluginId: 'ct-a', commandId: 'x-throw' })
    const elapsed = Date.now() - t0
    const boomOk = s2.type === 'error' && String(s2.payload?.message ?? '').includes('CT_BOOM_MARKER')
    step('CT-D2-S2 handler 抛错经 invoke.result 回传（error message 含 CT_BOOM_MARKER）', boomOk, `type=${s2.type} msg=${s2.payload?.message ?? ''} elapsed=${elapsed}ms`)
    step('CT-D2-S2b 错误回传毫秒级（< 5s，非超时路径）', boomOk && elapsed < 5000, `${elapsed}ms`)

    // S3: B:x 独立可执行（B 注册同名 x 成功——复合键 B:x 是独立条目）
    const s3 = await send('plugin.executeCommand', { pluginId: 'ct-b', commandId: 'x', args: { n: 'by-b' } })
    step('CT-D2-S3 executeCommand B:x 成功（同名命令独立注册）', s3.type !== 'error', `reply=${s3.type}${s3.type === 'error' ? ' msg=' + s3.payload?.message : ''}`)

    // S4: B 以 'ct-a:x' 注入形态注销——预期被拒（拒绝证据在插件日志，bash 侧断言）
    const s4 = await send('plugin.executeCommand', { pluginId: 'ct-b', commandId: 'ctrl-unreg-forge' })
    step('CT-D2-S4 注入注销探针命令执行完成（拒绝断言看日志）', s4.type !== 'error', `reply=${s4.type}`)

    // S5: B 注销自身 x
    const s5 = await send('plugin.executeCommand', { pluginId: 'ct-b', commandId: 'ctrl-unreg-x' })
    step('CT-D2-S5 B 注销自身 x', s5.type !== 'error', `reply=${s5.type}`)

    // S6: B:x 已删——Command not found: ct-b:x（复合键错误信息含插件前缀）
    const s6 = await send('plugin.executeCommand', { pluginId: 'ct-b', commandId: 'x' })
    const s6ok = s6.type === 'error' && String(s6.payload?.message ?? '').includes('Command not found: ct-b:x')
    step('CT-D2-S6 B:x 注销后报 Command not found: ct-b:x', s6ok, `type=${s6.type} msg=${s6.payload?.message ?? ''}`)

    // S7: A:x 不受 B 注册/注销影响，仍可执行（B 的注销 no-op 于 A:x）
    const s7 = await send('plugin.executeCommand', { pluginId: 'ct-a', commandId: 'x', args: { n: 'after' } })
    step('CT-D2-S7 B 注册+注销后 A:x 仍可执行（防劫持）', s7.type !== 'error', `reply=${s7.type}${s7.type === 'error' ? ' msg=' + s7.payload?.message : ''}`)

    // ── CT-D1：session 生命周期事件（真实 pi 子进程）──
    // T1: session.create → 回调触发断言在 bash 侧（didCreate 日志含此 sid）
    const t1 = await send('session.create', { cwd: sessionCwd, label: 'ct-d1-e2e' })
    createSid = t1.payload?.session?.id ?? ''
    step('CT-D1-T1 session.create 成功（真实 pi 子进程）', t1.type !== 'error' && !!createSid, `type=${t1.type} sid=${createSid}`)
    if (!createSid) throw new Error('session.create 未返回 sessionId，中止 delete 步骤')

    // T2: session.delete → didDestroy 定向投递断言在 bash 侧
    const t2 = await send('session.delete', { sessionId: createSid })
    step('CT-D1-T2 session.delete 成功', t2.type !== 'error', `type=${t2.type}`)

    // 插件侧 console（trusted Worker 共享 runtime stdout）落盘窗口
    await sleep(2000)

    // summary 必须在 process.exit 前显式写入——exit 立即终止，finally 不保证执行
    try { writeFileSync(summaryPath, JSON.stringify({ createSid })) } catch { /* best-effort */ }

    if (results.some((r) => !r.ok)) process.exit(1)
    console.log('WS_FLOW_DONE')
    ws.close()
    process.exit(0)
  } catch (e) {
    console.error(`FAIL [WS 编排异常] ${e.message ?? e}`)
    try { writeFileSync(summaryPath, JSON.stringify({ createSid })) } catch { /* best-effort */ }
    process.exit(1)
  }
}
setTimeout(() => { console.error('FAIL [WS 编排整体超时 120s]'); process.exit(1) }, 120000)
EOF

node "$WORK_DIR/ct-flow.mjs" "$PORT" "$WS_AUTH_TOKEN" "$SESSION_CWD" "$WORK_DIR/ct-summary.json" \
  | tee "$WORK_DIR/ct-flow.log" \
  || fail "WS 编排有失败步骤（见上方 FAIL 行与 $WORK_DIR/ct-flow.log）"

# 等插件侧 console 落盘（Worker stdout 共享主进程，异步窗口小；轮询兜底）
sleep 1

# ── 4. 日志断言（真实副作用证据）+ 标记行输出 ────────────────────
# wait_log <pattern> <label>：轮询等待 runtime stdout 出现 pattern（插件回调经
# WS 通知异步到达 Worker，须轮询而非单次 grep）。
wait_log() {
  local pattern="$1" label="$2"
  for _ in $(seq 1 30); do
    if grep -qF "$pattern" "$RUNTIME_STDOUT"; then
      echo -e "${GREEN}[OK] $label${NC}"
      return 0
    fi
    sleep 0.5
  done
  echo -e "${RED}[FAIL] $label —— 日志缺少匹配 '$pattern'${NC}" >&2
  return 1
}

# 场景标记行输出（行首锚定，供 grep -E '^CT-(D1|D2) (PASS|FAIL)$' 机读）
CT_EXIT=0
ct_report() {
  # $1=验收id $2=判定(0=pass) $3=明细
  if [ "$2" -eq 0 ]; then
    echo -e "${GREEN}[OK] $1 $3${NC}"
    echo "$1 PASS"
  else
    echo -e "${RED}[FAIL] $1 $3${NC}" >&2
    echo "$1 FAIL"
    CT_EXIT=1
  fi
}

CREATE_SID="$(node -e "
const s = require('fs').readFileSync('$WORK_DIR/ct-summary.json', 'utf8')
const j = JSON.parse(s)
console.log(j.createSid || '')
" 2>/dev/null || echo "")"

# ══ CT-D2 判定：命令执行链 + 复合键防劫持 ══════════════════════
d2=0
if grep -q '^FAIL' "$WORK_DIR/ct-flow.log" 2>/dev/null; then
  d2=1
  echo -e "${RED}[FAIL] WS 编排存在失败步骤（见 ct-flow.log）${NC}" >&2
fi
grep -q 'WS_FLOW_DONE' "$WORK_DIR/ct-flow.log" 2>/dev/null || { d2=1; echo -e "${RED}[FAIL] WS 编排未完成（无 WS_FLOW_DONE）${NC}" >&2; }

# handler 真实收到 args（Worker 侧证据）
if wait_log '[ct-a] handler-x called args={"n":"first"}' 'CT-D2 A 的 handler 收到调用与 args（S1）'; then :; else d2=1; fi
if wait_log '[ct-a] handler-x called args={"n":"after"}' 'CT-D2 B 注册+注销后 A:x 仍路由 A 的 handler（S7）'; then :; else d2=1; fi

# 路由隔离计数：A handler 恰 2 次（S1+S7）、B handler 恰 1 次（S3）——B 的同名
# 注册不覆盖 A:x（若覆盖，A 计数为 0 而 B 计数为 3）
A_CALLS="$(grep -cF '[ct-a] handler-x called' "$RUNTIME_STDOUT" || true)"
B_CALLS="$(grep -cF '[ct-b] handler-x called' "$RUNTIME_STDOUT" || true)"
if [ "$A_CALLS" = "2" ]; then
  echo -e "${GREEN}[OK] CT-D2 A 的 handler 恰被调 2 次（S1+S7；未被 B 覆盖）${NC}"
else
  d2=1
  echo -e "${RED}[FAIL] A 的 handler 调用次数=${A_CALLS}（期望 2）${NC}" >&2
fi
if [ "$B_CALLS" = "1" ]; then
  echo -e "${GREEN}[OK] CT-D2 B 的 handler 恰被调 1 次（S3；A:x 不路由到 B）${NC}"
else
  d2=1
  echo -e "${RED}[FAIL] B 的 handler 调用次数=${B_CALLS}（期望 1）${NC}" >&2
fi

# 注入形态注销被拒（asSafeKey 白名单不含 ':'；错误文本经 RPC 回传插件侧 catch 打印，
# code 字段不进 message——断言 message 特征「Invalid commandId + 注入串」）
if grep -F '[ct-b] forge-unreg rejected:' "$RUNTIME_STDOUT" | grep -qF 'Invalid commandId "ct-a:x"'; then
  echo -e "${GREEN}[OK] CT-D2 B 以 ct-a:x 注入注销被拒（asSafeKey 白名单拒复合键注入）${NC}"
else
  d2=1
  echo -e "${RED}[FAIL] 注入注销未被 INVALID_COMMAND_ID 拒：$(grep -F '[ct-b] forge-unreg' "$RUNTIME_STDOUT" | head -2)${NC}" >&2
fi
if grep -qF 'FORGE-UNREG-ACCEPTED' "$RUNTIME_STDOUT"; then
  d2=1
  echo -e "${RED}[FAIL] 注入注销竟被接受（FORGE-UNREG-ACCEPTED 出现）${NC}" >&2
fi

# B 注销自身 x 真实执行
if wait_log '[ct-b] unregistered own x' 'CT-D2 B 注销自身 x 真实执行（S5）'; then :; else d2=1; fi

ct_report CT-D2 $d2 '命令执行链：executeCommand 前端形态闭环（成功 resolve + 错误毫秒回传）+ 复合键防劫持（B 不覆盖/不注销 A:x，注入形态被拒）'

# ══ CT-D1 判定：sessions 事件 + events 降级 ════════════════════
d1=0
if grep -qE '^FAIL \[CT-D1' "$WORK_DIR/ct-flow.log" 2>/dev/null; then
  d1=1
  echo -e "${RED}[FAIL] CT-D1 WS 步骤存在失败（见 ct-flow.log）${NC}" >&2
fi

if [ -n "$CREATE_SID" ]; then
  if wait_log "[ct-c] didCreate sid=$CREATE_SID" 'CT-D1 onDidCreateSession 回调触发且含 sessionId'; then :; else d1=1; fi
  if wait_log "[ct-c] didDestroy sid=$CREATE_SID" 'CT-D1 onDidDestroySession 回调触发且含 sessionId'; then :; else d1=1; fi
else
  d1=1
  echo -e "${RED}[FAIL] createSid 为空（session.create 未成功，didCreate/didDestroy 无法比对）${NC}" >&2
fi

# events 降级：NOT_IMPLEMENTED + issue 指引 URL（同行断言，防只匹配到 URL 出现在别处）
if grep -F '[ct-c] events-on rejected: NOT_IMPLEMENTED' "$RUNTIME_STDOUT" | grep -qF 'https://github.com/zhushanwen321/tai-ji/issues'; then
  echo -e "${GREEN}[OK] CT-D1 api.events.on 抛 NOT_IMPLEMENTED（含 issue 指引 URL）${NC}"
else
  d1=1
  echo -e "${RED}[FAIL] events.on 错误文本缺 NOT_IMPLEMENTED 或指引 URL：$(grep -F '[ct-c] events-on' "$RUNTIME_STDOUT" | head -1)${NC}" >&2
fi
if grep -F '[ct-c] events-emit rejected: NOT_IMPLEMENTED' "$RUNTIME_STDOUT" | grep -qF 'https://github.com/zhushanwen321/tai-ji/issues'; then
  echo -e "${GREEN}[OK] CT-D1 api.events.emit 抛 NOT_IMPLEMENTED（含 issue 指引 URL）${NC}"
else
  d1=1
  echo -e "${RED}[FAIL] events.emit 错误文本缺 NOT_IMPLEMENTED 或指引 URL：$(grep -F '[ct-c] events-emit' "$RUNTIME_STDOUT" | head -1)${NC}" >&2
fi
if grep -qF 'EVENTS-ON-NO-THROW' "$RUNTIME_STDOUT" || grep -qF 'EVENTS-EMIT-NO-THROW' "$RUNTIME_STDOUT"; then
  d1=1
  echo -e "${RED}[FAIL] events.on/emit 未抛错（NO-THROW 标记出现）${NC}" >&2
fi

# plugin-sdk types events 段 @stable 已清零（S3-W2 冻结契约：events 面是 @experimental）
# events 段界定：`readonly events: {` 起、行首两空格 `}` 止（Phase1AgentAPI 内唯一段）
STABLE_IN_EVENTS="$(awk '/readonly events: \{/,/^  \}$/' "$REPO_ROOT/packages/plugin-sdk/src/types.ts" | grep -c '@stable' || true)"
if [ "$STABLE_IN_EVENTS" = "0" ]; then
  echo -e "${GREEN}[OK] CT-D1 plugin-sdk types events 段 @stable 计数为 0（已降级 @experimental）${NC}"
else
  d1=1
  echo -e "${RED}[FAIL] types.ts events 段 @stable 计数=${STABLE_IN_EVENTS}（期望 0）${NC}" >&2
fi

ct_report CT-D1 $d1 'sessions 事件：didCreate/didDestroy 定向投递含 sessionId；events.on/emit 抛 NOT_IMPLEMENTED（含指引 URL）；SDK events 段 @stable 清零'

# ── 5. 收尾：优雅退出 runtime（SIGTERM 发真实子进程）─────────────
kill -TERM "$RUNTIME_CHILD" 2>/dev/null || true
for _ in $(seq 1 30); do
  kill -0 "$RUNTIME_PID" 2>/dev/null || break
  kill -0 "$RUNTIME_CHILD" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$RUNTIME_CHILD" 2>/dev/null || kill -0 "$RUNTIME_PID" 2>/dev/null; then
  fail "runtime SIGTERM 后 15s 未退出"
fi
wait "$RUNTIME_PID" 2>/dev/null || true
RUNTIME_PID=""

if [ "$CT_EXIT" -ne 0 ]; then
  fail "存在 FAIL 场景（见上方 CT-D1/CT-D2 FAIL 行）"
fi
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}[OK] Plugin Contract E2E 验收全部通过（CT-D2 命令链+防劫持 + CT-D1 session 事件+events 降级）${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
