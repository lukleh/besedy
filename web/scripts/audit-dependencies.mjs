import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED_DEV_ADVISORY = {
  source: 1124334,
  id: 'GHSA-mh99-v99m-4gvg',
  package: 'brace-expansion',
};

const audit = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

if (audit.error) {
  console.error(`Could not run npm audit: ${audit.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error('npm audit did not return valid JSON.');
  if (audit.stderr) {
    console.error(audit.stderr.trim());
  }
  process.exit(1);
}

if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? report.error}`);
  process.exit(1);
}

const lock = JSON.parse(
  readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
);
const vulnerabilities = report.vulnerabilities ?? {};

function advisorySources(name, path = new Set()) {
  if (path.has(name) || !vulnerabilities[name]) {
    return new Set([`unresolved:${name}`]);
  }

  const nextPath = new Set(path);
  nextPath.add(name);
  const sources = new Set();

  for (const cause of vulnerabilities[name].via) {
    if (typeof cause === 'string') {
      for (const source of advisorySources(cause, nextPath)) {
        sources.add(source);
      }
    } else {
      sources.add(cause.source);
    }
  }

  return sources;
}

function isDevOnly(vulnerability) {
  return (
    vulnerability.nodes.length > 0 &&
    vulnerability.nodes.every((node) => lock.packages?.[node]?.dev === true)
  );
}

const failures = [];
const allowed = [];

for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (!['high', 'critical'].includes(vulnerability.severity)) {
    continue;
  }

  const sources = advisorySources(name);
  const isAllowed =
    sources.size === 1 &&
    sources.has(ALLOWED_DEV_ADVISORY.source) &&
    isDevOnly(vulnerability);

  if (isAllowed) {
    allowed.push(name);
  } else {
    failures.push({ name, severity: vulnerability.severity, sources });
  }
}

if (allowed.length > 0) {
  console.warn(
    [
      `Allowed dev-only ${ALLOWED_DEV_ADVISORY.id} in ${ALLOWED_DEV_ADVISORY.package}.`,
      `Affected audit paths: ${allowed.sort().join(', ')}.`,
      "The current ESLint plugins require minimatch 3's callable CommonJS API;",
      'remove this exception when those plugins support a patched minimatch major.',
    ].join(' '),
  );
}

if (failures.length > 0) {
  console.error('npm audit found unapproved high or critical vulnerabilities:');
  for (const failure of failures) {
    console.error(
      `- ${failure.name} (${failure.severity}); sources: ${[
        ...failure.sources,
      ].join(', ')}`,
    );
  }
  process.exit(1);
}

console.log('No unapproved high or critical npm vulnerabilities found.');
