# 渲染采样管道（render-sampling toolkit）

> 真机渲染验收/基线采集共用的采样管道资产。doc 是资产清单的 SSOT；脚本本体在
> `scripts/render-sampling/`（与本文档同 commit 维护，见下方 closeout 纪律）。
> 派生依据：dev-flow `flow/acceptance.md`「剧本预编译」的采样管道复用检查 [MANDATORY]。

## 管道六环节

真机采样 = 把「app 界面里的渲染结果」变成「可机器判定的数据」的固定流水线。六个环节中
①②④⑤⑥ 与验收场景无关（管道本体，本目录维护）；场景差异只在 ③ 的样本与 ⑤ 之后的断言
（场景脚本自行编写，不进本目录）。

| 环节 | 做什么 | 本项目已核实参数 | lib 函数 |
|------|--------|-----------------|----------|
| ① 连接 | 连 dev 实例调试端口并定位页面 | 端口来自 `node apps/electron/scripts/dev-instance.mjs --print`（禁硬编码；`--data-dir` 隔离实例端口互不相同） | `connectPage` |
| ② 定位 | 选择器锚定目标容器 | composer = `.composer-input[contenteditable="true"]`（contenteditable 非 textarea，fill 前须 click 聚焦） | 常量 `COMPOSER_SELECTOR` |
| ③ 注入 | 样本送进渲染管线 | 用户气泡粘贴同管线同宿主；发送优先按钮探测、fallback Enter | `injectToComposer` / `clickSendOrSubmit` |
| ④ 等待 | 「渲染完成」判定信号 | 图片加载完成 = `img.naturalWidth > 0`（`complete` 属性加载失败时也为 true，不能作信号；0x0 = 失败） | `waitForRenderSettled` |
| ⑤ 采样 | DOM 形态 + 截图 | 与基线同构的元素序列 JSON（tag/class/rect/text/img natural）+ 计算样式抽查 | `sampleDomShape` |
| ⑥ 落盘 | 统一命名 | `<name>-dom.json` / `<name>-console.log` / `<name>-fullpage.png` | `saveArtifacts` |

## 使用

```bash
# 管道冒烟（写场景断言前先跑通本条——预飞纪律）
node scripts/render-sampling/cli.mjs --cdp-port <端口> --sample <样本.md> --out .tmp/dev-flow/<plan>.acceptance --name a1

# 场景脚本内复用
import { connectPage, sampleDomShape } from '../../../scripts/render-sampling/lib.mjs'
```

基线采集与终态验收用同一管道 → 产物 JSON 同构，直接结构化 diff，替代人工截图判读。

## 资产清单表（SSOT；closeout 时逐行核对）

| 资产 | 覆盖环节 | 说明 | 最近验证 |
|------|---------|------|---------|
| `scripts/render-sampling/lib.mjs` | ①-⑥ 全部 | 共享函数库 + 关键选择器/信号常量 | 2026-09-19 建立（自 markdown HTML 支持验收脚本提炼；首次真机复用待下轮验收） |
| `scripts/render-sampling/cli.mjs` | 端到端 | 冒烟入口（连接→注入→采样→落盘） | 同上 |

## 已知坑

- **composer 是 contenteditable**：选择器写 `[contenteditable="true"]`；`fill()` 前必须 `click()` 聚焦。
- **图片等待信号**：只认 `naturalWidth > 0`；`complete === true` 包含加载失败态。
- **CDP 端口禁硬编码**：按 worktree hash 派生，多实例（`--data-dir` 隔离）互不相同。
- **真实数据目录禁区**：测试与采样禁触 `~/.taiji`（fs-guard 防线）；隔离目录用 `dev-instance.mjs --data-dir ~/.taiji-dev/<suffix>`。
- **console 抓取先挂**：`captureConsole` 必须在触发渲染的操作前挂上，否则丢启动期告警。

## closeout 纪律（dev-flow 验收收尾执行）

1. 本期验收新增/修改的管道环节脚本 → 同 commit 回写 `scripts/render-sampling/` 并更新上方资产清单表（含「最近验证」列）。
2. 选择器失效 / DOM 结构变化淘汰的函数 → 删除（git 可追溯），清单表同步删行。
3. 场景专属断言不进本目录（分流判定见 dev-flow `flow/acceptance.md`「一次性 vs 可复用分流」）。
