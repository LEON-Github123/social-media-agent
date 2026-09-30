import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Read only bounded regular UTF-8 files; a named pipe must not block the worker. */
export async function readLocalText(
  path: string,
  maxBytes = 1_000_000,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5_000_000)
    throw new Error("Invalid local file byte limit");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Input must be a regular file");
    if (info.size > maxBytes)
      throw new Error(`Input file exceeds ${maxBytes} bytes`);
    const data = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await file.read(
        data,
        length,
        data.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes)
      throw new Error(`Input file exceeds ${maxBytes} bytes`);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      data.subarray(0, length),
    );
  } finally {
    await file.close();
  }
}
