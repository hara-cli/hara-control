const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/giu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const COMMON_SECRET = /\b(?:sk|ak|rk|pk|ghp|gho|ghu|ghs|github_pat|xoxb|xoxp|xoxa|xoxr)[-_][A-Za-z0-9._-]{8,}\b/giu;
const WINDOWS_HOME_PATH = /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s,;"']+/gu;
const POSIX_HOME_PATH = /\/(?:Users|home)\/[^\s,;"']+/gu;
const URL_SECRET = /([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/giu;

/**
 * Redact credential-shaped values and private home paths before operator-authored or external text
 * reaches the Control database. This is intentionally deterministic so tests and audit review can
 * prove that every intake surface applies the same boundary.
 */
export function sanitizeControlText(value: string, max: number): string {
  return value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(CREDENTIAL_ASSIGNMENT, "credential=***")
    .replace(BEARER_CREDENTIAL, "Bearer ***")
    .replace(COMMON_SECRET, "<secret>")
    .replace(WINDOWS_HOME_PATH, "<local-path>")
    .replace(POSIX_HOME_PATH, "<local-path>")
    .replace(URL_SECRET, "$1***")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}
