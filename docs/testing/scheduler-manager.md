# scheduler-manager 插件验收归档（R3）

> plugin 交互点位（headerAction / modal / action-bar + 条目镜像数据面）与首消费者 `resources/plugins/scheduler-manager` 的真机验收记录。设计源 = `.tmp/tech-design/plugin-header-action-modal-points.md`（工作产物，不入库；本文档为其验收章节 §4 的归档承载，三态归宿 R3）。验收日期：2026-09-20；基线 `de2e475c0..` 全部场景 pass。

## 1. 场景结果总表

| # | 场景 | 判据要点 | 结果 | 关键证据 |
|---|------|----------|------|----------|
| 1 | 入口可见+弹出+归焦 | testid 按钮、22px 与 drawer-toggle 共线、modal z-1000、焦点进出、断连自愈（transient 不复活陈旧 open） | pass | 几何 JSON + reload 后 modalResurrected:false |
| 2 | 暂停真实生效 | 行文案变恢复、徽标/统计同步；**绕过 UI 读 JSONL** 末条 `{op:'toggle',enabled:false}`；重开仍暂停态 | pass | JSONL 逐字命中 + reopen 截图 |
| 3 | 三通路状态一致 | UI 暂停 / requireCommand 命令链 / 真 LLM（schedule_control）折叠同一张表，磁盘与 UI 逐次一致、无需手动刷新 | pass | 三通路各自 JSONL 对照 |
| 4 | 会话恢复窗口 | 读失败「正在恢复」无假空态；restore 后列表出现；写分支直接成功（JSONL toggle 落盘，与 P9 标定一致）；恢复提示语义 | pass | restoring 截图 + toggle JSON |
| 4b | 对账表之外零元素 | inputs=0（无筛选器/搜索框/作用域切换）、恰 1 统计行 + N 组行操作 + ≤1 notice | pass | DOM 清点 JSON |
| 5 | 换插件复用点位（demo-echo 夹具） | 两枚插件按钮并存、demo modal 点击计数闭环、禁用后按钮与层同消失（E2）、重启用恢复；验后夹具已删 | pass | statusChange/plugin-gone 双帧证 |
| 6 | 忙时回执诚实性 | 生成中点暂停 → 行内「会话正在忙，操作未生效」+ JSONL 零新条目；结束后再点生效 | pass | busy notice 截图 + baseline diff |
| 7 | 上限与空态 | 灌满 50：徽标 50 + 「共 50 / 上限 50」；零任务会话按钮常驻无徽标 + 空态 | pass | count50 + empty JSON |
| 8 | 顶栏无回归 | 像素轨绿（visual-chromium）+ 真机几何 22px 不变、新增按钮为唯一 DOM 变化 | pass | 像素轨 2 passed + header 采样 |
| 9 | 多会话徽标互不串 | A=2/B=1 切换互串零；重启应用后 didActivate 补拉正确（split 已移除，单 panel 口径） | pass | 重启前后截图 |
| 10 | 切会话关闭 modal | 切走层自动关、B 会话开 B 列表、切回状态保持 | pass | switch JSON 三连 |
| 11 | 浮层互斥 | (a) Settings 开 → modal 关（host-overlay）；(b) 插件对话框待决 → showModal 拒（E10）无半态；(c) ui-request 确认层叠 modal 上（--z-dialog 1100 > --z-modal 1000）、焦点归还 | pass | 帧证 + z 断言 |
| 12 | 负面路径 | 扩展禁用 → 灰置 + 泛化 tooltip + 点击零 prompt；requireCommand 直发无命令语境 → 回执 command-missing、零 prompt 不漏模型、无新通知通路 | pass | 回执证据 + 灰置截图 |

## 2. 探针结果回填（设计 §3.7）

