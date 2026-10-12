// Railway mounts volumes as root. Prepare only a dedicated child directory,
// then permanently drop privileges before importing any application code.
import { chown, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const directory = "/data/worker";
const database = resolve(
  process.env.CONTENT_DB_PATH || `${directory}/content.sqlite`,
);
if (!database.startsWith(directory + sep) || dirname(database) !== directory)
  throw new Error(
    "Railway workbench database must be directly inside /data/worker",
  );
await mkdir(directory, { recursive: true });
if ((await realpath(directory)) !== directory)
  throw new Error("Railway worker data directory must not be a symbolic link");
if (process.getuid?.() === 0) {
  await chown(directory, 1000, 1000);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
if (process.getuid?.() !== 1000)
  throw new Error("Railway workbench must run as the node user");
process.env.CONTENT_DB_PATH = database;
console.log("Workbench starting as non-root user with persistent storage");
const { main } = await import("../dist-postiz/src/postiz/cli.js");
await main(["serve"]);
