/**
 * Development launcher.
 *
 * Runs under plain Node, where `require('electron')` resolves to the binary's
 * path rather than the Electron API, then spawns that binary with a sanitised
 * environment.
 *
 * The reason this exists: if ELECTRON_RUN_AS_NODE is set — some editors,
 * terminals and CI images set it, and it is inherited by every child process —
 * Electron silently starts as a plain Node runtime. `require('electron')` then
 * returns a string, and the app dies with a baffling "Cannot read properties
 * of undefined (reading 'app')". Clearing it here makes `npm start` work
 * regardless of the surrounding environment.
 *
 *   npm start
 */

const { spawn } = require('node:child_process');
const electronBinary = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.env.ELECTRON_RUN_AS_NODE) {
  process.stdout.write('Cleared ELECTRON_RUN_AS_NODE for the Electron process.\n');
}

const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: __dirname,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  process.stderr.write(`Failed to start Electron: ${err.message}\n`);
  process.exit(1);
});
