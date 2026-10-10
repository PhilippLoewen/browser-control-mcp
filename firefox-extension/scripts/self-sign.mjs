#!/usr/bin/env node
/**
 * Self-signing helper for personal distribution.
 *
 * Stages this extension with a personal identity (AMO GUID + optional
 * update_url) in a temporary directory and signs it with web-ext for the
 * "unlisted" channel. The committed manifest.json is never modified — the
 * identity lives only in the gitignored .self-sign.json and in the staged
 * copy under .sign-staging/, so the owner's public AMO listing flow is
 * untouched.
 *
 * Usage (from the firefox-extension/ directory):
 *   npm run sign:local             build + stage + sign (channel: unlisted)
 *   npm run release:local          sign + upload to the fork release + bump update.json
 *   node scripts/self-sign.mjs --dry-run    stage only, print what would ship
 *   node scripts/self-sign.mjs --no-build   skip the esbuild step
 *   node scripts/self-sign.mjs --channel=unlisted
 *   node scripts/self-sign.mjs --upload            also upload the signed XPI to the fork release
 *   node scripts/self-sign.mjs --update-manifest   also update self-distribution/update.json
 *
 * Uploading needs a "github" section in .self-sign.json plus a token in the
 * environment (default $GITHUB_TOKEN) with write access to the fork —
 * fine-grained PAT with Contents (rw) and Releases (rw) on that repo.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingDir = path.join(extRoot, '.sign-staging');

// Paths that must never end up in the XPI (checked at every directory depth).
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.sign-staging', 'scripts', '__tests__', 'types', 'web-ext-artifacts']);
const EXCLUDED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'jest.config.js',
  'nx.json',
  '.self-sign.json',
  'xpi.ignore',
]);

function excludedFile(name) {
  return (
    EXCLUDED_FILES.has(name) ||
    /\.ts$/.test(name) || // covers .ts, .d.ts, .tsx, .ts.map
    /^\.eslint/.test(name) ||
    /^\.prettier/.test(name) ||
    /^\.env/.test(name) ||
    /^\.babel/.test(name) ||
    /^esbuild\.config\./.test(name) ||
    /^README/i.test(name)
  );
}

function fail(msg) {
  console.error(`self-sign: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    noBuild: false,
    upload: false,
    updateManifest: false,
    channel: 'unlisted',
    config: path.join(extRoot, '.self-sign.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--no-build') {
      args.noBuild = true;
    } else if (arg === '--upload') {
      args.upload = true;
    } else if (arg === '--update-manifest') {
      args.updateManifest = true;
      args.upload = true;
    } else if (arg === '--config') {
      i += 1;
      if (!argv[i]) fail('--config requires a value');
      args.config = path.resolve(argv[i]);
    } else if (arg.startsWith('--config=')) {
      args.config = path.resolve(arg.slice('--config='.length));
    } else if (arg === '--channel') {
      i += 1;
      if (!argv[i]) fail('--channel requires a value');
      args.channel = argv[i];
    } else if (arg.startsWith('--channel=')) {
      args.channel = arg.slice('--channel='.length);
    } else {
      fail(`unknown argument: ${arg} (supported: --dry-run, --no-build, --upload, --update-manifest, --channel=<unlisted|listed>, --config=<path>)`);
    }
  }
  if (!['unlisted', 'listed'].includes(args.channel)) {
    fail(`--channel must be "unlisted" or "listed", got "${args.channel}"`);
  }
  return args;
}

function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    fail(
      `config file not found: ${configPath}\n` +
        'Create it with at least a "guid", e.g.:\n' +
        '{\n' +
        '  "guid": "{<uuid, e.g. from uuidgen>}",\n' +
        '  "updateUrl": "https://<host>/path/update.json",\n' +
        '  "dataCollectionPermissions": ["none"]\n' +
        '}',
    );
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    fail(`could not parse ${configPath}: ${err.message}`);
  }
  const guid = String(config.guid ?? '').trim();
  const idPattern =
    /^(?:\{)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\})?$|^[a-z0-9]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
  if (!idPattern.test(guid)) {
    fail('config.guid must be a UUID (with or without braces) or an email-style ID like name@example.com');
  }
  const updateUrl = typeof config.updateUrl === 'string' && config.updateUrl ? config.updateUrl : undefined;
  if (updateUrl && !updateUrl.startsWith('https://')) {
    fail('config.updateUrl must be an https:// URL');
  }
  const dataCollectionPermissions =
    Array.isArray(config.dataCollectionPermissions) && config.dataCollectionPermissions.length
      ? config.dataCollectionPermissions
      : ['none'];
  return { guid, updateUrl, dataCollectionPermissions };
}

function runBuild() {
  console.log('==> Building extension (npm run build)');
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmBin, ['run', 'build'], { cwd: extRoot, stdio: 'inherit' });
  if (result.error) fail(`could not run npm: ${result.error.message}`);
  if (result.status !== 0) fail('npm run build failed');
}

function copyStage(srcDir, destDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      mkdirSync(dest, { recursive: true });
      copyStage(src, dest);
    } else if (entry.isFile() && !excludedFile(entry.name)) {
      copyFileSync(src, dest);
    }
  }
}

function patchManifest({ guid, updateUrl, dataCollectionPermissions }) {
  const manifestPath = path.join(stagingDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.browser_specific_settings = {
    ...manifest.browser_specific_settings,
    gecko: {
      ...(manifest.browser_specific_settings?.gecko ?? {}),
      id: guid,
      data_collection_permissions: { required: dataCollectionPermissions },
      ...(updateUrl ? { update_url: updateUrl } : {}),
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function listStaged() {
  const lines = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`${rel}/`);
        walk(full, `${rel}/`);
      } else {
        lines.push(`${rel} (${statSync(full).size} bytes)`);
      }
    }
  };
  walk(stagingDir, '');
  return lines;
}

// ---------------------------------------------------------------------------
// GitHub release upload (optional; --upload / --update-manifest)
// ---------------------------------------------------------------------------

const RELEASE_BODY = [
  'Self-distributed signed builds of the Browser Control MCP Firefox extension.',
  '',
  '- Signed via `web-ext sign --channel=unlisted` under a personal AMO account — a separate add-on from the public AMO listing (independent version line).',
  '- XPI asset naming: `browser-control-mcp-<version>.xpi`.',
  '- Update manifest: `self-distribution/update.json` on `main` — the stable URL referenced by the extension\'s `update_url` (locked in at install time, so it must not move).',
  '- Install: about:addons → gear menu → Install Add-on From File.',
  '- Auto-updates: Firefox polls the update manifest and downloads newer versions from this release.',
].join('\n');

class GhError extends Error {
  constructor(method, urlPath, status, statusText, body) {
    super(`GitHub API ${method} ${urlPath} failed (${status} ${statusText}): ${body.slice(0, 400)}`);
    this.status = status;
  }
}

async function ghApi(gh, method, urlPath, { json, body, headers } = {}) {
  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}${urlPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${gh.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch (err) {
    throw new Error(`GitHub API ${method} ${urlPath} unreachable: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new GhError(method, urlPath, res.status, res.statusText, text);
  return text ? JSON.parse(text) : undefined;
}

function githubConfig(config) {
  const gh = config.github;
  if (!gh || typeof gh.owner !== 'string' || typeof gh.repo !== 'string') {
    fail(
      'upload requires a "github" section in the config file, e.g.\n' +
        '  "github": { "owner": "<you>", "repo": "browser-control-mcp", "branch": "main", "manifestPath": "self-distribution/update.json" }',
    );
  }
  const tokenEnv = typeof gh.tokenEnv === 'string' && gh.tokenEnv ? gh.tokenEnv : 'GITHUB_TOKEN';
  const token = process.env[tokenEnv];
  if (!token) {
    fail(
      `upload requires a GitHub token in $${tokenEnv} — a fine-grained personal access token with "Contents: read/write" and "Releases: read/write" on ${gh.owner}/${gh.repo}\n` +
        `(quick alternative: export ${tokenEnv}="$(gh auth token)")`,
    );
  }
  return {
    owner: gh.owner,
    repo: gh.repo,
    branch: gh.branch ?? 'main',
    manifestPath: gh.manifestPath ?? 'self-distribution/update.json',
    token,
  };
}

/**
 * Upload the signed XPI as a release asset. Creates the release if the tag
 * does not exist yet, and replaces an existing asset with the same name
 * (the uploads API cannot overwrite in place), so re-runs are idempotent.
 */
