import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";

const DEFAULT_CACHE_DIR = process.env.WEASLEY_DEEPMIND_HOME
  ? path.resolve(process.env.WEASLEY_DEEPMIND_HOME)
  : path.join(os.homedir(), ".weasley", "deepmind");
const LEGACY_CACHE_FILE = path.join(os.homedir(), ".weasley-deepmind", "update-check.json");
const CACHE_FILENAME    = "update-check.json";

export class UpdateCache {
  constructor(cacheDir = DEFAULT_CACHE_DIR) {
    this._dir  = cacheDir;
    this._path = path.join(cacheDir, CACHE_FILENAME);
  }

  get() {
    try {
      return JSON.parse(fs.readFileSync(this._path, "utf8"));
    } catch {
      if (this._path !== path.join(DEFAULT_CACHE_DIR, CACHE_FILENAME)) return null;
      try {
        return JSON.parse(fs.readFileSync(LEGACY_CACHE_FILE, "utf8"));
      } catch {
        return null;
      }
    }
  }

  set(data) {
    try {
      fs.mkdirSync(this._dir, { recursive: true });
      fs.writeFileSync(this._path, JSON.stringify({ ...data, lastCheck: new Date().toISOString() }, null, 2));
    } catch { /* 쓰기 실패 시 무시 */ }
  }

  isExpired(ttlHours) {
    const cached = this.get();
    if (!cached || !cached.lastCheck) return true;
    return Date.now() - new Date(cached.lastCheck).getTime() > ttlHours * 3_600_000;
  }
}
