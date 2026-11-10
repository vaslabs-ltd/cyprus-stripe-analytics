// Prints the version the next release gets: the next patch after the newest vX.Y.Z tag, or
// package.json's version when that's newer (bump it there for a minor/major release).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) ?? []).slice(1).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const pkg = parse(JSON.parse(readFileSync('package.json', 'utf8')).version);
if (pkg.length !== 3) throw new Error('package.json version must be X.Y.Z');

const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split('\n').map(parse).filter((t) => t.length === 3).sort(cmp);
const latest = tags.at(-1);

const next = !latest || cmp(pkg, latest) > 0 ? pkg : [latest[0], latest[1], latest[2] + 1];
console.log(next.join('.'));
