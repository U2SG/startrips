import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";

export function normalizeQaBaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`QA_BASE_URL must use http or https: ${value}`);
  }
  return url.toString().replace(/\/$/, "");
}

export async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate QA loopback port")));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode != null;
}

export async function waitForChildExitOrTimeout(child, timeoutMs = 5_000) {
  if (hasChildExited(child)) return "exit";
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      if (timer) clearTimeout(timer);
      resolve(reason);
    };
    const onExit = () => finish("exit");
    child.once("exit", onExit);
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref?.();
  });
}

async function waitForHttpReady(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (hasChildExited(child)) {
      const reason = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      throw new Error(`QA Vite server exited before becoming ready (${reason})`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`QA Vite server did not become ready within ${timeoutMs}ms: ${lastError ?? "unknown error"}`);
}

export async function startOwnedQaViteServer({ cwd = process.cwd(), timeoutMs = 60_000 } = {}) {
  const port = await allocateLoopbackPort();
  const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
  const child = spawn(process.execPath, [
    viteBin,
    "--host", LOOPBACK_HOST,
    "--port", String(port),
    "--strictPort",
  ], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const collect = (chunk) => {
    output += chunk.toString();
    if (output.length > 32_000) output = output.slice(-32_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
  try {
    await waitForHttpReady(baseUrl, child, timeoutMs);
  } catch (error) {
    if (!hasChildExited(child)) child.kill();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
  return {
    baseUrl,
    async close() {
      if (hasChildExited(child)) return;
      child.kill();
      await waitForChildExitOrTimeout(child);
      if (!hasChildExited(child)) child.kill("SIGKILL");
    },
  };
}
