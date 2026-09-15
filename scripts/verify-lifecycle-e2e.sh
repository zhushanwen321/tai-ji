#!/usr/bin/env bash
# verify-lifecycle-e2e.sh — 插件生命周期健壮性端到端验收（S2-W3/W4，spec 2026-08-17
# plugin-trust-boundary-hardening §4 C2/C4 场景）
#
# 非 mock 端到端：隔离 runtime（随机端口 + 独立 TAIJI_AGENT_DATA_DIR + WS token 认证）
# + 真实插件 fixture，覆盖：
#
#   LC-C2 崩溃后退出（rebuild 约束）：
#     builtin trusted 插件 lc-crasher 激活后崩溃 Worker（exit code 1 → 触发 5s
#     rebuild 冷却 timer）→ 冷却窗口内（<2s）SIGTERM 优雅关停。断言：
#     ① 进程按时正常退出（<15s，无 30s 挂起——冷却 timer 被 shutdown 清理且 unref）
#     ② 无僵尸 worker/子进程（ps 按 runtime 子进程清单逐一核对）
#     ③ crash 回调未被误触发：plugin:crashed 广播恰 1 次（关停 terminate 不重复报崩溃）
#     ④ 无 onRebuilt 复活（无 rebuilt trusted worker / skip rebuild 日志）
#     ——配套 lc-hang（sandbox，deactivate 悬挂 5s 超时）拉长关停窗口跨过冷却到期点，
#     使「timer 未清理 → 关停中复活插件 → 二次崩溃广播」的旧缺陷可观测。
#
#   LC-C4 关停零丢失（关停顺序反转）：
#     sandbox 插件 lc-c4 在 onDeactivate 内 sessionData.set → SIGTERM 优雅关停 →
#     同 dataDir 重启 runtime → 读回数据一致；sessionData dispose 被调用（日志可证）。
#
# 输出协议（cw e2e-sh 标记行）：每个场景以**行首** `LC-C2 PASS/FAIL`、`LC-C4 PASS/FAIL`
# 纯文本标记行输出（上方 [OK]/[FAIL] 明细行保留）；脚本 exit code 与标记行一致。
#
# 运行形态：tsx 源码直跑（cwd=repo 根），自含 pnpm install（全新 checkout 可跑），
# 不占用正在跑的 dev app。
#
# 用法: bash scripts/verify-lifecycle-e2e.sh
# 依赖: node >= 22（全局 WebSocket）、curl、lsof、pgrep、pnpm
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
echo -e "${BLUE}[Lifecycle E2E 验收]（LC-C2 崩溃后退出 / LC-C4 关停零丢失）${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ── 1. 隔离环境准备（LC-C2 与 LC-C4 各自独立 data/builtin 目录，互不干扰）─────
WORK_DIR="$(mktemp -d /tmp/taiji-lifecycle-e2e.XXXXXX)"
DATA_DIR_C2="$WORK_DIR/data-c2"
DATA_DIR_C4="$WORK_DIR/data-c4"
BUILTIN_DIR="$WORK_DIR/builtin-plugins"
BUILTIN_EMPTY_DIR="$WORK_DIR/builtin-empty"
RUNTIME_PID=""
# 真实 runtime 进程（tsx wrapper 的唯一子进程）——SIGTERM 必须发给它：wrapper 对
# 信号的转发不保证（实测偶发 wrapper 直接 143 死亡、runtime 孤儿化、优雅关停链
# 整体被跳过），发 wrapper 会引入假 PASS/假 FAIL 双向噪声。
RUNTIME_CHILD=""
RUNTIME_STDOUT=""
PRESERVE_ON_FAIL=0