export async function uploadToRelease({ token, owner, repo, tag, xpiPath, assetName, body }) {
  const gh = { token, owner, repo };
  let release;
  try {
    release = await ghApi(gh, 'GET', `/releases/tags/${encodeURIComponent(tag)}`);
    console.log(`    release ${tag} exists (id ${release.id})`);
  } catch (err) {
    if (!(err instanceof GhError && err.status === 404)) throw err;
    console.log(`    creating release ${tag}`);
    release = await ghApi(gh, 'POST', '/releases', {
      json: { tag_name: tag, name: `${tag} (self-distribution)`, target_commitish: 'main', body, draft: false, prerelease: false },
    });
    console.log(`    created release ${tag} (id ${release.id})`);
  }
  const existing = (release.assets ?? []).find((a) => a.name === assetName);
  if (existing) {
    await ghApi(gh, 'DELETE', `/releases/assets/${existing.id}`);
    console.log(`    removed existing asset "${assetName}" (the uploads API cannot overwrite)`);
  }
  const buf = readFileSync(xpiPath);
  const asset = await ghApi(gh, 'POST', `/releases/${release.id}/uploads?name=${encodeURIComponent(assetName)}`, {
    body: buf,
    headers: { 'Content-Type': 'application/zip' },
  });
  console.log(`    uploaded ${assetName} (${asset.size} bytes)`);
  return { release, asset };
}

/**
 * (Re)write self-distribution/update.json on the fork so it points at the
 * given version + release asset. Skips the commit when the content already
 * matches, so re-running for the same version is a no-op.
 */
