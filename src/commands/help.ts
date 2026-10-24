const VERSION = '0.1.0';

const IMPLEMENTED = new Set([
  'doctor',
  'projects',
  'init',
  'collect',
  'link',
  'link-role',
  'unlink-role',
  'report',
  'trace',
]);

const TOP_LEVEL = [
  { name: 'doctor', summary: 'Check local tools (implemented)' },
  { name: 'init', summary: 'Initialize telemetry profile for this repository' },
  { name: 'projects', summary: 'List GitHub Projects for the current repository' },
  { name: 'collect', summary: 'Collect GitHub, Orca, and CodeBurn into local DB' },
  { name: 'link', summary: 'Link a CodeBurn session to a GitHub issue' },
  { name: 'link-role', summary: 'Link a CodeBurn session to a coordinator/worker role of an Orca Run' },
  { name: 'unlink-role', summary: 'Remove an explicit session role link (durable audit)' },
  { name: 'report', summary: 'Usage reports for tasks, project, and unmapped sessions' },
  { name: 'trace', summary: 'Link and refresh verified PR or commit evidence' },
];

const REPORT_SUBCOMMANDS = [
  { name: 'tasks', summary: 'Report across issues in the selected project' },
  { name: 'task <issue-id>', summary: 'Report for one issue (node id, URL, or owner/repo#n)' },
  { name: 'trace <issue-id>', summary: 'Issue→session→PR→commit evidence and usage' },
  { name: 'project', summary: 'Project-level totals with deduped linked sessions' },
  { name: 'hierarchy', summary: 'Direct and inclusive cost through native Issue parents' },
  { name: 'unmapped', summary: 'Sessions without an Issue link and link suggestions' },
  { name: 'overhead --run <id> [--host <id>]', summary: 'Coordinator vs worker usage for one Orca Run' },
];

export function rootHelpText(): string {
  const lines = [
    `orca-task-telemetry ${VERSION} — foundation scaffold`,
    '',
    'Usage:',
    '  orca-telemetry [--json] [--help]',
    '  orca-telemetry <command> [--help] [--json]',
    '',
    'Global flags:',
    '  -h, --help     Show help',
    '  -v, --version  Print version',
    '  --json         JSON output on stdout',
    '',
    'Commands:',
  ];
  for (const cmd of TOP_LEVEL) {
    const tag = IMPLEMENTED.has(cmd.name.split(' ')[0]!) ? 'implemented' : 'not implemented';
    lines.push(`  ${cmd.name.padEnd(10)} ${cmd.summary} [${tag}]`);
  }
  lines.push('', 'See docs/MVP-SPEC.md for acceptance criteria.');
  return `${lines.join('\n')}\n`;
}

