/**
 * Memento MCP Admin Console — SVG Sparkline 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 외부 의존성 없음. 순수 SVG + DOM API.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * container 엘리먼트 안에 SVG 미니 라인 차트를 렌더링한다.
 *
 * @param {HTMLElement} container  - sparkline을 붙일 부모 엘리먼트
 * @param {Array<{ts: string, value: number}>} data - 시계열 배열
 * @param {{
 *   width?: number,
 *   height?: number,
 *   stroke?: string,
 *   fill?: string,
 *   showAxis?: boolean
 * }} [opts]
 */
export function renderSparkline(container, data, opts = {}) {
  const width   = opts.width   ?? 160;
  const height  = opts.height  ?? 40;
  const stroke  = opts.stroke  ?? "#4a90e2";
  const fill    = opts.fill    ?? "rgba(74,144,226,0.15)";

  /* 기존 SVG 제거 (재호출 대비) */
  container.textContent = "";

  /* 데이터 없음 처리 */
  if (!data || data.length === 0) {
    const msg = document.createElement("span");
    msg.className = "metrics-sparkline__empty";
    msg.textContent = "데이터 없음";
    container.appendChild(msg);
    return;
  }

  const n      = data.length;
  const values = data.map(d => d.value);
  const min    = Math.min(...values);
  const max    = Math.max(...values);
  const range  = max - min;

  /**
   * value → SVG y 좌표.
   * range === 0 (모든 값 동일) 이면 중앙에 수평선.
   *
   * @param {number} v
   * @returns {number}
   */
  function toY(v) {
    if (range === 0) return height / 2;
    return height - ((v - min) / range) * height;
  }

  /** @param {number} i - 인덱스 */
  function toX(i) {
    if (n === 1) return width / 2;
    return (i / (n - 1)) * width;
  }

  /* points 문자열 (polyline + polygon 공용) */
  const pts = data.map((d, i) => `${toX(i)},${toY(d.value)}`).join(" ");

  /* polygon points: 라인 points + 오른쪽 하단 + 왼쪽 하단 (fill 영역) */
  const polygonPts = `${pts} ${toX(n - 1)},${height} ${toX(0)},${height}`;

  /* SVG 생성 */
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width",    String(width));
  svg.setAttribute("height",   String(height));
  svg.setAttribute("viewBox",  `0 0 ${width} ${height}`);
  svg.setAttribute("xmlns",    SVG_NS);
  svg.className = "metrics-sparkline__svg";

  /* fill 영역 */
  const polygon = document.createElementNS(SVG_NS, "polygon");
  polygon.setAttribute("points", polygonPts);
  polygon.setAttribute("fill",   fill);
  polygon.setAttribute("stroke", "none");
  svg.appendChild(polygon);

  /* 라인 */
  const polyline = document.createElementNS(SVG_NS, "polyline");
  polyline.setAttribute("points",       pts);
  polyline.setAttribute("fill",         "none");
  polyline.setAttribute("stroke",       stroke);
  polyline.setAttribute("stroke-width", "1.5");
  polyline.setAttribute("stroke-linejoin", "round");
  polyline.setAttribute("stroke-linecap",  "round");
  svg.appendChild(polyline);

  container.appendChild(svg);
}

/**
 * ISO8601 타임스탬프 기준으로 data 배열을 필터링한다.
 *
 * @param {Array<{ts: string, value: number}>} data
 * @param {number} windowMs - 유지할 구간 (밀리초). 현재 시각 기준 과거 방향.
 * @returns {Array<{ts: string, value: number}>}
 */
export function filterByWindow(data, windowMs) {
  if (!data || data.length === 0) return [];
  const cutoff = Date.now() - windowMs;
  return data.filter(d => new Date(d.ts).getTime() >= cutoff);
}
