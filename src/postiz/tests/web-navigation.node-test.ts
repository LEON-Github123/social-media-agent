import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const [html, script, styles] = await Promise.all(
  ["index.html", "app.js", "styles.css"].map((file) =>
    readFile(new URL(`../web/${file}`, import.meta.url), "utf8"),
  ),
);

void test("daily counts, collected discoveries, hash navigation and inline approval errors", async (t) => {
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const now = Date.now();
    const startsAt = now - 60_000;
    const backlogIds = Array.from(
      { length: 8 },
      (_, index) => `backlog-${index}`,
    );
    const todayIds = ["unrecommended", "watch", "pending"];
    const snapshot = {
      competitorMode: true,
      report: { scope: { generatedAt: now }, jobs: { items: [] } },
      readiness: { ready: true, checks: [] },
      runtime: {},
      quota: { startsAt, resetsAt: now + 86_400_000, used: 0, limit: 5 },
      candidates: [...backlogIds, ...todayIds].map((id) => ({
        id,
        createdAt: backlogIds.includes(id) ? startsAt - 86_400_000 : now,
        input: { url: `https://x.com/demo/status/${id}`, text: id },
      })),
      topics: backlogIds.map((id) => ({
        id: `topic-${id}`,
        title: id,
        status: "awaiting_approval",
        sourceCandidateIds: [id],
        sourceUrls: [`https://x.com/demo/status/${id}`],
        brandReadiness: { ready: true, missing: [] },
        createdAt: startsAt - 86_400_000,
      })),
      socialCandidates: [...backlogIds, ...todayIds].map((id) => ({
        candidateId: id,
        tier: backlogIds.includes(id)
          ? "recommended"
          : id === "unrecommended"
            ? "not_recommended"
            : id,
        held: false,
        assessment: {
          title: `素材 ${id}`,
          summary: "素材摘要",
          reason: id === "unrecommended" ? "与品牌主题关联较弱" : "具体可核实",
          factGaps: [],
        },
        editorial: { firstSeenAt: now, bucket: "backlog", waitingDays: 1 },
        social: { authorHandle: "demo", observedAt: now },
      })),
    };
    const posts: Array<{ path: string; body: unknown }> = [];
    let reads = 0;
    await page.route("https://test.local/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/")
        return route.fulfill({ body: html, contentType: "text/html" });
      if (path === "/app.js")
        return route.fulfill({ body: script, contentType: "text/javascript" });
      if (path === "/styles.css")
        return route.fulfill({ body: styles, contentType: "text/css" });
      if (path === "/api/snapshot") {
        reads += 1;
        return route.fulfill({ json: snapshot });
      }
      if (request.method() === "POST") {
        posts.push({ path, body: request.postDataJSON() });
        return route.fulfill({
          status: 409,
          json: { error: "审批冲突，请核对最新状态" },
        });
      }
      return route.abort();
    });
    await page.goto("https://test.local/");
    await page.locator("#app-view").waitFor({ state: "visible" });
    assert.deepEqual(
      await page
        .locator(".workspace-page:visible")
        .evaluateAll((pages) => pages.map((page) => page.id)),
      ["overview"],
    );
    assert.equal(await page.locator("#daily-collected").textContent(), "3");
    assert.equal(await page.locator("#daily-recommended").textContent(), "0");
    assert.equal(await page.locator("#daily-drafts").textContent(), "0");
    assert.equal(await page.locator("#daily-writing").textContent(), "0 / 5");
    assert.match(
      await page.locator("#daily-description").innerText(),
      /此前未处理的素材/,
    );
    await page.locator('.side-nav a[href="#topics"]').click();
    await page.waitForURL("**/#topics");
    await page.locator("#topics").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#topics-list article").count(),
      8,
      "all eight backlog recommendations are visible by default",
    );
    assert.equal(
      await page.locator('[data-freshness="all"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(
      await page
        .locator(".workspace-page:visible")
        .evaluateAll((pages) => pages.map((page) => page.id)),
      ["topics"],
    );
    await page.waitForFunction(
      () => document.activeElement?.id === "page-title",
    );
    assert.equal(
      await page
        .locator('.side-nav a[href="#topics"]')
        .getAttribute("aria-current"),
      "page",
    );
    await page.goBack();
    await page.waitForFunction(
      () =>
        !document.querySelector("#overview")?.hasAttribute("hidden") &&
        document.activeElement?.id === "page-title",
    );
    await page.locator('[data-review-freshness="new"]').click();
    await page.getByText("今天没有未看推荐", { exact: true }).waitFor();
    assert.equal(await page.locator("#topics-list article").count(), 0);
    await page
      .getByRole("button", { name: "查看全部推荐（8）", exact: true })
      .click();
    assert.equal(await page.locator("#topics-list article").count(), 8);
    await page.locator('[data-freshness="new"]').click();
    await page
      .getByRole("button", { name: "查看今日采集", exact: true })
      .click();
    assert.equal(
      await page
        .locator('[data-social-tab="collected"]')
        .getAttribute("aria-selected"),
      "true",
    );
    assert.deepEqual(
      await page.locator("#topics-list h3").allTextContents(),
      todayIds.map((id) => `素材 ${id}`),
    );
    assert.equal(
      await page
        .getByText("未推荐原因：与品牌主题关联较弱", { exact: true })
        .isVisible(),
      true,
    );
    assert.equal(await page.locator("#social-freshness").isHidden(), true);
    assert.equal(
      posts.length,
      0,
      "navigation and discovery do not approve or mutate candidates",
    );
    await page.getByRole("tab", { name: /推荐待办/ }).click();
    await page.locator('[data-freshness="all"]').click();
    const card = page.locator("#topics-list article").filter({
      has: page.getByRole("heading", { name: "素材 backlog-0", exact: true }),
    });
    await card.locator("summary", { hasText: "设置写作与审批" }).click();
    await card.getByLabel("写作方向", { exact: true }).selectOption("general");
    await card
      .getByLabel("写作角度（可选）", { exact: true })
      .fill("用行业案例解释可复现的实践");
    const readsBeforeApproval = reads;
    await card.getByRole("button", { name: "批准写作", exact: true }).click();
    await card
      .locator(".approval-status.danger")
      .getByText("审批冲突，请核对最新状态", { exact: true })
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#refresh")?.disabled,
    );
    assert.deepEqual(posts, [
      {
        path: "/api/topics/topic-backlog-0/review",
        body: {
          decision: "approve",
          reason: "人工批准竞品选题写作",
          purpose: "brand_original",
          writingScope: "general",
          writingAngle: "用行业案例解释可复现的实践",
        },
      },
    ]);
    assert.ok(
      reads > readsBeforeApproval,
      "failed approval refreshes the actual unchanged backend snapshot",
    );
    assert.equal(snapshot.topics[0].status, "awaiting_approval");
    assert.equal(
      await card.getByLabel("写作方向", { exact: true }).inputValue(),
      "general",
    );
    assert.equal(
      await card.getByLabel("写作角度（可选）", { exact: true }).inputValue(),
      "用行业案例解释可复现的实践",
    );
    assert.equal(
      await card.locator(".approval-panel").getAttribute("open"),
      "",
    );
    assert.equal(await page.locator("#topics-list article").count(), 8);
    assert.equal(
      await card
        .getByRole("button", { name: "批准写作", exact: true })
        .isEnabled(),
      true,
    );
    await page.setViewportSize({ width: 375, height: 812 });
    for (const pageId of [
      "overview",
      "topics",
      "brand-facts",
      "jobs",
      "materials",
      "sources",
    ]) {
      await page.locator(`.side-nav a[href="#${pageId}"]`).click();
      await page.waitForURL(`**/#${pageId}`);
      await page.locator(`#${pageId}`).waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        `${pageId} fits a 375px viewport`,
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
