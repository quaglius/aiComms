// Runs every test/*.test.ts through tsx's test runner.
//
// The file list is built here rather than with a glob in package.json: cmd.exe
// does not expand `test/**/*.test.ts`, and Node 20's test runner does not
// expand globs itself, so a glob would silently run nothing on Windows.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `test/${f}`);

try {
  execFileSync(process.execPath, [require.resolve('tsx/cli'), '--test', ...files], {
    stdio: 'inherit',
  });
} catch {
  process.exit(1);
}
