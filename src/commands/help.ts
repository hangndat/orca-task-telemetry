const VERSION = '0.1.0';

const IMPLEMENTED = new Set(['doctor', 'projects', 'init']);

const TOP_LEVEL = [
  { name: 'doctor', summary: 'Check local tools (implemented)' },
  { name: 'init', summary: 'Initialize telemetry profile for this repository' },
  { name: 'projects', summary: 'List GitHub Projects for the current repository' },
  { name: 'collect', summary: 'Collect Orca/CodeBurn usage (not implemented)' },
  { name: 'link', summary: 'Link a session to an issue (not implemented)' },
  { name: 'report', summary: 'Usage reports (not implemented)' },
];

const REPORT_SUBCOMMANDS = [
  { name: 'tasks', summary: 'Report across tasks (not implemented)' },
  { name: 'task <issue-id>', summary: 'Report for one issue (not implemented)' },
  { name: 'project', summary: 'Project-level report (not implemented)' },
  { name: 'unmapped', summary: 'Unmapped sessions (not implemented)' },
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
      `orca-task-telemetry report — usage reports (not implemented)`,
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
  if (command === 'doctor') {
    return [
      'orca-telemetry doctor — check local toolchain',
      '',
      'Usage:',
      '  orca-telemetry doctor [--json]',
      '',
      'Checks Node.js and presence of git, gh, orca, and codeburn.',
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
