/**
 * SVG Donut Chart — zero dependencies, responsive.
 * Renders a donut/ring chart with labels and a center stat.
 */

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export interface DonutConfig {
  width?: number;
  height?: number;
  radius?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}

const DEFAULT_CONFIG: Required<DonutConfig> = {
  width: 240,
  height: 240,
  radius: 80,
  thickness: 24,
  centerLabel: "",
  centerValue: "",
};

export function renderDonutChart(
  container: HTMLElement,
  slices: DonutSlice[],
  config: DonutConfig = {},
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { width, height, radius, thickness, centerLabel, centerValue } = cfg;

  if (slices.length === 0) {
    container.innerHTML = '<p class="empty-state">No data</p>';
    return;
  }

  const cx = width / 2;
  const cy = height / 2;
  const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
  const circumference = 2 * Math.PI * radius;

  let arcs = "";
  let legend = "";
  let offset = 0;

  for (const slice of slices) {
    const pct = slice.value / total;
    const dashLen = pct * circumference;
    const gapLen = circumference - dashLen;

    arcs += `<circle
      cx="${cx}" cy="${cy}" r="${radius}"
      fill="none"
      stroke="${slice.color}"
      stroke-width="${thickness}"
      stroke-dasharray="${dashLen} ${gapLen}"
      stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${cx} ${cy})"
      class="donut-slice"
      data-label="${slice.label}"
      data-value="${slice.value}"
      data-pct="${Math.round(pct * 100)}"
    />`;

    offset += dashLen;

    legend += `
      <div class="donut-legend-item">
        <span class="donut-legend-dot" style="background:${slice.color}"></span>
        <span class="donut-legend-label">${slice.label}</span>
        <span class="donut-legend-value">${slice.value}</span>
        <span class="donut-legend-pct">${Math.round(pct * 100)}%</span>
      </div>
    `;
  }

  const svg = `
    <div class="donut-chart-wrap">
      <svg viewBox="0 0 ${width} ${height}" width="${Math.min(width, 200)}" height="${Math.min(height, 200)}" class="donut-chart-svg">
        <!-- Background ring -->
        <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="${thickness}" />
        ${arcs}
        ${centerValue ? `<text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#fff" font-size="20" font-weight="700" font-family="SF Mono, Menlo, monospace">${centerValue}</text>` : ""}
        ${centerLabel ? `<text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10" font-family="SF Mono, Menlo, monospace">${centerLabel}</text>` : ""}
      </svg>
      <div class="donut-legend">${legend}</div>
    </div>
  `;

  container.innerHTML = svg;

  // Hover effect — show slice info
  const svgEl = container.querySelector("svg");
  if (svgEl) {
    const sliceEls = svgEl.querySelectorAll(".donut-slice");
    sliceEls.forEach(el => {
      el.addEventListener("mouseenter", () => {
        (el as SVGCircleElement).setAttribute("stroke-width", String(thickness + 4));
      });
      el.addEventListener("mouseleave", () => {
        (el as SVGCircleElement).setAttribute("stroke-width", String(thickness));
      });
    });
  }
}
