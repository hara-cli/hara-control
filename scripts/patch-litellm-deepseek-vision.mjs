#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_LITELLM_VERSION = "1.92.0";
export const PINNED_TRANSFORM_SHA256 = "ec443f9040d2aa6f97dedf89be391317ee011f0bac33275a93a2a6171a74b1d1";
export const VISION_MODEL = "deepseek-v4-flash-vision-exp";

const ORIGINAL_LINE = "        messages = handle_messages_with_content_list_to_str_conversion(messages)";
const PATCHED_BLOCK = [
  `        if model != "${VISION_MODEL}":`,
  "            messages = handle_messages_with_content_list_to_str_conversion(messages)",
].join("\n");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** LiteLLM's pinned DeepSeek transform predates this visual model and flattens every content array.
 * Accept only the byte-exact pinned source (or our one known patch), then preserve image blocks solely
 * for the exact model. Any upstream/source drift fails the deployment instead of applying a fuzzy edit. */
export function patchDeepSeekVisionTransform(source, expectedOriginalSha256 = PINNED_TRANSFORM_SHA256) {
  const patchedCount = source.split(PATCHED_BLOCK).length - 1;
  const originalCount = source.split(ORIGINAL_LINE).length - 1;
  if (patchedCount > 1 || originalCount > 1 || (patchedCount === 0 && originalCount !== 1)) {
    throw new Error("pinned LiteLLM DeepSeek transform has an unexpected message-conversion shape");
  }

  const canonical = patchedCount === 1
    ? source.replace(PATCHED_BLOCK, ORIGINAL_LINE)
    : source;
  if (sha256(canonical) !== expectedOriginalSha256) {
    throw new Error("pinned LiteLLM DeepSeek transform checksum changed; review before patching");
  }
  return canonical.replace(ORIGINAL_LINE, PATCHED_BLOCK);
}

function targetTransform(workspace) {
  const requirements = readFileSync(join(workspace, "deploy/nanhara-tech/requirements-litellm.txt"), "utf8");
  if (!new RegExp(`^litellm\\[proxy\\]==${PINNED_LITELLM_VERSION.replaceAll(".", "\\.")}$`, "m").test(requirements)) {
    throw new Error(`vision patch requires pinned LiteLLM ${PINNED_LITELLM_VERSION}`);
  }

  const versionsRoot = realpathSync(join(workspace, ".litellm-venvs"));
  const activeVenv = realpathSync(join(workspace, ".litellm-venv"));
  const fromRoot = relative(versionsRoot, activeVenv);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("active LiteLLM runtime must resolve inside the managed version directory");
  }
  const pythonDirs = readdirSync(join(activeVenv, "lib")).filter((name) => /^python3\.\d+$/u.test(name));
  if (pythonDirs.length !== 1) throw new Error("managed LiteLLM runtime must contain one Python library directory");
  return join(
    activeVenv,
    "lib",
    pythonDirs[0],
    "site-packages/litellm/llms/deepseek/chat/transformation.py",
  );
}

export function patchInstalledLiteLLM(workspace = process.cwd()) {
  const target = targetTransform(resolve(workspace));
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("LiteLLM transform must be a regular file");
  const source = readFileSync(target, "utf8");
  const patched = patchDeepSeekVisionTransform(source);
  if (patched === source) {
    return { changed: false, target, sha256: sha256(patched) };
  }

  const temporary = join(dirname(target), `.hara-deepseek-vision-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, patched, { encoding: "utf8", mode: stat.mode & 0o777 });
    chownSync(temporary, stat.uid, stat.gid);
    chmodSync(temporary, stat.mode & 0o777);
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* absent temporary file */ }
    throw error;
  }
  return { changed: true, target, sha256: sha256(patched) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = patchInstalledLiteLLM();
    console.log(`✓ LiteLLM DeepSeek vision transform ${result.changed ? "patched" : "already verified"} (${result.sha256.slice(0, 12)})`);
  } catch (error) {
    console.error(`✗ LiteLLM DeepSeek vision patch failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
