import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/** Minimal shape `prompt()` needs from an input stream — just enough to be
 *  fed to `readline` and to tell a real terminal apart from a pipe/EOF. */
export type PromptInput = NodeJS.ReadableStream & { isTTY?: boolean };

export interface PromptStreams {
  input?: PromptInput;
  output?: NodeJS.WritableStream;
}

/**
 * Ask a yes/no or free-text question, defaulting to `defaultValue` on a bare
 * Enter.
 *
 * Two non-interactive cases used to hang or silently drop the answer (v0.7
 * review finding #1):
 *
 * - No TTY at all (`ai-comms join ... < /dev/null`, a CI/script run, the
 *   daemon's own prompts): `readline`'s `question()` promise from
 *   `node:readline/promises` never settles once stdin hits EOF without a
 *   newline, so the `await` just sits there — and once nothing else keeps
 *   the event loop alive, node exits 0 with that `await` still pending and
 *   whatever came after it (saving config, offering to install hooks) never
 *   runs. Detecting the missing TTY up front and returning the default
 *   immediately avoids ever hitting that dead `await`.
 * - A stream that *is* a TTY but closes before an answer arrives (the
 *   session ending mid-prompt): same dead `await`. Racing `question()`
 *   against the interface's own `close` event fixes that case too.
 *
 * `input`/`output` are injectable so tests can exercise both paths without
 * touching the real `process.stdin`/`process.stdout`.
 */
export async function prompt(
  question: string,
  defaultValue?: string,
  streams: PromptStreams = {},
): Promise<string> {
  const promptInput = streams.input ?? input;
  const promptOutput = streams.output ?? output;
  const suffix = defaultValue ? ` [${defaultValue}]` : '';

  if (!promptInput.isTTY) {
    // Nothing is going to type an answer. Print what would have been asked
    // and what it resolved to, so a script/daemon log still shows it, and
    // return the default rather than waiting on input that will never come.
    promptOutput.write(`${question}${suffix}: \n`);
    promptOutput.write(`→ ${defaultValue || '(empty)'} (non-interactive)\n`);
    return defaultValue ?? '';
  }

  const rl = createInterface({ input: promptInput, output: promptOutput });
  try {
    return await new Promise<string>((resolve) => {
      let settled = false;
      const settle = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      // If the terminal goes away before an answer arrives, resolve to the
      // default instead of leaving the caller awaiting forever.
      rl.once('close', () => settle(defaultValue ?? ''));

      rl.question(`${question}${suffix}: `).then((answer) => {
        settle(answer.trim() || defaultValue || '');
      });
    });
  } finally {
    rl.close();
  }
}

export async function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(`${question}: `);

    if (!input.isTTY) {
      input.resume();
      input.setEncoding('utf8');
      let data = '';
      const onData = (chunk: string) => {
        data += chunk;
        if (data.includes('\n')) {
          input.removeListener('data', onData);
          resolve(data.trim());
        }
      };
      input.on('data', onData);
      return;
    }

    let secret = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const onData = (char: string) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(secret.trim());
          break;
        case '\u0003':
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          reject(new Error('Cancelled'));
          break;
        case '\u007f':
        case '\b':
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            process.stderr.write('\b \b');
          }
          break;
        default:
          if (char >= ' ' || char === '\t') {
            secret += char;
            process.stderr.write('*');
          }
          break;
      }
    };

    input.on('data', onData);
  });
}
