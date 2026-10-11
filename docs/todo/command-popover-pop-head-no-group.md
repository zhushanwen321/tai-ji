# CommandPopover 不补 demo .pop-head 组头（数据无分组概念，待分组需求出现再议）

来源：2026-10-10 composer UI 重构审查——CommandPopover 形态对齐 demo 插入浮层（workbench.css `.composer .pop-item` 档）时对照 demo `.pop-head` 组头的取舍登记。

## 状态：不补（登记待议）

demo 触发器弹层（ComposerBar.vue `store.pop === 'insert'`）顶部有 `.pop-head` 组头（mono / `--fs-xs` / uppercase / `--dim` / padding 6px 8px 4px），addMenu 等弹层亦用同款头。real 的 CommandPopover 四路候选（`$` file / `#` session / `@` subagent / `/` slash+skill）在组件内均组装为单一平铺 `CmdItem[]`（`items` computed，无 group 字段），没有可承载组头的数据结构；补一个静态头（如「命令」二字）只是装饰，属造结构。

**不补**。组件文件头注释已指向本登记。

## 再议触发条件

候选源引入分组语义时（例如 slash 段按 builtin / extension / skill 分组展示），随分组数据结构一并补组头，形态复用 ModelPickerPanel 组头先行落地的 real 侧写法：`px-2 pb-[4px] pt-[6px] font-mono text-[length:var(--text-3xs)] uppercase tracking-[0.08em] text-neutral-dim`（= demo `.pop-head` 逐值翻译）。