export function commandHelpText(command: string): string {
  if (command === 'link-role') {
    return [
      'orca-task-telemetry link-role — link a CodeBurn session to a Run role',
      '',
      'Usage:',
      '  orca-telemetry link-role --host <host-id> --run <run-id> --role coordinator \\',
      '    --provider claude|codex --session <raw-id> --verifier <operator-id> \\',
      '    [--evidence-note ids_visible_same_session|operator_observed_same_session] \\',
      '    --confirm-same-session [--json]',
      '  orca-telemetry link-role --host <host-id> --run <run-id> --role worker \\',
      '    --dispatch <dispatch-id> --provider claude|codex --session <raw-id> \\',
      '    --verifier <operator-id> [--evidence-note ...] --confirm-same-session [--json]',
      '',
      'Requires an already-collected usage session, Orca Run, and (for worker) Dispatch',
      'in the exact host/run. No fuzzy matching and no Issue auto-link. A session already',
      'linked to a different role/Run/Dispatch is a conflict; an exact repeat is idempotent.',
      '--confirm-same-session asserts both IDs were identified in one observed session.',
    ].join('\n') + '\n';
  }
  if (command === 'unlink-role') {
    return [
      'orca-task-telemetry unlink-role — remove an explicit session role link',
      '',
      'Usage:',
      '  orca-telemetry unlink-role --host <host-id> --run <run-id> --role coordinator \\',
      '    --provider claude|codex --session <raw-id> --verifier <operator-id> [--json]',
      '  orca-telemetry unlink-role --host <host-id> --run <run-id> --role worker \\',
      '    --dispatch <dispatch-id> --provider claude|codex --session <raw-id> \\',
      '    --verifier <operator-id> [--json]',
      '',
      'Selectors must match the existing link exactly. Writes a durable audit of the',
      'removed link and both verifiers (no raw evidence/prompt); delete+audit is atomic.',
      'Unrelated Issue links are unaffected.',
    ].join('\n') + '\n';
  }
  if (command === 'trace') {
    return [
      'orca-task-telemetry trace — manual GitHub PR/commit links and explicit refresh',
      '',
      'Usage:',
      '  orca-telemetry trace link-pr --issue <issue-url|owner/repo#n> --pr <pr-url|owner/repo#n> --provider claude|codex --session <id> [--json]',
      '  orca-telemetry trace link-commit --pr <pr-url|owner/repo#n> --sha <full-oid> --provider claude|codex --session <id> [--json]',
      '  orca-telemetry trace collect [--json]',
      '',
      'Requires a prior manual session→Issue link; commit links also require a manual session→PR link.',
      'GitHub closing Issue and PR commit lists must be fully paged before linking.',
      'collect reads stored PR node IDs sequentially; partial reads retain audit links and lastVerifiedAt.',
      'Pagination is not an atomic GitHub snapshot.',
    ].join('\n') + '\n';
  }
  if (command === 'report') {
    const lines = [
      `orca-task-telemetry report — usage reports (read-only local DB)`,
      '',
      'Usage:',
      '  orca-telemetry report <subcommand> [--help] [--json]',
      '',
      'Subcommands:',
    ];
    for (const sub of REPORT_SUBCOMMANDS) {
      lines.push(`  ${sub.name.padEnd(22)} ${sub.summary}`);
    }
    lines.push('', 'trace reads only the local database; cost is estimated API equivalent or unknown.');
    lines.push(
      'overhead requires --run; omit --host only when exactly one stored host matches that Run.',
      'Coverage is always unknown and',
      'overheadShare/overheadPerWorkerCost are null with a reason unless every classified session',
      'has a snapshot and known cost and all three sources are success within 24h.',
    );
    return `${lines.join('\n')}\n`;
  }
  if (command === 'projects') {
    return [
      'orca-telemetry projects — list GitHub Projects for the current repository',
      '',
      'Usage:',
      '  orca-telemetry projects [--remote <name>] [--json]',
      '',
      'Resolves the Git repository in the current directory, verifies the GitHub',
      'repository with gh, and lists Projects V2 linked to the repo and owner.',
    ].join('\n') + '\n';
  }
  if (command === 'init') {
    return [
      'orca-telemetry init — select a GitHub Project for the current repository',
      '',
      'Usage:',
      '  orca-telemetry init [--project <number|url>] [--remote <name>] [--json]',
      '',
      'Resolves the Git repository, discovers Projects V2, and stores a profile in',
      'the local orca-task-telemetry config. Interactive selection requires a TTY',
      'unless --project is provided.',
    ].join('\n') + '\n';
  }
  if (command === 'doctor') {
    return [
      'orca-telemetry doctor — check local toolchain',
      '',
      'Usage:',
      '  orca-telemetry doctor [--json]',
      '',
      'Checks Node.js, gh auth (read:project), Orca/CodeBurn versions, profile, and DB schema.',
      'Exit codes: 0 when summary is pass or warn; 2 when summary is fail (diagnostic).',
    ].join('\n') + '\n';
  }
  const entry = TOP_LEVEL.find((c) => c.name === command);
  if (entry) {
    const tag = IMPLEMENTED.has(command) ? 'implemented' : 'not implemented';
    return [
      `orca-telemetry ${command} — ${entry.summary.replace(/ \(not implemented\)/, '')}`,
      '',
      `Status: ${tag}`,
      '',
      'Usage:',
      `  orca-telemetry ${command} [--help] [--json]`,
    ].join('\n') + '\n';
  }
  return rootHelpText();
}

export { VERSION };
