#!/usr/bin/env node
/* global Buffer, console, process */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const usage = "Usage: node scripts/editor-job.mjs --input export.json --output submission.json -- executable [args...]";
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const inputIndex = args.indexOf("--input");
const outputIndex = args.indexOf("--output");
if (
  separator < 0 || inputIndex < 0 || outputIndex < 0 ||
  !args[inputIndex + 1] || !args[outputIndex + 1] || !args[separator + 1]
) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const inputPath = args[inputIndex + 1];
  const outputPath = args[outputIndex + 1];
  const executable = args[separator + 1];
  const commandArgs = args.slice(separator + 2);
  try {
    const job = JSON.parse(await readFile(inputPath, "utf8"));
    if (!job || typeof job !== "object" || Array.isArray(job))
      throw new Error("The editor export must be a JSON object.");
    const output = await run(executable, commandArgs, JSON.stringify(job));
    const submission = JSON.parse(output);
    if (!submission || typeof submission !== "object" || Array.isArray(submission))
      throw new Error("The editor must write one JSON object to stdout.");
    await writeFile(outputPath, `${JSON.stringify(submission, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Editor job failed.");
    process.exitCode = 1;
  }
}

function run(executable, commandArgs, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, { shell: false, stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024)
        child.kill("SIGTERM");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (Buffer.byteLength(output) > 2 * 1024 * 1024)
        reject(new Error("Editor stdout exceeded 2 MiB."));
      else if (code !== 0)
        reject(new Error(`Editor exited with status ${code ?? "unknown"}.`));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}
