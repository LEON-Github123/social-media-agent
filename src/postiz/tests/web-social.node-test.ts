import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const html = await readFile(
  new URL("../web/index.html", import.meta.url),
  "utf8",
);
const script = await readFile(
  new URL("../web/app.js", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../web/styles.css", import.meta.url),
  "utf8",
);

void test("competitor review uses backend tiers, protects approval and preserves legacy mode", async (t) => {
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
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const brandReadiness = { ready: false, missing: ["产品定位"] };
    const snapshot = {
      competitorMode: true,
      report: { scope: { generatedAt: Date.now() }, jobs: { items: [] } },
      readiness: { ready: true, checks: [] },
      runtime: {},
      candidates: [
        {
          id: "c1",
          input: {
            url: "https://x.com/example/status/101",
            text: "Original post",
          },
        },
        {
          id: "c2",
          input: {
            url: "https://x.com/example/status/102",
            text: "Watch post",
          },
        },
        {
          id: "c3",
          input: {
            url: "https://x.com/example/status/103",
            text: "Failed post",
          },
        },
        {
          id: "c4",
          origin: "manual",
          input: { url: "https://example.com/manual", text: "Manual post" },
        },
      ],
      topics: [
        {
          id: "t1",
          title: "Old title",
          status: "awaiting_approval",
          sourceCandidateIds: ["c1"],
          sourceUrls: ["https://x.com/example/status/101"],
          brandReadiness,
          createdAt: Date.now(),
        },
        {
          id: "rss",
          title: "RSS 历史",
          status: "awaiting_approval",
          sourceCandidateIds: [],
          sourceUrls: ["https://example.com/news"],
          createdAt: Date.now(),
        },
        {
          id: "t2",
          title: "观察中待核对",
          status: "needs_review",
          sourceCandidateIds: ["c2"],
          sourceUrls: ["https://x.com/example/status/102"],
          brandReadiness: { ready: true, missing: [] },
          createdAt: Date.now(),
        },
        {
          id: "t3",
          title: "待核对异常",
          status: "needs_review",
          sourceCandidateIds: ["c3"],
          sourceUrls: ["https://x.com/example/status/103"],
          createdAt: Date.now(),
        },
        {
          id: "manual",
          title: "手动历史",
          status: "awaiting_approval",
          sourceCandidateIds: ["c4"],
          sourceUrls: ["https://example.com/manual"],
          createdAt: Date.now(),
        },
      ],
      socialCandidates: [
        {
          candidateId: "c1",
          tier: "recommended",
          held: false,
          attempts: 0,
          assessment: {
            title: "中文推荐标题",
            summary: "中文摘要",
            reason: "与用户相关",
            angle: "原创观察",
            factGaps: ["发布日期"],
          },
          social: {
            authorHandle: "example",
            views: null,
            likes: 12,
            replies: 0,
            reposts: 1,
            quotes: null,
            bookmarks: null,
            observedAt: Date.now(),
          },
          performance: { interactionRate: 0.025 },
        },
        {
          candidateId: "c2",
          tier: "watch",
          held: false,
          attempts: 0,
          assessment: {
            title: "观察标题",
            summary: "稍后再看",
            reason: "证据不足",
            angle: "",
            factGaps: [],
          },
          social: null,
          performance: null,
        },
        {
          candidateId: "c3",
          tier: "error",
          held: false,
          attempts: 2,
          recovery: {
            manualAttempts: 0,
            limit: 2,
            inFlight: false,
            leaseUntil: null,
          },
          errorMessage:
            "Selection model failed or returned an invalid decision set; no candidates were auto-selected",
          social: null,
          performance: null,
        },
      ],
      socialQuotas: {
        provider: { used: 2, limit: 10 },
        selection: { used: 4, limit: 40 },
      },
    };
    await page.route("https://test.local/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/")
        return route.fulfill({ body: html, contentType: "text/html" });
      if (url.pathname === "/app.js")
        return route.fulfill({ body: script, contentType: "text/javascript" });
      if (url.pathname === "/styles.css")
        return route.fulfill({ body: styles, contentType: "text/css" });
      if (url.pathname === "/api/snapshot")
        return route.fulfill({ json: snapshot });
      if (url.pathname === "/api/topics/t1/readiness") {
        assert.deepEqual(request.postDataJSON(), {
          writingAngle: "通用输入格式教程",
          writingScope: "general",
        });
        return route.fulfill({ json: { ready: true, missing: [] } });
      }
      if (request.method() === "POST") {
        posts.push({ path: url.pathname, body: request.postDataJSON() });
        if (url.pathname === "/api/social-candidates/c2/hold")
          snapshot.socialCandidates[1].held = request.postDataJSON().held;
        return route.fulfill({ json: {} });
      }
      return route.abort();
    });
    await page.goto("https://test.local/");
    await page.getByRole("heading", { name: "中文推荐标题" }).waitFor();
    assert.equal(await page.getByText("待补品牌资料：产品定位").count(), 1);
    assert.equal(
      await page
        .locator("#topics-list summary", { hasText: "批准写作" })
        .count(),
      1,
    );
    await page.locator("#topics-list summary", { hasText: "批准写作" }).click();
    await page.getByLabel("写作范围").selectOption("general");
    await page.getByLabel("写作角度（可选）").fill("通用输入格式教程");
    await page.getByRole("button", { name: "检查所需资料" }).click();
    await page.getByText("资料检查通过，可以批准写作。").waitFor();
    assert.equal(
      posts.length,
      0,
      "checking readiness does not approve or write",
    );
    assert.equal((await page.getByText("未提供").count()) > 0, true);
    assert.equal(await page.getByText(/传播高不等于产品声明已核实/).count(), 1);
    assert.equal(await page.getByText(/同账号基线样本不足/).count(), 1);
    await page.getByRole("tab", { name: /待观察/ }).click();
    await page.getByRole("heading", { name: "观察标题" }).waitFor();
    assert.equal(
      await page
        .locator("#topics-list summary", { hasText: "人工选择并批准写作" })
        .count(),
      1,
    );
    await page
      .locator("#topics-list summary", { hasText: "人工选择并批准写作" })
      .click();
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/topics/t2/review") &&
          response.request().method() === "POST",
      ),
      page
        .locator("#topics-list button", { hasText: "人工选择并批准写作" })
        .click(),
    ]);
    assert.deepEqual(posts[0], {
      path: "/api/topics/t2/review",
      body: {
        decision: "approve",
        reason: "人工批准竞品选题写作",
        purpose: "brand_original",
      },
    });
    await page.waitForFunction(
      () => !document.querySelector("#topics-list details[open]"),
    );
    await page.locator("#topics-list summary", { hasText: "暂存观察" }).click();
    await page.getByLabel("暂存原因").fill("等更多数据");
    await page.locator("#topics-list button", { hasText: "暂存观察" }).click();
    await page.waitForTimeout(50);
    assert.deepEqual(posts[1], {
      path: "/api/social-candidates/c2/hold",
      body: { held: true, reason: "等更多数据" },
    });
    await page.locator("#topics-list summary", { hasText: "继续处理" }).click();
    await page.getByLabel("继续处理原因").fill("已有新的观察结论");
    await page.locator("#topics-list button", { hasText: "继续处理" }).click();
    await page.waitForFunction(
      () => !document.querySelector("#topics-list details[open]"),
    );
    assert.deepEqual(posts[2], {
      path: "/api/social-candidates/c2/hold",
      body: { held: false, reason: "已有新的观察结论" },
    });
    await page.getByRole("tab", { name: /处理异常/ }).click();
    await page.getByRole("heading", { name: "待核对异常" }).waitFor();
    assert.equal(
      await page
        .locator("#topics-list summary", { hasText: /^重试评估$/ })
        .count(),
      0,
    );
    assert.equal(await page.getByText(/已到自动重试上限/).count(), 1);
    await page
      .locator("#topics-list summary", { hasText: "人工重试评估" })
      .click();
    await page.getByLabel("已核查的问题或重试原因").fill("模型连接已修复");
    await page
      .locator("#topics-list button", { hasText: "人工重试评估" })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#topics-list details[open]"),
    );
    assert.deepEqual(posts[3], {
      path: "/api/social-candidates/c3/recover",
      body: { reason: "模型连接已修复" },
    });
    assert.equal(
      await page.getByText(/历史评估失败，原始原因未记录/).count(),
      1,
    );
    await page.getByRole("tab", { name: /历史记录/ }).click();
    await page.getByRole("heading", { name: "RSS 历史" }).waitFor();
    const rssCard = page
      .locator("#topics-list article")
      .filter({ hasText: "RSS 历史" });
    const manualCard = page
      .locator("#topics-list article")
      .filter({ hasText: "手动历史" });
    assert.equal(await rssCard.count(), 1);
    assert.equal(
      await rssCard.locator("summary").count(),
      0,
      await rssCard.innerHTML(),
    );
    assert.equal(
      await manualCard
        .locator("summary", { hasText: "批准手动选题写作" })
        .count(),
      1,
    );
    assert.equal(
      await page.getByRole("heading", { name: "中文推荐标题" }).count(),
      0,
    );
    brandReadiness.ready = true;
    brandReadiness.missing = [];
    await page.getByRole("tab", { name: /今日推荐/ }).click();
    await page.getByRole("button", { name: "刷新" }).click();
    await page.locator("#topics-list summary", { hasText: "批准写作" }).click();
    await page.getByLabel("写作角度（可选）").fill("聚焦实践");
    await page.getByRole("button", { name: "刷新" }).click();
    assert.equal(
      await page.getByLabel("写作角度（可选）").inputValue(),
      "聚焦实践",
    );
    await page.locator("#topics-list button", { hasText: "批准写作" }).click();
    await page.waitForTimeout(50);
    assert.deepEqual(posts[4], {
      path: "/api/topics/t1/review",
      body: {
        decision: "approve",
        reason: "人工批准竞品选题写作",
        purpose: "brand_original",
        writingAngle: "聚焦实践",
      },
    });
    snapshot.topics = snapshot.topics.filter((topic) => topic.id !== "t1");
    snapshot.socialCandidates[0].recovery = {
      manualAttempts: 0,
      limit: 2,
      inFlight: false,
      leaseUntil: null,
    };
    await page.getByRole("button", { name: "刷新" }).click();
    await page
      .locator("#topics-list summary", { hasText: "作为表达素材重新归组" })
      .click();
    await page
      .getByLabel("为何应借鉴表达而非引用公告")
      .fill("只参考演示方法，不引用公告事实");
    await page
      .locator("#topics-list button", { hasText: "作为表达素材重新归组" })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#topics-list details[open]"),
    );
    assert.deepEqual(posts[5], {
      path: "/api/social-candidates/c1/repair",
      body: { kind: "creative", reason: "只参考演示方法，不引用公告事实" },
    });
    snapshot.competitorMode = false;
    await page.getByRole("button", { name: "刷新" }).click();
    await page
      .getByRole("heading", { name: "素材审批", exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#social-review-controls").isHidden(),
      true,
    );
    assert.equal(await page.locator("#candidates").isHidden(), false);
    assert.equal(
      await page.getByRole("heading", { name: "中文推荐标题" }).count(),
      0,
    );
  } finally {
    await browser.close();
  }
});
