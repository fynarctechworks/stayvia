// Frees the API dev port before nodemon starts. Cross-platform.
//
// We keep ending up with zombie node processes holding port 3001 —
// usually after a module-load crash where nodemon's parent dies but
// the child keeps the socket open. Rather than asking the dev to
// hunt the PID by hand every time, run this `predev` hook.
//
// Strategy:
//   - On Windows, use `netstat -ano | findstr :3001` to find the PID,
//     then `taskkill /F /PID <pid>`.
//   - On Unix, use `lsof -ti:3001 | xargs -r kill -9`.
// Both are forgiving: if the port is already free we just exit 0.
// We never fail the predev — the worst that happens is nodemon hits
// the EADDRINUSE itself, which is the same situation as today.

import { execSync } from "node:child_process";
import { platform } from "node:os";

const PORT = Number(process.env.PORT ?? 3001);

function kill(pid) {
  try {
    if (platform() === "win32") {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
    console.log(`[free-port] killed pid ${pid} holding :${PORT}`);
  } catch {
    /* already gone — fine */
  }
}

try {
  if (platform() === "win32") {
    const out = execSync(`netstat -ano -p TCP`, { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      // Match LISTENING rows for the port. Field layout:
      //   Proto  Local Address  Foreign Address  State  PID
      const m = line.match(/\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === PORT) pids.add(Number(m[2]));
    }
    for (const pid of pids) kill(pid);
  } else {
    const out = execSync(`lsof -ti:${PORT} || true`, { encoding: "utf8" });
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      kill(Number(pid));
    }
  }
} catch (err) {
  // Don't break dev startup on a probing failure.
  console.warn(
    `[free-port] probe failed: ${err instanceof Error ? err.message : err}`,
  );
}
