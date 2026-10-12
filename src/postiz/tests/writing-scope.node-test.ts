import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateContent, validatePost } from "../content.js";
import type { ModelRequest } from "../models.js";
import {
  enqueueContent,
  generateNext,
  submitNext,
  type JobInput,
} from "../runner.js";
import { PostizClient } from "../postiz-client.js";
import { ContentJobStore } from "../store.js";
import { validateContentInput, validateJobInput } from "../validation.js";

const input: JobInput = {
  brand: {
    id: "example-api",
    name: "Example API",
    audience: "Developers",
    businessContext: "Practical API engineering advice",
    language: "English",
    contentRules: [],
    examples: [],
  },
  sources: [
    {
      url: "https://competitor.example/docs",
      text: "Compare retry policies before changing providers.",
    },
  ],
  integrationId: "x-account",
  mediaPaths: [],
  purpose: "brand_original",
  writingAngle: "Compare retry policies",
  writingScope: "general",
  inspirationRequiresFacts: false,
};

function contentInput(overrides: Partial<JobInput> = {}) {
  return validateContentInput({ ...input, ...overrides });
}

void test("general scope survives validation and a persisted job snapshot", (t) => {
  assert.equal(validateJobInput(input).writingScope, "general");
  assert.equal(contentInput().writingScope, "general");
  assert.throws(() => validateJobInput({ ...input, writingScope: "brand" }));
  const directory = mkdtempSync(join(tmpdir(), "writing-scope-"));
  const store = new ContentJobStore(join(directory, "jobs.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const job = enqueueContent(store, input);
  assert.equal(
    validateJobInput(store.get(job.id)!.input).writingScope,
    "general",
  );
});

void test("general without brand facts reaches all stages and carries the scope rule", async () => {
  const calls: ModelRequest[] = [];
  const outputs = [
    '{"relevant":true,"reasoning":"重试策略比较是有用的通用观点"}',
    "<report>比较重试策略，避免将竞对能力转为自身产品主张。</report>",
    "<post>Compare retry policies before changing providers.</post>",
    '{"approved":true,"reasons":[]}',
  ];
  const result = await generateContent(
    contentInput({ inspirationRequiresFacts: true }),
    {
      model: {
        invoke: async (request) => {
          calls.push(request);
          return outputs[calls.length - 1];
        },
      },
    },
  );
  assert.equal(result.quality.approved, true);
  assert.equal(calls.length, 4);
  for (const request of calls) {
    assert.match(request.system, /Writing scope: general/);
    assert.match(
      request.system,
      /implicit transfer of competitor capabilities/,
    );
  }
  assert.match(calls[0].system, /Brand facts are not required/);
});

void test("general rejects configured brand names, IDs and first-person claims even with facts", () => {
  for (const brand of [
    input.brand,
    { ...input.brand, id: "tokenhot", name: "Tokenhot" },
  ]) {
    for (const verifiedFacts of [
      [],
      [
        {
          claim: "The platform supports image models.",
          url: "https://competitor.example/docs",
        },
      ],
    ]) {
      const context = contentInput({ brand: { ...brand, verifiedFacts } });
      for (const post of [
        `${brand.name} supports image models.`,
        `${brand.id} provides fast responses.`,
        "We offer fast inference.",
        "Our service supports image models.",
        "Choose us for fast inference.",
        "我们的平台支持图片模型。",
      ]) {
        assert.ok(
          validatePost(post, context).some((reason) =>
            reason.includes("通用观点范围"),
          ),
          post,
        );
      }
      assert.deepEqual(
        validatePost(
          "Compare retry policies before changing providers.",
          context,
        ),
        [],
      );
    }
  }
});

void test("general quality review can reject implicit competitor capability transfer", async () => {
  const calls: ModelRequest[] = [];
  const outputs = [
    '{"relevant":true,"reasoning":"可以讨论重试策略"}',
    "<report>比较重试策略。</report>",
    "<post>Switch here for the same fast inference.</post>",
    '{"approved":false,"reasons":["隐式将竞对推理性能转移到发布方"]}',
  ];
  const result = await generateContent(contentInput(), {
    model: {
      invoke: async (request) => {
        calls.push(request);
        return outputs[calls.length - 1];
      },
    },
  });
  assert.equal(calls[3].task, "quality");
  assert.match(calls[3].system, /without naming it/);
  assert.equal(result.quality.approved, false);
  assert.match(result.quality.reasons.join(" "), /隐式/);
});

void test("legacy scope keeps missing-fact rejection and verified first-party rules", async () => {
  const legacy = contentInput({
    writingScope: undefined,
    inspirationRequiresFacts: true,
  });
  const result = await generateContent(legacy, {
    model: {
      invoke: async () => {
        throw new Error("Missing facts must stop before model calls");
      },
    },
  });
  assert.equal(result.relevant, false);
  assert.match(result.reasoning, /需要已核实的品牌事实/);
  assert.ok(
    validatePost("Example API supports image models.", legacy).some((reason) =>
      reason.includes("品牌自身"),
    ),
  );
  assert.deepEqual(
    validatePost("Example API supports image models.", {
      ...legacy,
      brand: {
        ...legacy.brand,
        verifiedFacts: [
          {
            claim: "Example API supports image models.",
            url: input.sources[0].url,
          },
        ],
      },
    }),
    [],
  );
});

void test("submission rechecks general scope before any external request", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "writing-scope-submit-"));
  const store = new ContentJobStore(join(directory, "jobs.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const job = enqueueContent(store, {
    ...input,
    brand: {
      ...input.brand,
      verifiedFacts: [
        {
          claim: "Example API supports image models.",
          url: input.sources[0].url,
        },
      ],
    },
  });
  const ready = await generateNext({
    store,
    brandId: input.brand.id,
    jobId: job.id,
    leaseMs: 30_000,
    generate: async (snapshot) => {
      assert.equal(snapshot.writingScope, "general");
      return {
        relevant: true,
        reasoning: "Historical approval",
        report: "Historical brief",
        post: "Example API supports image models.",
        quality: { approved: true, reasons: [] },
        sources: contentInput().sources,
      };
    },
  });
  assert.equal(ready?.state, "ready");
  let requests = 0;
  const client = new PostizClient({
    baseUrl: "http://postiz.test/api/public/v1",
    apiKey: "test",
    fetch: async () => {
      requests++;
      throw new Error("Must not call Postiz");
    },
  });
  const failed = await submitNext({
    store,
    client,
    brandId: input.brand.id,
    jobId: job.id,
    leaseMs: 30_000,
  });
  assert.equal(failed?.state, "failed");
  assert.match(failed!.lastError!, /通用观点范围/);
  assert.equal(requests, 0);
});
