#!/usr/bin/env node
/* global fetch */
/**
 * Production & Local Environment Verification Script for Online Board.
 * Validates security headers, strict CSP, robots.txt, 404 unified responses, and 405 methods.
 *
 * Usage:
 *   node scripts/verify-prod.mjs [BASE_URL]
 * Example:
 *   node scripts/verify-prod.mjs http://localhost:8787
 *   node scripts/verify-prod.mjs https://online-board.<subdomain>.workers.dev
 */

import crypto from "node:crypto";
import WebSocket from "ws";

const rawTarget = process.argv[2] || process.env.BASE_URL || "http://localhost:8787";
const baseUrl = rawTarget.replace(/\/$/, "");
const wsBaseUrl = baseUrl.replace(/^http/, "ws");
const pilotTestId = process.env.PILOT_TEST_ID;

function toBoardRef(id) {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
}

function checkWsHandshakeStatus(url) {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.terminate();
        } catch {
          // Ignore socket termination error on timeout
        }
        resolve({ ok: false, status: 0, error: "Handshake timed out (5s)" });
      }
    }, 5000);

    ws.on("open", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve({ ok: true, status: 101 });
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, status: res.statusCode });
      }
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, status: 0, error: err.message });
      }
    });
  });
}

function checkCspSafety(cspHeader) {
  if (!cspHeader) return { safe: false, reason: "Missing CSP header" };
  if (cspHeader.includes("'unsafe-eval'")) {
    return { safe: false, reason: "Contains 'unsafe-eval'" };
  }
  const scriptSrcMatch = /script-src\s+([^;]+)/.exec(cspHeader);
  if (scriptSrcMatch && scriptSrcMatch[1].includes("'unsafe-inline'")) {
    return { safe: false, reason: "script-src contains 'unsafe-inline'" };
  }
  // Check that connect-src doesn't have open wildcards without origin
  const connectSrcMatch = /connect-src\s+([^;]+)/.exec(cspHeader);
  if (connectSrcMatch) {
    const tokens = connectSrcMatch[1].trim().split(/\s+/);
    for (const t of tokens) {
      if (t === "*" || t === "http:" || t === "https:") {
        return { safe: false, reason: `connect-src contains overly permissive '${t}'` };
      }
    }
  }
  return { safe: true };
}

