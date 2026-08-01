import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AssetKind, AssetLifecycle } from "@prisma/client";

export const MAX_SKILL_CAPABILITIES = 64;
export const MAX_SKILL_CAPABILITY_LENGTH = 160;

const CAPABILITY_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

export function assertAssetLifecycleState(
  actual: AssetLifecycle,
  expected: AssetLifecycle,
  operation: string,
): void {
  if (actual !== expected) {
    throw new BadRequestException(
      `${operation} requires ${expected}, received ${actual}`,
    );
  }
}

function normalizeCapabilityNames(
  values: readonly string[],
  label: string,
): string[] {
  if (values.length > MAX_SKILL_CAPABILITIES) {
    throw new BadRequestException(
      `${label} may contain at most ${MAX_SKILL_CAPABILITIES} capabilities`,
    );
  }

  const normalized = new Set<string>();
  for (const value of values) {
    if (
      value.length > MAX_SKILL_CAPABILITY_LENGTH
      || !CAPABILITY_PATTERN.test(value)
    ) {
      throw new BadRequestException(
        `${label} must use exact lowercase capability names without wildcards`,
      );
    }
    normalized.add(value);
  }
  return [...normalized].sort();
}

export function normalizeRequiredCapabilities(
  kind: AssetKind,
  values: readonly string[] = [],
): string[] {
  const normalized = normalizeCapabilityNames(values, "requiredCapabilities");
  if (kind !== AssetKind.SKILL && normalized.length > 0) {
    throw new BadRequestException(
      "Only SKILL assets may declare execution capabilities",
    );
  }
  return normalized;
}

export function normalizeGrantedCapabilities(
  kind: AssetKind,
  requiredValues: readonly string[],
  grantedValues: readonly string[] = [],
): string[] {
  const required = new Set(normalizeRequiredCapabilities(kind, requiredValues));
  const granted = normalizeCapabilityNames(
    grantedValues,
    "grantedCapabilities",
  );
  if (kind !== AssetKind.SKILL && granted.length > 0) {
    throw new BadRequestException(
      "Only SKILL assets may receive execution capabilities",
    );
  }
  for (const capability of granted) {
    if (!required.has(capability)) {
      throw new BadRequestException(
        "A reviewed skill may only receive capabilities it declared",
      );
    }
  }
  return granted;
}

/**
 * Execution hosts call this after resolving the organization and audience
 * policy floors. An ungranted or undeclared capability is always denied.
 */
export function assertSkillCapabilitiesGranted(
  requiredValues: readonly string[],
  grantedValues: readonly string[],
  requestedValues: readonly string[],
): string[] {
  const required = new Set(normalizeCapabilityNames(
    requiredValues,
    "requiredCapabilities",
  ));
  const granted = new Set(normalizeCapabilityNames(
    grantedValues,
    "grantedCapabilities",
  ));
  const requested = normalizeCapabilityNames(
    requestedValues,
    "requestedCapabilities",
  );

  for (const capability of requested) {
    if (!required.has(capability) || !granted.has(capability)) {
      throw new ForbiddenException(
        `Skill capability is not approved: ${capability}`,
      );
    }
  }
  return requested;
}
