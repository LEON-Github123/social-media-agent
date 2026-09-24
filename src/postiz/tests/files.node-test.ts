import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalText } from "../files.js";

void test("local file limits count bytes and reject directories before reading", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "content-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "source.txt");
  await writeFile(file, "中文");
  assert.equal(await readLocalText(file, 6), "中文");
  await assert.rejects(readLocalText(file, 5), /exceeds/);
  await assert.rejects(readLocalText(dir, 100), /regular file/);
});

void test("malformed UTF-8 cannot silently alter imported evidence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "content-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "source.txt");
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readLocalText(file), /encoded data|encoding/);
});
