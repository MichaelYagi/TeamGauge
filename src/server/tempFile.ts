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
  const { path: filePath, cleanup } = await createTempFile(buffer, suffix);
  try {
    return await fn(filePath);
  } finally {
    await cleanup();
  }
}

// Same scratch-file mechanics as withTempFile, but for a caller that needs
// to read the file more than once across a span of `await`s (e.g. one
// provider call, then conditionally another) rather than within a single
// callback — the caller is responsible for calling `cleanup()` when done.
export async function createTempFile(buffer: Buffer, suffix: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "teamgauge-"));
  const filePath = path.join(dir, `upload${suffix}`);
  await writeFile(filePath, buffer);
  return { path: filePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
