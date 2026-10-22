import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const paths = ['openapi/openapi.json', 'packages/sdk/src/generated'];
const changed = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths], {
  cwd: root, encoding: 'utf8'
});
if (changed.trim()) {
  console.error('Generated API artifacts differ from git. Run pnpm generate and commit all output:\n' + changed);
  process.exitCode = 1;
}
