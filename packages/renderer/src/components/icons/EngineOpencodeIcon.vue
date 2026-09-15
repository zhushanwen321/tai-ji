<template>
  <!--
    引擎 opencode（OpenCode）单色 icon（U3 D8 / C-ext-18）。几何来自 assets/icons/engine/opencode.svg
    （源 lobehub icons opencode.svg，path d 原样拷贝；方框 O 镂空依赖 evenodd 填充规则），
    禁止手改 path d——改几何回源 SVG 文件同步。viewBox 扩边留白：内容 24 单位居中、占比 60%
    （对齐 pi 官方留白观感），视觉尺寸由调用方 class 控制（size-*）。
  -->
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 40 40" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/>
  </svg>
</template>
