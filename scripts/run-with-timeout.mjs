#!/usr/bin/env node
import { spawn } from "node:child_process";

const seconds = Number(process.argv[2]);
const [command, ...args] = process.argv.slice(3);

if (!Number.isFinite(seconds) || seconds <= 0 || !command) {
  console.error("usage: run-with-timeout.mjs <seconds> <command> [args...]");
  process.exit(2);
}

const detached = process.platform !== "win32";
const child = spawn(command, args, {
  stdio: "inherit",
  detached,
});

let timedOut = false;
let forceTimer;

function terminate(signal) {
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`command exceeded ${seconds}s and was terminated`);
  terminate("SIGTERM");
  forceTimer = setTimeout(() => terminate("SIGKILL"), 3_000);
  forceTimer.unref();
}, seconds * 1_000);

child.on("error", (error) => {
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  console.error(`unable to start bounded command: ${error.message}`);
  process.exitCode = 127;
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) process.exitCode = 124;
  else if (typeof code === "number") process.exitCode = code;
  else process.exitCode = signal ? 128 : 1;
});
