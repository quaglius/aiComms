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
    // `(password|secret|token|api_key) [:=] <value>`, where <value> is either
    // a quoted string of 8+ chars, or an unquoted run of 8+ "secret-shaped"
    // characters *not* followed by `(` — the `(` exclusion is what keeps
    // `const token = getToken()` from matching: the identifier right of `=`
    // is a call, not a literal, and the SPEC's literal `\S{8,}` would
    // otherwise flag it (`getToken()` is 10 non-space chars).
    regex: /\b(password|secret|token|api_key)\b\s*[:=]\s*(?:(["'])(?:(?!\2).){8,}\2|[A-Za-z0-9_\-+/.]{8,}(?!\())/gi,
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
