/**
 * SVG Line Chart — zero dependencies, responsive.
 * Renders a line chart with axes, gridlines, and hover tooltips.
 */

export interface LineChartPoint {
  label: string;
  value: number;
}

export interface LineChartConfig {
  width?: number;
  height?: number;
  color?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  showDots?: boolean;
  showGrid?: boolean;
  gridLines?: number;
  formatLabel?: (label: string) => string;
  formatValue?: (value: number) => string;
}

const DEFAULT_CONFIG: Required<LineChartConfig> = {
  width: 600,
  height: 200,
  color: "#4ade80",
  fillOpacity: 0.1,
  strokeWidth: 2,
  showDots: true,
  showGrid: true,
  gridLines: 4,
  formatLabel: (l: string) => l,
  formatValue: (v: number) => String(v),
};

export function renderLineChart(
  container: HTMLElement,
  points: LineChartPoint[],
  config: LineChartConfig = {},
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { width, height, color, fillOpacity, strokeWidth, showDots, showGrid, gridLines } = cfg;

  if (points.length === 0) {
    container.innerHTML = '<p class="empty-state">No data</p>';
    return;
  }

  const padding = { top: 10, right: 20, bottom: 30, left: 40 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const values = points.map(p => p.value);
  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 1);
  const range = maxVal - minVal || 1;

  const xScale = (i: number) => padding.left + (i / Math.max(points.length - 1, 1)) * chartW;
  const yScale = (v: number) => padding.top + chartH - ((v - minVal) / range) * chartH;

  // Grid lines
  let gridSvg = "";
  if (showGrid) {
    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + (i / gridLines) * chartH;
      const val = maxVal - (i / gridLines) * range;
      gridSvg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(255,255,255,0.06)" />`;
      gridSvg += `<text x="${padding.left - 6}" y="${y + 3}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="SF Mono, Menlo, monospace">${cfg.formatValue(val)}</text>`;
    }
  }

  // X-axis labels (show max ~8 labels)
  const labelInterval = Math.max(1, Math.floor(points.length / 8));
  let labelsSvg = "";
  for (let i = 0; i < points.length; i++) {
    if (i % labelInterval === 0 || i === points.length - 1) {
      labelsSvg += `<text x="${xScale(i)}" y="${height - 6}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="10" font-family="SF Mono, Menlo, monospace">${cfg.formatLabel(points[i].label)}</text>`;
    }
  }

  // Line path
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(p.value)}`).join(" ");

  // Fill area
  const fillPath = linePath +
    ` L${xScale(points.length - 1)},${yScale(minVal)}` +
    ` L${xScale(0)},${yScale(minVal)} Z`;

  // Dots
  let dotsSvg = "";
  if (showDots) {
    dotsSvg = points.map((p, i) =>
      `<circle cx="${xScale(i)}" cy="${yScale(p.value)}" r="3" fill="${color}" stroke="#0a0a0a" stroke-width="1.5" class="chart-dot" data-value="${p.value}" data-label="${p.label}" />`
    ).join("");
  }

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" class="line-chart-svg">
      ${gridSvg}
      <path d="${fillPath}" fill="${color}" fill-opacity="${fillOpacity}" />
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" />
      ${dotsSvg}
      ${labelsSvg}
    </svg>
  `;

  container.innerHTML = svg;

  // Hover tooltip
  const svgEl = container.querySelector("svg");
  if (svgEl && showDots) {
    const dots = svgEl.querySelectorAll(".chart-dot");
    let tooltip: SVGTextElement | null = null;

    dots.forEach(dot => {
      dot.addEventListener("mouseenter", () => {
        const val = (dot as SVGCircleElement).dataset.value;
        const label = (dot as SVGCircleElement).dataset.label;
        if (!val || !label) return;

        const cx = Number((dot as SVGCircleElement).getAttribute("cx"));
        const cy = Number((dot as SVGCircleElement).getAttribute("cy"));

        tooltip = document.createElementNS("http://www.w3.org/2000/svg", "text");
        tooltip.setAttribute("x", String(cx));
        tooltip.setAttribute("y", String(cy - 10));
        tooltip.setAttribute("text-anchor", "middle");
        tooltip.setAttribute("fill", "#fff");
        tooltip.setAttribute("font-size", "11");
        tooltip.setAttribute("font-family", "SF Mono, Menlo, monospace");
        tooltip.textContent = `${cfg.formatLabel(label)}: ${cfg.formatValue(Number(val))}`;
        svgEl.appendChild(tooltip);
      });

      dot.addEventListener("mouseleave", () => {
        if (tooltip) { tooltip.remove(); tooltip = null; }
      });
    });
  }
}
