/**
 * Small process helpers shared by the audio backends.
 *
 * Everything here uses spawn with an argument array - never a shell string -
 * so values coming from configuration or the API can never be interpreted as
 * shell syntax.
 */

import { spawn } from 'node:child_process';

/**
 * Run a command to completion and capture its output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number, input?: string}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
export function runCommand(command, args, { timeoutMs = 5000, input } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Is an executable present on PATH?
 *
 * Uses the platform's own lookup tool rather than scanning PATH by hand, so
 * Termux's unusual prefix and Debian's /usr/sbin split both behave.
 *
 * @param {string} command
 * @returns {Promise<boolean>}
 */
export async function commandExists(command) {
  const probe = process.platform === 'win32'
    ? { cmd: 'where', args: [command] }
    : { cmd: 'sh', args: ['-c', `command -v ${JSON.stringify(command)}`] };

  try {
    const { code } = await runCommand(probe.cmd, probe.args, { timeoutMs: 3000 });
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Check several executables at once.
 * @param {string[]} commands
 * @returns {Promise<Record<string, boolean>>}
 */
export async function whichAll(commands) {
  const results = await Promise.all(commands.map((c) => commandExists(c)));
  return Object.fromEntries(commands.map((c, i) => [c, results[i]]));
}
