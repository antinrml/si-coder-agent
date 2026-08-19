// prompt.js — terminal input helpers shared by bin/onboard.js and bin/sc.js.
//
// Extracted so the wizard and the new `sc` CLI cannot drift on the one behaviour that
// actually matters here: a secret must never be echoed, and must never reach argv.
const readline = require('readline');

const CR = 13, LF = 10, EOT = 4, ETX = 3, BS = 8, DEL = 127, SPACE = 32;

// A plain, single-shot line read (visible echo). One interface per call so it can
// coexist with the raw-mode hidden reader below without them fighting over stdin.
function askVisible(promptText) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, ans => { rl.close(); resolve(ans.trim()); });
  });
}

// A hidden line read: the prompt shows, keystrokes do not. Used for every secret
// so a shoulder-surfer or a scrollback log never captures the token. Falls back to
// a visible read when stdin is not a TTY (piped input can't enter raw mode) — the
// value still never touches argv, which is the leak that actually matters.
function askHidden(promptText) {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY) return askVisible(promptText);
  return new Promise(resolve => {
    output.write(promptText);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let buf = '';
    const onData = (d) => {
      for (const ch of d.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (code === CR || code === LF || code === EOT) {   // Enter / Ctrl-D
          input.removeListener('data', onData);
          input.setRawMode(wasRaw || false);
          input.pause();
          output.write('\n');
          return resolve(buf.trim());
        }
        if (code === ETX) { output.write('\n'); process.exit(130); } // Ctrl-C
        else if (code === BS || code === DEL) buf = buf.slice(0, -1); // Backspace
        else if (code >= SPACE) buf += ch;                            // ignore other control chars
      }
    };
    input.on('data', onData);
  });
}

// Reveal at most ~25% of a value (cap 4 chars) so short secrets aren't echoed whole.
function redactValue(val) {
  if (!val) return '';
  const n = Math.min(4, Math.floor(val.length / 4));
  return `${val.slice(0, n)}…[len=${val.length}]`;
}

// Interactive means BOTH ends are a terminal. A wizard that prompts on a closed or piped
// stdin does not "ask" — it blocks forever, which in CI reads as a hung job. Every
// auto-launch path must gate on this.
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirm(promptText) {
  const a = (await askVisible(`${promptText} [y/N]: `)).toLowerCase();
  return a === 'y' || a === 'yes';
}

module.exports = { askVisible, askHidden, redactValue, isInteractive, confirm };
