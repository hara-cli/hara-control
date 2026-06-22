// Server-side ingest guard for org assets — ported from the CLI's src/memory/guard.ts. The IP-leak
// risk is the headline for B2: secrets get redacted to typed placeholders on contribute, and
// prompt-injection / exfil content is blocked outright (an instruction can't be meaningfully redacted).
// Re-run on publish (never trust the client). Per-org extensible rule lists are a Phase-2b add.

const SECRETS: [RegExp, string][] = [
  [/\bsk-[a-zA-Z0-9_-]{16,}\b/, "sk-key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws-key"],
  [/\bghp_[A-Za-z0-9]{20,}\b/, "github-token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, "private-key"],
];

const INJECTION: [RegExp, string][] = [
  [/ignore (all |your )?(previous|prior|above) (instructions|prompts?)/i, "prompt-injection phrase"],
  [/disregard (your |the )?(system prompt|instructions|rules|guidelines)/i, "prompt-injection phrase"],
  [/\bfile:\/\/\/?\S+/i, "file:// URL"],
];

/** Strip secret-shaped tokens to typed placeholders (capture path). Returns the redacted text + labels. */
export function redactSecrets(text: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let out = text;
  for (const [re, label] of SECRETS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(g, () => {
      redactions.push(label);
      return `<REDACTED:${label}>`;
    });
  }
  return { text: out, redactions };
}

/** Block-only check for injection phrases / exfil URLs (can't be redacted). ok=false → reject. */
export function scanForInjection(text: string): { ok: boolean; hits: string[] } {
  const hits = [...new Set(INJECTION.filter(([re]) => re.test(text)).map(([, label]) => label))];
  return { ok: hits.length === 0, hits };
}