| # | 断言 | 结果 |
|---|------|------|
| P2 | runtime `prompt()` 发 `/schedule off <id>` 三态（执行命令/不产生模型 turn/不留用户消息） | 成立。pi 0.84.4 RPC 直发实测：toggle entry 落盘、assistant/user entry 增量均 0；`expandPromptTemplates ?? true`（agent-session.js:822）+ rpc-mode 不传该键 → 默认 true。注意：该结论限于 runtime prompt RPC 直发链；**输入框手敲路径存在独立缺陷候选**（见 §4） |
| P3 | 点击到列表更新往返 | UI 暂停 ≤1300ms（写回执+失效转发+插件重拉+渲染，轮询粒度 500ms 首测即完成态）；命令链 ~1200ms；LLM 链 ~54s（LLM 响应 50s + UI 刷新秒级） |
| P4 | builtin 插件 dev/打包两态装载 | dev：三 builtin 插件（statusline/scheduler-manager/demo-echo）同批激活成功（statusline 历史坑同批关闭）；打包态留发布链验证 |
| P5 | action-bar 新宿主透传/旧宿主降级 | 单测两条绿（resolve.test.ts：透传 + ansi-text 降级 label 可读） |
| P7 | 折叠器下沉逐字节等价 + 依赖收敛 | extensions 280 断言零改动全绿；extension-protocol 内 pi-ext-guards/pi-extension-logger/croner 零 import |
| P9 | 恢复窗口 requireCommand 时延 | 裸 spawn + switch_session 附着 5/5 成功；附着→命令可用 gap 1.3-3.0ms；重试参数定案 500ms×6（3s 预算，对 30s 首 tick 约束 10 倍余量） |

## 3. 验收期发现并已修复的缺陷

| 缺陷 | 修复 |
|------|------|
| 新 S→C 帧未进 renderer 路由声明表（route-inbound）→ bridge 双订阅收不到帧，modal/徽标全死 | 6f9182bf7 补 2 行。教训：新增 S→C 帧的登记点共四处（protocol / PLUGIN_HANDLERS / message-bus-bridge / route-inbound） |
| requireCommand 扩展命令 prompt 后 occupancy 停 dispatching（pi 同步执行无 agent_start/end 回流）→ 会话假死 busy（实证 47 条回执 busy） | 6f9182bf7 对该链收口 idle |
| togglePlugin disable/enable 不广播 plugin:statusChange → E2 触发链无源，禁用后按钮/modal 残留 | f4d390e4d 两腿补广播（payload 按 renderer 契约 newStatus；enable 按激活终态派生） |
| disabled 态 tooltip 回落声明 title（灰按钮显示「定时任务」，误导） | 11930b18e disabled 态回落 pluginActionExtensionNotLoaded 泛化文案 |
| modal 内写操作命令未进 builtin 声明 → 点击 ERR6 死链 | 9ba71ee08 补 toggle/run/delete 三条声明 |

## 4. 已知边界与待排查（登记，非阻塞）

1. **输入框手敲 `/schedule …` 漏进模型（缺陷候选，基线机制）**：手敲路径（renderer 输入框 → WS message.send）与插件 sendMessage RPC 链在 send-queue/BeforeSend hook 段行为不同，手敲的 slash 扩展命令可能漏进模型并伴随 isGenerating 永久残留（需手动 abort）。P2 探针证明 runtime prompt RPC 直发链无此问题；插件面板写路径（本设计主链）不受影响。建议独立归因 send-queue 排队链。
2. **空闲会话的插件对话框不可见（既有机制缺口）**：插件 `api.ui.show*` 的 ui-request 无显式 sessionId 时依赖 activeSessionResolver（语义=正在生成的会话，空闲=undefined），sid 缺失帧被渲染端双守卫跳过 → 确认层不渲染但 runtime pending 占位 30 分钟，期间 E10 恒拒 showModal。生成中会话正常。修复方向：ui-request 显式 sessionId 注入（另一设计）。
3. **新建会话不投 didActivate**（设计内边界：不经 session.switch 不投递）→ 首次 switch 前徽标补拉与 E13 判定不生效。
4. **纯扩展命令会话的任务重启即失**：pi session 文件延迟写入（无 assistant 消息不落盘），建任务后若从未产生模型 turn，重启后会话 JSONL 为空。pi 既有行为。
5. **杀 pi 后 3-6s 内点击的静默丢帧**：极端序列（多轮杀进程）诱发，帧出站但 runtime 零处理痕迹；疑似 pi-exited 后 client 状态与 ensureActiveOrBroadcast 竞态，建议单开排查。
6. **对账表 tooltip 面（prompt/expiresAt/model/id 进 tooltip）未渲染**：GuiComponent TreeItem 无 tooltip 字段，结构性不可渲染；id 可达性由行内 notice 文案承担（E5/E7 文案明文含 id 与手敲退路）。补协议字段或改对账表呈现形态属后续设计裁决。
7. **写路径的重复通知**：scheduler 扩展命令 handler 的 `ctx.ui.notify` 与 modal 行内 notice 重复呈现（扩展既有行为，消除需改扩展，另一 scope）。

## 5. 验收产物

真机产物（截图/断言 JSON/轮询日志/WS 抓取）在开发期落 `.tmp/dev-flow/plugin-header-action-modal-points.acceptance/`（工作产物，不入库）。本文档为唯一持久归档。
