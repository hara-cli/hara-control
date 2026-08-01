import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AssetKind, AssetLifecycle } from "@prisma/client";

import {
  assertAssetLifecycleState,
  assertSkillCapabilitiesGranted,
  normalizeGrantedCapabilities,
  normalizeRequiredCapabilities,
} from "../src/assets/skill-capabilities";

test("asset review and publication operations enforce their lifecycle edge", () => {
  assert.doesNotThrow(() => assertAssetLifecycleState(
    AssetLifecycle.IN_REVIEW,
    AssetLifecycle.IN_REVIEW,
    "Asset review",
  ));
  assert.throws(
    () => assertAssetLifecycleState(
      AssetLifecycle.PUBLISHED,
      AssetLifecycle.IN_REVIEW,
      "Asset review",
    ),
    BadRequestException,
  );
});

test("skill capability declarations are exact, stable and deduplicated", () => {
  assert.deepEqual(
    normalizeRequiredCapabilities(AssetKind.SKILL, [
      "file.read",
      "channel.post",
      "file.read",
    ]),
    ["channel.post", "file.read"],
  );
  assert.throws(
    () => normalizeRequiredCapabilities(AssetKind.SKILL, ["file.*"]),
    BadRequestException,
  );
  assert.throws(
    () => normalizeRequiredCapabilities(AssetKind.KNOWLEDGE, ["file.read"]),
    BadRequestException,
  );
});

test("review grants may only narrow a skill's declared capabilities", () => {
  assert.deepEqual(
    normalizeGrantedCapabilities(
      AssetKind.SKILL,
      ["file.read", "file.write"],
      ["file.read"],
    ),
    ["file.read"],
  );
  assert.throws(
    () => normalizeGrantedCapabilities(
      AssetKind.SKILL,
      ["file.read"],
      ["file.write"],
    ),
    BadRequestException,
  );
});

test("execution denies every capability that was not both declared and granted", () => {
  assert.deepEqual(
    assertSkillCapabilitiesGranted(
      ["file.read", "file.write"],
      ["file.read"],
      ["file.read"],
    ),
    ["file.read"],
  );
  assert.throws(
    () => assertSkillCapabilitiesGranted(
      ["file.read", "file.write"],
      ["file.read"],
      ["file.write"],
    ),
    ForbiddenException,
  );
});
