# 浮层 × 未收编模态叠开时的 Tab 属主（已裁决并实施：Tab 只在最上层生效）

> **状态**：已裁决并实施（2026-10-03 用户裁决：Tab 只在最上层生效）——D6 交付后修复落地，本文件转为定案记录。

## 裁决（2026-10-03 用户原话）

「tab键，应该只在最上层overlay中生效。同时要注意，每一层overlay，都可以按esc关闭，但只能每次按一下关闭最上面一层。」

实现语义：① **Tab 归最上层表面**——浮层上叠着模态/弹层（如 ⌘K 搜索）时，Tab 归该模态的焦点域，编排器不把焦点拉回浮层面板；② **Esc 每层可关、每按一次只关最上面一层**——容器级层级序（浮层→底抽屉→右抽屉，S3）与浮层上叠模态 Esc 先关模态（S8）均为既有实装，本次仅核实不回归（esc-stack-order / modal-yield-event-order 单测全绿，Esc 路径零改动）。

## 实施（D6 交付后修复，原「候选修复」按裁决落地）

- `key-orchestrator/orchestrator.ts` Tab 分支：`trapTabIntoOverlayPanel` 陷阱前补双检，与 Esc 分支同源（§6.7 模态共存守卫两重）——`e.defaultPrevented` 已置位（先行档消费方已消费）→ 不动作；`anyModalSurfaceYieldsEsc()` 任一成员开着（模态/弹层族让位，含弹出层族 yieldsEsc ✓）→ 不动作，Tab 先服务视觉最外层。非阻塞面（Toast/横幅族 yieldsEsc ✗）不抢属主，浮层陷阱照常。
- 单测对账（真实事件序，禁 mock 时序）：`overlay-modal-stack.test.ts`——浮层+模态同开 Tab 不被陷阱捕获（焦点留模态、不 preventDefault）；对照半边（同装配无模态叠加 → 陷阱照常拉回首元素，判别可证伪）；模态 Esc 关闭 + flush 翻新注册后让位解除、陷阱恢复（属主判定动作时刻直读，非永久闩锁）；Esc 序 Esc#1 关模态（浮层原样）→ Esc#2 关浮层（递进）。
- 设计文档 §6.7 编排器监听规格「Tab 属主 = 最上层表面」+ §8.2 S3 叠开组合断言已同 commit 回写。

## 证据指针

- 代码锚：`packages/renderer/src/composables/features/app/key-orchestrator/orchestrator.ts` Tab 分支双检。
- 单测：`packages/renderer/src/__tests__/composables/key-orchestrator/overlay-modal-stack.test.ts`。
- 设计文档：`.tmp/tech-design/display-containers.md` §6.7 / §8.2 S3（.tmp 过程产物不入库，本文件为仓库内定案登记处）。
