import { copyFile, mkdir } from "node:fs/promises";

const source = new URL("../src/postiz/web/", import.meta.url);
const destination = new URL("../dist-postiz/src/postiz/web/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["index.html", "app.js", "styles.css"])
  await copyFile(new URL(name, source), new URL(name, destination));
