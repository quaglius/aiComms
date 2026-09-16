import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || '';
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
