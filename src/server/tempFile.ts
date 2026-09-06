import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Providers read from a file path (mirrors how the CLI works). Uploaded
// files arrive as in-memory buffers, so write them to a scratch file for the
// duration of one request.
export async function withTempFile<T>(
  buffer: Buffer,
  suffix: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "teamgauge-"));
  const filePath = path.join(dir, `upload${suffix}`);
  try {
    await writeFile(filePath, buffer);
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
