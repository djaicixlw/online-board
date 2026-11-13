#!/usr/bin/env node
/* global fetch, AbortSignal */
/**
 * verify-all.mjs: one-command verification of the online-board repository.
 *
 * Put this file into scripts/ and run it from the repo root:
 *   node scripts/verify-all.mjs
 *
 * It runs install, licenses, typecheck, lint, tests, build, Playwright e2e and
 * live WebSocket checks against a real `wrangler dev`, then writes:
 *   verify-report.md   short report you can paste into a chat
 *   verify-logs/*.log  full output of every step
 *
 * Flags:  --skip-e2e   --skip-live
 * Env:    VERIFY_WS_URL=ws://host:port  use an already running server (only live checks run)
 *         VERIFY_DRY_RUN=1              replace every command with a harmless fake (self-test)
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logsDir = join(root, "verify-logs");
const reportPath = join(root, "verify-report.md");
const flags = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";
const dryRun = process.env.VERIFY_DRY_RUN === "1";
const externalWsUrl = process.env.VERIFY_WS_URL ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodeMajor = Number(process.versions.node.split(".")[0]);

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", shell: isWin });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

function killTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  try {
    if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // the process is already gone
  }
}

function startProcess(cmdline, { env = {}, logFile }) {
  const child = spawn(cmdline, {
    cwd: root,
    shell: true,
    detached: !isWin,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env },
  });
  const onData = (chunk) => appendFileSync(logFile, chunk);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return child;
}

function excerpt(logFile) {
  const lines = readFileSync(logFile, "utf8").split(/\r?\n/);
  if (lines.length <= 110) return lines.join("\n");
  const skipped = lines.length - 100;
  return [
    ...lines.slice(0, 60),
    `... (${skipped} строк пропущено, полный лог в файле) ...`,
    ...lines.slice(-40),
  ].join("\n");
}

function highlights(logFile) {
  // skip the first "$ command" header line so the command text is never matched
  const text = readFileSync(logFile, "utf8").split(/\r?\n/).slice(1).join("\n");
  const found = [];
  const tsErrors = (text.match(/error TS\d+/g) ?? []).length;
  if (tsErrors > 0) found.push(`ошибок TypeScript: ${tsErrors}`);
  const patterns = [
    /Test Files\s+.+/,
    /Tests\s+\d+.+/,
    /Found \d+ errors?.*/,
    /\d+ problems?.*/,
    /проверено.*/i,
    /added \d+ packages.*/,
    /up to date.*/,
    /\d+ (passed|failed).*/,
  ];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && patterns.some((p) => p.test(t)) && !found.includes(t.slice(0, 110)))
      found.push(t.slice(0, 110));
    if (found.length >= 4) break;
  }
  return found;
}

let stepNo = 0;
async function runStep(step) {
  stepNo += 1;
  const logFile = join(logsDir, `${String(stepNo).padStart(2, "0")}-${step.id}.log`);
  const cmd = dryRun ? step.dry : step.cmd;
  writeFileSync(logFile, `$ ${cmd}\n\n`);
  const started = Date.now();
  const child = startProcess(cmd, { env: step.env, logFile });
  const outcome = await new Promise((done) => {
    const timer = setTimeout(
      () => {
        killTree(child);
        done({ code: null, timedOut: true });
      },
      step.timeoutMs ?? 10 * 60 * 1000,
    );
    child.on("error", (e) => {
      appendFileSync(logFile, `\n[spawn error] ${e.message}\n`);
      clearTimeout(timer);
      done({ code: -1, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, timedOut: false });
    });
  });
  const status = step.info ? "INFO" : outcome.code === 0 ? "PASS" : "FAIL";
  if (outcome.timedOut) appendFileSync(logFile, "\n[timeout] шаг остановлен по тайм-ауту\n");
  const result = {
    id: step.id,
    title: step.title,
    status,
    code: outcome.code,
    timedOut: outcome.timedOut,
    ms: Date.now() - started,
    logFile,
    notes: highlights(logFile),
  };
  console.log(`${status.padEnd(4)} ${step.title} (${(result.ms / 1000).toFixed(1)} s)`);
  return result;
}

// ---------- live checks against a real server ----------

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function boardId() {
  let s = "";
  while (s.length < 22) {
    const b = randomBytes(1)[0];
    if (b < 248) s += B62[b % 62]; // 248 = 62 * 4, no modulo bias
  }
  return s;
}

const rect = (id) => ({
  id,
  type: "rectangle",
  x: 10,
  y: 10,
  width: 80,
  height: 40,
  angle: 0,
  isDeleted: false,
  version: 1,
  versionNonce: 1234567,
  updated: Date.now(),
  seed: 1,
  groupIds: [],
  frameId: null,
  boundElements: null,
  locked: false,
  index: "a0",
});

