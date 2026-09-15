/**
 * useMermaidZoom —— mermaid 全屏 Dialog 内的 zoom/fit 控制。
 *
 * 移植自 design-visual-explainer templates/zoom.js 的核心交互（简化版）：
 *  - readSvgNaturalSize：四级回退读 SVG 自然尺寸
 *  - computeSmartFit：contain 缩放，低于 readabilityFloor 切 width/height-priority（保证可读）
 *  - zoomAround：围绕点缩放，同步修正 pan
 *  - constrainPan：图小于视口居中，否则限制 pan 不拖出
 *
 * 简化取舍（按需求"静态图+点击全屏"，不含 wheel/drag/pinch）：
 *  - 只保留按钮 zoom-in/out/fit/1:1，无滚轮/拖拽/触摸（MermaidRenderer 内另加 Ctrl+wheel 缩放）
 *  - Dialog 内空间大（max-w-[95vh]），fit 容差足够
 *
 * 用法：const { zoomLabel, zoomIn, zoomOut, fit, resetOneToOne, syncSvg } = useMermaidZoom(viewportRef, canvasRef)
 */
import { ref, type Ref } from 'vue'

interface ZoomConfig {
  /** fit 时四周留白（px） */
  fitPadding: number
  minZoom: number
  maxZoom: number
  /** 初始 fit 允许的最大放大倍数（防小图被放过大） */
  maxInitialZoom: number
  /** 每次按钮 zoom 的步进比例 */
  zoomStep: number
  /** contain 缩放低于此阈值则切 width/height-priority（保证可读性） */
  readabilityFloor: number
  /** 可用区域最小宽高下限（px，防视口过小算出负值/0） */
  minUsableSize: number
  /** SVG 尺寸全缺失时的回退宽高（px） */
  fallbackWidth: number
  fallbackHeight: number
}

const CONFIG: ZoomConfig = {
  fitPadding: 32,
  minZoom: 0.1,
  maxZoom: 8,
  maxInitialZoom: 2,
  zoomStep: 0.15,
  readabilityFloor: 0.5,
  minUsableSize: 80,
  fallbackWidth: 800,
  fallbackHeight: 600,
}

/** 双侧 padding（上下/左右各一份 fitPadding） */
const PADDING_BOTH_SIDES = 2
/** 百分比转换因子（zoom 小数 → 整数百分比显示） */
const PERCENT = 100

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

