import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const [html, script, styles] = await Promise.all(
  ["index.html", "app.js", "styles.css"].map((file) =>
    readFile(new URL(`../web/${file}`, import.meta.url), "utf8"),
  ),
);

for (const scenario of ["receipt", "refresh", "warnings"] as const) {
  void test(`job detail ${scenario} preserves operator review boundaries`, async (t) => {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      try {
        browser = await chromium.launch({ headless: true, channel: "chrome" });
      } catch (error) {
        if (process.env.CI) throw error;
        t.skip("Chromium or Chrome is required for the browser UI check");
        return;
      }
    }
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.setInterval = ((callback: () => void) => {
          (window as unknown as { tick: () => void }).tick = callback;
          return 1;
        }) as typeof window.setInterval;
      });
      const now = Date.now();
      const job = {
        id: "social-v1-test",
        state: "ready",
        mode: "draft",
        updatedAt: now,
        input: {},
        postizId: null as string | null,
        postizState: null as string | null,
        output: {
          post: "Original draft",
          quality: {
            approved: true,
            warnings: ["请核对 Seedance 模型链接", "第三方品牌名称需运营复核"],
          },
        },
      };
      let reads = 0;
      const writes: string[] = [];
      await page.route("https://test.local/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === "/")
          return route.fulfill({ body: html, contentType: "text/html" });
        if (path === "/app.js")
          return route.fulfill({
            body: script,
            contentType: "text/javascript",
          });
        if (path === "/styles.css")
          return route.fulfill({ body: styles, contentType: "text/css" });
        if (request.method() !== "GET") {
          writes.push(path);
          return route.fulfill({ json: {} });
        }
        if (path === "/api/snapshot")
          return route.fulfill({
            json: {
              report: {
                scope: { generatedAt: now },
                jobs: {
                  items: [
                    {
                      id: job.id,
                      localState: job.state,
                      updatedAt: job.updatedAt,
                      delivery: {
                        status: job.postizId ? "draft" : "not_submitted",
                      },
                    },
                  ],
                },
              },
              readiness: { ready: true, checks: [] },
              runtime: {},
              postizUrl: "https://postiz.example.com",
            },
          });
        if (path === `/api/jobs/${job.id}`) {
          reads++;
          return route.fulfill({
            json: { job, postizUrl: "https://postiz.example.com" },
          });
        }
        return route.abort();
      });
      await page.goto("https://test.local/#jobs");
      await page.locator("#jobs-list button").click();
      await page.locator("#job-detail .item-meta").first().waitFor();
      const review = page.locator("#job-detail a", {
        hasText: "打开 Postiz 完成最终审阅",
      });
      if (scenario === "receipt") {
        assert.equal(
          await review.count(),
          0,
          "no receipt means no final-review link",
        );
        assert.match(
          await page.locator("#job-detail").innerText(),
          /尚未送达 Postiz/,
        );
        job.state = "submitted";
        job.postizId = "receipt-1";
        job.postizState = "DRAFT";
        job.updatedAt++;
        await page.getByRole("button", { name: "刷新", exact: true }).click();
        await review.waitFor();
        assert.equal(
          await review.getAttribute("href"),
          "https://postiz.example.com/",
        );
      } else if (scenario === "warnings") {
        assert.match(
          await page.locator("#job-detail").innerText(),
          /运营复核点（不阻断草稿）/,
        );
        assert.equal(
          await page
            .getByText("请核对 Seedance 模型链接", { exact: true })
            .count(),
          1,
        );
        assert.equal(
          await page
            .getByText("第三方品牌名称需运营复核", { exact: true })
            .count(),
          1,
        );
        await page
          .locator("#job-detail summary", { hasText: "提交到 Postiz 草稿" })
          .click();
        assert.equal(
          await page
            .getByRole("button", { name: "提交到 Postiz 草稿", exact: true })
            .isEnabled(),
          true,
        );
      } else {
        await page
          .locator("#job-detail summary", { hasText: "直接编辑正文并重新检查" })
          .click();
        await page
          .getByLabel("编辑后的完整正文")
          .fill("Operator text must survive");
        await page
          .getByLabel("修改原因（单独记录到审计）")
          .fill("Keep my reason");
        await page
          .locator("#job-detail summary", { hasText: "直接编辑正文并重新检查" })
          .click();
        job.state = "processing";
        job.updatedAt++;
        await page.evaluate(() =>
          (window as unknown as { tick: () => void }).tick(),
        );
        await page.waitForFunction(() =>
          document.querySelector("#jobs-list")?.textContent?.includes("生成中"),
        );
        await page.waitForFunction(() =>
          document
            .querySelector("#job-detail .item-meta")
            ?.textContent?.includes("生成中"),
        );
        assert.equal(reads, 2);
        await page
          .locator("#job-detail summary", { hasText: "直接编辑正文并重新检查" })
          .click();
        assert.equal(
          await page.getByLabel("编辑后的完整正文").inputValue(),
          "Operator text must survive",
        );
        assert.equal(
          await page.getByLabel("修改原因（单独记录到审计）").inputValue(),
          "Keep my reason",
        );
        assert.equal(
          await page
            .getByRole("button", {
              name: "直接编辑正文并重新检查",
              exact: true,
            })
            .isDisabled(),
          true,
        );
        await page
          .locator("#job-detail form")
          .filter({ has: page.locator('[name="post"]') })
          .evaluate((form) =>
            form.dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true }),
            ),
          );
        assert.deepEqual(
          writes,
          [],
          "even programmatic submission cannot use an obsolete form",
        );
        await page
          .locator("#job-detail summary", { hasText: "记录反馈" })
          .click();
        await page.getByLabel("原因或备注").fill("Feedback remains editable");
        job.state = "rejected";
        job.updatedAt++;
        await page.evaluate(() =>
          (window as unknown as { tick: () => void }).tick(),
        );
        await page.waitForFunction(() =>
          document
            .querySelector("#job-detail .item-meta")
            ?.textContent?.includes("已拒绝"),
        );
        assert.equal(
          await page.getByLabel("原因或备注").inputValue(),
          "Feedback remains editable",
        );
        assert.equal(
          await page
            .getByRole("button", { name: "记录反馈", exact: true })
            .isEnabled(),
          true,
        );
      }
      assert.deepEqual(writes, []);
    } finally {
      await browser.close();
    }
  });
}
