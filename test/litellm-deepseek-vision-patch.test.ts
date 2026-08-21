import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VISION_MODEL,
  patchDeepSeekVisionTransform,
  sha256,
} from "../scripts/patch-litellm-deepseek-vision.mjs";

const original = [
  "class DeepSeekChatConfig(OpenAIGPTConfig):",
  "    def _transform_messages(self, messages, model, is_async=False):",
  "        messages = handle_messages_with_content_list_to_str_conversion(messages)",
  "        return super()._transform_messages(messages=messages, model=model, is_async=is_async)",
  "",
].join("\n");

test("the pinned patch preserves multimodal content only for the exact DeepSeek visual model", () => {
  const patched = patchDeepSeekVisionTransform(original, sha256(original));
  assert.match(patched, new RegExp(`if model != "${VISION_MODEL}"`));
  assert.match(patched, /            messages = handle_messages_with_content_list_to_str_conversion/);
  assert.doesNotMatch(patched, /^        messages = handle_messages_with_content_list_to_str_conversion/m);
  assert.equal(patchDeepSeekVisionTransform(patched, sha256(original)), patched, "patch must be idempotent");
});

test("the pinned patch fails closed on dependency source drift", () => {
  assert.throws(
    () => patchDeepSeekVisionTransform(original.replace("return super()", "return changed_super()"), sha256(original)),
    /checksum changed/,
  );
  assert.throws(
    () => patchDeepSeekVisionTransform(original.replace("        messages =", "        converted ="), sha256(original)),
    /unexpected message-conversion shape/,
  );
});
