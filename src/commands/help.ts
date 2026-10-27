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
  'writeback',
  'preview',
  'suggest-links',
]);

const TOP_LEVEL = [
  { name: 'doctor', summary: 'Check local tools (implemented)' },
  { name: 'init', summary: 'Initialize telemetry profile for this repository' },
  { name: 'projects', summary: 'List GitHub Projects for the current repository' },
  { name: 'collect', summary: 'Collect GitHub, Orca, and agent-top usage into local DB' },
  { name: 'link', summary: 'Link an agent-top session to a GitHub issue' },
  { name: 'report', summary: 'Usage reports for tasks, project, and unmapped sessions' },
  { name: 'trace', summary: 'Link and refresh verified PR or commit evidence' },
  { name: 'writeback', summary: 'Preview or explicitly apply GitHub Project NUMBER field writeback' },
  { name: 'suggest-links', summary: 'Suggest high-confidence session↔Issue links (explicit apply)' },
];

const REPORT_SUBCOMMANDS = [
  { name: 'tasks', summary: 'Report across issues in the selected project' },
  { name: 'task <issue-id>', summary: 'Report for one issue (node id, URL, or owner/repo#n)' },
  { name: 'trace <issue-id>', summary: 'Issue→session→PR→commit evidence and usage' },
  { name: 'project', summary: 'Project-level totals with deduped linked sessions' },
  { name: 'hierarchy', summary: 'Direct and inclusive cost through native Issue parents' },
  { name: 'overhead', summary: 'Coordinator vs worker usage for one Orca Run' },
  { name: 'retries', summary: 'Retry chains and wasted retry cost for one Orca Run' },
  { name: 'duplicates', summary: 'Non-retry duplicate Dispatches for one Orca Run' },
  { name: 'waste', summary: 'Cache-miss and oversize-context heuristics for linked sessions' },
  { name: 'budget', summary: 'Warn when Issue hierarchy cost exceeds --limit-usd' },
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
if (command === 'link-role') {
    return [
      'orca-task-telemetry link-role — link an agent-top session to a Run role',
      '',
      'Usage:',
      '  orca-telemetry link-role --run <run-id> [--host <host-id>] --role coordinator \\',
      '    --provider claude|codex --session <raw-id> --verifier <operator-id> \\',
      '    [--evidence-note ids_visible_same_session|operator_observed_same_session] \\',
      '    --confirm-same-session [--json]',
      '  orca-telemetry link-role --dispatch <dispatch-id> [--host <host-id>] [--run <run-id>] \\',
      '    --role worker --provider claude|codex --session <raw-id> \\',
      '    --verifier <operator-id> [--evidence-note ...] --confirm-same-session [--json]',
      '',
      'Requires an already-collected usage session, Orca Run, and (for worker) Dispatch',
      'in the exact host/run. No fuzzy matching and no Issue auto-link. A session already',
      'linked to a different role/Run/Dispatch is a conflict; an exact repeat is idempotent.',
      '',
      'Coordinator links require --run; --host may be omitted only when exactly one stored',
      'Run matches that run ID. Worker links require --dispatch; --host and/or --run may be',
      'omitted only when the supplied selectors narrow stored Dispatches to exactly one',
      '(host,run,dispatch) tuple. Any selector you do pass is an exact filter, never a hint:',
      '0 or multiple matches is a safe-candidate error, never a first/default pick.',
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
if (command === 'preview') {
    return [
      'orca-task-telemetry preview — read-only, in-memory UAT previews',
      '',
      'Usage:',
      '  orca-telemetry preview overhead --run <run-id> --roles <roles.json> [--json]',
      '',
      'Reads the Orca Run and agent-top sessions (read-only) and sums only the sessions',
      'listed in the roles file: {"schemaVersion":1,"runId":"<exact --run>","entries":[{"role":"coordinator|worker",',
      '"provider":"claude|codex","sessionId":"<raw-id>","dispatchId":"<worker only>"}]}.',
      'Mappings are operator-supplied and unverified; session matching uses exact IDs.',
      'Raw session IDs stay input-side and are omitted from output. Writes nothing',
      '(no telemetry DB). Coverage is unknown; Run-wide ratios are always null.',
      'See docs/UAT-PREVIEW.md.',
    ].join('\n') + '\n';
  }

  if (command === 'suggest-links') {
    return [
      'orca-telemetry suggest-links — high-confidence session suggestions (no silent linking)',
      '',
      'Usage:',
      '  orca-telemetry suggest-links [--json]',
      '  orca-telemetry suggest-links apply --issue <sel> --provider claude|codex --session <id> --yes [--json]',
      '',
      'Lists ready / needs_approval / no_match suggestions from agent-top projectHint.',
      'apply only accepts a ready pair and requires --yes. Ambiguous cases stay manual `link`.',
    ].join('\n') + '\n';
  }

  if (command === 'doctor') {
    return [
      'orca-telemetry doctor — check local toolchain',
      '',
      'Usage:',
      '  orca-telemetry doctor [--json]',
      '',
      'Checks Node.js, gh auth (read:project), Orca/agent-top versions, profile, and DB schema.',
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
