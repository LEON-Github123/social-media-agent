// Built-artifact/container smoke test. Never load .env files or business keys.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

let child;
let directory;
let origin = process.argv[2];
const password = origin
  ? process.env.WORKBENCH_TEST_PASSWORD
  : randomBytes(32).toString("hex");
assert.ok(password && password.length >= 20, "Provide a test-only password");
try {
  if (!origin) {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    directory = await mkdtemp(join(tmpdir(), "postiz-built-web-"));
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(CONTENT_|POSTIZ_|OPENAI_|ANTHROPIC_|LANGCHAIN_|LANGSMITH_|FIRECRAWL_|GETXAPI_|TWITTERAPI_IO_)/.test(
            key,
          ),
      ),
    );
    child = spawn(
      process.execPath,
      ["dist-postiz/src/postiz/cli.js", "serve"],
      {
        env: {
          ...cleanEnv,
          CONTENT_ENV_FILE: join(directory, "missing.env"),
          CONTENT_DB_PATH: join(directory, "content.sqlite"),
          CONTENT_BRAND_FILE: "config/postiz/brand.example.json",
          CONTENT_SOURCES_FILE:
            "config/postiz/sources.tokenhot-competitors.json",
          CONTENT_WORKBENCH_PASSWORD: password,
          CONTENT_WORKBENCH_URL: origin,
          CONTENT_AUTO_SUBMIT: "false",
          CONTENT_ALLOW_SCHEDULING: "false",
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.on("error", (error) => {
      throw error;
    });
  }
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child && child.exitCode !== null)
      throw new Error("Built server exited before startup");
    try {
      healthy = (await fetch(`${origin}/healthz`)).ok;
    } catch {
      /* wait for startup */
    }
    if (healthy) break;
    await delay(500);
  }
  assert.ok(healthy, "Server became healthy");
  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Tokenhot/);
  for (const path of ["/app.js", "/styles.css"])
    assert.equal((await fetch(origin + path)).status, 200);
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i);
  const headers = {
    Cookie: cookie.split(";")[0],
    Origin: origin,
    "Content-Type": "application/json",
  };
  const snapshot = await fetch(`${origin}/api/snapshot`, { headers });
  assert.equal(snapshot.status, 200);
  const body = await snapshot.json();
  assert.equal(
    body.readiness.ready,
    false,
    "Missing business credentials are visible, not a process crash",
  );
  assert.equal(body.quota.used, 0);
  assert.equal(JSON.stringify(body).includes(password), false);
  assert.equal(
    (
      await fetch(`${origin}/api/pause`, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: '{"paused":false}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/logout`, {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`${origin}/api/snapshot`, { headers })).status,
    401,
  );
  console.log(
    "Built workbench: assets, health, authentication, setup state, origin protection and logout passed.",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}
