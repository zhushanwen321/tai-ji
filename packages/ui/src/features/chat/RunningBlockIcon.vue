<template>
  <!--
    RunningBlockIcon —— trace 块行头「运行中」专属动效图标（每类活动一种动效）。

    替代原全类型共用的呼吸弧 loader（RUNNING_LOADER_SVG）：running 不再吞掉字形——
    各活动保留自己的图标字形（染 --neutral-dim，与完成态同色），动效元素一律 accent
    （唯一语义色），扫一眼同时知道「在跑」与「什么在跑」。

    kind → 动效（全部纯 CSS，token 配色，reduced-motion 由 style.css 全局兜底瞬切）：
    - thinking   轨道点：核 + 双卫星互绕（想法绕核；思考块无实体动作，唯一无字形档）
    - tool-read  纵向扫描：book-open 字形 + 一道扫描线下移（逐行读下去）
    - tool-bash  光标闪烁：square-terminal 字形内 "_" steps(1) 硬切（终端光标本色）
    - tool-edit  笔画描线：pencil 字形 + 笔下一道线画出再淡出（落笔）
    - tool-grep  透镜扫掠：search 字形 + 镜片内雷达扇区旋转（扫描中）
    - subagent   在线脉冲：users 字形 + 右下角在线点涟漪（另一个 agent 在干活）
    - workflow   连线行进：workflow 双节点字形（composer slash 菜单同款）+ 节点连线上
                 一个 accent 点行进（offset-path 走真实弯线）+ 两节点交替呼吸亮
    - tool-other 字形呼吸：square-function 字形透明度脉动（兜底档，最通用的「活着」信号）

    完成态交叉切换沿用消费方既有 <Transition mode="out-in" name="tico">（本组件只替换
    原 loader span 的位置）。data-running-icon 属性 = 测试/视觉回归锚点。
  -->
  <span
    class="rbi inline-flex size-[15px] shrink-0 self-center items-center justify-center"
    :data-running-icon="kind"
  >
    <!-- ① thinking · 轨道点（无字形） -->
    <template v-if="kind === 'thinking'">
      <span class="rbi-orbit relative inline-flex size-full">
        <span class="rbi-orbit-core absolute left-1/2 top-1/2 size-[4px] -ml-[2px] -mt-[2px] rounded-full bg-accent opacity-55" />
        <span class="rbi-orbit-sat absolute inset-0" />
        <span class="rbi-orbit-sat rbi-orbit-sat--b absolute inset-0" />
      </span>
    </template>

    <!-- ② tool-read · 纵向扫描（book-open 字形 + 扫描线） -->
    <span v-else-if="kind === 'tool-read'" class="rbi-scan relative inline-flex size-full">
      <span class="text-neutral-dim">
        <svg class="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
      </span>
    </span>

    <!-- ③ tool-bash · 光标闪烁（square-terminal 字形，"_" 硬切） -->
    <span v-else-if="kind === 'tool-bash'" class="inline-flex size-full">
      <span class="text-neutral-dim">
        <svg class="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="m7 9 2.5 2.5L7 14" />
          <line class="rbi-blink text-accent" x1="12" y1="15" x2="16" y2="15" stroke-width="2.2" />
        </svg>
      </span>
    </span>

    <!-- ④ tool-edit · 笔画描线（pencil 字形 + 笔下横线画出） -->
    <span v-else-if="kind === 'tool-edit'" class="rbi-draw relative inline-flex size-full">
      <span class="text-neutral-dim">
        <svg class="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      </span>
    </span>

    <!-- ⑤ tool-grep · 透镜扫掠（search 字形 + 镜片内雷达扇区） -->
    <span v-else-if="kind === 'tool-grep'" class="relative inline-flex size-full">
      <span class="text-neutral-dim">
        <svg class="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </span>
      <span class="rbi-lens-sweep absolute left-[2.5px] top-[2.5px] size-[8.75px] rounded-full" />
    </span>

    <!-- ⑥ subagent · 在线脉冲（users 字形 + 右下在线点涟漪） -->
    <span v-else-if="kind === 'subagent'" class="rbi-presence relative inline-flex size-full">
      <span class="text-neutral-dim">
        <svg class="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </span>
    </span>

    <!-- ⑦ workflow · 连线行进（双节点字形 + 弯线上行进点 + 节点交替亮） -->
    <span v-else-if="kind === 'workflow'" class="relative inline-flex size-full">
      <span class="text-neutral-dim">
        <svg class="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect class="rbi-node rbi-node--a text-accent" x="3" y="3" width="8" height="8" rx="2" />
          <path class="rbi-wf-conn text-accent" d="M7 11v4a2 2 0 0 0 2 2h4" />
          <rect class="rbi-node rbi-node--b text-accent" x="13" y="13" width="8" height="8" rx="2" />
        </svg>
      </span>
      <span class="rbi-wf-travel absolute left-0 top-0 size-full" />
    </span>

    <!-- ⑧ tool-other · 字形呼吸（square-function 兜底档） -->
    <span v-else class="rbi-breathe inline-flex size-full text-accent">
      <svg class="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3" />
        <path d="M9 11.2h5.7" />
      </svg>
    </span>
  </span>
