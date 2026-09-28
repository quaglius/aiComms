// Guards the two `openSync(lockPath, 'wx')` lock helpers this bus relies on
// (`acquireLogLock` in src/store.ts, `acquireNoticeLock` in src/hook.ts)
// against ever leaving the lock file's fd open. An open handle to a file
// doesn't just leak a descriptor: on Windows it also blocks deleting or
// renaming that file (and any ancestor directory) until the handle is
// closed, which is exactly the class of bug this test exists to catch
// before it reaches Windows CI. Both helpers already `closeSync` right after
// `openSync`, and this test is the regression guard for that.
//
// There's no portable way to count a process's open file descriptors, so
// this only runs where /proc/self/fd exists (Linux); it's a no-op assertion
// everywhere else (including the macOS/Windows machines this bug actually
// bites, which is unfortunate but unavoidable from here — see
// SETUP-FOR-AGENTS.md's Windows CI notes for how those are verified).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createEnvelope } from '../src/envelope.js';
import { markNotified } from '../src/hook.js';
import { appendEnvelope, resetLogIndexForTests } from '../src/store.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  if (ORIGINAL_USERPROFILE) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;
  process.chdir(ORIGINAL_CWD);
  resetLogIndexForTests();
});

function withTempHome<T>(prefix: string, fn: (home: string) => T): T {
  const home = mktempOrThrow(prefix);
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(home);
  } finally {
    try {
      process.chdir(previousCwd);
    } catch {
      // previousCwd should always still exist.
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function mktempOrThrow(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Number of this process's currently-open file descriptors, Linux only. */
function openFdCount(): number | null {
  if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) return null;
  return readdirSync('/proc/self/fd').length;
}

describe('lock helpers always close the lock file fd they open', () => {
  it('acquireLogLock (via appendEnvelope) leaves the fd count unchanged, repeatedly', () => {
    const before = openFdCount();
    if (before === null) return; // not Linux — nothing to check here.

    withTempHome('ai-comms-fd-guard-log-', () => {
      for (let i = 0; i < 20; i++) {
        const envelope = createEnvelope(
          { type: 'fyi', subject: 'fd guard', body: `iteration ${i}` },
          { dev: 'ana', agent: 'claude-code', repo: 'acme-api' },
        );
        const appended = appendEnvelope(envelope, 'fd-guard-project');
        assert.equal(appended, true, 'sanity: each envelope has a unique id and should append');
      }
    });

    const after = openFdCount();
    assert.equal(after, before, 'appendEnvelope must not leak a fd across repeated lock acquisitions');
  });

  it('acquireNoticeLock (via markNotified) leaves the fd count unchanged, repeatedly', () => {
    const before = openFdCount();
    if (before === null) return; // not Linux — nothing to check here.

    withTempHome('ai-comms-fd-guard-notice-', () => {
      for (let i = 0; i < 20; i++) {
        markNotified('fd-guard-project', [`fake-id-${i}`]);
      }
    });

    const after = openFdCount();
    assert.equal(after, before, 'markNotified must not leak a fd across repeated lock acquisitions');
  });
});
