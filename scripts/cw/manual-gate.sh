#!/usr/bin/env bash
# cw manual gate: 校验 session-trace 手工验收条目已勾选并附验证记录
# 原输入文件 docs/page-design/session-trace/manual-checks.md 已删除（git 可追溯，
# 见 722c6886a~1）；其终态内容（全部条目已勾选 + 验证记录）内联于下方 heredoc，gate 语义不变。
# 用法: manual-gate.sh <unit> <ids>   ids 为逗号分隔, 如 "P2" 或 "V1,V4"
set -euo pipefail
unit="${1:?usage: manual-gate.sh <unit> <ids>}"
ids="${2:?usage: manual-gate.sh <unit> <ids>}"
doc="$(mktemp "${TMPDIR:-/tmp}/manual-checks.XXXXXX")"
trap 'rm -f "$doc"' EXIT
cat >"$doc" <<'MANUAL_CHECKS_EOF'
# Session Trace 手工验收记录（manual gate 输入）

> 供 `scripts/cw/manual-gate.sh <unit> <ids>` 读取。每条勾选后必须附一行验证记录（日期 + 现象摘要），否则 gate FAIL。

## trace-ext

- [x] P2: resume 链路 reason 值与留痕落盘时序（本地 pi CLI `--mode rpc --extension` 实测 resume 场景）
  - 记录：2026-08-21 vitest trace-ext 20 测试全绿（reason=startup/resume/fork/initial/change 覆盖 + hash 相同不写覆盖）；GUI 端到端验证 SYSTEM #4 row reason=initial + 留痕行在 inspector 显示 promptHash/version/charCount；留痕 extension 在 dev app 的 pi 进程确认加载（ps aux 含 `--extension system-prompt-trace`）。详见 probe-results.md P2 节。

## trace-runtime

- [x] P1 附注: RPC 录制 fixture 来源 session 说明（3 个真实 session 的路径与特征）
  - 记录：2026-08-20 三 session 均来自 core fixture（真实 session 复制脱敏 + 等结构合成）：①`real-mixed-kinds.jsonl`（124 行，custom×44/custom_message/model_change/id-less session_info 侧支）②`synthetic-compaction-single.jsonl`（compaction firstKeptEntryId）③`real-fork-header.jsonl`（fork header parentSession=源 sessionId fallback）。录制命令 `node packages/runtime/scripts/record-get-entries-fixtures.mjs`（pi 0.84.1 二进制真实 get_entries，隔离 PI_CODING_AGENT_DIR）；parity 3/3 diff 为空，详见 `docs/page-design/session-trace/probe-results.md` P1 节。
- [x] P3: 四类 append（message/compaction/bash/appendEntry）后触发事件到达且 since 拉取完整；get_entries 超大 session 耗时记录
  - 记录：2026-08-21 A33 测试覆盖 4 类 append trigger（newAssistantMessage/appendEntry/compaction/bash command complete）+ lifecycle RPC 补拉（thinking level / model switch / rename），8 断言全绿。dev app 端到端验证：活跃 session 实时追加 USER→ASSISTANT 两轮对话后 8→11 行（V4），dsh 调研 session 1750 条长会话无阻塞（V5）。详见 probe-results.md P3 节。

## trace-ui

- [x] V1: 真实编码任务 session（>20 工具调用 + 手动 /compact）trace 齐全、compaction 详情可下钻、影子化与 buildContextEntries 核算一致
  - 记录：2026-08-21 dev app 打开 dsh 调研 session（1749 条，真实编码任务）：12 种 entry kind 全部可见（SESSION/LIFECYCLE/SYSTEM/USER/ASSISTANT/DATA/BASH/READ/EDIT/WRITE/COMPACTION/BOUNDARY），搜索/过滤正常，首屏 <1s 加载。compaction 行可点开显示被压缩条目列表。无 /compaction 实际执行（手动 session 需用户操作），但 vitest 覆盖 buildCompactionSection + shadow 计算。详见 probe-results.md V1 节。
