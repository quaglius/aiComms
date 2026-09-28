/**
 * Secret scanner run on the auto-answerer's output before it is published.
 *
 * `buildReadOnlyAgentSpec` (`src/agent-cli.ts`) keeps the answerer from
 * *reading* secrets, but a read-only model can still echo one it saw while
 * doing its job — a token pasted into a code comment, a key baked into a
 * fixture, a credential typed into the question itself and quoted back. Its
 * answer is published to a shared channel, so this is the last line of
 * defense before that happens.
 *
 * `findings` names which *pattern* matched (`'github-token'`, …), never the
 * matched text — the finding is logged (`daemon.log`) and must never itself
 * become a place a secret leaks out to.
 */

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'private-key-block',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    name: 'github-token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    // Anthropic (`sk-ant-...`) and OpenAI-shaped (`sk-...`) API keys share the
    // `sk-` prefix, so one pattern covers both.
    name: 'sk-api-key',
    regex: /\bsk-(?:ant-)?[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g,
  },
  {
    name: 'aws-access-key-id',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g,
  },
  {
    name: 'slack-token',
    regex: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'google-api-key',
    regex: /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'credential-uri',
    // scheme://user:pass@... — redacts the scheme+credentials, leaving the
    // host/path (still useful for pointing at *where*, per the bus's
    // "pointers, not content" rule) out of the match.
    regex: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/:@'"]+@/g,
  },
  {
    name: 'secret-assignment',
    // A key *containing* one of the credential-shaped words — password/
    // passwd/pwd/secret/token/api[_-]key/access[_-]key/private[_-]key/
    // credential(s) — with any identifier characters before or after it
    // (`DB_PASSWORD`, `STRIPE_SECRET`, `client_secret`, `AWS_SECRET_ACCESS_KEY`),
    // optionally quoted (`"password"` in a JSON blob), followed by `:`/`=`
    // and a value that is either a quoted string of 8+ chars or an unquoted
    // run of 8+ "secret-shaped" characters *not* followed by `(` — the `(`
    // exclusion is what keeps `const token = getToken()` from matching: the
    // identifier right of `=` is a call, not a literal, and a plain `\S{8,}`
    // would otherwise flag it (`getToken()` is 10 non-space chars). A bare
    // type annotation like `password: string` and an interpolation like
    // `token=${token}` also fail the value check (too short, or `$` isn't a
    // "secret-shaped" character), so neither is redacted.
    regex:
      /["']?\b[A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_]*\b["']?\s*[:=]\s*(?:(["'])(?:(?!\1).){8,}\1|[A-Za-z0-9_\-+/.]{8,}(?!\())/gi,
  },
  {
    name: 'aws-secret-access-key',
    // An AWS secret access key is an unlabeled 40-char base64-ish string —
    // unlike the access key id (`AKIA`/`ASIA` prefix) it has no recognizable
    // shape of its own, so on its own it's indistinguishable from any other
    // base64 blob. Flag one only when it appears within 40 characters after
    // the standalone word "aws" or "secret" (case-insensitive) — a lookbehind,
    // so the anchor word itself is left in place and only the value is
    // redacted. This catches labeled forms the key-based pattern above misses
    // when the label and the value aren't directly adjacent (free text
    // between them, e.g. "AWS secret access key (rotate soon): <value>").
    regex: /(?<=\b(?:aws|secret)\b[\s\S]{0,40}?)(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=])/gi,
  },
];

export interface RedactionResult {
  text: string;
  /** Pattern names that matched, one entry per match — never the matched text. */
  findings: string[];
}

export function redactSecrets(text: string): RedactionResult {
  let result = text;
  const findings: string[] = [];

  for (const pattern of SECRET_PATTERNS) {
    // A fresh RegExp per use: global regexes carry `lastIndex` state, and
    // reusing the same instance across the count pass and the replace pass
    // (or across calls) can skip or double-match.
    const countRe = new RegExp(pattern.regex.source, pattern.regex.flags);
    const matches = result.match(countRe);
    if (!matches || matches.length === 0) continue;

    for (let i = 0; i < matches.length; i++) findings.push(pattern.name);
    const replaceRe = new RegExp(pattern.regex.source, pattern.regex.flags);
    result = result.replace(replaceRe, '[redacted]');
  }

  return { text: result, findings };
}