export function useMermaidZoom(viewportRef: Ref<HTMLElement | null>, canvasRef: Ref<HTMLElement | null>) {
  const zoomLabel = ref('100% — fit')
  let zoom = 1
  let panX = 0
  let panY = 0
  let svgW = 0
  let svgH = 0

  /** 读 SVG 自然尺寸（viewBox > width/height attr > getBBox > getBoundingClientRect 四级回退） */
  function readSvgNaturalSize(svg: SVGSVGElement): { w: number; h: number } {
    let w = 0
    let h = 0
    const vb = svg.viewBox?.baseVal
    if (vb && vb.width > 0) {
      w = vb.width
      h = vb.height
    }
    if (!w) {
      w = parseFloat(svg.getAttribute('width') ?? '') || 0
      h = parseFloat(svg.getAttribute('height') ?? '') || 0
    }
    if (!w) {
      const b = svg.getBBox()
      w = b.width
      h = b.height
    }
    if (!w) {
      const r = svg.getBoundingClientRect()
      w = r.width || CONFIG.fallbackWidth
      h = r.height || CONFIG.fallbackHeight
    }
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    return { w, h }
  }

  /** 限制 pan：图小于视口居中，否则不拖出可视区 */
  function constrainPan(): void {
    const vp = viewportRef.value
    if (!vp || !svgW) return
    const vpW = vp.clientWidth
    const vpH = vp.clientHeight
    const rW = svgW * zoom
    const rH = svgH * zoom
    const pad = CONFIG.fitPadding
    // 图 + 双侧 padding 仍小于视口 → 居中；否则 clamp 在可视区内
    panX = rW + pad * PADDING_BOTH_SIDES <= vpW ? (vpW - rW) / PADDING_BOTH_SIDES : clamp(panX, vpW - rW - pad, pad)
    panY = rH + pad * PADDING_BOTH_SIDES <= vpH ? (vpH - rH) / PADDING_BOTH_SIDES : clamp(panY, vpH - rH - pad, pad)
  }

  function applyTransform(mode: string): void {
    const canvas = canvasRef.value
    const svg = canvas?.querySelector('svg')
    if (!svg || !svgW) return
    constrainPan()
    svg.style.width = `${svgW * zoom}px`
    svg.style.height = `${svgH * zoom}px`
    if (canvas) canvas.style.transform = `translate(${panX}px, ${panY}px)`
    zoomLabel.value = `${Math.round(zoom * PERCENT)}% — ${mode}`
  }

  /** 智能 fit：contain，低于可读阈值切 width/height-priority */
  function computeSmartFit(): { z: number; mode: string } {
    const vp = viewportRef.value
    if (!vp || !svgW) return { z: 1, mode: 'fit' }
    const vpW = vp.clientWidth
    const vpH = vp.clientHeight
    // 可用区域 = 视口 - 双侧 padding，下限 minUsableSize 防负值
    const aW = Math.max(CONFIG.minUsableSize, vpW - CONFIG.fitPadding * PADDING_BOTH_SIDES)
    const aH = Math.max(CONFIG.minUsableSize, vpH - CONFIG.fitPadding * PADDING_BOTH_SIDES)
    const contain = Math.min(aW / svgW, aH / svgH)
    let z = contain
    let mode = 'contain'
    if (contain < CONFIG.readabilityFloor) {
      // 太小看不清：按宽高比选优先方向（宁可裁剪也要保证可读尺寸）
      const chartR = svgH / svgW
      const vpR = vpH / Math.max(vpW, 1)
      if (chartR >= vpR) {
        z = aW / svgW
        mode = 'width-priority'
      } else {
        z = aH / svgH
        mode = 'height-priority'
      }
    }
    return { z: clamp(z, CONFIG.minZoom, CONFIG.maxInitialZoom), mode }
  }

  /** 同步新 SVG：读尺寸 + fit */
  function syncSvg(): void {
    const canvas = canvasRef.value
    const svg = canvas?.querySelector('svg') as SVGSVGElement | null
    if (!svg) return
    const { w, h } = readSvgNaturalSize(svg)
    svgW = w
    svgH = h
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.style.maxWidth = 'none'
    svg.style.display = 'block'
    fit()
  }

  function fit(): void {
    if (!svgW) return
    const { z, mode } = computeSmartFit()
    zoom = z
    const vp = viewportRef.value
    if (vp) {
      // 居中：视口中心 - 图中心
      panX = (vp.clientWidth - svgW * zoom) / PADDING_BOTH_SIDES
      panY = (vp.clientHeight - svgH * zoom) / PADDING_BOTH_SIDES
    }
    applyTransform(mode)
  }

  function resetOneToOne(): void {
    zoom = clamp(1, CONFIG.minZoom, CONFIG.maxZoom)
    const vp = viewportRef.value
    if (vp) {
      panX = (vp.clientWidth - svgW * zoom) / PADDING_BOTH_SIDES
      panY = (vp.clientHeight - svgH * zoom) / PADDING_BOTH_SIDES
    }
    applyTransform('1:1')
  }

  function zoomAround(factor: number): void {
    const vp = viewportRef.value
    if (!vp) return
    const next = clamp(zoom * factor, CONFIG.minZoom, CONFIG.maxZoom)
    // 围绕视口中心缩放：保持中心点不动，反推 pan
    const cx = vp.clientWidth / PADDING_BOTH_SIDES
    const cy = vp.clientHeight / PADDING_BOTH_SIDES
    const ratio = next / zoom
    panX = cx - ratio * (cx - panX)
    panY = cy - ratio * (cy - panY)
    zoom = next
    applyTransform('custom')
  }

  const zoomIn = (): void => zoomAround(1 + CONFIG.zoomStep)
  const zoomOut = (): void => zoomAround(1 / (1 + CONFIG.zoomStep))

  /** 视口尺寸变化时重新 fit（ResizeObserver 回调；当前未接线，保留供未来） */
  function onViewportResize(): void {
    if (svgW) fit()
  }

  return { zoomLabel, zoomIn, zoomOut, fit, resetOneToOne, syncSvg, onViewportResize }
}