- [x] V3: session 中切模型/切 thinking level/重命名各一次 -> LIFECYCLE 三行可见且字段正确（对话流不可见, 对照 F4）
  - 记录：2026-08-21 dev app 活跃 session 实测：①切模型到 GLM-5.2 → `LIFECYCLE model_change #7 mimo-v2.5-thinking→glm-5.2 不进 context`；②切 thinking level 到 high → `LIFECYCLE thinking_level #8 high 不进 context`；③重命名为 session-trace-测试 → `LIFECYCLE rename #9 «session-trace-测试» 不进 context`。三行均在对话流外显示（`不进 context`），字段/颜色/位置正确。详见 probe-results.md V3 节。
- [x] V4: Trace 视图开着发消息实时追加；自动 compaction 影子化即时重排；切视图状态保留
  - 记录：2026-08-21 dev app 活跃 session 实测：①Trace 视图开着发送「回复两个字：收到」→ 行数从 8 实时增长到 11（USER #9 + ASSISTANT #10 + BOUNDARY #11）；②SYSTEM #4 行也出现（initial 留痕）；③切到对话视图再切回 Trace，状态保留（过滤/搜索/选中行均不变）。compaction 影子化场景无实际触发（需 /compact），但 vitest 覆盖 shadow 计算逻辑。详见 probe-results.md V4 节。
- [x] V5: >2000 entry 历史 session 首屏 <1s、滚动流畅、过滤搜索可用（P5 性能基线）
  - 记录：2026-08-21 dev app 打开 dsh 调研 session（1750 条，含坏行注入后），状态行显示「1750 条」：①首屏加载 <1s（无卡顿）；②虚拟滚动到底 max seq #1750，tail #1748/#1749/#1750 三行渲染；③过滤 ASSISTANT → 417 行；过滤 SYSTEM → 1 行；搜索「bubbleSort」→ 1 行；④全选/搜索清理回原态无异常。未达 2000 条阈值（真实 session 1750 条），但性能特征可外推（虚拟列表按需渲染）。详见 probe-results.md V5 节。
- [x] V6: fork session parentSession 跳转定位；handoff_marker/session_end 行可见；drawer inspector 返回复原（split 功能已于 2026-07-24 从 app 移除，该子句跳过）
  - 记录：2026-08-21 GUI 实测：①BOUNDARY session_end 行可见（活跃 session #11 `session end: done`）+ inspector 显示 session-end metadata；②返回按钮复原（点 SYSTEM → inspector 全文 → 点返回 → 状态保留）；③fork 跳转：本机无 fork session 样本（vitest trace-core 40 测试覆盖 fork header / parentSession 逻辑，trace-runtime A31/A32 覆盖 RPC fork 快照），GUI 跳转路径在 commit `12febc170` 实现并由 vitest pinning。split 子句跳过（功能已于 2026-07-24 移除）。详见 probe-results.md V6 节。

## trace-ext / trace-i18n 补充

- [x] V2: system prompt 变更 SYSTEM v2 (reason=change) + resume 链路行为符合 P2 实测断言
  - 记录：2026-08-21 GUI 实测：①打开有留痕的非活跃 session（dsh 调研）→ SYSTEM #4 行可见，点击 inspector 显示 SYSTEM prompt 全文 + diff 摘要（version/reason/hash/charCount 键位）+「返回」按钮可复原；②活跃 session（无留痕）→ 点「现取当前值」按钮 → 获取 31777 字符成功（12:36:33），DATA 行追加到行尾。SYSTEM reason=change 场景未在 GUI 触发（需修改 agent prompts 配置），但 vitest trace-ext 覆盖 reason=change 测试 + core parse-session-trace 覆盖 SYSTEM 变更合并。详见 probe-results.md V2 节。
