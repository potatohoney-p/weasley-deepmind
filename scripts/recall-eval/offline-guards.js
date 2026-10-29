import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

/** Install only inside a disposable evaluation child, before production imports. */
export function installOfflineGuards(fail) {
  globalThis.fetch = fail;
  http.request = http.get = https.request = https.get = fail;
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = fail;
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    childProcess[method] = fail;
  }
  syncBuiltinESMExports();
}
