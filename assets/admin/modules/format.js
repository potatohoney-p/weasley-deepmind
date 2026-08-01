/**
 * Memento MCP Admin Console — 순수 포맷팅 유틸리티
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 *
 * 의존성 없음. DOM/state/API 접근 없음.
 */

/** HTML 특수문자를 이스케이프한다. */
export function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 숫자를 한국어 로케일 형식으로 포맷한다. */
export function fmt(n) {
  if (n == null) return "0";
  return Number(n).toLocaleString("ko-KR");
}

/** 밀리초를 소수점 한 자리 ms 문자열로 포맷한다. */
export function fmtMs(ms) {
  if (ms == null) return "-";
  return Number(ms).toFixed(1) + "ms";
}

/** 0~1 사이 값을 백분율 문자열로 포맷한다. */
export function fmtPct(val) {
  if (val == null) return "-";
  return (Number(val) * 100).toFixed(1) + "%";
}

/** ISO 날짜 문자열을 한국어 날짜+시간 형식으로 포맷한다. */
export function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("ko-KR") + " " + d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

/** 바이트 수를 사람이 읽기 좋은 단위 문자열로 포맷한다. */
export function fmtBytes(bytes) {
  if (bytes == null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let val = Number(bytes);
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return val.toFixed(1) + " " + units[idx];
}

/** 문자열을 지정 길이로 잘라내고 "..."을 붙인다. */
export function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

/** ISO 날짜 또는 타임스탬프를 상대 시간 문자열로 변환한다. */
export function relativeTime(iso) {
  const ts   = typeof iso === "number" ? iso : new Date(iso).getTime();
  const diff = Date.now() - ts;
  const min  = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const day = Math.floor(hr / 24);
  return day + "d ago";
}

/** 로딩 스피너 DOM 엘리먼트를 생성하여 반환한다. */
export function loadingHtml() {
  const div = document.createElement("div");
  div.className = "loading-spinner";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "spinner-dot";
    div.appendChild(dot);
  }
  return div;
}