</template>

<script setup lang="ts">
import type { RunningIconKind } from './block-icon'

defineProps<{ kind: RunningIconKind }>()
</script>

<style scoped>
/* ── 动效实现注记 ────────────────────────────────────────────────
   全部 scoped（非 v-html 内联 SVG，元素带 data-v 属性，scoped keyframes 同块自洽——
   fchip-roll-x 先例）；颜色只引用主题 token（accent/dim 语义色），六主题免逐个定值；
   prefers-reduced-motion 由 style.css 全局兜底（duration 0.01ms + iteration 1），
   各动效瞬切后呈现 = 静态字形 + 一个可见 accent 元素，形态识别保留。 */

/* ① 轨道点：双卫星反向互绕（顺 1.5s / 逆 2.2s 半速层次） */
.rbi-orbit-sat {
  animation: rbi-spin 1.5s linear infinite;
}
.rbi-orbit-sat::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  width: 3.5px;
  height: 3.5px;
  margin-left: -1.75px;
  border-radius: 50%;
  background: var(--accent);
}
.rbi-orbit-sat--b {
  animation-duration: 2.2s;
  animation-direction: reverse;
  opacity: 0.5;
}
@keyframes rbi-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ② 纵向扫描：accent 细线 + 微光晕，top 0→12px 后淡出（15px 槽位内） */
.rbi-scan::after {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  top: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  box-shadow: 0 0 5px 0 var(--accent);
  animation: rbi-scan-y 1.6s ease-in-out infinite;
}
@keyframes rbi-scan-y {
  0% {
    top: 0;
    opacity: 0;
  }
  15% {
    opacity: 0.95;
  }
  50% {
    top: 12px;
    opacity: 0.95;
  }
  65%,
  100% {
    top: 12px;
    opacity: 0;
  }
}

/* ③ 光标闪烁：steps(1) 硬切（终端光标本色，不渐变） */
.rbi-blink {
  animation: rbi-blink 1s steps(1) infinite;
}
@keyframes rbi-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}

/* ④ 笔画描线： scaleX 0→1（左起）再淡出（落笔 → 收笔） */
.rbi-draw::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 2px;
  bottom: -1px;
  height: 1.5px;
  border-radius: 1px;
  background: var(--accent);
  transform-origin: left center;
  animation: rbi-draw-line 1.7s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
@keyframes rbi-draw-line {
  0% {
    transform: scaleX(0);
    opacity: 1;
  }
  55% {
    transform: scaleX(1);
    opacity: 1;
  }
  75%,
  100% {
    transform: scaleX(1);
    opacity: 0;
  }
}

/* ⑤ 透镜扫掠：conic 扇区旋转（雷达）；radial mask 抠掉圆心（环带内扫）。
   几何 = search 圆 at 15px 渲染（24 viewBox × 0.625）：bbox left/top 2.5px、径 8.75px。 */
.rbi-lens-sweep {
  background: conic-gradient(from 0deg, var(--accent) 0deg 70deg, transparent 70deg 360deg);
  opacity: 0.9;
  -webkit-mask: radial-gradient(circle, transparent 1.2px, #000 1.7px);
  mask: radial-gradient(circle, transparent 1.2px, #000 1.7px);
  animation: rbi-spin 1.3s linear infinite;
}

/* ⑥ 在线脉冲：右下角 accent 点 + 扩散涟漪环（IM 在线心智） */
.rbi-presence::after {
  content: '';
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.rbi-presence::before {
  content: '';
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  border: 1px solid var(--accent);
  animation: rbi-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes rbi-ping {
  0% {
    transform: scale(0.6);
    opacity: 0.8;
  }
  80%,
  100% {
    transform: scale(2.1);
    opacity: 0;
  }
}

/* ⑦ 连线行进：offset-path 走 workflow 弯线（M7 11v4a2 2 0 0 0 2 2h4 的 15px 渲染等效：
   × 0.625 → M4.4 6.9v2.5a1.25 1.25 0 0 0 1.25 1.25h2.5）；节点交替亮 0.8s 错相。
   offset-path 是 Chromium 特性（Electron 宿主内建支持）；reduced-motion 瞬切终态 =
   点停弯线中段，形态保留。 */
.rbi-wf-travel {
  offset-path: path('M4.4 6.9v2.5a1.25 1.25 0 0 0 1.25 1.25h2.5');
  offset-rotate: 0deg;
  animation: rbi-wf-travel 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
.rbi-wf-travel::before {
  content: '';
  position: absolute;
  left: -1.75px;
  top: -1.75px;
  width: 3.5px;
  height: 3.5px;
  border-radius: 50%;
  background: var(--accent);
}
@keyframes rbi-wf-travel {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  82% {
    opacity: 1;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}
.rbi-node {
  animation: rbi-node-light 1.6s ease-in-out infinite;
}
.rbi-node--b {
  animation-delay: 0.8s;
}
@keyframes rbi-node-light {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

/* ⑧ 字形呼吸（tool-other 兜底档）：opacity 脉动，最安静的通用「活着」信号 */
.rbi-breathe {
  animation: rbi-breathe 2.2s ease-in-out infinite;
}
@keyframes rbi-breathe {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
</style>
