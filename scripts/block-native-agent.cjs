// Project-local Claude hook: keep delegated work in the Orca lifecycle.
'use strict';

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      'Repo này dùng Orca cho worker/reviewer; không dùng native Agent tool. ' +
      'Đọc AGENTS.md và .cursor/rules/orca-leader-activation.mdc. ' +
      'Chỉ coordinator được giao quyền mới dispatch bằng skill orchestration ' +
      'và CLI guide đúng phiên bản host; worker/reviewer không spawn con.'
  }
}) + '\n');
