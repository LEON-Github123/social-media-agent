/* global document, window, URL, fetch */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    snapshot: null,
    selectedJob: null,
    detail: null,
    busy: false,
    loading: false,
    timer: null,
  };
  const statusNames = {
    new: "待筛选",
    selected: "已选中",
    rejected: "已拒绝",
    needs_review: "待审核",
    failed: "失败",
    ready: "就绪",
    existing: "已有选题",
    queued: "排队中",
    processing: "生成中",
    submitting: "提交中",
    submitted: "已提交",
    unknown: "结果待核实",
    pending: "等待抓取",
    fetched: "已抓取",
    draft: "Postiz 草稿",
    scheduled: "已排期",
    published: "已发布",
    accepted: "已接收",
    not_submitted: "未提交",
    start: "开始",
    finish: "完成",
    error: "出错",
    edit: "修改",
    reject: "拒绝",
    note: "备注",
  };
  const stageNames = {
    discovery: "来源收集",
    selection: "选题筛选",
    writing: "内容生成",
    submission: "提交 Postiz",
    sync: "同步 Postiz",
    tick: "流程",
    pause: "暂停状态",
    relevance: "相关性判断",
    report: "研究简报",
    post: "生成文案",
    quality: "质量检查",
    "writing.job": "生成任务",
    "submission.job": "提交任务",
    "submission.manual": "手动提交",
    "sync.manual": "手动同步",
  };
  const checkNames = {
    brand: "品牌配置",
    model: "写作模型",
    integration: "X 账号绑定",
    postiz: "Postiz API",
  };
  const missingCheckHelp = {
    brand: "品牌配置缺失或无效",
    model: "写作模型凭据或模型名称缺失",
    integration: "X 渠道 ID 缺失",
    postiz: "Postiz API 凭据缺失",
  };
  const time = (value) => {
    if (value == null || value === "") return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
  };
  const label = (value) => statusNames[value] || String(value || "—");
  const text = (value) => (value == null || value === "" ? "—" : String(value));
  const array = (value) => (Array.isArray(value) ? value : []);
  const shortId = (value) =>
    value && value.length > 24
      ? `${value.slice(0, 10)}…${value.slice(-8)}`
      : value;
  const topicById = (id) =>
    array(state.snapshot?.topics).find((topic) => topic.id === id);
  const titleForJob = (id) =>
    array(state.snapshot?.topics).find(
      (topic) => topic.jobId === id && !topic.mergedIntoTopicId,
    )?.title || shortId(id);
  const node = (tag, cls, content) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (content != null) el.textContent = String(content);
    return el;
  };
  const add = (parent, ...children) => {
    children.filter(Boolean).forEach((child) => parent.append(child));
    return parent;
  };
  const clear = (el) => el.replaceChildren();
  const pill = (value, tone) =>
    node("span", `pill ${tone || toneFor(value)}`, label(value));
  const toneFor = (value) =>
    ["failed", "rejected", "unknown", "ERROR"].includes(value)
      ? "danger"
      : [
            "needs_review",
            "pending",
            "submitting",
            "processing",
            "queued",
          ].includes(value)
        ? "warn"
        : [
              "ready",
              "selected",
              "published",
              "draft",
              "scheduled",
              "fetched",
            ].includes(value)
          ? "good"
          : "neutral";
  const safeUrl = (value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const link = (value, caption) => {
    const url = safeUrl(value);
    if (!url) return node("span", "muted", text(caption || value));
    const a = node("a", "external", caption || url);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  };
  const empty = (title, detail) =>
    add(
      node("div", "empty"),
      node("strong", "", title),
      node("span", "", detail),
    );
  const note = (message, kind = "info") => {
    const el = $("notice");
    el.textContent = message;
    el.className = `notice ${kind}`;
    el.hidden = !message;
  };
  const setBusy = (busy) => {
    state.busy = busy;
    document.querySelectorAll("button").forEach((button) => {
      if (button.id === "refresh") return;
      if (button.id === "run")
        button.disabled =
          busy ||
          !state.snapshot?.readiness?.ready ||
          !!state.snapshot?.runtime?.running ||
          !!state.snapshot?.runtime?.paused;
      else if (button.closest("#app-view form"))
        button.disabled =
          busy ||
          !state.snapshot?.readiness?.ready ||
          !!(
            button.closest("#job-detail .actions") && $("detail-refresh-error")
          );
      else button.disabled = busy;
    });
  };

  async function request(path, method = "GET", body) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* A gateway may return an empty error body. */
    }
    if (response.status === 401) {
      if (path === "/api/login") throw new Error("密码不正确，请重试。");
      const expired = !!state.snapshot;
      showLogin(expired);
      throw new Error(
        expired ? "登录已过期，请重新输入工作台密码" : "请先登录工作台",
      );
    }
    if (!response.ok)
      throw new Error(
        typeof data?.error === "string"
          ? data.error
          : `请求失败（${response.status}）`,
      );
    return data;
  }

  function showLogin(expired = false) {
    $("loading-view").hidden = true;
    $("login-view").hidden = false;
    $("app-view").hidden = true;
    $("logout").hidden = true;
    $("connection").textContent = expired ? "会话已过期" : "需要登录";
    $("login-error").textContent = expired ? "会话已过期，请重新登录。" : "";
    $("login-error").hidden = !expired;
    $("password").value = "";
    $("password").focus();
  }
  function showApp() {
    $("loading-view").hidden = true;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("logout").hidden = false;
    $("connection").textContent = "已连接";
  }

  async function refresh({
    detail = false,
    quiet = false,
    preserveForm = false,
  } = {}) {
    if (state.loading || state.busy) return;
    state.loading = true;
    if (!$("loading-view").hidden) {
      $("loading-view").classList.remove("failed");
      $("loading-view").querySelector("h2").textContent = "正在连接工作台";
      $("loading-view").querySelector("p").textContent =
        "读取运行状态与今日任务…";
    }
    if (!quiet) $("connection").textContent = "正在同步";
    try {
      const snapshot = await request("/api/snapshot");
      state.snapshot = snapshot;
      showApp();
      render(snapshot);
      if (detail && state.selectedJob)
        await loadJob(state.selectedJob, { preserveForm });
      if (!quiet) note("数据已更新。", "success");
    } catch (error) {
      if (!$("app-view").hidden) {
        $("connection").textContent = "连接异常";
        note(error.message, "error");
      } else if (
        !$("login-view").hidden &&
        error.message !== "登录已过期，请重新输入工作台密码"
      ) {
        $("login-error").textContent = error.message;
        $("login-error").hidden = false;
      } else if (!$("loading-view").hidden) {
        $("connection").textContent = "连接异常";
        $("loading-view").classList.add("failed");
        $("loading-view").querySelector("h2").textContent = "暂时无法连接";
        $("loading-view").querySelector("p").textContent =
          `${error.message}。请点击右上角“刷新”重试。`;
      }
    } finally {
      state.loading = false;
    }
  }
  async function mutate(path, payload, success, options = {}) {
    if (state.busy) return;
    setBusy(true);
    note("正在处理，请稍候…");
    try {
      await request(path, "POST", payload);
      note(success, "success");
      if (options.reset) options.reset();
    } catch (error) {
      note(error.message, "error");
    } finally {
      setBusy(false);
      await refresh({ detail: true, quiet: true });
    }
  }

  function render(s) {
    const report = s.report || {};
    const jobs = array(report.jobs?.items);
    const topics = array(s.topics);
    const waiting = topics.filter(
      (t) => t.status === "needs_review" && !t.mergedIntoTopicId,
    ).length;
    const repair = jobs.filter((j) =>
      ["failed", "rejected", "unknown"].includes(j.localState),
    ).length;
    $("snapshot-time").textContent =
      `更新于 ${time(report.scope?.generatedAt || Date.now())} · 北京时间`;
    $("quota-value").textContent = s.quota
      ? `${s.quota.remaining} / ${s.quota.limit}`
      : "—";
    $("quota-meta").textContent = s.quota
      ? `今日已用 ${s.quota.used} 次 · ${time(s.quota.resetsAt)} 重置 · ${s.quota.timeZone || "Asia/Shanghai"}`
      : "额度暂不可用";
    $("quota-fill").max = s.quota?.limit || 3;
    $("quota-fill").value = s.quota?.used || 0;
    $("runtime-value").textContent = s.runtime?.paused
      ? "已暂停"
      : s.runtime?.running
        ? "运行中"
        : "待命";
    $("runtime-meta").textContent = s.runtime?.stage
      ? `当前阶段：${stageNames[s.runtime.stage] || s.runtime.stage}`
      : `上次运行：${time(s.runtime?.lastRunAt)}`;
    $("readiness-value").textContent = s.readiness?.ready
      ? "可以运行"
      : "需要处理";
    const checks = array(s.readiness?.checks);
    $("readiness-meta").textContent =
      `${checks.filter((c) => c.ready).length} / ${checks.length} 项检查通过`;
    const missing = checks.filter((check) => !check.ready);
    $("material-readiness").hidden = !missing.length;
    $("material-readiness").textContent = missing.length
      ? `素材提交暂不可用：${missing.map((check) => missingCheckHelp[check.key] || checkNames[check.key] || check.label).join("、")}。请检查服务端配置。`
      : "";
    $("attention-value").textContent = String(waiting + repair);
    $("attention-meta").textContent =
      `${waiting} 个待审选题 · ${repair} 个待处理任务`;
    $("brand-name").textContent = s.brand?.name || "品牌未配置";
    $("runtime-error").textContent = s.runtime?.lastError || "";
    $("runtime-error").hidden = !s.runtime?.lastError;
    $("run").disabled =
      state.busy ||
      !s.readiness?.ready ||
      !!s.runtime?.running ||
      !!s.runtime?.paused;
    $("pause").textContent = s.runtime?.paused ? "恢复处理" : "暂停处理";
    const postiz = safeUrl(s.postizUrl);
    $("sidebar-postiz").hidden = !postiz;
    if (postiz) $("sidebar-postiz").href = postiz;
    renderChecks(checks);
    renderEvents(array(s.events));
    if (!activeFormIn("candidates-list"))
      renderCandidates(array(s.candidates), report);
    if (!activeFormIn("topics-list")) renderTopics(topics);
    renderJobs(jobs);
    renderSources(array(s.sources));
    setBusy(state.busy);
  }
  function activeFormIn(id) {
    const target = $(id);
    return (
      (target.contains(document.activeElement) &&
        document.activeElement.closest("form")) ||
      !!target.querySelector("details[open]")
    );
  }
  function renderEvents(items) {
    const target = $("events-list");
    clear(target);
    if (!items.length)
      return add(
        target,
        empty("暂无流程动态", "运行流程后，这里会显示各阶段进度。"),
      );
    items.slice(0, 8).forEach((event) => {
      const row = node("div", "list-item compact");
      add(
        row,
        add(
          node("div", "item-top"),
          node("h3", "", stageNames[event.stage] || event.stage || "流程"),
          pill(event.status),
        ),
        node(
          "p",
          "item-meta",
          `${time(event.createdAt)}${event.jobId ? ` · 任务 ${event.jobId}` : ""}`,
        ),
      );
      if (event.detail) row.append(node("p", "reason", event.detail));
      target.append(row);
    });
  }
  function renderChecks(checks) {
    const target = $("checks");
    clear(target);
    if (!checks.length)
      return add(target, empty("暂无检查结果", "请刷新后重试。"));
    checks.forEach((item) => {
      const row = add(
        node("div", "check-row"),
        node("span", `check-dot ${item.ready ? "good" : "danger"}`),
        add(
          node("div"),
          node("strong", "", checkNames[item.key] || item.label || item.key),
          node(
            "small",
            "",
            item.ready
              ? "已配置"
              : missingCheckHelp[item.key] || "未配置，请检查服务端设置",
          ),
        ),
      );
      target.append(row);
    });
  }
  function renderCandidates(items, report) {
    const target = $("candidates-list");
    clear(target);
    $("candidate-count").textContent = `${items.length} 条`;
    if (!items.length)
      return add(
        target,
        empty("还没有候选素材", "从上方添加链接，或运行一次采集流程。"),
      );
    const reasons = new Map(
      array(report.candidates?.decisionItems).map((item) => [
        item.id,
        item.reason,
      ]),
    );
    items.forEach((c) => {
      const row = node("article", "list-item");
      const title =
        c.document?.title ||
        c.input?.title ||
        c.document?.url ||
        c.input?.url ||
        c.id;
      add(
        row,
        add(node("div", "item-top"), node("h3", "", title), pill(c.status)),
        node(
          "p",
          "item-meta",
          `${c.origin || "手动"} · ${c.primary ? "主来源" : "补充来源"} · ${label(c.fetchState)} · ${time(c.createdAt)}`,
        ),
      );
      const url = c.document?.url || c.input?.url;
      if (url) row.append(link(url, url));
      const reason = reasons.get(c.id) || c.lastError;
      if (reason)
        row.append(
          node("p", c.lastError ? "inline-warning" : "reason", reason),
        );
      if (c.topicId) {
        const relation = node(
          "p",
          "item-meta",
          `关联选题：${topicById(c.topicId)?.title || shortId(c.topicId)}`,
        );
        relation.title = c.topicId;
        row.append(relation);
      }
      if (c.legacyConflict && c.status === "needs_review" && !c.topicId) {
        row.append(
          node(
            "p",
            "inline-warning",
            "存在历史任务关联；只有确认是不同的新事件后，才能重新进入筛选。",
          ),
        );
        row.append(
          actionForm(
            "确认新事件",
            [field("reason", "确认依据", true)],
            async (values) =>
              mutate(
                `/api/candidates/${encodeURIComponent(c.id)}/retry`,
                { reason: values.reason, confirmNewEvent: true },
                "新事件已确认，候选将重新筛选。",
              ),
          ),
        );
      } else if (
        !c.topicId &&
        !c.legacyConflict &&
        ["failed", "rejected", "needs_review"].includes(c.status)
      ) {
        const form = actionForm(
          "重试候选",
          [field("reason", "重试原因", true)],
          async (values) =>
            mutate(
              `/api/candidates/${encodeURIComponent(c.id)}/retry`,
              { reason: values.reason },
              "候选已提交重试。",
            ),
        );
        row.append(form);
      }
      target.append(row);
    });
  }
  function renderTopics(items) {
    const target = $("topics-list");
    clear(target);
    $("topic-count").textContent = `${items.length} 个`;
    if (!items.length)
      return add(
        target,
        empty("暂无选题", "流程筛选素材后，选题会出现在这里。"),
      );
    items.forEach((topic) => {
      const row = node("article", "list-item");
      add(
        row,
        add(
          node("div", "item-top"),
          node("h3", "", topic.title || topic.identity?.product || topic.id),
          pill(topic.status),
        ),
        node(
          "p",
          "item-meta",
          `${topic.identity?.entity || "未识别实体"} · ${topic.identity?.eventType || "事件待定"} · ${time(topic.createdAt)}`,
        ),
      );
      if (topic.reason) row.append(node("p", "reason", topic.reason));
      if (topic.mergedIntoTopicId)
        row.append(
          node("p", "item-meta", `已合并到：${topic.mergedIntoTopicId}`),
        );
      if (array(topic.conflictingTopicIds).length)
        row.append(
          node(
            "p",
            "inline-warning",
            `可能重复：${topic.conflictingTopicIds.join("、")}`,
          ),
        );
      const sources = add(
        node("div", "source-links"),
        node("small", "", "证据来源"),
      );
      array(topic.sourceUrls).forEach((url) => sources.append(link(url, url)));
      if (sources.childElementCount > 1) row.append(sources);
      if (
        topic.status === "needs_review" &&
        !topic.mergedIntoTopicId &&
        !topic.hasContent
      ) {
        const options = array(topic.conflictingTopicIds)
          .filter((id) => id && id !== topic.id)
          .map((id) => ({ value: id, label: id }));
        row.append(
          actionForm(
            "审核选题",
            [
              selectField("decision", "审核决定", [
                { value: "approve", label: "通过" },
                { value: "reject", label: "拒绝" },
              ]),
              field("reason", "审核理由", true),
              ...(options.length
                ? [
                    selectField("mergeWith", "合并到已有选题（可选）", [
                      { value: "", label: "不合并" },
                      ...options,
                    ]),
                  ]
                : []),
            ],
            async (values) =>
              mutate(
                `/api/topics/${encodeURIComponent(topic.id)}/review`,
                {
                  decision: values.decision,
                  reason: values.reason,
                  ...(values.mergeWith ? { mergeWith: values.mergeWith } : {}),
                },
                "审核结果已保存。",
              ),
          ),
        );
      }
      target.append(row);
    });
  }
  function renderJobs(items) {
    const target = $("jobs-list");
    clear(target);
    $("job-count").textContent = `${items.length} 项`;
    if (!items.length)
      return add(
        target,
        empty("暂无内容任务", "选题通过后，生成任务会在这里出现。"),
      );
    items.forEach((job) => {
      const button = node(
        "button",
        `job-button ${state.selectedJob === job.id ? "selected" : ""}`,
      );
      button.type = "button";
      button.title = job.id;
      button.setAttribute(
        "aria-current",
        state.selectedJob === job.id ? "true" : "false",
      );
      add(
        button,
        add(
          node("span", "job-button-top"),
          node("strong", "", titleForJob(job.id)),
          pill(job.delivery?.status || job.localState),
        ),
        node(
          "small",
          "",
          `${shortId(job.id)} · ${label(job.localState)} · ${time(job.updatedAt)}`,
        ),
      );
      button.addEventListener("click", () => {
        state.selectedJob = job.id;
        renderJobs(items);
        loadJob(job.id);
      });
      target.append(button);
    });
    if (state.selectedJob && !items.some((j) => j.id === state.selectedJob)) {
      state.selectedJob = null;
      state.detail = null;
      clear($("job-detail"));
      $("job-detail").append(empty("选择一项任务", "这里会显示任务详情。"));
    }
  }
  function renderSources(items) {
    const target = $("sources-list");
    clear(target);
    $("source-count").textContent = `${items.length} 个`;
    if (!items.length)
      return add(
        target,
        empty("暂无配置来源", "配置的自动来源及检查进度会显示在这里。"),
      );
    items.forEach((source) => {
      const row = node("article", "list-item compact");
      add(
        row,
        add(
          node("div", "item-top"),
          node("h3", "", source.sourceId || source.origin || "来源"),
          pill(source.lastFailure ? "failed" : "ready"),
        ),
        node(
          "p",
          "item-meta",
          `${source.origin || "来源"} · ${source.primary ? "主来源" : "补充来源"} · 上次检查 ${time(source.checkedAt)} · 下次 ${time(source.nextCheckAt)}`,
        ),
      );
      if (source.lastFailure)
        row.append(
          node(
            "p",
            "inline-warning",
            `${source.lastFailure}（连续失败 ${source.failureCount || 0} 次）`,
          ),
        );
      target.append(row);
    });
  }

  async function loadJob(id, { preserveForm = false } = {}) {
    const target = $("job-detail");
    const sameJob = state.detail?.job?.id === id;
    if (sameJob && preserveForm && activeFormIn("job-detail")) return;
    if (!sameJob) {
      clear(target);
      target.append(empty("正在加载任务", "读取原稿和 Postiz 状态…"));
    }
    try {
      const detail = await request(`/api/jobs/${encodeURIComponent(id)}`);
      if (state.selectedJob !== id) return;
      if (sameJob && preserveForm && activeFormIn("job-detail")) return;
      state.detail = detail;
      renderJobDetail(detail);
      setBusy(state.busy);
    } catch (error) {
      if (state.selectedJob === id) {
        if (sameJob) {
          target.querySelector("#detail-refresh-error")?.remove();
          const warning = node(
            "div",
            "alert-block",
            `详情更新失败：${error.message}。以下是上次读取的内容，请刷新后再操作。`,
          );
          warning.id = "detail-refresh-error";
          target.prepend(warning);
          target.querySelectorAll(".actions button").forEach((button) => {
            button.disabled = true;
          });
        } else {
          clear(target);
          target.append(empty("任务加载失败", error.message));
        }
      }
    }
  }
  function renderJobDetail(detail) {
    const target = $("job-detail");
    clear(target);
    const job = detail.job || {};
    const reportJob =
      array(state.snapshot?.report?.jobs?.items).find(
        (item) => item.id === job.id,
      ) || {};
    const delivery =
      reportJob.delivery?.status ||
      (job.state === "unknown"
        ? "unknown"
        : job.postizState?.toLowerCase() || job.state);
    const heading = node("h3", "", titleForJob(job.id));
    heading.title = job.id || "";
    add(
      target,
      add(
        node("div", "detail-head"),
        add(node("div"), node("span", "eyebrow", "TASK DETAIL"), heading),
        pill(delivery),
      ),
      node(
        "p",
        "item-meta",
        `${shortId(job.id)} · ${label(job.state)} · ${job.mode === "draft" ? "草稿模式" : "排期模式"} · 更新 ${time(job.updatedAt)}`,
      ),
    );
    if (job.lastError)
      target.append(node("p", "inline-warning", job.lastError));
    if (job.state === "unknown")
      target.append(
        node(
          "div",
          "alert-block",
          "提交结果未知。不要再次提交。先在 Postiz 核对是否已创建内容，再用现有 Postiz ID 同步绑定。",
        ),
      );
    const facts = node("dl", "fact-grid");
    [
      ["Postiz ID", job.postizId],
      ["Postiz 状态", job.postizState],
      ["平台文章 ID", job.platformPostId],
      ["计划时间", job.scheduledAt ? time(job.scheduledAt) : null],
    ].forEach(([name, value]) =>
      add(facts, node("dt", "", name), node("dd", "", text(value))),
    );
    target.append(facts);
    if (job.platformUrl) target.append(link(job.platformUrl, "查看平台文章 ↗"));
    const postiz = safeUrl(detail.postizUrl || state.snapshot?.postizUrl);
    if (postiz) target.append(link(postiz, "打开 Postiz 完成最终审阅 ↗"));
    section(
      target,
      "原始生成内容",
      reportJob.originalPost || job.output?.post || "暂无原稿",
      "pre-wrap",
    );
    const output =
      job.output && typeof job.output === "object" ? job.output : null;
    const checks =
      output?.quality ||
      output?.check ||
      output?.checks ||
      output?.qualityCheck;
    if (checks)
      section(
        target,
        "检查结果",
        typeof checks === "string"
          ? checks
          : `${checks.approved === true ? "检查通过" : checks.approved === false ? "检查未通过" : "等待确认"}${array(checks.reasons).length ? `\n${checks.reasons.join("\n")}` : ""}`,
        "pre-wrap",
      );
    const sources = array(job.input?.sources);
    if (sources.length) {
      const box = add(node("div", "detail-section"), node("h4", "", "来源"));
      sources.forEach((source) =>
        box.append(link(source.url, source.title || source.url)),
      );
      target.append(box);
    }
    const latest =
      array(detail.observations).at(-1) || reportJob.latestObservation;
    if (latest) {
      section(
        target,
        "Postiz 最近观察",
        `${time(latest.observedAt)} · ${text(latest.postizState)}${latest.content ? `\n\n${latest.content}` : ""}`,
        "pre-wrap",
      );
      if (reportJob.edited !== null && reportJob.edited !== undefined)
        target.append(
          node(
            "p",
            "item-meta",
            reportJob.edited
              ? "Postiz 内容与原稿不同"
              : "Postiz 内容与原稿一致",
          ),
        );
    }
    const history = array(detail.history);
    if (history.length) {
      const box = add(
        node("div", "detail-section"),
        node("h4", "", "操作历史"),
      );
      history.forEach((h) =>
        box.append(
          node(
            "p",
            "history-line",
            `${time(h.createdAt)} · ${h.eventType || h.type || "记录"} · ${h.reason || ""}`,
          ),
        ),
      );
      target.append(box);
    }
    const feedback = array(detail.feedback);
    if (feedback.length) {
      const box = add(node("div", "detail-section"), node("h4", "", "反馈"));
      feedback.forEach((f) =>
        box.append(
          node(
            "p",
            "history-line",
            `${time(f.createdAt)} · ${label(f.kind)} · ${f.reason}`,
          ),
        ),
      );
      target.append(box);
    }
    const events = array(detail.events);
    if (events.length) {
      const box = add(
        node("div", "detail-section"),
        node("h4", "", "流程事件"),
      );
      events.forEach((e) =>
        box.append(
          node(
            "p",
            "history-line",
            `${time(e.createdAt)} · ${stageNames[e.stage] || e.stage} · ${label(e.status)}${e.detail ? ` · ${e.detail}` : ""}`,
          ),
        ),
      );
      target.append(box);
    }
    renderJobActions(target, job);
  }
  function section(parent, title, body, cls = "") {
    parent.append(
      add(
        node("div", "detail-section"),
        node("h4", "", title),
        node("div", cls, body),
      ),
    );
  }
  function renderJobActions(target, job) {
    const actions = add(
      node("div", "detail-section actions"),
      node("h4", "", "处理此任务"),
    );
    if (job.state === "ready" && job.mode === "draft")
      actions.append(
        actionForm("提交到 Postiz 草稿", [], async () =>
          mutate(
            `/api/jobs/${encodeURIComponent(job.id)}/submit`,
            {},
            "已发起提交，请核对 Postiz 回执。",
          ),
        ),
      );
    if (["failed", "rejected"].includes(job.state) && !job.postizId)
      actions.append(
        actionForm(
          "重试任务",
          [
            field("reason", "处理原因", true),
            checkbox("refreshBrand", "使用最新品牌配置"),
            checkbox("toDraft", "改为草稿模式"),
          ],
          async (v) =>
            mutate(
              `/api/jobs/${encodeURIComponent(job.id)}/retry`,
              {
                reason: v.reason,
                refreshBrand: v.refreshBrand,
                toDraft: v.toDraft,
              },
              "任务已提交重试。",
            ),
        ),
      );
    if (job.state === "submitted")
      actions.append(
        actionForm("同步 Postiz 状态", [], async () =>
          mutate(
            `/api/jobs/${encodeURIComponent(job.id)}/sync`,
            {},
            "同步已完成。",
          ),
        ),
      );
    if (job.state === "unknown")
      actions.append(
        actionForm(
          "绑定现有 Postiz 内容",
          [
            field("postizId", "已有 Postiz ID", true),
            checkbox("acceptEdited", "核对后接受 Postiz 中已修改的内容"),
            field("reason", "核对说明（接受修改时必填）", false),
          ],
          async (v) =>
            mutate(
              `/api/jobs/${encodeURIComponent(job.id)}/sync`,
              {
                postizId: v.postizId,
                acceptEdited: v.acceptEdited,
                ...(v.reason ? { reason: v.reason } : {}),
              },
              "现有 Postiz 内容已绑定。",
            ),
        ),
      );
    actions.append(
      actionForm(
        "记录反馈",
        [
          selectField("kind", "反馈类型", [
            { value: "edit", label: "修改" },
            { value: "reject", label: "拒绝" },
            { value: "note", label: "备注" },
          ]),
          field("reason", "原因或备注", true),
        ],
        async (v) =>
          mutate(
            `/api/jobs/${encodeURIComponent(job.id)}/feedback`,
            { kind: v.kind, reason: v.reason },
            "反馈已记录。",
          ),
      ),
    );
    target.append(actions);
  }
  function field(name, caption, required, value = "") {
    return { type: "text", name, caption, required, value };
  }
  function checkbox(name, caption) {
    return { type: "checkbox", name, caption };
  }
  function selectField(name, caption, options) {
    return { type: "select", name, caption, options };
  }
  function actionForm(caption, fields, submit) {
    const details = node("details", "action-form");
    details.append(node("summary", "", caption));
    const form = node("form", "stack-form small-form");
    fields.forEach((spec) => {
      const id = `f-${Math.random().toString(36).slice(2)}`;
      if (spec.type === "checkbox") {
        const wrap = node("label", "check-field");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = spec.name;
        wrap.append(input, document.createTextNode(spec.caption));
        form.append(wrap);
        return;
      }
      const lbl = node("label", "", spec.caption);
      lbl.htmlFor = id;
      form.append(lbl);
      let input;
      if (spec.type === "select") {
        input = document.createElement("select");
        spec.options.forEach((option) => {
          const opt = document.createElement("option");
          opt.value = option.value;
          opt.textContent = option.label;
          input.append(opt);
        });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = spec.value || "";
        input.required = !!spec.required;
      }
      input.id = id;
      input.name = spec.name;
      form.append(input);
    });
    const button = node("button", "button secondary", caption);
    button.type = "submit";
    form.append(button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = {};
      fields.forEach((spec) => {
        const input = form.elements.namedItem(spec.name);
        values[spec.name] =
          spec.type === "checkbox" ? input.checked : input.value.trim();
      });
      if (values.acceptEdited && !values.reason) {
        note("接受 Postiz 中的修改需要填写核对说明。", "error");
        form.elements.namedItem("reason").focus();
        return;
      }
      submit(values);
    });
    details.append(form);
    return details;
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("password").value;
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    $("login-error").hidden = true;
    try {
      await request("/api/login", "POST", { password });
      $("password").value = "";
      await refresh();
    } catch (error) {
      $("login-error").textContent = error.message;
      $("login-error").hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  $("logout").addEventListener("click", async () => {
    try {
      await request("/api/logout", "POST", {});
    } catch {
      /* Still clear the visible session. */
    }
    state.snapshot = null;
    state.selectedJob = null;
    showLogin();
  });
  $("refresh").addEventListener("click", () => refresh({ detail: true }));
  $("run").addEventListener("click", () =>
    mutate("/api/run", {}, "流程已启动，进度会自动更新。"),
  );
  $("pause").addEventListener("click", () =>
    mutate(
      "/api/pause",
      { paused: !state.snapshot?.runtime?.paused },
      state.snapshot?.runtime?.paused ? "处理已恢复。" : "处理已暂停。",
    ),
  );
  $("material-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const source = { url: $("material-url").value.trim() };
    if ($("material-title").value.trim())
      source.title = $("material-title").value.trim();
    if ($("material-text").value.trim())
      source.text = $("material-text").value.trim();
    if ($("material-date").value)
      source.publishedAt = new Date($("material-date").value).toISOString();
    mutate("/api/materials", { sources: [source] }, "素材已添加。", {
      reset: () => $("material-form").reset(),
    });
  });
  $("batch-form").addEventListener("submit", (event) => {
    event.preventDefault();
    let sources;
    try {
      sources = JSON.parse($("batch-json").value);
      if (
        !Array.isArray(sources) ||
        !sources.length ||
        sources.some(
          (item) => !item || typeof item.url !== "string" || !safeUrl(item.url),
        )
      )
        throw new Error("请输入包含有效 http(s) 链接的非空素材数组。");
    } catch (error) {
      note(
        error instanceof SyntaxError ? "JSON 格式不正确。" : error.message,
        "error",
      );
      return;
    }
    mutate("/api/materials", { sources }, "批量素材已添加。", {
      reset: () => $("batch-form").reset(),
    });
  });
  refresh();
  state.timer = window.setInterval(() => {
    if (!document.hidden && $("login-view").hidden)
      refresh({
        detail: !!state.selectedJob && !activeFormIn("job-detail"),
        quiet: true,
        preserveForm: true,
      });
  }, 30000);
})();
