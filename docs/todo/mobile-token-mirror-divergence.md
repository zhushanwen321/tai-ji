# mobile-renderer 令牌镜像副本与桌面 style.css 分叉（已裁决关闭）

状态：已对齐关闭（2026-10-22 用户裁决：**mobile 跟随桌面终态，全量对齐**；否决「解除镜像声称」备选项）。mobile tokens.css 暗亮两块已与桌面 style.css 对应块逐 token 对齐：背景五层阶梯 + neutral 六档去蓝偏值 + `--bubble-bg` 归层派生 `var(--bg-elevated)`（亮族纸白 `#fefefe` 独立档）+ 缺失组补齐（`--md-code-bg/fg`、`--link-c`/`--code-c`、`--name`、`--sel-bg`/`--sel-edge`、`--shadow-3`、亮色阴影三档、亮色 `--bg-stage`、`--ease-out`/`--ease-in`/`--ease-out-soft`——均经消费点核实后补）+ shadcn 别名映射目标对齐（`--secondary`→`var(--bg-card)`、`--popover`→`var(--bg-elevated)`）+ 公式类派生收敛桌面形态（亮块不重声明 `--accent-soft`/`--accent-ring`/`--*-soft`/`--bg-sunken`，继承 `:root` 公式自动跟随）。死定义清理：`--composer-bg`（全仓零消费）与 tailwind.config 四组零消费 keyframes（pulse-accent / pulse-warn / steer-breathe / working-pulse）；main.ts 启动失败兜底页 neutral 字面量同步现值。登记来源：ui-optimize-unified D5 终态同步（2026-10-08）。

## 现状（2026-10-22 对齐后）

无登记内分叉。镜像校验单测 `mobile-token-mirror-parity.test.ts`（accent 族四组 + shadcn `--primary`/`--ring` + `--neutral-fg-2` 逐字相等）双绿；其余 token 逐项对账随本次对齐完成。

mobile 合法独立档（镜像范围外，非分叉）：

- `--safe-area-*` 视口安全区四变量（mobile 专属）
- 字号槽位仅 `--font-scale-u`（无桌面三分区档 `--font-scale-sidebar/chat/drawer`）
- `styles/shell.css` 浮层过渡段（dialog 居中依赖，独立镜像，头注释自带双壳同步义务）
- 图表派生 token 组（`--chart-*`/`--heat-*`/`--cache-*`/`--hover-tint` 等，mobile 壳与所消费 @taiji/ui 组件零消费，未镜像）；`--blk-gap`/`--z-toast`/`--z-banner`/`--content-max-w-wide`/`--message-stream-pad-top` 等桌面专用 token 同理未镜像
- tailwind.config 存量 keyframes 中 wiggle / pulse-strong / ask-user-slide-up 三组当前亦无消费点（本次范围外未删，留待后续动画清理波次裁决）

## 裁决结果

2026-10-22 用户裁决：**mobile 跟随桌面终态（全量对齐）**——两壳观感一致、镜像契约恢复；代价（mobile 壳无像素验收轨，改值需真机核对）知情接受。后续桌面令牌改值仍以 renderer style.css 为真值源同步 mobile 镜像。

## 关联登记

- 镜像范围口径（2026-10-06 定案）：`docs/testing/e2e-map.json` E2E-VISUAL-01 已登记 `packages/mobile-renderer/src/styles/**` scope，镜像一致性机器断言 = `packages/renderer/src/__tests__/mobile-token-mirror-parity.test.ts`
