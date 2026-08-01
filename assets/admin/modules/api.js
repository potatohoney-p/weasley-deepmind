/**
 * Memento MCP Admin Console — API 클라이언트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 *
 * state.masterKey를 Authorization 헤더에 주입하여 내부 API를 호출한다.
 */

import { state } from "./state.js";

export const API_BASE = "/v1/internal/model/nothing";

/**
 * 내부 Admin API를 호출한다.
 *
 * @param {string} path    - API_BASE에 이어지는 경로 (예: "/auth")
 * @param {Object} options - fetch options (method, body, headers 등)
 * @returns {{ ok: boolean, status: number, data: any, error?: string }}
 */
export async function api(path, options = {}) {
  const url     = `${API_BASE}${path}`;
  const headers = { "Authorization": `Bearer ${state.masterKey}` };

  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }

  try {
    const resp = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    let data   = null;
    const ct   = resp.headers.get("content-type") || "";
    if (ct.includes("json") && resp.status !== 204) {
      data = await resp.json();
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}
