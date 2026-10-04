#!/usr/bin/env bash
# oe-assert.sh — code-overdesign-audit pre-commit assertions (template v1, TS/JS)
# 卸载：删除 hook 中带 `# oe-audit-assert` marker 的调用行 + 删除本文件。
# 可移植性：仅用 POSIX/BSD/GNU/ugrep 四实现的公共 ERE 子集——禁 \b \s（BSD 不支持）、
# 禁转义加号 \+（ugrep 解析为量词），行首 + 用括号类 [+]、字面花括号用 [{]，空白用 [[:space:]]。
#
# ── 本仓适配（taiji 部署副本特化；特化内容随部署副本走，不回写 skill 模板本体）──
#
# single-impl 误拦面豁免指引：本仓架构偏好「类型契约先行——ports 接口先立、单实现常态」。
# ports / SDK 协议契约层的 interface 定义属合法单实现形态，新增时在其声明行行尾加豁免
# 标记（标记必须与声明同行，本脚本只解析声明行；可被 `grep -rn "oe-exempt:"` 汇总）：
#   export interface FooPort { ... } // oe-exempt:<yyyymmdd>:framework:<理由>
# 豁免类目：wip（30 天）/ test（90 天）/ framework（无期限）；日期过期 = 视为无豁免重新
# 拦截（expired-exempt），恢复动作：复核移除标记，或确属长期豁免改类目补理由。
#
# 与 skill 模板本体的逻辑分叉（登记见设计文档 review-pipeline-redesign §3.3 决策 5）：
# ① 断言 2（single-impl）本副本消费声明行豁免标记——single-impl 是本仓预告的误拦主力
#   （接口先立、单实现常态），豁免通道必须可用；模板本体断言 2 无豁免解析。
# ② count_refs 先剥 git grep 输出的路径前缀再排注释行——git grep 输出行首是文件路径，
#   模板本体的注释排除正则永不命中、注释行提及被误计入引用；ci-assertions.md 断言 1
#   口径明文「排除注释行」，本副本使其真实生效，模板本体同缺陷由 skill 侧处置。
# ③ count_refs 对定义文件只排除 export 声明行，不再整文件排除——原口径把「CLI 检查脚本
#   导出纯函数 + 同文件主流程自调」的本仓惯例形态（check-chat-ops-sync.mjs /
#   check-cross-process-literals.mjs 同款：导出供 import 消费，主流程自己也要用）误判
#   no-reference（同文件调用点被整文件排除一并清零）。[HISTORICAL] 2026-10-01 实拦
#   cross-process-literals 新脚本 extractStringLiterals。真死导出（定义文件内亦无调用）
#   仍零引用照拦，漏拦面不因此放大。
#
# 权威模板与断言口径：code-overdesign-audit skill 的 references/ci-assertions.md（模板 v1）。
set -u

# merge 中间态跳过：断言扫描「staged 新增」，而 merge 带入的是对方分支已过其 review
# 流程的既成代码——本检查的行尾豁免通道（oe-exempt 标记）在 merge 场景会向对方分支
# 的既有行写入标记，制造后续同步的永久冲突。merge 产物的复杂度审查由 dev-merge 的
# branch-review 横切维度承担（不在此重复拦截）。
[ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] && { echo "[oe-audit] skipped: merge in progress (对方分支既成代码，复杂度横切审查由 dev-merge branch-review 承担)"; exit 0; }

# --- skip 纪律：工具级故障打印 skipped，不阻塞提交（失败要出声）
command -v git  >/dev/null 2>&1 || { echo "[oe-audit] skipped: git unavailable";  exit 0; }
command -v grep >/dev/null 2>&1 || { echo "[oe-audit] skipped: grep unavailable"; exit 0; }

SRC_FILES=$(git diff --cached --name-only --diff-filter=A -- '*.ts' '*.tsx' '*.js' '*.mjs')
[ -z "$SRC_FILES" ] && exit 0

VIOLATIONS=""
TODAY=$(date +%Y%m%d)

