/**
 * 최소 DOM shim -- admin.js 유닛 테스트용
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 *
 * 브라우저 DOM API의 최소 구현.
 * 실제 렌더 결과의 텍스트/클래스만 검증하는 수준.
 *
 * 보안 참고: loadAdminModule()의 Function 생성자는 프로젝트 소유 파일(admin.js)만
 * 대상으로 하며, 사용자 입력은 일절 관여하지 않음.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

class MiniElement {
  constructor(tag) {
    this.tagName     = tag.toUpperCase();
    this.className   = "";
    this.id          = "";
    this.textContent = "";
    this.children    = [];
    this.dataset     = {};
    this.style       = {};
    this.attributes  = {};
    this.colSpan     = 0;
    this.type        = "";
    this.value       = "";
    this.placeholder = "";
    this.autocomplete = "";
    this.disabled    = false;
    this.selected    = false;
    this.parentNode  = null;
    this.href        = "";
  }

  get classList() {
    const self = this;
    return {
      add(cls)    { self.className = (self.className ? self.className + " " + cls : cls); },
      remove(cls) { self.className = self.className.replace(new RegExp("\\b" + cls + "\\b", "g"), "").trim(); },
      contains(cls) { return self.className.split(/\s+/).includes(cls); }
    };
  }

  appendChild(child) {
    if (child && child.tagName !== undefined) {
      child.parentNode = this;
    }
    this.children.push(child);
    return child;
  }

  querySelectorAll() { return []; }
  querySelector()    { return null; }
  addEventListener() {}
  remove()           {}

  get innerHTML()    { return this._innerHTML || ""; }
  set innerHTML(v)   { this._innerHTML = v; this.children = []; }

  hasClass(cls) {
    return this.className.split(/\s+/).includes(cls);
  }
}

class MiniDocumentFragment {
  constructor() {
    this.children = [];
    this.tagName  = undefined;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  querySelectorAll() { return []; }
}

function createElement(tag) {
  return new MiniElement(tag);
}

function createDocumentFragment() {
  return new MiniDocumentFragment();
}

function setupGlobals() {
  globalThis.document = {
    createElement,
    createDocumentFragment,
    createTextNode: (t) => t,
    getElementById: () => null,
    addEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null
  };
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 0, headers: { get: () => "" } });
  globalThis.Node = MiniElement;
  try {
    globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  } catch {
    /* navigator is a getter-only in some Node versions; safely ignore */
  }
}

/**
 * admin.js를 로드하여 테스트용 exports를 반환.
 * Function 생성자 사용: 프로젝트 소유 assets/admin/admin.js (고정 경로)만
 * 대상이며, 외부/사용자 입력은 관여하지 않음.
 */
function loadAdminModule() {
  setupGlobals();

  const adminPath = path.join(__dirname, "..", "..", "assets", "admin", "admin.js");
  const code      = fs.readFileSync(adminPath, "utf-8");
  const myExports = {};
  const myModule  = { exports: myExports };

  const wrapper = new Function("module", "exports", "require", code);  // SAFE: test-only, fixed project file
  wrapper(myModule, myExports, (id) => {
    throw new Error("require() not supported in admin.js test: " + id);
  });

  return myModule.exports;
}

export { MiniElement, MiniDocumentFragment, setupGlobals, loadAdminModule };
