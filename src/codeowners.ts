import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { globMatches, globsOverlap } from './envelope.js';

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/** Where GitHub itself looks for CODEOWNERS, in the order it checks them. */
const CODEOWNERS_LOCATIONS = [
  path.join('.github', 'CODEOWNERS'),
  'CODEOWNERS',
  path.join('docs', 'CODEOWNERS'),
];

/**
 * A CODEOWNERS owner token is either `@username`, `@org/team`, or an email
 * address. Only `@username` maps to a bus login — teams have no single
 * GitHub login to route a question to, and emails aren't logins at all.
 */
function parseOwnerToken(token: string): string | null {
  if (!token.startsWith('@')) return null;
  const rest = token.slice(1);
  if (!rest || rest.includes('/')) return null;
  return rest;
}

/**
 * Reads and parses the repo's CODEOWNERS file, checking `.github/`, the
 * repo root, and `docs/` in that order (GitHub's own search order) and using
 * the first one found. Returns `null` when none of the three exist.
 */
export function loadCodeowners(repoRoot: string): CodeownersRule[] | null {
  const found = CODEOWNERS_LOCATIONS.map((rel) => path.join(repoRoot, rel)).find((p) => existsSync(p));
  if (!found) return null;

  const raw = readFileSync(found, 'utf8');
  const rules: CodeownersRule[] = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const tokens = line.split(/\s+/);
    const pattern = tokens[0]!;
    const owners = dedupeLoginsCaseInsensitive(
      tokens.slice(1).map(parseOwnerToken).filter((o): o is string => o !== null),
    );
    rules.push({ pattern, owners });
  }

  return rules;
}

/**
 * Deduplicates logins case-insensitively (GitHub logins are case-insensitive)
 * while keeping each login's first-seen casing — never lowercasing it, so a
 * CODEOWNERS entry written as `@Alice` still routes to the login exactly as
 * that file spelled it.
 */
function dedupeLoginsCaseInsensitive(logins: string[]): string[] {
  const seen = new Map<string, string>();
  for (const login of logins) {
    const key = login.toLowerCase();
    if (!seen.has(key)) seen.set(key, login);
  }
  return [...seen.values()];
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

/**
 * Converts one CODEOWNERS pattern into a set of glob-comparable candidate
 * strings, using the glob syntax `globMatches`/`globsOverlap`
 * (src/envelope.ts) understand (`*`, `**`, literal characters):
 *
 * - A leading `/` anchors the pattern to the repo root.
 * - A pattern with no `/` at all (aside from a possible trailing one)
 *   matches at any depth, so it also gets a `**\/pattern` form.
 * - A trailing `/` marks a directory; we always also add a `.../**` form so
 *   a pattern reaches under what it names, whether or not GitHub would in
 *   fact treat it as a directory on disk (we have no filesystem to check
 *   against here, and it is far cheaper to over-attribute ownership on a
 *   path/CODEOWNERS mismatch than to silently miss an owner).
 */
function patternCandidates(pattern: string): string[] {
  let p = pattern.trim();
  const isDir = p.endsWith('/');
  if (isDir) p = p.slice(0, -1);
  const anchored = p.startsWith('/');
  p = stripLeadingSlash(p);
  if (p === '') p = '**';

  const hasInnerSlash = p.includes('/');
  const roots = anchored || hasInnerSlash ? [p] : [p, `**/${p}`];

  const candidates = new Set<string>();
  for (const root of roots) {
    candidates.add(root);
    candidates.add(`${root}/**`);
  }
  return [...candidates];
}

/** The wildcard-free directory prefix of a query path/glob, e.g.
 *  `src/api/**` and `src/api/*.ts` both yield `src/api`. */
function literalPrefixDir(query: string): string {
  const idx = query.search(/[*?]/);
  const upTo = idx === -1 ? query : query.slice(0, idx);
  const lastSlash = upTo.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : upTo.slice(0, lastSlash);
  return stripLeadingSlash(dir);
}

/**
 * Whether a CODEOWNERS `pattern` covers a queried `path`, where `path` may
 * itself be a glob (e.g. `src/api/**`) rather than a literal file path.
 */
function ruleMatchesQuery(pattern: string, query: string): boolean {
  const candidates = patternCandidates(pattern);
  const q = stripLeadingSlash(query.trim());
  if (!q) return false;

  for (const c of candidates) {
    if (globMatches(c, q)) return true;
  }

  const prefix = literalPrefixDir(q);
  if (prefix) {
    for (const c of candidates) {
      if (globMatches(c, prefix)) return true;
    }
  }

  return globsOverlap(candidates, [q]);
}

/**
 * Owners for a set of paths/globs, GitHub semantics: for each path, the
 * *last* matching rule wins (not every matching rule). Results across all
 * given paths are unioned into a deduped list of logins (no `@`).
 */
export function ownersForPaths(rules: CodeownersRule[], paths: string[]): string[] {
  const owners: string[] = [];

  for (const query of paths) {
    let lastMatch: CodeownersRule | null = null;
    for (const rule of rules) {
      if (ruleMatchesQuery(rule.pattern, query)) {
        lastMatch = rule;
      }
    }
    for (const owner of lastMatch?.owners ?? []) {
      owners.push(owner);
    }
  }

  // Two rules can name the same login with different casing (`@Alice` vs
  // `@alice`); GitHub logins are case-insensitive, so union across paths must
  // dedupe the same way, not just by exact string.
  return dedupeLoginsCaseInsensitive(owners);
}
