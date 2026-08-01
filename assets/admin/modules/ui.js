/**
 * Memento MCP Admin Console — UI 컴포넌트 (Toast / Modal)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 *
 * DOM만 조작하며 state/api 의존성 없음.
 */

/**
 * 토스트 메시지를 화면 하단에 표시한다.
 *
 * @param {string} message - 표시할 메시지
 * @param {string} type    - CSS 클래스 ("info" | "success" | "error" 등)
 */
export function showToast(message, type = "info") {
  const root = document.getElementById("toast-root");
  if (!root) return;

  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  root.appendChild(el);

  setTimeout(() => {
    el.classList.add("fade-out");
    el.addEventListener("animationend", () => el.remove());
  }, 3000);
}

/**
 * 모달 다이얼로그를 표시한다.
 *
 * @param {string}      title   - 모달 제목
 * @param {Node|string} bodyEl  - 본문 (DOM 노드 또는 텍스트 문자열)
 * @param {Array}       actions - 버튼 정의 배열 [{ label, cls, handler }]
 */
export function showModal(title, bodyEl, actions) {
  const root = document.getElementById("modal-root");
  if (!root) return;

  root.textContent = "";

  const card = document.createElement("div");
  card.className = "modal-card";

  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  card.appendChild(titleEl);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "modal-body";
  if (typeof bodyEl === "string") {
    bodyWrap.appendChild(buildSafeHtml(bodyEl));
  } else if (bodyEl instanceof Node) {
    bodyWrap.appendChild(bodyEl);
  }
  card.appendChild(bodyWrap);

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "modal-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "CANCEL";
  cancelBtn.addEventListener("click", closeModal);
  actionsWrap.appendChild(cancelBtn);

  if (actions && actions.length) {
    actions.forEach(a => {
      const btn = document.createElement("button");
      btn.className = "btn " + (a.cls || "");
      btn.textContent = a.label;
      if (a.handler) btn.addEventListener("click", a.handler);
      actionsWrap.appendChild(btn);
    });
  }

  card.appendChild(actionsWrap);
  root.appendChild(card);
  root.classList.add("visible");
}

/** 모달 다이얼로그를 닫는다. */
export function closeModal() {
  const root = document.getElementById("modal-root");
  if (root) {
    root.classList.remove("visible");
    root.textContent = "";
  }
}

/**
 * 텍스트를 XSS-safe span 엘리먼트로 감싸 반환한다.
 *
 * @param  {string} text - 표시할 텍스트
 * @returns {HTMLSpanElement}
 */
export function buildSafeHtml(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}
