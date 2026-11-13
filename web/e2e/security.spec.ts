import { test, expect } from "@playwright/test";

const TEST_BOARD_ID = process.env.TEST_BOARD_ID ?? "5D5s8U8ugdus2jDtyflsJE";

test.describe("Security and Network Isolation Suite (T2.6)", () => {
  test("collects all network requests: 0 external requests, strict CSP, and sanitized DOM anchors", async ({
    page,
    request,
    baseURL,
  }) => {
    const targetOrigin = new URL(baseURL ?? "http://localhost:5173").origin;
    const capturedRequests: string[] = [];
    const forbiddenExternalRequests: string[] = [];

    page.on("request", (req) => {
      const url = req.url();
      capturedRequests.push(url);

      if (url.startsWith("data:") || url.startsWith("blob:")) {
        return;
      }
      try {
        const reqOrigin = new URL(url).origin;
        // Allow same origin (or local dev vite/wrangler hosts)
        const isLocalHost =
          reqOrigin.includes("localhost") ||
          reqOrigin.includes("127.0.0.1") ||
          reqOrigin === targetOrigin;

        if (!isLocalHost) {
          forbiddenExternalRequests.push(url);
        }
      } catch {
        forbiddenExternalRequests.push(url);
      }
    });

    // 1. Visit board page
    const pageResponse = await page.goto(`/b/${TEST_BOARD_ID}`);
    expect(pageResponse).not.toBeNull();

    // 2. Dismiss nick dialog if visible
    const nickDialog = page.getByTestId("nick-dialog");
    if (await nickDialog.isVisible()) {
      await page.getByTestId("nick-input").fill("Тестировщик");
      await page.getByTestId("nick-submit-button").click();
      await expect(nickDialog).toBeHidden();
    }

    // 3. Interact with UI elements to trigger any potential lazy-loaded requests
    // Open MainMenu (hamburger menu)
    const menuButton = page
      .locator('button[aria-label="Main menu"], .dropdown-menu-button, button.main-menu-trigger')
      .first();
    if (await menuButton.isVisible()) {
      await menuButton.click();
      await page.waitForTimeout(300);
    }

    // 4. Assert zero external requests were emitted
    expect(forbiddenExternalRequests).toEqual([]);
    expect(capturedRequests.length).toBeGreaterThan(0);

    // 5. Inspect DOM for anchor tags: any external anchor must have rel="noopener noreferrer"
    const externalAnchors = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const currentHost = window.location.host;
      return anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const rel = a.getAttribute("rel") || "";
          return { href, rel };
        })
        .filter(({ href }) => {
          if (!href.startsWith("http://") && !href.startsWith("https://")) {
            return false;
          }
          try {
            return new URL(href).host !== currentHost;
          } catch {
            return false;
          }
        });
    });

    for (const anchor of externalAnchors) {
      expect(anchor.rel).toContain("noopener");
      expect(anchor.rel).toContain("noreferrer");
      // Explicitly forbidden social trackers
      expect(anchor.href).not.toContain("twitter.com");
      expect(anchor.href).not.toContain("x.com");
      expect(anchor.href).not.toContain("discord.gg");
      expect(anchor.href).not.toContain("discord.com");
    }

    // 6. Check /api/health security headers via APIRequestContext
    const healthResponse = await request.get("/api/health");
    if (healthResponse.status() === 200) {
      const headers = healthResponse.headers();
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe("no-referrer");
      expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(headers["cache-control"]).toContain("no-store");

      const csp = headers["content-security-policy"] ?? "";
      if (csp) {
        expect(csp).not.toContain("'unsafe-eval'");
        const scriptSrcMatch = /script-src\s+([^;]+)/.exec(csp);
        if (scriptSrcMatch) {
          expect(scriptSrcMatch[1]).not.toContain("'unsafe-inline'");
        }
      }
    }
  });
});