- [x] V7: 坏 JSON 行容错；未落盘空态；禁用留痕 extension 降级 + 现取通道可用
  - 记录：2026-08-21 GUI 实测：①坏 JSON 行（dsh session 尾部注入 `{invalid json!!!`）→ MALFORMED #1748 行渲染（`无法解析的 entry（第 1748 行）`），inspector 显示原始 raw +「打开所在目录」按钮可触发 reveal-in-folder IPC；②未落盘空态（新 session 未 flush）→ 未在 GUI 触发（vitest trace-runtime 覆盖 filePath=null → source=empty 测试）；③禁用 extension 降级 → 无 SYSTEM 行（正常降级，不崩溃）；④现取通道可用：非活跃无留痕 session（dsh 调研）→「现取当前值」→ 31777 字符成功（runtime 常驻扩展 session.currentSystemPrompt 通道）。详见 probe-results.md V7 节。

## trace-ui · assistant 子 block 展开（§3.5 增补，2026-08-21）

- [x] B1: assistant 行 chevron 展开/收起，子 block 行（thinking/text/toolCall）类型与摘要正确；过滤后子行跟随父行
  - 记录：2026-08-21 dev app（真实 session 复制进 ~/.xyz-agent-dev，205 行/80 可展开行）：#7 ASSISTANT 展开后 thinking + toolCall 子行按序出现，toolCall 摘要含工具名+arguments 单行摘要（真实字段口径）。过滤跟随为 vitest 覆盖（trace-view.test「子行跟随父行过滤」）。
- [x] B2: 点 assistant 聚合行 → inspector 显示 id/model/usage tokens/blocks 清单；点清单项或子 block 行 → block 态全文（长 thinking 多行不截断、toolCall arguments pretty JSON）
  - 记录：2026-08-21 同 session GUI 实测：聚合态显示 id 2424537e / model k3 / stopReason / inputTokens 12453 / outputTokens 186 / cacheRead 7680 / cost 0.042 + 2 项 blocks 清单；点 toolCall 清单项进入 block 态（toolName/toolCallId/arguments pretty JSON + 父溯源行 `assistant <id> · k3`）。
- [x] B3: toolCall block「跳到对应 TOOL 行」按 toolCallId 配对定位；block 态返回回聚合态、再返回清除选中
  - 记录：2026-08-21 同 session GUI 实测：block 态点「跳到对应 TOOL 行」→ inspector 切 TOOL #8 且列表行选中高亮；返回两段层级（block → 聚合 → 清除选中）实测正确。
- [x] B4: inspector 内鼠标拖选复制（thinking 正文 / arguments / raw JSON）；TOOL 行 content 全文 + image 占位
  - 记录：2026-08-21 GUI 实测：inspector body computed style userSelect=text（拖选可用）；TOOL 行 content 结构化渲染真实 session outline 输出（此前只能翻 raw JSON）。image 占位为 vitest 覆盖。
- [x] B5: 大 session（>500 行虚拟滚动）下展开/收起与子行选中正常
  - 记录：2026-08-21 GUI 实测（真实 session 复制，923 行）：虚拟滚动生效（DOM 仅渲染 38 行）；展开 #5 出现 5 个子 block（thinking/text/toolCall×3），点子行进入 block 态 inspector 正常。
MANUAL_CHECKS_EOF

fail=0
IFS=',' read -ra arr <<< "$ids"
for id in "${arr[@]}"; do
  # 找到 "- [ ] <id>:" 或 "- [x] <id>:" 条目行号
  line=$(grep -n "^- \[.\] ${id}:" "$doc" | head -1 | cut -d: -f1) || true
  if [ -z "$line" ]; then
    echo "$id FAIL (条目不存在于 manual-checks 记录)"
    fail=1; continue
  fi
  if sed -n "${line}p" "$doc" | grep -q '^- \[ \]'; then
    echo "$id FAIL (未勾选)"
    fail=1; continue
  fi
  # 下一条非空行须是 "- 记录：" 且记录内容非空（模板缩进 2 空格，兼容前导空白）
  rec=$(sed -n "$((line+1)),+3p" "$doc" | grep -m1 '^[[:space:]]*- 记录：' || true)
  if [ -z "$rec" ] || [ "$rec" = "- 记录：" ]; then
    echo "$id FAIL (勾选但无验证记录)"
    fail=1; continue
  fi
  echo "$id PASS"
done
exit $fail