async function run() {
  console.log("===============================================================");
  console.log(`🛡️  VERIFY-PROD: Проверка безопасности и заголовков`);
  console.log(`🎯 URL: ${baseUrl}`);
  console.log("===============================================================\n");

  const results = [];

  function record(checkName, passed, details = "") {
    results.push({ check: checkName, status: passed ? "PASS" : "FAIL", details });
    const mark = passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${mark} | ${checkName}${details ? ` (${details})` : ""}`);
  }

  try {
    // 1. GET /api/health
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = await healthRes.json().catch(() => null);
    record(
      "GET /api/health returns 200 with JSON { ok: true }",
      healthRes.status === 200 && healthJson?.ok === true,
      `status=${healthRes.status}`,
    );

    record(
      "GET /api/health has Cache-Control: no-store",
      healthRes.headers.get("cache-control")?.includes("no-store") === true,
      healthRes.headers.get("cache-control") || "missing",
    );

    // 2. POST /api/health -> 405
    const postHealthRes = await fetch(`${baseUrl}/api/health`, { method: "POST" });
    record(
      "POST /api/health returns 405 Method Not Allowed with Allow header",
      postHealthRes.status === 405 && postHealthRes.headers.get("allow")?.includes("GET"),
      `status=${postHealthRes.status}, allow=${postHealthRes.headers.get("allow")}`,
    );

    // 3. GET /robots.txt
    const robotsRes = await fetch(`${baseUrl}/robots.txt`);
    const robotsText = await robotsRes.text();
    record(
      "GET /robots.txt returns 200 and Disallow: /",
      robotsRes.status === 200 && robotsText.includes("Disallow: /"),
      `status=${robotsRes.status}`,
    );

    // 4. Security Headers on /api/health
    record(
      "/api/health: X-Content-Type-Options is nosniff",
      healthRes.headers.get("x-content-type-options") === "nosniff",
      healthRes.headers.get("x-content-type-options") || "missing",
    );
    record(
      "/api/health: Referrer-Policy is no-referrer",
      healthRes.headers.get("referrer-policy") === "no-referrer",
      healthRes.headers.get("referrer-policy") || "missing",
    );
    record(
      "/api/health: X-Frame-Options is DENY",
      healthRes.headers.get("x-frame-options") === "DENY",
      healthRes.headers.get("x-frame-options") || "missing",
    );
    record(
      "/api/health: Permissions-Policy restricts sensitive features",
      healthRes.headers.get("permissions-policy")?.includes("camera=()") === true,
      healthRes.headers.get("permissions-policy") || "missing",
    );
    record(
      "/api/health: X-Robots-Tag is noindex, nofollow",
      healthRes.headers.get("x-robots-tag") === "noindex, nofollow",
      healthRes.headers.get("x-robots-tag") || "missing",
    );

    const healthCsp = healthRes.headers.get("content-security-policy");
    const healthCspSafety = checkCspSafety(healthCsp);
    record(
      "/api/health: Strict CSP (no unsafe-inline/unsafe-eval in scripts)",
      healthCspSafety.safe,
      healthCspSafety.reason || "safe",
    );

    // 5. Root page GET /
    const rootRes = await fetch(`${baseUrl}/`);
    record("GET / returns 200 OK", rootRes.status === 200, `status=${rootRes.status}`);

    const rootCsp = rootRes.headers.get("content-security-policy");
    const rootCspSafety = checkCspSafety(rootCsp);
    record(
      "GET /: Strict CSP (no unsafe-inline/unsafe-eval in scripts)",
      rootCspSafety.safe,
      rootCspSafety.reason || "safe",
    );

    record(
      "GET /: X-Frame-Options is DENY",
      rootRes.headers.get("x-frame-options") === "DENY",
      rootRes.headers.get("x-frame-options") || "missing",
    );

    // 6. WebSocket to garbage board ID
    const badIdHandshake = await checkWsHandshakeStatus(
      `${wsBaseUrl}/ws/invalid_garbage_board_id?nick=Tester`,
    );
    record(
      "WebSocket to invalid garbage board ID returns 404",
      badIdHandshake.status === 404,
      `status=${badIdHandshake.status}`,
    );

    // 7. WebSocket to unwhitelisted 22-char board ID
    const unwhitelistedHandshake = await checkWsHandshakeStatus(
      `${wsBaseUrl}/ws/1111111111111111111111?nick=Tester`,
    );
    record(
      "WebSocket to unwhitelisted board ID returns unified 404",
      unwhitelistedHandshake.status === 404,
      `status=${unwhitelistedHandshake.status}`,
    );

    // 8. Optional: PILOT_TEST_ID check
    if (pilotTestId) {
      const pilotRef = toBoardRef(pilotTestId);
      const pilotHandshake = await checkWsHandshakeStatus(
        `${wsBaseUrl}/ws/${pilotTestId}?nick=PilotVerifier`,
      );
      record(
        `WebSocket to whitelisted pilot board (ref: ${pilotRef}) returns 101`,
        pilotHandshake.status === 101,
        `status=${pilotHandshake.status}`,
      );
    }
  } catch (err) {
    record("Script execution", false, err instanceof Error ? err.message : String(err));
  }

  console.log("\n===============================================================");
  console.log("📊 СВОДНЫЙ ОТЧЁТ");
  console.log("===============================================================");
  const allPassed = results.every((r) => r.status === "PASS");
  const passedCount = results.filter((r) => r.status === "PASS").length;
  console.log(
    `Всего проверок: ${results.length} | Успешно: ${passedCount} | Ошибок: ${results.length - passedCount}`,
  );

  if (allPassed) {
    console.log("🎉 ВСЕ ПРОВЕРКИ УСПЕШНО ПРОЙДЕНЫ!");
    process.exit(0);
  } else {
    console.error("❌ НЕКОТОРЫЕ ПРОВЕРКИ НЕ ПРОЙДЕНЫ!");
    process.exit(1);
  }
}

run();
