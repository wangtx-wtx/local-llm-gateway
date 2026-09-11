/**
 * Structural validation for the container/CI configuration files.
 *
 * This is not a full YAML parser — it exists to catch the mistakes that actually
 * break CI: tabs in YAML, unbalanced quotes, a compose file with no services, the
 * required-variable syntax being dropped from the security-critical env entries,
 * and a Dockerfile that copies paths which do not exist.
 */

import { readFileSync, existsSync } from 'node:fs';

let failures = 0;

function check(condition, message) {
  if (condition) {
    process.stdout.write(`  ok   ${message}\n`);
  } else {
    process.stdout.write(`  FAIL ${message}\n`);
    failures += 1;
  }
}

function read(path) {
  if (!existsSync(path)) {
    process.stdout.write(`  FAIL ${path} does not exist\n`);
    failures += 1;
    return '';
  }
  return readFileSync(path, 'utf8');
}

process.stdout.write('\ndocker-compose.yml\n');
{
  const text = read('docker-compose.yml');
  check(!/\t/.test(text), 'contains no tab characters (tabs are illegal in YAML)');
  check(/^services:/m.test(text), 'declares a services block');
  check(/^ {2}gateway:/m.test(text), 'declares the gateway service');
  check(/^volumes:/m.test(text), 'declares a volumes block');
  check(/gateway-data:/m.test(text), 'persists a named data volume');

  // The gateway refuses to bind 0.0.0.0 without both secrets; compose must
  // therefore use required-variable syntax so it fails instead of starting.
  check(
    /LOCAL_GATEWAY_API_KEY: "\$\{LOCAL_GATEWAY_API_KEY:\?/.test(text),
    'LOCAL_GATEWAY_API_KEY uses required-variable syntax',
  );
  check(
    /LOCAL_GATEWAY_ADMIN_PASSWORD: "\$\{LOCAL_GATEWAY_ADMIN_PASSWORD:\?/.test(text),
    'LOCAL_GATEWAY_ADMIN_PASSWORD uses required-variable syntax',
  );
  check(/LOCAL_GATEWAY_HOST: "0\.0\.0\.0"/.test(text), 'binds 0.0.0.0 inside the container');
  check(/LOCAL_GATEWAY_DB_PATH: "\/app\/data\//.test(text), 'points the database at the mounted volume');

  // Publish to host loopback by default.
  check(/"127\.0\.0\.1:\d+:\d+"/.test(text), 'publishes the port on host loopback only');

  const quotes = (text.match(/"/g) ?? []).length;
  check(quotes % 2 === 0, 'double quotes are balanced');
}

process.stdout.write('\nDockerfile\n');
{
  const text = read('Dockerfile');
  check(/node:24-slim/.test(text), 'uses a Node 24 image (node:sqlite is unflagged from Node 22.13)');
  check(/FROM .* AS build/.test(text) && /FROM .* AS runtime/.test(text), 'is multi-stage');
  check(/^USER node$/m.test(text), 'drops privileges to the non-root node user');
  check(/^EXPOSE 8317$/m.test(text), 'exposes the gateway port');
  check(/^HEALTHCHECK /m.test(text), 'declares a healthcheck');
  check(/\/health/.test(text), 'healthcheck probes the real /health endpoint');
  check(/"node", "dist\/index\.js"/.test(text) || /CMD \["node", "dist\/index\.js"\]/.test(text), 'starts the built entry point');

  // Every COPY source must exist in the repository — but only for COPY steps
  // that read from the build context. A `--from=<stage>` copy reads from an
  // earlier image layer, and a shell-style `*` is an intentionally optional
  // input (a checkout may not carry a web lockfile).
  const copyLines = text.split(/\r?\n/).filter((line) => line.startsWith('COPY '));
  check(copyLines.length > 0, `found ${copyLines.length} COPY instruction(s)`);
  for (const line of copyLines) {
    const fromStage = /--from=(\S+)/.exec(line)?.[1];
    const parts = line.replace(/^COPY\s+/, '').replace(/--\S+\s+/g, '').trim().split(/\s+/);
    const sources = parts.slice(0, -1);
    for (const source of sources) {
      if (fromStage !== undefined) {
        check(true, `COPY source is inside stage "${fromStage}": ${source}`);
        continue;
      }
      if (source.includes('*')) {
        // Optional glob: report whether it matched rather than requiring it.
        const directory = source.slice(0, source.lastIndexOf('/'));
        process.stdout.write(
          `  note optional COPY glob ${source} (directory present: ${existsSync(directory)})\n`,
        );
        continue;
      }
      const local = source.replace(/^\.\//, '');
      check(existsSync(local), `COPY source exists: ${source}`);
    }
  }
}

process.stdout.write('\n.github/workflows/ci.yml\n');
{
  const text = read('.github/workflows/ci.yml');
  check(!/\t/.test(text), 'contains no tab characters');
  check(/^on:/m.test(text), 'declares triggers');
  check(/^jobs:/m.test(text), 'declares jobs');
  check(/node-version: '24'/.test(text), 'pins Node 24');
  const runsVerify = /npm run verify/.test(text);
  check(runsVerify || /npm run typecheck/.test(text), 'runs typecheck');
  check(runsVerify || /npm run lint/.test(text), 'runs lint');
  check(runsVerify || /npm test/.test(text), 'runs the test suite');
  check(/npm run build/.test(text), 'runs the build');
  check(/docker\/build-push-action/.test(text), 'builds the container image');
  check(/LOCAL_GATEWAY_API_KEY=/.test(text), 'smoke-tests the image with the required secrets');
}

process.stdout.write(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
