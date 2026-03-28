#!/usr/bin/env bun
/**
 * Release script — bumps version, tags commit, builds all platforms, packages zips, publishes GitHub release.
 *
 * Usage:
 *   bun run release              — patch bump (1.0.0 → 1.0.1)
 *   bun run release minor        — minor bump (1.0.0 → 1.1.0)
 *   bun run release major        — major bump (1.0.0 → 2.0.0)
 *   bun run release 1.2.3        — exact version
 *
 * Requirements: gh CLI installed and authenticated (gh auth login)
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const RELEASE_DIR = path.join(ROOT, 'release');
const PKG_PATH = path.join(ROOT, 'package.json');

// Files to bundle alongside every executable
const BUNDLE_FILES = [
    { src: path.join(ROOT, 'src', 'local_converter.py'), dest: 'local_converter.py' },
    { src: path.join(ROOT, 'requirements.txt'),           dest: 'requirements.txt' },
    { src: path.join(ROOT, '.env.example'),               dest: '.env.example' },
    { src: path.join(ROOT, 'README.md'),                  dest: 'README.md' },
    { src: path.join(ROOT, 'LICENSE'),                    dest: 'LICENSE' },
];

const TARGETS = [
    {
        name: 'windows-x64',
        script: 'build:win',
        exe: 'onshape-exporter.exe',
        ext: 'zip',
    },
    {
        name: 'linux-x64',
        script: 'build:linux',
        exe: 'onshape-exporter',
        ext: 'tar.gz',
    },
    {
        name: 'macos-arm64',
        script: 'build:mac',
        exe: 'onshape-exporter-mac',
        ext: 'zip',
    },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function run(cmd, args, opts = {}) {
    console.log(`  > ${cmd} ${args.join(' ')}`);
    const proc = Bun.spawn([cmd, ...args], {
        stdout: 'inherit',
        stderr: 'inherit',
        cwd: opts.cwd ?? ROOT,
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`Command failed (exit ${code}): ${cmd} ${args.join(' ')}`);
}

async function capture(cmd, args) {
    const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe', cwd: ROOT });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
}

function bumpVersion(current, bump) {
    const [major, minor, patch] = current.split('.').map(Number);
    if (bump === 'major') return `${major + 1}.0.0`;
    if (bump === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`; // patch (default)
}

async function zipDir(sourceDir, outFile) {
    const relativeOut = path.relative(ROOT, outFile);
    if (process.platform === 'win32') {
        const absoluteOut = path.resolve(ROOT, relativeOut);
        await run('powershell', [
            '-Command',
            `Compress-Archive -Path "${sourceDir}\\*" -DestinationPath "${absoluteOut}" -Force`,
        ]);
    } else {
        await run('zip', ['-r', relativeOut, '.'], { cwd: sourceDir });
    }
}

async function tarDir(sourceDir, outFile) {
    const relativeOut = path.relative(ROOT, outFile);
    // On Windows, tar interprets 'C:\path' as 'host:path'. 
    // Using relative paths or --force-local fixes this.
    await run('tar', ['-czf', relativeOut, '-C', sourceDir, '.']);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const bumpArg = process.argv[2] ?? 'patch';

    // Determine new version
    let newVersion;
    if (/^\d+\.\d+\.\d+$/.test(bumpArg)) {
        newVersion = bumpArg; // exact version passed
    } else if (['major', 'minor', 'patch'].includes(bumpArg)) {
        newVersion = bumpVersion(pkg.version, bumpArg);
    } else {
        throw new Error(`Invalid argument: "${bumpArg}". Use major | minor | patch | x.y.z`);
    }

    const TAG = `v${newVersion}`;

    // Check git working tree is clean
    const dirty = await capture('git', ['status', '--porcelain']);
    if (dirty) {
        throw new Error(`Working tree has uncommitted changes. Commit or stash before releasing.\n${dirty}`);
    }

    // Check the tag
    const tagHash = await capture('git', ['rev-parse', '--verify', TAG]).catch(() => "");
    const headHash = await capture('git', ['rev-parse', '--verify', 'HEAD']);
    let alreadyTagged = false;

    if (tagHash) {
        if (tagHash === headHash) {
            console.log(`ℹ️  Tag ${TAG} already exists on this commit. Resuming release...`);
            alreadyTagged = true;
        } else {
            throw new Error(`Tag ${TAG} exists on a different commit (${tagHash.substring(0, 7)}). Delete it or bump the version.`);
        }
    }

    console.log(`\n🚀 Releasing ${pkg.name} ${pkg.version} → ${newVersion} (${TAG})\n`);

    if (!alreadyTagged) {
        // Bump version in package.json
        pkg.version = newVersion;
        fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`✅ Bumped package.json to ${newVersion}`);

        // Commit version bump
        await run('git', ['add', 'package.json']);
        await run('git', ['commit', '-m', `chore: release ${TAG}`]);

        // Create and push tag
        await run('git', ['tag', TAG]);
        await run('git', ['push']);
        await run('git', ['push', 'origin', TAG]);
        console.log(`✅ Tagged and pushed ${TAG}`);
    } else {
        console.log(`⏩ Skipping version bump and git steps (already completed).`);
    }

    // Clean build dirs
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.mkdirSync(RELEASE_DIR, { recursive: true });

    const releaseAssets = [];

    for (const target of TARGETS) {
        console.log(`\n📦 Building ${target.name}...`);
        await run('bun', ['run', target.script]);

        const exeSrc = path.join(BUILD_DIR, target.exe);
        if (!fs.existsSync(exeSrc)) {
            console.warn(`  ⚠️  Build output not found: ${exeSrc} — skipping ${target.name}`);
            continue;
        }

        // Assemble staging folder
        const stageDir = path.join(RELEASE_DIR, target.name);
        fs.mkdirSync(stageDir, { recursive: true });
        fs.copyFileSync(exeSrc, path.join(stageDir, target.exe));

        for (const f of BUNDLE_FILES) {
            if (fs.existsSync(f.src)) {
                fs.copyFileSync(f.src, path.join(stageDir, f.dest));
            } else {
                console.warn(`  ⚠️  Missing bundle file: ${f.src}`);
            }
        }

        const archiveName = `onshape-exporter-${target.name}-${TAG}.${target.ext}`;
        const outArchive = path.join(RELEASE_DIR, archiveName);

        if (target.ext === 'tar.gz') {
            await tarDir(stageDir, outArchive);
        } else {
            await zipDir(stageDir, outArchive);
        }

        console.log(`  ✅ ${archiveName}`);
        releaseAssets.push(outArchive);
    }

    if (releaseAssets.length === 0) {
        throw new Error('No assets built — aborting release.');
    }

    // Publish GitHub release
    console.log(`\n🐙 Publishing GitHub release ${TAG}...`);
    await run('gh', [
        'release', 'create', TAG,
        ...releaseAssets,
        '--title', `${pkg.name} ${TAG}`,
        '--generate-notes',
    ]);

    console.log(`\n✨ Release ${TAG} published!\n`);
}

main().catch(err => {
    console.error('\n❌', err.message);
    process.exit(1);
});
