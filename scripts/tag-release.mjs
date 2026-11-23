// Tags the published version and pushes the tag. Lives in Node rather than the npm script
// because npm runs scripts through cmd.exe on Windows, which can't expand $(...).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('packages/server/package.json', 'utf8'));
const tag = `v${version}`;
const git = (...args) => execFileSync('git', args, { stdio: 'inherit' });

git('tag', '-a', '-m', '', tag);
git('push', 'origin', tag);