cleanup() {
  if [ -n "$RUNTIME_PID" ]; then
    # 真实 runtime 是 tsx wrapper 的子进程（node --require tsx/...）；wrapper 不保证
    # 转发信号（实测偶发 wrapper 直接 143 死亡 + runtime 孤儿化），清理两个都杀。
    # runtime 的孙进程（sandbox fork）按 CHILD 清单逐一核对。
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

mkdir -p "$DATA_DIR_C2/plugins/lc-hang" "$DATA_DIR_C4/plugins/lc-c4" "$BUILTIN_DIR/lc-crasher" "$BUILTIN_EMPTY_DIR"

# builtin trusted 崩溃插件（LC-C2）：built-in source → trusted → 共享 Worker 线程。
# activate 正常返回（激活完成、activated 回复送达——不阻塞 boot initialize 30s），
# 随后 2s 定时器 process.exit(1)——Worker 线程内 process.exit 只退出本线程
#（exit code 1 → 宿主 handleWorkerCrash → 5s rebuild 冷却 timer）。延迟 2s 是为了让
# lc-hang 先完成激活（关停时 deactivateAll 有真实挂起对象，拉长关停窗口跨过冷却到期点，
# 使「timer 未在关停入口清理 → 关停中复活插件 → 二次崩溃广播」的缺陷可观测）。
cat > "$BUILTIN_DIR/lc-crasher/package.json" <<'EOF'
{
  "name": "lc-crasher",
  "version": "1.0.0",
  "type": "module",
  "taijiPlugin": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"] }
}
EOF
cat > "$BUILTIN_DIR/lc-crasher/index.js" <<'EOF'
export async function activate() {
  console.log('[lc-crasher] activate called (crash scheduled in 2s)')
  setTimeout(() => {
    console.log('[lc-crasher] crashing worker thread now')
    process.exit(1)
  }, 2000)
}
export async function deactivate() {}
EOF

# sandbox 悬挂插件（LC-C2 关停窗口拉长）：activate 正常、deactivate 永不回复——
# deactivateAll（allSettled）等它 5s 超时，关停总时长跨过 rebuild 冷却到期点。
cat > "$DATA_DIR_C2/plugins/lc-hang/package.json" <<'EOF'
{
  "name": "lc-hang",
  "version": "1.0.0",
  "type": "module",
  "taijiPlugin": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"], "trustLevel": "sandbox" }
}
EOF
cat > "$DATA_DIR_C2/plugins/lc-hang/index.js" <<'EOF'
export async function activate() {
  console.log('[lc-hang] activate called')
}
export async function deactivate() {
  console.log('[lc-hang] deactivate called (hanging by design)')
  await new Promise(() => {})
}
EOF

# sandbox 会话数据插件（LC-C4）：onDeactivate 内 sessionData.set，重启后 activate
# 读回并打印（readback 断言目标）。
cat > "$DATA_DIR_C4/plugins/lc-c4/package.json" <<'EOF'
{
  "name": "lc-c4",
  "version": "1.0.0",
  "type": "module",
  "taijiPlugin": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"], "trustLevel": "sandbox", "permissions": ["plugin.sessionData.set", "plugin.sessionData.get"] }
}
EOF
cat > "$DATA_DIR_C4/plugins/lc-c4/index.js" <<'EOF'
let ctx
export async function activate(context) {
  ctx = context
  console.log('[lc-c4] activate called')
  try {
    const prev = await ctx.api.sessionData.get('lc-c4-session', 'lc-c4-key')
    console.log('[lc-c4] readback=' + JSON.stringify(prev))
  } catch (e) {
    console.log('[lc-c4] readback-error ' + (e && e.message))
  }
}
export async function deactivate() {
  await ctx.api.sessionData.set('lc-c4-session', 'lc-c4-key', 'written-at-deactivate')
  console.log('[lc-c4] deactivate wrote sessionData')
}
EOF

# 预批准权限（lc-c4 boot 自动激活不挂审批等待；lc-hang/lc-crasher 无权限声明）
cat > "$DATA_DIR_C4/plugins/permissions.json" <<'EOF'
{
  "lc-c4": ["plugin.sessionData.set", "plugin.sessionData.get"]
}
EOF

# ── 2. 通用工具：起隔离 runtime / WS 编排 ────────────────────────
pick_port() {
  for _ in $(seq 1 10); do
    local candidate=$(( (RANDOM % 3000) + 41000 ))
    if ! lsof -n -P -i :$candidate 2>/dev/null | grep -q LISTEN; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# 起 runtime：$1 = stdout 落盘路径，$2 = dataDir，$3 = builtinPluginsDir。
# 设置全局 RUNTIME_PID / PORT / WS_AUTH_TOKEN。
launch_runtime() {
  PORT="$(pick_port)" || fail "10 次随机端口均被占用（41000-43999）"
  WS_AUTH_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  RUNTIME_STDOUT="$1"
  TAIJI_RUNTIME_TOKEN="$WS_AUTH_TOKEN" TAIJI_AGENT_DATA_DIR="$2" \
    node "$TSX_CLI" "$REPO_ROOT/packages/runtime/src/index.ts" --port "$PORT" --builtin-plugins-dir "$3" \
    > "$RUNTIME_STDOUT" 2>&1 &
  RUNTIME_PID=$!
  local ready=false
  for _ in $(seq 1 40); do
    if curl -s --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
      ready=true
      break
    fi
    kill -0 "$RUNTIME_PID" 2>/dev/null || break
    sleep 0.5
  done
  [ "$ready" = true ] || fail "runtime 未在 20s 内就绪（port=${PORT}, pid=${RUNTIME_PID}, log=${RUNTIME_STDOUT}）"
  # 解析真实 runtime 进程（wrapper 唯一子进程；见 RUNTIME_CHILD 声明处注释）
  RUNTIME_CHILD="$(pgrep -P "$RUNTIME_PID" 2>/dev/null | head -1 || true)"
  [ -n "$RUNTIME_CHILD" ] || fail "未找到 runtime 子进程（wrapper=${RUNTIME_PID} 的 pgrep -P 为空——tsx 拓扑变化？）"
  echo -e "${GREEN}[OK] 隔离 runtime 就绪（port=${PORT}, wrapper=${RUNTIME_PID}, runtime=${RUNTIME_CHILD}, data=$2）${NC}"
}

# 等 runtime 退出（watch wrapper + 真实 runtime 两个 pid）：$1=上限描述秒数。echo 实际耗时（秒）。
wait_runtime_exit() {
  local limit="$1" t0=$SECONDS
  for _ in $(seq 1 $((limit * 2))); do
    kill -0 "$RUNTIME_PID" 2>/dev/null || break
    kill -0 "$RUNTIME_CHILD" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$RUNTIME_CHILD" 2>/dev/null || kill -0 "$RUNTIME_PID" 2>/dev/null; then
    return 1
  fi
  wait "$RUNTIME_PID" 2>/dev/null || true
  echo $((SECONDS - t0))
}

# WS 等待插件 active 的编排脚本（LC-C4 两轮复用；LC-C2 有专用编排）
cat > "$WORK_DIR/ws-wait-active.mjs" <<'EOF'
// 用法: node ws-wait-active.mjs <port> <token> <pluginId> <timeoutMs>
const [port, token, pluginId, timeoutMs = '30000'] = process.argv.slice(2)
const ws = new WebSocket(`ws://127.0.0.1:${port}`)
const pending = new Map()
let nextId = 1
const send = (type, payload) => new Promise((resolve, reject) => {
  const id = `w-${nextId++}`
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ type, id, payload }))
  setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC 超时: ${type}`)) }
  }, 10000)
})
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'auth.result') {
    if (msg.payload?.ok !== true) { console.error(`FAIL [WS auth 被拒] ${msg.payload?.reason ?? ''}`); process.exit(1) }
    void run()
    return
  }
  if (msg.id && pending.has(msg.id)) pending.get(msg.id).resolve(msg)
}
ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
ws.onerror = () => { console.error('FAIL [WS 连接失败]'); process.exit(1) }
const run = async () => {
  const deadline = Date.now() + Number(timeoutMs)
  while (Date.now() < deadline) {
    const m = await send('plugin.list', {})
    const p = m.payload?.plugins?.find((x) => x.pluginId === pluginId)
    if (p?.status === 'active') { console.log(`ACTIVE ${pluginId}`); ws.close(); process.exit(0) }
    await new Promise((r) => setTimeout(r, 300))
  }
  console.error(`FAIL [${pluginId} 未在 ${timeoutMs}ms 内激活]`)
  process.exit(1)
}
setTimeout(() => { console.error('FAIL [整体超时]'); process.exit(1) }, Number(timeoutMs) + 15000)
EOF

# LC-C2 专用 WS 编排：等 lc-hang active + lc-crasher 首次 crash 广播 → +1s 发 SIGTERM
# （冷却窗口内）→ 保持连接统计 plugin:crashed 广播次数直到连接关闭（关停完成）。
cat > "$WORK_DIR/ws-lcc2.mjs" <<'EOF'
// 用法: node ws-lcc2.mjs <port> <token> <runtimePid> <summaryJsonPath>
import { writeFileSync } from 'node:fs'
const [port, token, runtimePidArg, summaryPath] = process.argv.slice(2)
const runtimePid = Number(runtimePidArg)
const ws = new WebSocket(`ws://127.0.0.1:${port}`)
const pending = new Map()
let nextId = 1
let crashCount = 0
let hangActive = false
let shutdownSent = false
const writeSummary = () => {
  try { writeFileSync(summaryPath, JSON.stringify({ crashCount, hangActive })) } catch { /* best-effort */ }
}
const send = (type, payload) => new Promise((resolve, reject) => {
  const id = `c-${nextId++}`
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ type, id, payload }))
  setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC 超时: ${type}`)) }
  }, 10000)
})
const maybeShutdown = () => {
  if (shutdownSent || crashCount < 1 || !hangActive) return
  shutdownSent = true
  // 崩溃后 1s（冷却窗口 5s 内）发起优雅关停
  setTimeout(() => {
    console.log('SHUTDOWN_SENT')
    try { process.kill(runtimePid, 'SIGTERM') } catch (e) { console.error('kill failed: ' + e.message); process.exit(1) }
    // 观察窗口 8s：覆盖「冷却到期（crash+5s）复活插件 → 二次 crash 广播」的旧缺陷
    // 时序。窗口结束后客户端主动断开——runtime conn.stop 的 wss.close() 等待全部
    // 客户端断开，客户端等服务器先关会死锁（verify-plugin-e2e 同款客户端主动收尾）。
    setTimeout(() => {
      writeSummary()
      console.log(`OBSERVATION_DONE crashCount=${crashCount}`)
      try { ws.close(1000, 'observation done') } catch { /* best-effort */ }
      process.exit(0)
    }, 8000)
  }, 1000)
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'auth.result') {
    if (msg.payload?.ok !== true) { console.error(`FAIL [WS auth 被拒] ${msg.payload?.reason ?? ''}`); writeSummary(); process.exit(1) }
    void run()
    return
  }
  if (msg.type === 'plugin:crashed' && msg.payload?.pluginId === 'lc-crasher') {
    crashCount++
    maybeShutdown()
  }
  if (msg.id && pending.has(msg.id)) pending.get(msg.id).resolve(msg)
}
ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
ws.onerror = () => { console.error('FAIL [WS 连接失败]'); writeSummary(); process.exit(1) }
ws.onclose = () => { writeSummary(); console.log(`WS_CLOSED crashCount=${crashCount}`); process.exit(0) }
const run = async () => {
  try {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !hangActive) {
      const m = await send('plugin.list', {})
      const hang = m.payload?.plugins?.find((x) => x.pluginId === 'lc-hang')
      if (hang?.status === 'active') { hangActive = true; console.log('HANG_ACTIVE') }
      else await new Promise((r) => setTimeout(r, 300))
      maybeShutdown()
    }
    if (!hangActive) { console.error('FAIL [lc-hang 未激活]'); writeSummary(); process.exit(1) }
  } catch (e) {
    console.error('FAIL [编排异常] ' + (e.message ?? e))
    writeSummary()
    process.exit(1)
  }
}
setTimeout(() => { console.error('FAIL [整体超时 60s]'); writeSummary(); process.exit(1) }, 60000)
EOF

# 场景标记行输出（行首锚定，供 grep -E '^LC-(C2|C4) (PASS|FAIL)$' 机读）
LC_EXIT=0
lc_report() {
  # $1=验收id $2=判定(0=pass) $3=明细
  if [ "$2" -eq 0 ]; then
    echo -e "${GREEN}[OK] $1 $3${NC}"
    echo "$1 PASS"
  else
    echo -e "${RED}[FAIL] $1 $3${NC}"
    echo "$1 FAIL"
    LC_EXIT=1
  fi
}

# ══ LC-C2：崩溃后退出（rebuild 约束）════════════════════════════
echo -e "${BLUE}── LC-C2 崩溃后退出：crash → 冷却窗口内 SIGTERM → 无复活/无残留/无假崩溃 ──${NC}"
LOG_C2="$WORK_DIR/runtime-c2.log"
launch_runtime "$LOG_C2" "$DATA_DIR_C2" "$BUILTIN_DIR"

node "$WORK_DIR/ws-lcc2.mjs" "$PORT" "$WS_AUTH_TOKEN" "$RUNTIME_CHILD" "$WORK_DIR/lcc2-summary.json" > "$WORK_DIR/ws-lcc2.log" 2>&1 &
WS_C2_PID=$!

# 等 SIGTERM 发出（crash + 1s）
for _ in $(seq 1 120); do
  grep -q 'SHUTDOWN_SENT' "$WORK_DIR/ws-lcc2.log" 2>/dev/null && break
  kill -0 "$WS_C2_PID" 2>/dev/null || break
  sleep 0.5
done
grep -q 'SHUTDOWN_SENT' "$WORK_DIR/ws-lcc2.log" 2>/dev/null \
  || fail "LC-C2 编排未发出 SIGTERM（见 $WORK_DIR/ws-lcc2.log 与 ${LOG_C2}）"

# 关停刚发起：记录 runtime 的子进程清单（sandbox fork 子进程），退出后逐一核对
CHILDREN_C2="$(pgrep -P "$RUNTIME_CHILD" 2>/dev/null || true)"
echo -e "${BLUE}[i] SIGTERM 已发；关停前子进程: ${CHILDREN_C2:-<无>}${NC}"

ELAPSED_C2="$(wait_runtime_exit 20)" \
  || fail "LC-C2: runtime SIGTERM 后 20s 未退出（疑似 rebuild timer / worker 挂起）"
echo -e "${GREEN}[OK] LC-C2 进程按时退出（耗时 ${ELAPSED_C2}s < 15s，无 30s 挂起）${NC}"

# 等 WS 编排随连接关闭退出（拿到最终 crashCount）
for _ in $(seq 1 20); do
  kill -0 "$WS_C2_PID" 2>/dev/null || break
  sleep 0.5
done
kill -0 "$WS_C2_PID" 2>/dev/null && kill "$WS_C2_PID" 2>/dev/null || true
wait "$WS_C2_PID" 2>/dev/null || true

# 判定汇总
lcc2=0
[ "$ELAPSED_C2" -lt 15 ] || { lcc2=1; echo -e "${RED}[FAIL] 退出耗时 ${ELAPSED_C2}s ≥ 15s${NC}" >&2; }

ZOMBIE_C2=0
for c in $CHILDREN_C2; do
  if kill -0 "$c" 2>/dev/null; then
    ZOMBIE_C2=1
    echo -e "${RED}[FAIL] 僵儿子进程残留: ${c}${NC}" >&2
  fi
done
[ "$ZOMBIE_C2" -eq 0 ] && echo -e "${GREEN}[OK] LC-C2 无僵尸子进程（关停前清单 ${CHILDREN_C2:-<无>} 全部退出）${NC}" || lcc2=1

# crash 真实发生过（exit code 1 的 Worker 崩溃日志）
if grep -q 'exited with code 1' "$LOG_C2"; then
  echo -e "${GREEN}[OK] LC-C2 崩溃真实触发（Worker exited with code 1）${NC}"
else
  lcc2=1
  echo -e "${RED}[FAIL] 未见 Worker 崩溃日志（fixture 未生效？）${NC}" >&2
fi

# crash 回调未被误触发：plugin:crashed 广播恰 1 次（关停 terminate 不重复报崩溃）
CRASH_BROADCASTS="$(node -e "
const s = require('fs').readFileSync('$WORK_DIR/lcc2-summary.json', 'utf8')
const j = JSON.parse(s)
console.log(Number.isFinite(j.crashCount) ? j.crashCount : -1)
" 2>/dev/null || echo -1)"
if [ "$CRASH_BROADCASTS" = "1" ]; then
  echo -e "${GREEN}[OK] LC-C2 crash 回调恰 1 次（关停未误触发假崩溃 toast 路径）${NC}"
else
  lcc2=1
  echo -e "${RED}[FAIL] plugin:crashed 广播次数 = ${CRASH_BROADCASTS}（期望 1）${NC}" >&2
fi

# 无 onRebuilt 复活
if grep -q 'rebuilt trusted worker' "$LOG_C2" || grep -q 'skip rebuild' "$LOG_C2"; then
  lcc2=1
  echo -e "${RED}[FAIL] 关停后出现 rebuild/复活日志：$(grep -E 'rebuilt trusted worker|skip rebuild' "$LOG_C2" | head -3)${NC}" >&2
else
  echo -e "${GREEN}[OK] LC-C2 无 onRebuilt 复活（无 rebuilt/skip rebuild 日志）${NC}"
fi

lc_report LC-C2 $lcc2 '崩溃后退出：进程按时退出、无僵尸、crash 广播恰 1 次、无复活'

RUNTIME_PID=""

# ══ LC-C4：关停零丢失（关停顺序反转）════════════════════════════
echo -e "${BLUE}── LC-C4 关停零丢失：onDeactivate 写 sessionData → SIGTERM → 重启读回 ──${NC}"
LOG_C4_1="$WORK_DIR/runtime-c4-run1.log"
LOG_C4_2="$WORK_DIR/runtime-c4-run2.log"

launch_runtime "$LOG_C4_1" "$DATA_DIR_C4" "$BUILTIN_EMPTY_DIR"
node "$WORK_DIR/ws-wait-active.mjs" "$PORT" "$WS_AUTH_TOKEN" lc-c4 30000 > "$WORK_DIR/ws-c4-1.log" 2>&1 \
  || fail "LC-C4 run1: lc-c4 未激活（见 $WORK_DIR/ws-c4-1.log 与 ${LOG_C4_1}）"
echo -e "${GREEN}[OK] LC-C4 run1 lc-c4 已激活${NC}"

# 优雅关停（SIGTERM → shutdown 链：deactivateAll → sessionData flush+dispose → ...）
kill -TERM "$RUNTIME_CHILD"
ELAPSED_C4="$(wait_runtime_exit 20)" \
  || fail "LC-C4 run1: runtime SIGTERM 后 20s 未退出"
echo -e "${GREEN}[OK] LC-C4 run1 优雅退出（耗时 ${ELAPSED_C4}s）${NC}"
RUNTIME_PID=""

sleep 1  # stdout 落盘窗口

# run1 断言：onDeactivate 写入 + sessionData dispose 日志可证
c4=0
if grep -q '\[lc-c4\] deactivate wrote sessionData' "$LOG_C4_1"; then
  echo -e "${GREEN}[OK] LC-C4 onDeactivate 内 sessionData.set 真实执行${NC}"
else
  c4=1
  echo -e "${RED}[FAIL] run1 未见 deactivate 写入日志${NC}" >&2
fi
if grep -q 'shutdown: sessionData flushed and disposed' "$LOG_C4_1"; then
  echo -e "${GREEN}[OK] LC-C4 sessionData dispose 被调用（日志可证）${NC}"
else
  c4=1
  echo -e "${RED}[FAIL] run1 未见 sessionData disposed 日志${NC}" >&2
fi

# 同 dataDir 重启：activate 读回 deactivate 写入的值
launch_runtime "$LOG_C4_2" "$DATA_DIR_C4" "$BUILTIN_EMPTY_DIR"
node "$WORK_DIR/ws-wait-active.mjs" "$PORT" "$WS_AUTH_TOKEN" lc-c4 30000 > "$WORK_DIR/ws-c4-2.log" 2>&1 \
  || fail "LC-C4 run2: lc-c4 未激活（见 $WORK_DIR/ws-c4-2.log 与 ${LOG_C4_2}）"
echo -e "${GREEN}[OK] LC-C4 run2 lc-c4 已激活（同 dataDir 重启）${NC}"

sleep 1  # 读回日志落盘窗口
if grep -q '\[lc-c4\] readback="written-at-deactivate"' "$LOG_C4_2"; then
  echo -e "${GREEN}[OK] LC-C4 重启读回数据一致（readback="written-at-deactivate"）${NC}"
else
  c4=1
  echo -e "${RED}[FAIL] run2 读回不一致：$(grep '\[lc-c4\] readback' "$LOG_C4_2" | head -2)${NC}" >&2
fi

# 收尾：run2 优雅退出（复用同一清理协议）
kill -TERM "$RUNTIME_CHILD"
ELAPSED_C4_2="$(wait_runtime_exit 20)" \
  || fail "LC-C4 run2: runtime SIGTERM 后 20s 未退出"
RUNTIME_PID=""
echo -e "${GREEN}[OK] LC-C4 run2 优雅退出（耗时 ${ELAPSED_C4_2}s）${NC}"

lc_report LC-C4 $c4 '关停零丢失：onDeactivate 写入经 flush 落盘、重启读回一致、dispose 有日志'

# ── 收尾 ────────────────────────────────────────────────────────
if [ "$LC_EXIT" -ne 0 ]; then
  fail "存在 FAIL 场景（见上方 LC-XX FAIL 行）"
fi
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}[OK] Lifecycle E2E 验收全部通过（LC-C2 + LC-C4）${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
