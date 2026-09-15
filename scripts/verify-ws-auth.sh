#!/usr/bin/env bash
# verify-ws-auth.sh — SEC-B1（S1-W1，spec §3.3 D4）：WS auth 握手 + 回环绑定真实进程验收。
#
# 与 packages/runtime/test/ws-listen-hardening.test.ts（进程内 SEC-U2）互补：
# 本脚本起真实 runtime 进程（tsx 源码直跑 + 隔离数据目录 + TAIJI_RUNTIME_TOKEN 注入），
# 覆盖三条通路：
#
#   1. 无 token 客户端被拒——连接后直接发业务命令（plugin.toggle），pre-auth 消息被
#      静默丢弃（无任何响应）
#   2. 伪造 token 被拒——auth 握手返回 ok=false + close 1008
#   3. token 文件客户端（模拟 taiji-settings CLI）——读 <dataDir>/runtime-token 文件
#      auth 成功并收发一条 config 命令
#
# 用法: bash scripts/verify-ws-auth.sh
# 依赖: node >= 22（全局 WebSocket）、curl、lsof
# 耗时: ~10s

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

fail() {
  echo -e "${RED}SEC-B1 FAIL $1${NC}" >&2
  if [ -f "${RUNTIME_STDOUT:-}" ]; then
    echo -e "${YELLOW}── runtime stdout 尾部 ──${NC}" >&2
    tail -20 "$RUNTIME_STDOUT" >&2
  fi
  echo -e "${YELLOW}[定位] runtime stdout: ${RUNTIME_STDOUT:-<未创建>}（失败保留现场）${NC}" >&2
  PRESERVE_ON_FAIL=1
  exit 1
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 0. 环境前置（install 幂等，可重复跑）─────────────────────────
cd "$REPO_ROOT"
pnpm install --prefer-offline --silent

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo -e "${RED}[ERROR] 需要 node >= 22（全局 WebSocket 客户端），当前 $(node --version)${NC}" >&2
  echo -e "${YELLOW}[FIX] 升级 node（nvm install 22）后重试${NC}" >&2
  exit 1
fi

# tsx 解析对齐 process-control.ts：从 apps/electron（tsx 声明方）按 Node 解析算法定位
TSX_PKG="$(node -e "console.log(require.resolve('tsx/package.json', { paths: ['$REPO_ROOT/apps/electron'] }))")" \
  || fail "tsx 不可解析——先 pnpm install（解析基准: $REPO_ROOT/apps/electron）"
TSX_CLI="$(dirname "$TSX_PKG")/dist/cli.mjs"
[ -f "$TSX_CLI" ] || fail "tsx cli 不存在: ${TSX_CLI}（先 pnpm install）"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[WS Auth 验收] SEC-B1（S1-W1 传输安全，真实 runtime 进程）${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ── 1. 隔离环境 + 起 runtime ─────────────────────────────────────
WORK_DIR="$(mktemp -d /tmp/taiji-ws-auth.XXXXXX)"
DATA_DIR="$WORK_DIR/data"
RUNTIME_STDOUT="$WORK_DIR/runtime-stdout.log"
RUNTIME_PID=""
PRESERVE_ON_FAIL=0

cleanup() {
  if [ -n "$RUNTIME_PID" ]; then
    kill "$RUNTIME_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$RUNTIME_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$RUNTIME_PID" 2>/dev/null || true
  fi
  if [ "$PRESERVE_ON_FAIL" = "1" ]; then
    echo -e "${YELLOW}[WARN] 失败现场保留: ${WORK_DIR}（排查后手动删除）${NC}" >&2
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$DATA_DIR"

# token（模拟 Electron 主进程 spawn：env 通道 + 0600 文件通道双分发）
TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
printf '%s' "$TOKEN" > "$DATA_DIR/runtime-token"
chmod 600 "$DATA_DIR/runtime-token"

PORT=""
for _ in $(seq 1 10); do
  CANDIDATE=$(( (RANDOM % 3000) + 41000 ))
  if ! lsof -n -P -i :$CANDIDATE 2>/dev/null | grep -q LISTEN; then
    PORT=$CANDIDATE
    break
  fi
done
[ -n "$PORT" ] || fail "10 次随机端口均被占用（41000-43999）"

TAIJI_RUNTIME_TOKEN="$TOKEN" TAIJI_AGENT_DATA_DIR="$DATA_DIR" \
  node "$TSX_CLI" "$REPO_ROOT/packages/runtime/src/index.ts" --port "$PORT" \
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
[ "$READY" = true ] || fail "runtime 未在 20s 内就绪（port=${PORT}, pid=${RUNTIME_PID}）"
echo -e "${GREEN}[OK] 隔离 runtime 就绪（port=${PORT}, data=${DATA_DIR}）${NC}"

# ── 2. 三场景验证（node 全局 WebSocket 编排）────────────────────
cat > "$WORK_DIR/scenarios.mjs" <<'EOF'
// SEC-B1 三场景：无 token 拒服务 / 伪造 token 1008 / token 文件客户端（模拟 CLI）收发
const port = process.argv[2]
const tokenFile = process.argv[3]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const result = (name, ok, detail) => {
  console.log(`SEC-B1 ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

// ── 场景 1：无 token 客户端——pre-auth 业务消息被静默丢弃（无任何响应）──
{
  const received = []
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.close(); resolve() }, 1500)
    ws.onmessage = (ev) => received.push(JSON.parse(ev.data))
    ws.onopen = () => {
      // 不发 auth，直接发敏感业务命令（攻击面代表：spec B1 场景）
      ws.send(JSON.stringify({ type: 'plugin.toggle', id: 'sec-b1-1', payload: { pluginId: 'x', enabled: false } }))
    }
    ws.onerror = (e) => { clearTimeout(timer); reject(e) }
    ws.onclose = () => { clearTimeout(timer); resolve() }
  }).catch((e) => result('无 token 客户端被拒', false, `连接错误: ${e.message ?? e}`))
  if (received.length === 0) {
    result('无 token 客户端被拒（pre-auth plugin.toggle 无任何响应）', true)
  } else {
    result('无 token 客户端被拒', false, `pre-auth 消息收到了响应: ${JSON.stringify(received[0]).slice(0, 120)}`)
  }
}

// ── 场景 2：伪造 token——auth.result ok=false + close 1008 ──
{
  const outcome = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'auth.result') ws.close(1000, 'done')
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token: 'forged-' + 'a'.repeat(64) } }))
    }
    ws.onerror = (e) => reject(e)
    ws.onclose = (ev) => resolve({ code: ev.code })
    setTimeout(() => { try { ws.close() } catch { /* already closed */ } resolve({ code: -1 }) }, 3000)
  }).catch((e) => ({ code: -2, err: e.message ?? String(e) }))
  // close code 需为 1008（policy violation）。注：客户端主动 close(1000) 收尾的 ok=false
  // 路径不出现——服务端拒绝时会先回执再 close 1008，客户端 onclose 捕获服务端码。
  if (outcome.code === 1008) {
    result('伪造 token 被拒（close 1008）', true)
  } else if (outcome.code === -2 || outcome.code === -1) {
    result('伪造 token 被拒（close 1008）', false, `未观察到 1008 关闭（code=${outcome.code}, err=${outcome.err ?? 'n/a'}）`)
  } else {
    result('伪造 token 被拒（close 1008）', false, `close code=${outcome.code}，期望 1008`)
  }
}

// ── 场景 3：token 文件客户端（模拟 taiji-settings CLI）——auth + config 命令收发 ──
{
  const { readFileSync } = await import('node:fs')
  let fileToken = ''
  try {
    fileToken = readFileSync(tokenFile, 'utf-8').trim()
  } catch (e) {
    result('token 文件客户端（模拟 CLI）成功收发一条命令', false, `token 文件读取失败: ${e.message}`)
  }
  if (fileToken) {
    const reply = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      let authed = false
      const timer = setTimeout(() => { try { ws.close() } catch { /* noop */ } reject(new Error('场景 3 超时（auth 或 config.getProviders reply 未到）')) }, 5000)
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (!authed) {
          if (msg.type === 'auth.result' && msg.payload?.ok === true) {
            authed = true
            ws.send(JSON.stringify({ type: 'config.getProviders', id: 'sec-b1-3', payload: {} }))
          } else if (msg.type === 'auth.result') {
            clearTimeout(timer); ws.close()
            reject(new Error(`token 文件 auth 失败: ${msg.payload?.reason}`))
          }
          return
        }
        if (msg.id === 'sec-b1-3') {
          clearTimeout(timer); ws.close(); resolve(msg)
        }
      }
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WS error: ' + (e.message ?? e))) }
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', payload: { token: fileToken } }))
      }
    }).catch((e) => ({ __error: e.message }))
    if (reply && !reply.__error) {
      result('token 文件客户端（模拟 CLI）成功收发一条命令（config.getProviders reply 到达）', true)
    } else {
      result('token 文件客户端（模拟 CLI）成功收发一条命令', false, reply?.__error ?? '未知错误')
    }
  }
}

await sleep(100)
EOF

# ── 3. 运行三场景 + 汇总判定（任何场景 FAIL → exit 1）─────────────
set +e
node "$WORK_DIR/scenarios.mjs" "$PORT" "$DATA_DIR/runtime-token" 2>&1 | tee "$WORK_DIR/results.txt"
set -e

if grep -q '^SEC-B1 FAIL' "$WORK_DIR/results.txt"; then
  fail "存在失败场景（见上方 FAIL 行）"
fi
if ! grep -q '^SEC-B1 PASS' "$WORK_DIR/results.txt"; then
  fail "未产生任何 PASS 结果行（编排脚本异常）"
fi
echo -e "${GREEN}[OK] 全部场景通过${NC}"
exit 0
