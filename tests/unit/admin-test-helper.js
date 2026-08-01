/**
 * admin.js 테스트 헬퍼 -- VM 기반 로딩
 *
 * admin.js는 브라우저 SPA로 module.exports guard를 CJS 조건으로 사용.
 * ESM 프로젝트("type": "module")에서 createRequire로 로드하면
 * .js가 ESM으로 해석되어 module.exports가 동작하지 않음.
 * vm.Script로 CJS sandbox에서 실행하여 exports를 추출한다.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ADMIN_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../assets/admin/admin.js"
);

/* ----------------------------------------------------------------
   Minimal DOM mock
   ---------------------------------------------------------------- */

class MockElement {
  constructor(tag) {
    this.tagName    = tag.toUpperCase();
    this.className  = "";
    this.textContent = "";
    this.children   = [];
    this.childNodes = [];
    this.style      = {};
    this.dataset    = {};
    this._attrs     = {};
    this._listeners = {};
    this.parentNode = null;
    this.type       = undefined;
    this.min        = undefined;
    this.max        = undefined;
    this.value      = undefined;
    this.placeholder = undefined;
    this.autocomplete = undefined;
    this.selected   = false;
    this.disabled   = false;
    this.href       = undefined;
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k)    { return this._attrs[k] ?? null; }
  appendChild(child) {
    if (child && typeof child === "object") {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
    }
    return child;
  }
  addEventListener(ev, fn) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
  }
  querySelectorAll(sel) { return flatQuery(this, sel); }
  querySelector(sel)    { return flatQuery(this, sel)[0] ?? null; }
  remove() {}
  classList = { add() {}, remove() {}, contains() { return false; } };
  get id() { return this.dataset._id ?? ""; }
  set id(v) { this.dataset._id = v; }
  set colSpan(v) { this._attrs.colspan = v; }
}

/**
 * querySelectorAll 구현 -- 단순 class/tag/[data-*] 매칭
 */
function flatQuery(root, sel) {
  const all = [];
  function walk(node) {
    if (!node || !node.children) return;
    for (const child of node.children) {
      all.push(child);
      walk(child);
    }
  }
  walk(root);
  return all.filter(el => matchesSelector(el, sel));
}

function matchesSelector(el, sel) {
  if (!el || typeof el.className !== "string") return false;
  const parts = sel.split(/(?=[.#[])/);
  for (const part of parts) {
    if (part.startsWith(".")) {
      const cls = part.slice(1).replace(/\\\//g, "/");
      if (!el.className.split(/\s+/).includes(cls)) return false;
    } else if (part.startsWith("#")) {
      if (el.dataset?._id !== part.slice(1)) return false;
    } else if (part.startsWith("[")) {
      const m = part.match(/\[([^\]=]+)(?:='([^']*)')?\]/);
      if (m) {
        const attr = m[1];
        if (attr.startsWith("data-")) {
          const key = attr.replace("data-", "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          if (el.dataset?.[key] == null) return false;
          if (m[2] !== undefined && el.dataset[key] !== m[2]) return false;
        } else if (attr === "type") {
          if (el.type !== m[2] && el._attrs?.type !== m[2]) return false;
        } else {
          if (el._attrs?.[attr] == null) return false;
          if (m[2] !== undefined && el._attrs[attr] !== m[2]) return false;
        }
      }
    } else if (part === "th" || part === "button" || part === "h2" || part === "svg" || part === "input" || part === "select") {
      if (el.tagName !== part.toUpperCase()) return false;
    }
  }
  return true;
}

/**
 * loadAdmin이 ESM admin.js를 만났을 때 던지는 sentinel 에러.
 * 테스트 파일은 이 에러를 catch하여 describe.skip으로 우회한다.
 */
export class AdminEsmLoadError extends Error {
  constructor() {
    super("admin.js is now an ESM entry point. loadAdmin() VM sandbox is incompatible. " +
          "Tests should import from assets/admin/modules/* directly. " +
          "See ~/.claude/plans/memento-security-hardening.md Step 1.0.2.");
    this.name = "AdminEsmLoadError";
  }
}

/**
 * admin.js를 VM sandbox에서 로드하고 module.exports를 반환
 */
export function loadAdmin() {
  const code = readFileSync(ADMIN_PATH, "utf-8");

  /** ESM 진입점 감지: import/export 문이 있으면 vm.runInContext가 SyntaxError를 발생시킨다.
   *  명시적 sentinel 에러로 변환하여 테스트가 skip 처리할 수 있게 한다. */
  if (/^\s*(import|export)\s/m.test(code)) {
    throw new AdminEsmLoadError();
  }

  const mockModule  = { exports: {} };
  const mockExports = mockModule.exports;

  const sandbox = {
    module:  mockModule,
    exports: mockExports,
    require: () => null,

    document: {
      createElement(tag) { return new MockElement(tag); },
      createElementNS(ns, tag) { return new MockElement(tag); },
      createDocumentFragment() { return new MockElement("fragment"); },
      createTextNode(text) { return { textContent: text, nodeType: 3 }; },
      getElementById() { return null; },
      querySelector() { return null; },
      addEventListener() {},
      body: new MockElement("body")
    },

    window: { location: { search: "" } },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Node: MockElement,
    HTMLElement: MockElement,
    console,
    Date,
    Number,
    Math,
    String,
    Array,
    Object,
    JSON,
    Set,
    Map,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    URLSearchParams,
    Promise,
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) }),
    navigator: { clipboard: { writeText: async () => {} } }
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: ADMIN_PATH });

  return mockModule.exports;
}

export { flatQuery };

/**
 * Node.js global에 DOM mock을 주입한다.
 * modules/*.js를 직접 import하는 테스트에서 import 전에 호출해야 한다.
 * 멱등적 — 이미 설정되어 있으면 재할당하지 않는다.
 */
export function setupDom() {
  if (global.document) return;

  global.document = {
    createElement(tag) { return new MockElement(tag); },
    createElementNS(_ns, tag) { return new MockElement(tag); },
    createDocumentFragment() { return new MockElement("fragment"); },
    createTextNode(text) { return { textContent: text, nodeType: 3 }; },
    getElementById() { return null; },
    querySelector() { return null; },
    addEventListener() {},
    body: new MockElement("body")
  };

  global.window      = { location: { search: "" } };
  global.sessionStorage = {
    getItem:    () => null,
    setItem:    () => {},
    removeItem: () => {}
  };
  global.Node        = MockElement;
  global.HTMLElement = MockElement;
  /* navigator는 Node.js v24에서 read-only getter이므로 defineProperty 사용 */
  try {
    Object.defineProperty(global, "navigator", {
      value: { clipboard: { writeText: async () => {} } },
      writable: true, configurable: true
    });
  } catch (_) { /* 이미 정의된 경우 무시 */ }
  global.fetch       = async () => ({
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({})
  });
  global.setTimeout  = (fn) => fn();
  global.clearTimeout = () => {};
}
