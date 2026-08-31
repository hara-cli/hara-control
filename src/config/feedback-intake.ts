import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";

function readPrivateKeyFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("HARA_FEEDBACK_INTAKE_KEYFILE must be absolute");
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("HARA_FEEDBACK_INTAKE_KEYFILE must be a regular file");
  }
  if ((before.mode & 0o077) !== 0) {
    throw new Error("HARA_FEEDBACK_INTAKE_KEYFILE must use owner-only permissions");
  }
  if (typeof process.geteuid === "function" && before.uid !== process.geteuid()) {
    throw new Error("HARA_FEEDBACK_INTAKE_KEYFILE must be owned by the service user");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("HARA_FEEDBACK_INTAKE_KEYFILE changed while opening");
    }
    return readFileSync(descriptor, "utf8").trim();
  } finally {
    closeSync(descriptor);
  }
}

/** Load the purpose-scoped intake credential without ever returning a broad Control credential. */
export function loadFeedbackIntakeKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const inline = env.HARA_FEEDBACK_INTAKE_KEY?.trim() || "";
  const keyfile = env.HARA_FEEDBACK_INTAKE_KEYFILE?.trim() || "";
  if (inline && keyfile) {
    throw new Error("configure only one feedback intake key source");
  }
  if (!inline && !keyfile) return null;
  const key = inline || readPrivateKeyFile(keyfile);
  if (key.length < 32) throw new Error("feedback intake credential is too short");
  return key;
}