export async function updateReleaseManifest({ token, owner, repo, branch, manifestPath, guid, version, updateLink }) {
  const gh = { token, owner, repo };
  let current;
  try {
    current = await ghApi(gh, 'GET', `/contents/${manifestPath}`);
  } catch (err) {
    if (!(err instanceof GhError && err.status === 404)) throw err;
  }
  const nextText = `${JSON.stringify({ addons: { [guid]: { updates: [{ version, update_link: updateLink }] } } }, null, 2)}\n`;
  if (current) {
    const currentText = Buffer.from(current.content, 'base64').toString('utf8');
    if (currentText === nextText) {
      console.log(`    update manifest already points at ${version} — no change`);
      return false;
    }
  }
  await ghApi(gh, 'PUT', `/contents/${manifestPath}`, {
    json: {
      message: `Update self-distribution manifest to ${version}`,
      content: Buffer.from(nextText).toString('base64'),
      ...(current ? { sha: current.sha } : {}),
      branch,
    },
  });
  console.log(`    ${manifestPath} -> ${version} (${updateLink})`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const majorNode = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (majorNode < 22) {
    console.warn(`self-sign: warning: web-ext 10 requires Node 22+, this is Node ${process.versions.node}`);
  }
  const config = loadConfig(args.config);

  if (!args.noBuild) runBuild();

  console.log('==> Staging extension (copy without dev files, patch manifest)');
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  copyStage(extRoot, stagingDir);
  const manifest = patchManifest(config);
  console.log(`    staged ${listStaged().length} entries at ${stagingDir}`);
  console.log(`    id:           ${manifest.browser_specific_settings.gecko.id}`);
  const updateUrl = manifest.browser_specific_settings.gecko.update_url;
  if (updateUrl) console.log(`    update_url:   ${updateUrl}`);

  if (args.dryRun) {
    console.log('\n--dry-run: staged file list (nothing was signed)\n');
    for (const line of listStaged()) console.log(`  ${line}`);
    console.log('\n--dry-run: staged manifest.json\n');
    console.log(readFileSync(path.join(stagingDir, 'manifest.json'), 'utf8'));
    return;
  }

  console.log(`==> Signing with web-ext (channel: ${args.channel})`);
  const result = spawnSync(
    'npx',
    [
      '--yes',
      '--package',
      'web-ext@10',
      'web-ext',
      'sign',
      '--source-dir',
      stagingDir,
      '--channel',
      args.channel,
      '--artifacts-dir',
      path.join(extRoot, 'web-ext-artifacts'),
      '--ignore-files',
      path.join(extRoot, 'xpi.ignore'),
    ],
    { stdio: 'inherit' },
  );
  if (result.error) fail(`could not run web-ext: ${result.error.message}`);
  if (result.status !== 0) {
    fail('web-ext sign failed — check the output above (are AMO credentials set via WEB_EXT_API_KEY / WEB_EXT_API_SECRET or ~/.web-ext/config.js?)');
  }

  const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const artifactDir = path.join(extRoot, 'web-ext-artifacts');
  // web-ext downloads the signed XPI from AMO and names it after AMO's
  // download URL (random prefix per signing), so list what is actually there.
  const xpis = readdirSync(artifactDir)
    .filter((f) => f.endsWith('.xpi'))
    .map((f) => ({ f, mtime: statSync(path.join(artifactDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
  if (xpis.length === 0) fail('signing finished but no .xpi was found in ' + artifactDir);
  const assetName = `${slug}-${manifest.version}.xpi`;

  if (args.upload || args.updateManifest) {
    const gh = githubConfig(config);
    const tag = `v${manifest.version}`;
    const updateLink = `https://github.com/${gh.owner}/${gh.repo}/releases/download/${tag}/${assetName}`;
    try {
      console.log(`==> Uploading to GitHub release ${tag} (${gh.owner}/${gh.repo})`);
      const { asset } = await uploadToRelease({
        token: gh.token,
        owner: gh.owner,
        repo: gh.repo,
        tag,
        xpiPath: path.join(artifactDir, xpis[0]),
        assetName,
        body: RELEASE_BODY,
      });
      if (args.updateManifest) {
        await updateReleaseManifest({
          token: gh.token,
          owner: gh.owner,
          repo: gh.repo,
          branch: gh.branch,
          manifestPath: gh.manifestPath,
          guid: config.guid,
          version: manifest.version,
          updateLink,
        });
      }
      console.log(`\nPublished: ${asset.browser_download_url}`);
    } catch (err) {
      fail(err.message);
    }
  }

  console.log(`\nDone. Signed XPIs in ${artifactDir} (newest first):`);
  for (const f of xpis) console.log(`  ${f}`);
  console.log('\nNext steps:');
  console.log(`  1. Install: about:addons -> gear menu -> Install Add-on From File -> ${xpis[0]}`);
  let step = 2;
  if (!(args.upload || args.updateManifest)) {
    console.log(`  ${step}. Upload the newest one to the GitHub release as "${assetName}" (the update manifest points there; AMO names the artifact with a random prefix, so rename it) — or use "npm run release:local" to sign + upload in one step`);
    step += 1;
  }
  console.log(`  ${step}. New version later: bump the version, then "npm run release:local" (signs, publishes the release asset and updates the manifest)`);
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => fail(err.message));
}
