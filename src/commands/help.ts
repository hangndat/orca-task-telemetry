const VERSION = '0.1.0';

const IMPLEMENTED = new Set([
  'doctor',
  'projects',
  'init',
  'collect',
  'link',
  'report',
  'writeback',
]);

const TOP_LEVEL = [
  { name: 'doctor', summary: 'Check local tools (implemented)' },
  { name: 'init', summary: 'Initialize telemetry profile for this repository' },
  { name: 'projects', summary: 'List GitHub Projects for the current repository' },
  { name: 'collect', summary: 'Collect GitHub, Orca, and CodeBurn into local DB' },
  { name: 'link', summary: 'Link a CodeBurn session to a GitHub issue' },
  { name: 'report', summary: 'Usage reports for tasks, project, and unmapped sessions' },
  { name: 'writeback', summary: 'Preview or explicitly apply GitHub Project NUMBER field writeback' },
];

const REPORT_SUBCOMMANDS = [
  { name: 'tasks', summary: 'Report across issues in the selected project' },
  { name: 'task <issue-id>', summary: 'Report for one issue (node id, URL, or owner/repo#n)' },
  { name: 'project', summary: 'Project-level totals with deduped linked sessions' },
  { name: 'hierarchy', summary: 'Direct and inclusive cost through native Issue parents' },
  { name: 'unmapped', summary: 'Sessions without an Issue link and link suggestions' },
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
  if (command === 'writeback') {
    return [
      'orca-telemetry writeback — Project NUMBER field cost writeback',
      '',
      'Usage:',
      '  orca-telemetry writeback (--field <name> | --field-id <id>) [--rollup direct|inclusive]',
      '    [--issue <selector>] [--force-overwrite] [--apply [--yes]] [--json]',
      '',
      'Computes estimated API equivalent usage from the local DB and compares to the',
      'current GitHub Project field value. Default is read-only dry-run.',
      '--apply re-reads each candidate and writes one NUMBER field per item with gh item-edit.',
      'A TTY prompts for confirmation; non-TTY apply requires --yes. --yes requires --apply.',
      'A changed remote value is skipped unless --force-overwrite is explicit.',
      'Partial item failures exit 5; no automatic rollback. Apply requires gh project scope.',
      '',
      'Project and owner come from orca-telemetry init (no --project/--owner).',
      '--rollup inclusive requires at least one --issue.',
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
