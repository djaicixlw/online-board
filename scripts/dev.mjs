import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..");
const devVarsExamplePath = resolve(repoRoot, ".dev.vars.example");
const workerDevVarsPath = resolve(repoRoot, "worker/.dev.vars");
const webDistDir = resolve(repoRoot, "web/dist");
const webDistIndex = resolve(webDistDir, "index.html");

if (!existsSync(workerDevVarsPath) && existsSync(devVarsExamplePath)) {
  copyFileSync(devVarsExamplePath, workerDevVarsPath);
  console.log("[dev] Создан worker/.dev.vars из .dev.vars.example (для локальной разработки).");
}

if (!existsSync(webDistIndex)) {
  mkdirSync(webDistDir, { recursive: true });
  writeFileSync(
    webDistIndex,
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"UTF-8\"/><title>Онлайн-доска (dev)</title></head><body><p>Используйте Vite dev-сервер (http://localhost:5173) или выполните npm run build для сборки web/dist.</p></body></html>\n",
    "utf8",
  );
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function startProcess(label, args) {
  const child = spawn(npmCmd, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk.toString()}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk.toString()}`);
  });

  return child;
}

console.log("[dev] Запуск локального окружения: worker (http://localhost:8787) и web (http://localhost:5173)...");

const workerProc = startProcess("worker", ["--workspace=@online-board/worker", "run", "dev"]);
const webProc = startProcess("web", ["--workspace=@online-board/web", "run", "dev"]);

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  workerProc.kill("SIGTERM");
  webProc.kill("SIGTERM");
  setTimeout(() => {
    process.exit(exitCode);
  }, 200);
}

workerProc.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[dev] Процесс worker завершился с кодом ${code ?? 0}. Остановка...`);
    shutdown(code ?? 1);
  }
});

webProc.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[dev] Процесс web завершился с кодом ${code ?? 0}. Остановка...`);
    shutdown(code ?? 1);
  }
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
