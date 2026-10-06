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

void test("editorial filters, backend ordering and explicit feedback preserve approval boundaries", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    try {
      browser = await chromium.launch({ headless: true, channel: "chrome" });
    } catch (error) {
      if (process.env.CI) throw error;
      t.skip("Chromium or Chrome is required");
      return;
    }
  }
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const now = Date.now();
    const item = (id: string, bucket: string, title: string) => ({
      candidateId: id,
      tier: "recommended",
      held: false,
      assessment: { title, summary: "摘要", reason: "相关", factGaps: [] },
      editorial: {
        firstSeenAt: now,
        seenAt: null,
        snoozedUntil: null,
        bucket,
        reason: "后端推荐变化理由",
        waitingDays: 2,
      },
      limitReason: "同账号推荐上限",
      social: { authorHandle: "demo", observedAt: now },
    });
    const snapshot = {
      competitorMode: true,
      report: { jobs: { items: [] } },
      readiness: { ready: true, checks: [] },
      runtime: {},
      candidates: ["first", "second", "rise", "old", "unlinked"].map((id) => ({
        id,
        input: { url: `https://x.com/demo/status/${id}`, text: id },
      })),
      // Both topic order and source order oppose the backend candidate ranking.
      topics: [
        {
          id: "older",
          title: "历史组",
          sourceCandidateIds: ["old"],
          status: "awaiting_approval",
          createdAt: now + 4,
        },
        {
          id: "rise-topic",
          title: "上升组",
          sourceCandidateIds: ["rise"],
          status: "awaiting_approval",
          createdAt: now + 3,
        },
        {
          id: "multi",
          title: "多来源组",
          sourceCandidateIds: ["second", "first"],
          status: "awaiting_approval",
          createdAt: now,
        },
      ],
      socialCandidates: [
        item("first", "new", "第一推荐"),
        item("second", "new", "同组次选"),
        item("unlinked", "new", "未归组推荐"),
        item("rise", "rising", "上升推荐"),
        item("old", "backlog", "历史推荐"),
      ],
      editorial: {
        profile: {
          version: 1,
          selectionGuidance: "旧选材",
          writingGuidance: "旧风格",
          examples: ["Old English sample"],
        },
        feedbackSummary: {
          uniqueCandidates: 5,
          tagCounts: { useful_topic: 2 },
          suggestions: ["减少宽泛主题"],
        },
      },
    };
    let legacy = false;
    let preferenceStatus = 409;
    await page.route("https://test.local/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/")
        return route.fulfill({ body: html, contentType: "text/html" });
      if (path === "/app.js")
        return route.fulfill({ body: script, contentType: "text/javascript" });
      if (path === "/styles.css")
        return route.fulfill({ body: styles, contentType: "text/css" });
      if (path === "/api/snapshot")
        return route.fulfill({
          json: legacy
            ? {
                ...snapshot,
                editorial: undefined,
                socialCandidates: snapshot.socialCandidates.map(
                  ({ editorial: _editorial, ...rest }) => rest,
                ),
              }
            : snapshot,
        });
      if (req.method() === "POST") {
        const body: Record<string, unknown> = req.postDataJSON();
        posts.push({ path, body });
        if (path === "/api/editorial/preferences") {
          if (preferenceStatus === 409) {
            snapshot.editorial.profile.version = 2;
            return route.fulfill({
              status: 409,
              json: { error: "Version conflict" },
            });
          }
          if (preferenceStatus === 503)
            return route.fulfill({
              status: 503,
              json: { error: "模型服务不可用" },
            });
          snapshot.editorial.profile = {
            version: snapshot.editorial.profile.version + 1,
            selectionGuidance: String(body.selectionGuidance),
            writingGuidance: String(body.writingGuidance),
            examples: Array.isArray(body.examples) ? body.examples : [],
          };
          return route.fulfill({
            json: { accepted: true, profile: snapshot.editorial.profile },
          });
        }
        return route.fulfill({ json: { accepted: true } });
      }
      return route.abort();
    });
    await page.goto("https://test.local/");
    await page.getByRole("heading", { name: "第一推荐" }).waitFor();
    assert.deepEqual(await page.locator("#topics-list h3").allTextContents(), [
      "第一推荐",
      "未归组推荐",
    ]);
    assert.equal(posts.length, 0, "rendering never marks seen");
    assert.equal(
      await page
        .getByRole("button", { name: "今日新发现 2", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "传播上升 1", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "历史待办 1", exact: true })
        .count(),
      1,
    );
    assert.equal(await page.getByText(/未处理 2 天/).count(), 2);
    assert.equal(await page.getByText(/推荐限制：同账号推荐上限/).count(), 2);
    await page.getByRole("button", { name: "传播上升 1", exact: true }).click();
    assert.deepEqual(await page.locator("#topics-list h3").allTextContents(), [
      "上升推荐",
    ]);
    await page.getByRole("button", { name: "全部 4", exact: true }).click();
    assert.deepEqual(await page.locator("#topics-list h3").allTextContents(), [
      "第一推荐",
      "未归组推荐",
      "上升推荐",
      "历史推荐",
    ]);
    const card = page
      .locator("#topics-list article")
      .filter({ has: page.getByRole("heading", { name: "第一推荐" }) });
    await card.getByRole("button", { name: "已看过", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#notice")?.textContent?.includes("已标记看过"),
    );
    assert.deepEqual(posts[0], {
      path: "/api/social-candidates/first/seen",
      body: {},
    });
    await card.locator("summary", { hasText: "暂存观察" }).click();
    await card.getByLabel("暂存原因").fill("明天核对");
    await card.getByLabel("暂存到").selectOption("1");
    await card.getByRole("button", { name: "暂存观察", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#topics-list details[open]"),
    );
    assert.deepEqual(posts[1], {
      path: "/api/social-candidates/first/snooze",
      body: { days: 1, reason: "明天核对" },
    });
    await card.locator("summary", { hasText: "暂存观察" }).click();
    await card.getByLabel("暂存原因").fill("三天后核对");
    await card.getByLabel("暂存到").selectOption("3");
    await card.getByRole("button", { name: "暂存观察", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#topics-list details[open]"),
    );
    assert.deepEqual(posts[2], {
      path: "/api/social-candidates/first/snooze",
      body: { days: 3, reason: "三天后核对" },
    });
    for (const tag of [
      "too_broad",
      "not_relevant",
      "repetitive",
      "useful_topic",
      "good_expression",
      "product_demo",
    ]) {
      await card.locator("summary", { hasText: "记录选材反馈" }).click();
      await card.getByLabel("反馈标签").selectOption(tag);
      await card.getByLabel("反馈备注（可选）").fill("保留人工判断");
      await card
        .getByRole("button", { name: "记录选材反馈", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#topics-list details[open]"),
      );
      assert.deepEqual(posts[posts.length - 1], {
        path: "/api/social-candidates/first/feedback",
        body: { tag, note: "保留人工判断" },
      });
    }
    assert.equal(
      posts.some((post) => post.path.endsWith("/review")),
      false,
    );
    await page.locator("#editorial-preferences > summary").click();
    assert.equal(await page.getByText(/反馈样本：5 条素材/).count(), 1);
    await page.locator("#editorial-form summary").click();
    await page.getByLabel("选材偏好", { exact: true }).fill("偏好具体教程");
    await page.getByLabel("写作风格", { exact: true }).fill("简洁英语");
    await page
      .getByLabel("英文风格样本 1（可选）", { exact: true })
      .fill("Show the workflow.");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    assert.equal(
      await page.getByLabel("选材偏好", { exact: true }).inputValue(),
      "偏好具体教程",
    );
    await page.locator("#editorial-form summary").click();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.locator("#editorial-form summary").click();
    assert.equal(
      await page.getByLabel("选材偏好", { exact: true }).inputValue(),
      "偏好具体教程",
      "closing a dirty form does not discard edits on refresh",
    );
    assert.equal(
      posts.filter((post) => post.path === "/api/editorial/preferences").length,
      0,
    );
    await page
      .getByRole("button", { name: "确认并应用偏好", exact: true })
      .click();
    await page.getByText(/偏好版本已更新/).waitFor();
    assert.deepEqual(posts[posts.length - 1], {
      path: "/api/editorial/preferences",
      body: {
        expectedVersion: 1,
        selectionGuidance: "偏好具体教程",
        writingGuidance: "简洁英语",
        examples: ["Show the workflow."],
        confirmed: true,
      },
    });
    assert.equal(
      await page.getByLabel("选材偏好", { exact: true }).inputValue(),
      "偏好具体教程",
    );
    await page
      .getByRole("button", {
        name: "载入最新偏好（替换当前输入）",
        exact: true,
      })
      .click();
    await page.locator("#editorial-form summary").click();
    preferenceStatus = 503;
    await page.getByLabel("选材偏好", { exact: true }).fill("错误后保留");
    await page
      .getByRole("button", { name: "确认并应用偏好", exact: true })
      .click();
    await page.getByText("模型服务不可用", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("选材偏好", { exact: true }).inputValue(),
      "错误后保留",
    );
    preferenceStatus = 200;
    for (const label of ["选材偏好", "写作风格", "英文风格样本 1（可选）"])
      await page.getByLabel(label, { exact: true }).fill("");
    await page
      .getByRole("button", { name: "确认并应用偏好", exact: true })
      .click();
    await page.getByText(/偏好已应用/).waitFor();
    assert.deepEqual(posts[posts.length - 1].body, {
      expectedVersion: 2,
      selectionGuidance: "",
      writingGuidance: "",
      examples: [],
      confirmed: true,
    });
    legacy = true;
    await page
      .getByRole("button", { name: "今日新发现 2", exact: true })
      .click();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page
      .getByRole("heading", { name: "历史推荐", exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#topics-list article").count(),
      4,
      "old snapshots show all recommendations",
    );
    assert.equal(
      await page.locator("#editorial-preferences").isVisible(),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
