#!/usr/bin/env bun
/**
 * Build wrapper that spawns bun build with a clean PATH.
 *
 * Bun 1.1.x inlines process.env.PATH as a string literal when bundling the
 * 'which' package. On Windows, paths like C:\Users\... contain \U, \W, etc.
 * which Bun's parser treats as invalid Unicode escape sequences at runtime.
 *
 * Fix: pass a slash-only PATH to the child build process so the embedded
 * value is safe. The binary user gets their real PATH at runtime anyway.
 */
import { spawnSync } from 'child_process';

const [target, outfile] = process.argv.slice(2);

const result = spawnSync(
    process.execPath, // current bun binary — no PATH lookup needed
    [
        'build', './src/index.js',
        '--compile',
        `--target=${target}`,
        `--outfile=${outfile}`,
        '--external', 'playwright',
        '--external', 'chromium-bidi',
        '--external', 'electron',
    ],
    {
        stdio: 'inherit',
        env: {
            ...process.env,
            PATH: '/usr/bin:/usr/local/bin', // no backslashes → safe to embed
            PATHEXT: '',
        },
    }
);

process.exit(result.status ?? 1);