async function loadWebSocket() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  return (await import("ws")).default;
}

function connect(WS, url) {
  return new Promise((resolveP, rejectP) => {
    const ws = new WS(url);
    const inbox = [];
    const waiters = [];
    const text = (d) => (typeof d === "string" ? d : Buffer.from(d).toString("utf8"));
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(text(ev.data));
      } catch {
        return;
      }
      inbox.push(m);
      for (const w of waiters.slice()) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(m);
        }
      }
    });
    ws.addEventListener("error", () =>
      rejectP(
        new Error(
          `не удалось подключиться к ${url} (если сервер ответил 404, проверьте ALLOW_ANY_BOARD_ID=true в worker/.dev.vars)`,
        ),
      ),
    );
    ws.addEventListener("open", () =>
      resolveP({
        send: (o) => ws.send(JSON.stringify(o)),
        close: () => ws.close(1000),
        waitFor: (pred, ms = 10000) =>
          new Promise((res, rej) => {
            const hit = inbox.find(pred);
            if (hit) return res(hit);
            const w = {
              pred,
              resolve: res,
              timer: setTimeout(() => {
                waiters.splice(waiters.indexOf(w), 1);
                rej(new Error("истёк тайм-аут ожидания ответа сервера"));
              }, ms),
            };
            waiters.push(w);
          }),
      }),
    );
  });
}

async function joinForElements(WS, base, id, clientId) {
  const c = await connect(WS, `${base}/ws/${id}?nick=Verify`);
  c.send({ type: "hello", client_id: clientId, nick: "Verify" });
  const snap = await c.waitFor((m) => m.type === "snapshot");
  c.close();
  return Array.isArray(snap.elements) ? snap.elements : [];
}

async function liveChecks(base) {
  const WS = await loadWebSocket();
  const results = [];
  const scenario = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
      console.log(`PASS live: ${name}`);
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
      console.log(`FAIL live: ${name}: ${e.message}`);
    }
  };

  await scenario("ping получает pong", async () => {
    const c = await connect(WS, `${base}/ws/${boardId()}?nick=Verify`);
    c.send({ type: "ping" });
    await c.waitFor((m) => m.type === "pong", 3000);
    c.close();
    return "ответ pong получен";
  });

  await scenario("правка переживает 15 секунд тишины (соединение открыто)", async () => {
    const id = boardId();
    const c1 = await connect(WS, `${base}/ws/${id}?nick=Verify`);
    c1.send({ type: "hello", client_id: "verify-a", nick: "Verify" });
    await c1.waitFor((m) => m.type === "snapshot");
    c1.send({ type: "scene_update", elements: [rect("live-15s")] });
    await sleep(15500);
    const elements = await joinForElements(WS, base, id, "verify-b");
    c1.close();
    if (!elements.some((e) => e.id === "live-15s"))
      throw new Error("новый клиент не увидел элемент: правка потеряна");
    return "новый клиент увидел элемент через 15,5 с";
  });

  await scenario("правка сохраняется при немедленном закрытии вкладки", async () => {
    const id = boardId();
    const c1 = await connect(WS, `${base}/ws/${id}?nick=Verify`);
    c1.send({ type: "hello", client_id: "verify-a", nick: "Verify" });
    await c1.waitFor((m) => m.type === "snapshot");
    c1.send({ type: "scene_update", elements: [rect("live-close")] });
    await sleep(30);
    c1.close();
    await sleep(800);
    const elements = await joinForElements(WS, base, id, "verify-b");
    if (!elements.some((e) => e.id === "live-close"))
      throw new Error("новый клиент не увидел элемент: правка потеряна при закрытии");
    return "новый клиент увидел элемент через 0,8 с после закрытия";
  });

  return results;
}

