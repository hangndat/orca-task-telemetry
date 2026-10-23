#!/usr/bin/env node
/**
 * Stub for `gh repo view --json id,nameWithOwner,url`.
 * GH_STUB_REPO_VIEW_JSON — stdout body (default: {})
 * GH_STUB_EXIT_CODE — exit code (default 0)
 */
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  stdin += c;
});
process.stdin.on('end', () => {
  void stdin;
  const argv = process.argv.slice(2);
  const isRepoView =
    argv[0] === 'repo' &&
    argv[1] === 'view' &&
    argv.includes('--json') &&
    argv.some((a) => a.includes('nameWithOwner'));

  if (!isRepoView) {
    process.stderr.write('gh-repo-stub: unexpected argv\n');
    process.exit(2);
  }

  const stderr = process.env.GH_STUB_STDERR ?? '';
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }

  const stdout = process.env.GH_STUB_REPO_VIEW_JSON ?? '{}';
  const code = Number.parseInt(process.env.GH_STUB_EXIT_CODE ?? '0', 10);
  const exitCode = Number.isFinite(code) ? code : 0;
  process.stdout.write(stdout, () => {
    process.exit(exitCode);
  });
});
process.stdin.resume();
