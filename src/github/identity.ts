import type { GitHubIssue, ProjectItem } from '../contracts.js';
import {
  githubIssueNotFoundError,
  githubNotAnIssueError,
  usageError,
} from '../errors.js';
import { graphql, type GithubGraphqlOptions } from './client.js';

export const ISSUE_REF_HINT =
  'Use https://github.com/owner/repo/issues/N or owner/repo#N.';

const SHORTHAND_RE =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)\/([a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)#(\d+)$/;

export type ParsedIssueRef = {
  owner: string;
  repo: string;
  number: number;
};

export type AttributionEligibility = {
  eligible: boolean;
  reason: 'issue' | 'pull_request' | 'draft_issue' | 'redacted';
};

const RESOLVE_ISSUE_QUERY = `query ResolveIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      number
      url
      title
      state
      repository { nameWithOwner }
    }
  }
}`;

const RESOLVE_PULL_QUERY = `query ResolvePull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}`;

type ResolveIssueResponse = {
  repository: {
    issue: ResolvedIssueNode | null;
  } | null;
};

type ResolvePullResponse = {
  repository: {
    pullRequest: { id: string; number: number } | null;
  } | null;
};

function parsePositiveIssueNumber(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw usageError('Issue number must be a positive integer.', ISSUE_REF_HINT);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw usageError('Issue number must be a positive integer.', ISSUE_REF_HINT);
  }
  return n;
}

function parseGithubIssueUrl(input: string): ParsedIssueRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw usageError('Invalid GitHub issue URL.', ISSUE_REF_HINT);
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw usageError('Issue URL must use host github.com.', ISSUE_REF_HINT);
  }

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length >= 4 && segments[2] === 'pull') {
    throw usageError('Pull request URLs are not issue references.', ISSUE_REF_HINT);
  }

  if (
    segments.length < 4 ||
    segments[2] !== 'issues' ||
    !segments[0] ||
    !segments[1] ||
    !segments[3]
  ) {
    throw usageError('URL must be https://github.com/owner/repo/issues/N.', ISSUE_REF_HINT);
  }

  const owner = segments[0];
  const repo = segments[1];
  const number = parsePositiveIssueNumber(segments[3]);

  validateOwnerRepoSegment(owner, 'owner');
  validateOwnerRepoSegment(repo, 'repository');

  return { owner, repo, number };
}

function validateOwnerRepoSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(value)) {
    throw usageError(`Invalid ${label} name in issue reference.`, ISSUE_REF_HINT);
  }
}

/**
 * Parse a GitHub issue URL or `owner/repo#issue` shorthand.
 */
export function parseIssueRef(input: string): ParsedIssueRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw usageError('Issue reference is required.', ISSUE_REF_HINT);
  }

  const isUrl =
    /^https?:\/\//i.test(trimmed) ||
    /^github\.com\//i.test(trimmed) ||
    /^www\.github\.com\//i.test(trimmed);

  if (isUrl) {
    const withoutFragment = trimmed.split('#')[0] ?? trimmed;
    const withoutQuery = withoutFragment.split('?')[0] ?? withoutFragment;
    const normalized = withoutQuery.replace(/\/+$/, '');
    return parseGithubIssueUrl(
      /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`,
    );
  }

  const shorthand = trimmed.split('?')[0]?.replace(/\/+$/, '') ?? trimmed;
  const match = SHORTHAND_RE.exec(shorthand);
  if (!match) {
    throw usageError(
      'Issue reference must be a GitHub issue URL or owner/repo#N.',
      ISSUE_REF_HINT,
    );
  }

  const owner = match[1];
  const repo = match[2];
  const numberRaw = match[3];
  if (!owner || !repo || !numberRaw) {
    throw usageError('Invalid owner/repo#issue shorthand.', ISSUE_REF_HINT);
  }

  return {
    owner,
    repo,
    number: parsePositiveIssueNumber(numberRaw),
  };
}

type ResolvedIssueNode = {
  id: string;
  number: number;
  url: string;
  title: string;
  state: string;
  repository: { nameWithOwner: string };
};

function mapIssueNode(issue: ResolvedIssueNode): GitHubIssue {
  return {
    issueNodeId: issue.id,
    repository: { nameWithOwner: issue.repository.nameWithOwner },
    number: issue.number,
    url: issue.url,
    title: issue.title,
    state: issue.state,
  };
}

export type ResolveIssueOptions = GithubGraphqlOptions;

/**
 * Resolve a parsed issue ref to {@link GitHubIssue} via read-only GraphQL.
 * Transferred issues: GitHub returns the issue under its current `repository.nameWithOwner`.
 */
export async function resolveIssue(
  ref: ParsedIssueRef,
  opts?: ResolveIssueOptions,
): Promise<GitHubIssue> {
  const data = await graphql<ResolveIssueResponse>(RESOLVE_ISSUE_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  }, opts);

  const repository = data.repository;
  if (!repository) {
    throw githubIssueNotFoundError(ref.owner, ref.repo, ref.number);
  }

  if (repository.issue) {
    return mapIssueNode(repository.issue);
  }

  const pullData = await graphql<ResolvePullResponse>(RESOLVE_PULL_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  }, opts);

  if (pullData.repository?.pullRequest) {
    throw githubNotAnIssueError(ref.owner, ref.repo, ref.number);
  }

  throw githubIssueNotFoundError(ref.owner, ref.repo, ref.number);
}

/** Whether a project item can be attributed to a linked Issue in reports. */
export function attributionEligibility(
  projectItem: ProjectItem,
): AttributionEligibility {
  switch (projectItem.contentType) {
    case 'Issue':
      return { eligible: true, reason: 'issue' };
    case 'PullRequest':
      return { eligible: false, reason: 'pull_request' };
    case 'DraftIssue':
      return { eligible: false, reason: 'draft_issue' };
    case 'Redacted':
      return { eligible: false, reason: 'redacted' };
    default:
      return { eligible: false, reason: 'redacted' };
  }
}
