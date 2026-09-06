import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// node:readline/promises' Interface.question() is unreliable for a second
// and later call when stdin is piped (non-TTY) — it hangs indefinitely even
// with buffered input still available. That breaks both scripted/tested
// runs of `teamgauge setup` and any future automation piping answers in. On
// a real TTY, question() works fine, so branch: read the whole piped input
// upfront into a line queue for non-TTY, use normal interactive prompting
// on a real terminal.
let sharedInterface: Interface | null = null;
let pipedLines: string[] | null = null;
let pipedLineIndex = 0;

async function readAllPipedLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").split("\n");
}

function getInterface(): Interface {
  if (!sharedInterface) sharedInterface = createInterface({ input: stdin, output: stdout });
  return sharedInterface;
}

export function closePrompt(): void {
  sharedInterface?.close();
  sharedInterface = null;
}

export async function ask(question: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";

  if (!stdin.isTTY) {
    if (pipedLines === null) pipedLines = await readAllPipedLines();
    const line = (pipedLines[pipedLineIndex++] ?? "").trim();
    stdout.write(`${question}${suffix}: ${line}\n`);
    return line || defaultValue;
  }

  const answer = (await getInterface().question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const answer = await ask(`${question} (y/n)`, defaultYes ? "y" : "n");
  return answer.toLowerCase().startsWith("y");
}