async function waitForHealth(child) {
  const hosts = ["127.0.0.1:8787", "localhost:8787"];
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `wrangler dev завершился с кодом ${child.exitCode}, см. verify-logs/live-wrangler-dev.log`,
      );
    for (const host of hosts) {
      try {
        const res = await fetch(`http://${host}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return host;
      } catch {
        // not ready yet
      }
    }
    await sleep(1000);
  }
  throw new Error(
    "wrangler dev не ответил на /api/health за 120 секунд, см. verify-logs/live-wrangler-dev.log",
  );
}

function extractFlushes(logFile) {
  if (!logFile || !existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("snapshot_flush"))
    .map((l) => l.trim().slice(0, 260))
    .slice(-8);
}

async function runLive() {
  if (externalWsUrl) {
    return { results: await liveChecks(externalWsUrl), flushes: [], error: "" };
  }
  const devVars = join(root, "worker", ".dev.vars");
  const example = join(root, ".dev.vars.example");
  if (!existsSync(devVars) && existsSync(example)) copyFileSync(example, devVars);
  const logFile = join(logsDir, "live-wrangler-dev.log");
  writeFileSync(logFile, "$ npm --workspace=@online-board/worker run dev\n\n");
  const child = startProcess("npm --workspace=@online-board/worker run dev", {
    env: { WRANGLER_SEND_METRICS: "false" },
    logFile,
  });
  try {
    const host = await waitForHealth(child);
    const results = await liveChecks(`ws://${host}`);
    await sleep(1500); // let the last flush land in the log
    return { results, flushes: extractFlushes(logFile), error: "" };
  } catch (e) {
    return { results: [], flushes: extractFlushes(logFile), error: e.message };
  } finally {
    killTree(child);
    await sleep(500);
  }
}

// ---------- main ----------

function preflightWarnings() {
  const warnings = [];
  const devScript = join(root, "scripts", "dev.mjs");
  if (isWin && existsSync(devScript)) {
    const src = readFileSync(devScript, "utf8");
    if (/spawn\(npmCmd/.test(src) && !/shell:\s*true/.test(src)) {
      warnings.push(
        "scripts/dev.mjs запускает npm.cmd без shell: true. На Windows с Node 20.12+ и 22 это даёт spawn EINVAL, и npm run dev (а с ним e2e-тест) не запустится. Добавьте shell: true в опции spawn() и завершайте дерево процессов (taskkill /T /F) вместо kill(SIGTERM).",
      );
    }
  }
  return warnings;
}

function writeReport(ctx) {
  const { env, steps, live, warnings } = ctx;
  const failed = steps.filter((s) => s.status === "FAIL");
  const liveFailed = live.results.filter((r) => !r.ok);
  const green = failed.length === 0 && liveFailed.length === 0 && !live.error && steps.length > 0;
  const out = [];
  out.push("# Отчёт проверки (verify-all)", "");
  out.push(
    `- Дата: ${env.date}`,
    `- Система: ${env.platform}`,
    `- Node: ${env.node}, npm: ${env.npm}`,
    `- Git: ${env.git}`,
    `- package-lock.json: ${env.lock}`,
    "",
  );
  out.push(`## Итог: ${green ? "всё зелёное" : "есть проблемы"}`, "");
  if (warnings.length) out.push(...warnings.map((w) => `> Предупреждение: ${w}`), "");
  out.push("| Шаг | Результат | Время | Ключевые строки |", "|---|---|---|---|");
  for (const s of steps) {
    const note = s.notes.join(" / ").replace(/\|/g, "/") || "";
    out.push(
      `| ${s.title} | ${s.status}${s.timedOut ? " (тайм-аут)" : ""} | ${(s.ms / 1000).toFixed(1)} с | ${note} |`,
    );
  }
  out.push("");
  out.push("## Живые проверки (wrangler dev)", "");
  if (live.skipped) out.push(`Пропущено: ${live.skipped}`, "");
  else if (live.error) out.push(`Не выполнены: ${live.error}`, "");
  else {
    out.push("| Сценарий | Результат | Детали |", "|---|---|---|");
    for (const r of live.results)
      out.push(`| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail} |`);
    out.push("");
  }
  if (live.flushes.length)
    out.push(
      "Строки snapshot_flush из лога wrangler dev (там есть rowsWritten):",
      "",
      "```text",
      ...live.flushes,
      "```",
      "",
    );
  if (failed.length) {
    out.push("## Подробности падений", "");
    for (const s of failed)
      out.push(
        `### ${s.title} (код выхода ${s.code}, лог: ${s.logFile.replace(root, "").replace(/^[\\/]/, "")})`,
        "",
        "```text",
        excerpt(s.logFile),
        "```",
        "",
      );
  }
  out.push(
    "## Что прислать",
    "",
    "Пришлите этот файл целиком. Если он большой, достаточно разделов «Итог» и «Подробности падений». В логах могут быть пути с именем вашего пользователя, а токенов и паролей там нет (скрипт их не читает и не печатает).",
    "",
  );
  writeFileSync(reportPath, out.join("\n"), "utf8");
}

async function main() {
  mkdirSync(logsDir, { recursive: true });
  const env = {
    date: new Date().toISOString(),
    platform: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    node: process.versions.node,
    npm: run("npm", ["-v"]) || "не найден",
    git: run("git", ["rev-parse", "--short", "HEAD"])
      ? `${run("git", ["rev-parse", "--abbrev-ref", "HEAD"])} @ ${run("git", ["rev-parse", "--short", "HEAD"])}`
      : "нет git-репозитория",
    lock: existsSync(join(root, "package-lock.json"))
      ? "есть"
      : "нет (будет создан npm install, закоммитьте его)",
  };
  const warnings = preflightWarnings();
  const steps = [];
  const live = { results: [], flushes: [], error: "", skipped: "" };

  if (nodeMajor < 20) {
    warnings.push(
      `Node ${process.versions.node}: нужен Node 20 или выше (лучше 22). Проверки не запускались.`,
    );
    writeReport({ env, steps, live: { ...live, skipped: "Node слишком старый" }, warnings });
    console.log(`Отчёт: ${reportPath}`);
    process.exitCode = 1;
    return;
  }

  if (externalWsUrl) {
    live.skipped = "";
    Object.assign(live, await runLive());
    writeReport({ env, steps, live, warnings });
    console.log(`Отчёт: ${reportPath}`);
    process.exitCode = live.results.every((r) => r.ok) && !live.error ? 0 : 1;
    return;
  }

  const lockExists = existsSync(join(root, "package-lock.json"));
  const plan = [
    {
      id: "install",
      title: lockExists ? "npm ci" : "npm install (создаёт package-lock.json)",
      cmd: lockExists ? "npm ci" : "npm install",
      dry: "node -e \"console.log('added 612 packages')\"",
      timeoutMs: 15 * 60 * 1000,
      gate: true,
    },
    {
      id: "mpl-check",
      title: "npm ls axe-core lightningcss (справка про MPL-2.0)",
      cmd: "npm ls axe-core lightningcss",
      dry: "node -e \"console.log('(empty)')\"",
      info: true,
    },
    {
      id: "licenses",
      title: "npm run check:licenses",
      cmd: "npm run check:licenses",
      dry: "node -e \"console.log('проверено 612 пакетов')\"",
    },
    {
      id: "typecheck",
      title: "npm run typecheck",
      cmd: "npm run typecheck",
      dry: "node -e \"for(let i=0;i<150;i++)console.log('src/x.ts('+i+',1): error TS2322: dummy '+i);process.exit(2)\"",
    },
    {
      id: "lint",
      title: "npm run lint",
      cmd: "npm run lint",
      dry: "node -e \"console.log('ok')\"",
    },
    {
      id: "test",
      title: "npm test (REQUIRE_RUNTIME=1)",
      cmd: "npm test",
      env: { REQUIRE_RUNTIME: "1" },
      dry: "node -e \"console.log('Tests  29 passed (29)')\"",
    },
    {
      id: "build",
      title: "npm run build",
      cmd: "npm run build",
      dry: "node -e \"console.log('built')\"",
      gateFor: "live",
    },
  ];
  if (!flags.has("--skip-e2e")) {
    plan.push(
      {
        id: "pw-install",
        title: "npx playwright install chromium",
        cmd: "npx playwright install chromium",
        dry: "node -e \"console.log('ok')\"",
        timeoutMs: 15 * 60 * 1000,
        gateFor: "e2e",
      },
      {
        id: "e2e",
        title: "npm run test:e2e",
        cmd: "npm run test:e2e",
        dry: "node -e \"console.log('1 passed')\"",
        timeoutMs: 15 * 60 * 1000,
      },
    );
  }

  let installFailed = false;
  let buildFailed = false;
  let pwFailed = false;
  for (const step of plan) {
    if (installFailed) {
      steps.push({
        id: step.id,
        title: step.title,
        status: "SKIP",
        code: null,
        timedOut: false,
        ms: 0,
        logFile: "",
        notes: ["пропущено: установка зависимостей не прошла"],
      });
      continue;
    }
    if (step.id === "e2e" && pwFailed) {
      steps.push({
        id: step.id,
        title: step.title,
        status: "SKIP",
        code: null,
        timedOut: false,
        ms: 0,
        logFile: "",
        notes: ["пропущено: браузер Playwright не установился"],
      });
      continue;
    }
    const result = await runStep(step);
    steps.push(result);
    if (step.gate && result.status === "FAIL") installFailed = true;
    if (step.id === "build" && result.status === "FAIL") buildFailed = true;
    if (step.id === "pw-install" && result.status === "FAIL") pwFailed = true;
  }

  if (flags.has("--skip-live")) live.skipped = "запрошено флагом --skip-live";
  else if (dryRun) live.skipped = "пробный запуск (VERIFY_DRY_RUN=1)";
  else if (installFailed) live.skipped = "установка зависимостей не прошла";
  else if (buildFailed) live.skipped = "сборка не прошла, а wrangler dev раздаёт web/dist";
  else Object.assign(live, await runLive());

  writeReport({ env, steps, live, warnings });
  console.log(`\nОтчёт: ${reportPath}`);
  const anyFail =
    steps.some((s) => s.status === "FAIL") ||
    live.results.some((r) => !r.ok) ||
    Boolean(live.error);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((e) => {
  console.error("verify-all: непредвиденная ошибка:", e);
  try {
    rmSync(reportPath, { force: true });
  } catch {
    // ignore
  }
  process.exitCode = 2;
});