# 豁免解析：$1=标记行整行。输出 ok | expired | none
check_exempt() {
  local tag; tag=$(printf '%s' "$1" | grep -oE 'oe-exempt:[0-9]{8}:(wip|test|framework)' | head -1)
  [ -z "$tag" ] && { echo none; return; }
  local d=${tag#oe-exempt:}; d=${d%%:*}
  local cat=${tag##*:}
  local days
  # 兼容 BSD/GNU date：两层解析均失败（非法日期串如 99999999）时回退 epoch 0 → 巨大天数
  # → 判 expired。fail-safe：手滑写错的豁免日期被拒绝豁免，而非意外获得永久放行
  # （合法日期含未来日期两层解析正常，实测 20260926/20990101 均 ok）
  days=$(( ( $(date +%s) - $(date -j -f "%Y%m%d" "$d" +%s 2>/dev/null || date -d "${d:0:4}-${d:4:2}-${d:6:2}" +%s 2>/dev/null || echo 0) ) / 86400 ))
  { [ "$cat" = "wip"  ] && [ "$days" -gt 30 ]; } && { echo expired; return; }
  { [ "$cat" = "test" ] && [ "$days" -gt 90 ]; } && { echo expired; return; }
  echo ok   # framework 无期限
}

# 引用计数：$1=符号 $2=定义文件。git grep 限 tracked；排除注释行/re-export 行/定义文件
# 的 export 声明行（分叉③：声明行非调用，同文件主流程调用点计入引用）。
# 部署副本特化（分叉②见头部注释区）：先剥 git grep 输出的路径前缀再排注释行——注释排除
# 正则锚定行首，对「path:content」原始输出永不命中；export 声明行排除必须先于剥前缀（按
# 「定义路径:行首 export」锚定，剥前缀后无法区分文件归属）。
count_refs() {
  git grep -I -w -F "$1" -- ':!*.md' ':!*.mdx' 2>/dev/null \
    | grep -vE "^$2:[[:space:]]*export([[:space:]{]|$)" \
    | sed -E 's/^[^:]*://' \
    | grep -vE '^[[:space:]]*(//|/\*|\*|#)' \
    | grep -vE 'export[^(]*from' \
    | wc -l | tr -d ' '
}

# ---------- 断言 1：新增具名非别名导出零引用（按新增文件迭代，定义文件即该文件本身） ----------
for f in $SRC_FILES; do
  ADDED=$(git diff --cached --diff-filter=A -U0 -- "$f" | grep -E '^[+]' | grep -vE '^[+][+][+]')
  # 具名声明导出：export const|let|var|function|class|async function <name>
  SYMS=$(printf '%s\n' "$ADDED" \
    | grep -oE 'export (async function|function|const|let|var|class) [A-Za-z_$][A-Za-z0-9_$]*' \
    | awk '{print $NF}' | sort -u)
  # 具名花括号导出，跳过别名（export { x as y } 拦截面外）
  SYMS="$SYMS
$(printf '%s\n' "$ADDED" | grep -oE 'export [{][^}]*[}]' \
    | sed -E 's/export[[:space:]]*[{]//; s/[}]//' | tr ',' '\n' \
    | grep -v ' as ' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/:.*//' \
    | grep -E '^[A-Za-z_$][A-Za-z0-9_$]*$' | sort -u)"
  SYMS=$(printf '%s\n' "$SYMS" | sed '/^$/d' | sort -u)
  [ -z "$SYMS" ] && continue

  for sym in $SYMS; do
    exempt_line=$(printf '%s\n' "$ADDED" | grep -E "export .*$sym" | grep -E 'oe-exempt:[0-9]{8}:' | head -1)
    if [ -n "$exempt_line" ]; then
      st=$(check_exempt "$exempt_line")
      [ "$st" = "ok" ] && continue
      if [ "$st" = "expired" ]; then
        VIOLATIONS="$VIOLATIONS
$f | $sym | expired-exempt | 豁免已过期（wip>30d/test>90d）——复核移除标记，或改类目补理由"
        continue
      fi
    fi
    refs=$(count_refs "$sym" "$f")
    if [ "$refs" -eq 0 ]; then
      VIOLATIONS="$VIOLATIONS
$f | $sym | no-reference | 全仓零引用——删除该导出，或分步提交加豁免 // oe-exempt:$TODAY:wip:<理由>"
    fi
  done
done

# ---------- 断言 2：新增单实现接口（-w 整词，不用 \b） ----------
ALL_ADDED=$(git diff --cached --diff-filter=A -U0 -- '*.ts' '*.tsx' '*.js' '*.mjs' | grep -E '^[+]' | grep -vE '^[+][+][+]')
IFACES=$(printf '%s\n' "$ALL_ADDED" | grep -oE 'interface [A-Za-z_$][A-Za-z0-9_$]*' | awk '{print $2}' | sort -u)
for ifc in $IFACES; do
  # 部署副本特化（分叉①见头部注释区）：single-impl 是本仓预告误拦主力（ports 接口先立、
  # 单实现常态），消费声明行行尾豁免标记——提取形态与断言 1 同款（同行）
  exempt_line=$(printf '%s\n' "$ALL_ADDED" | grep -E "interface .*$ifc" | grep -E 'oe-exempt:[0-9]{8}:' | head -1)
  if [ -n "$exempt_line" ]; then
    st=$(check_exempt "$exempt_line")
    [ "$st" = "ok" ] && continue
    if [ "$st" = "expired" ]; then
      VIOLATIONS="$VIOLATIONS
? | $ifc | expired-exempt | 豁免已过期（wip>30d/test>90d）——复核移除标记，或确属长期豁免改类目补理由"
      continue
    fi
  fi
  impls=$(git grep -I -w -E "(implements|extends) $ifc" 2>/dev/null | wc -l | tr -d ' ')
  [ "$impls" -le 1 ] && VIOLATIONS="$VIOLATIONS
? | $ifc | single-impl | 接口仅 1 实现——内联或等待第 2 个真实变体（Rule of Three）；ports/SDK 契约接口按 .githooks/oe-assert.sh 头部指引在声明行行尾加豁免标记"
done

# ---------- 断言 3：新增纯转发方法 ----------
PT=$(printf '%s\n' "$ALL_ADDED" \
  | grep -nE '[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\)[^{]*[{] *return [A-Za-z_$][A-Za-z0-9_.$]*\.[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\); *[}]' \
  | head -5)
[ -n "$PT" ] && VIOLATIONS="$VIOLATIONS
(暂存新增行) | pass-through | pass-through | 纯转发方法——直接暴露目标或下沉语义（Remove Middle Man）"

# ---------- 汇总输出 ----------
if [ -n "$VIOLATIONS" ]; then
  echo "[oe-audit] intercepted:" >&2
  printf '%s\n' "$VIOLATIONS" | sed '/^$/d' | while IFS='|' read -r loc sym reason fix; do
    [ -z "$loc$sym$reason" ] && continue
    echo "  $loc | $sym | [$reason] $fix" >&2
  done
  echo "  依据与口径：code-overdesign-audit skill references/ci-assertions.md（四类已知漏拦由 audit 细网兜底）" >&2
  exit 1
fi
exit 0
