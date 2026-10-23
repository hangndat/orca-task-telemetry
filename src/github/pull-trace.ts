import { CliError, EXIT_SOURCE_UNAVAILABLE, usageError } from '../errors.js';
import { graphql, type GithubGraphqlOptions } from './client.js';

export const PULL_REF_HINT = 'Use https://github.com/owner/repo/pull/N or owner/repo#N.';
export const PULL_TRACE_PAGE_SIZE = 100;
export const DEFAULT_MAX_PULL_TRACE_PAGES = 100;

export type ParsedPullRef = { owner: string; repo: string; number: number };
export type PullTraceIdentity = {
  pullNodeId: string;
  number: number;
  url: string;
  repository: { nameWithOwner: string };
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergedAt: string | null;
  /** Detect a force push while paging commits; not a persistent commit relation. */
  headRefOid: string;
};
export type PullTraceRelation = {
  status: 'verified_current' | 'stale' | 'unknown';
  source: 'closingIssuesReferences' | 'pullRequest.commits';
  /** Null until a complete, successful read; storage must retain its prior lastVerifiedAt on unknown. */
  lastVerifiedAt: string | null;
};
export type PullTraceCommit = { oid: string; url: string };
export type PullTraceEvidence = {
  /** Null when even the PR identity cannot be established. */
  pull: PullTraceIdentity | null;
  observedAt: string;
  status: 'verified_current' | 'unknown';
  /** Complete sets only on verified_current; null means no absence claim is possible. */
  closingIssueNodeIds: string[] | null;
  commits: PullTraceCommit[] | null;
  issueRelations: Record<string, PullTraceRelation>;
  commitRelations: Record<string, PullTraceRelation>;
  /** Sanitized CLI/API error code; null on success. */
  errorCode: string | null;
};
export type PullTraceOptions = GithubGraphqlOptions & {
  maxPages?: number;
  now?: () => Date;
};

const RESOLVE_QUERY = `query ResolveTracePull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number url state isDraft mergedAt headRefOid repository { nameWithOwner }
    }
  }
}`;
const ISSUE_KIND_QUERY = `query TracePullIssueKind($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
}`;
const NODE_QUERY = `query TracePullNode($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequest {
      id number url state isDraft mergedAt headRefOid repository { nameWithOwner }
    }
  }
}`;
const ISSUES_QUERY = `query TracePullIssues($id: ID!, $after: String) {
  rateLimit { remaining resetAt }
  node(id: $id) {
    __typename
    ... on PullRequest {
      id
      closingIssuesReferences(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
}`;
const COMMITS_QUERY = `query TracePullCommits($id: ID!, $after: String) {
  rateLimit { remaining resetAt }
  node(id: $id) {
    __typename
    ... on PullRequest {
      id
      commits(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid url } }
      }
    }
  }
}`;

function bad(path: string): CliError {
  return new CliError({ code: 'trace_partial', message: `Invalid or incomplete GitHub pull trace at ${path}.`, exitCode: EXIT_SOURCE_UNAVAILABLE });
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(path);
  return value as Record<string, unknown>;
}
function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw bad(path);
  return value;
}
function identity(value: unknown, path: string): PullTraceIdentity {
  const node = record(value, path);
  const repo = record(node['repository'], `${path}.repository`);
  const number = node['number'];
  const state = node['state'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) throw bad(`${path}.number`);
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') throw bad(`${path}.state`);
  if (typeof node['isDraft'] !== 'boolean') throw bad(`${path}.isDraft`);
  const mergedAt = node['mergedAt'];
  if (mergedAt !== null && (typeof mergedAt !== 'string' || !Number.isFinite(Date.parse(mergedAt)))) throw bad(`${path}.mergedAt`);
  const nameWithOwner = str(repo['nameWithOwner'], `${path}.repository.nameWithOwner`);
  const url = str(node['url'], `${path}.url`);
  if (url !== `https://github.com/${nameWithOwner}/pull/${number}`) throw bad(`${path}.url`);
  return {
    pullNodeId: str(node['id'], `${path}.id`), number: number as number, url,
    repository: { nameWithOwner }, state, isDraft: node['isDraft'], mergedAt: mergedAt as string | null,
    headRefOid: str(node['headRefOid'], `${path}.headRefOid`),
  };
}

/** Parse only a GitHub PR URL or owner/repo#number; GitHub decides whether it is a PR. */
export function parsePullRef(input: string): ParsedPullRef {
  const raw = input.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  let numberRaw: string | undefined;
  if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(raw)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
    catch { throw usageError('Invalid pull request URL.', PULL_REF_HINT); }
    if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) {
      throw usageError('Pull request URL must use https://github.com.', PULL_REF_HINT);
    }
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    owner = match?.[1]; repo = match?.[2]; numberRaw = match?.[3];
  } else {
    const match = /^([^/#?]+)\/([^/#?]+)#(\d+)$/.exec(raw);
    owner = match?.[1]; repo = match?.[2]; numberRaw = match?.[3];
  }
  const validName = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
  const number = Number(numberRaw);
  if (!owner || !repo || !validName.test(owner) || !validName.test(repo) || !Number.isSafeInteger(number) || number < 1) {
    throw usageError('Invalid GitHub pull request reference.', PULL_REF_HINT);
  }
  return { owner, repo, number };
}

/** Resolve by PR endpoint, never by Issue text or cross-reference. An inaccessible ref is unknown. */
export async function resolvePullRequest(ref: ParsedPullRef, opts?: GithubGraphqlOptions): Promise<PullTraceIdentity> {
  const variables = { owner: ref.owner, name: ref.repo, number: ref.number };
  const checkIssueKind = async (): Promise<void> => {
    try {
      const kind = record(await graphql<unknown>(ISSUE_KIND_QUERY, variables, opts), 'data');
      const kindRepo = record(kind['repository'], 'repository');
      if (kindRepo['issue']) {
        throw new CliError({ code: 'not_pull_request', message: `${ref.owner}/${ref.repo}#${ref.number} is an Issue, not a pull request.`, exitCode: 2 });
      }
    } catch (kindError) {
      if (kindError instanceof CliError && kindError.code === 'not_pull_request') throw kindError;
    }
  };
  let data: Record<string, unknown>;
  try {
    data = record(await graphql<unknown>(RESOLVE_QUERY, variables, opts), 'data');
  } catch (error) {
    // GitHub emits NOT_FOUND errors, rather than a clean null, for an Issue number.
    // A separate successful Issue query is the only basis for a wrong-kind verdict.
    if (!(error instanceof CliError) || error.code !== 'github_bad_response') throw error;
    await checkIssueKind();
    throw error;
  }
  if (data['repository'] === null) throw bad('repository (not found or inaccessible)');
  const repo = record(data['repository'], 'repository');
  if (repo['pullRequest'] === null) {
    await checkIssueKind();
    throw bad('repository.pullRequest (not found or inaccessible)');
  }
  const pull = identity(repo['pullRequest'], 'repository.pullRequest');
  if (pull.number !== ref.number) throw bad('repository.pullRequest.number');
  return pull;
}

async function readNode(id: string, opts?: GithubGraphqlOptions): Promise<PullTraceIdentity> {
  const data = record(await graphql<unknown>(NODE_QUERY, { id }, opts), 'data');
  const node = record(data['node'], 'node');
  if (node['__typename'] !== 'PullRequest') throw bad('node.__typename');
  const pull = identity(node, 'node');
  if (pull.pullNodeId !== id) throw bad('node.id');
  return pull;
}

async function readConnection(id: string, kind: 'issues' | 'commits', opts?: PullTraceOptions): Promise<unknown[]> {
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PULL_TRACE_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw usageError('maxPages must be a positive integer.');
  const nodes: unknown[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data = record(await graphql<unknown>(kind === 'issues' ? ISSUES_QUERY : COMMITS_QUERY, { id, after }, opts), 'data');
    const rate = record(data['rateLimit'], 'rateLimit');
    if (!Number.isSafeInteger(rate['remaining']) || (rate['remaining'] as number) < 0) throw bad('rateLimit.remaining');
    const node = record(data['node'], 'node');
    if (node['__typename'] !== 'PullRequest' || node['id'] !== id) throw bad('node.id');
    const field = kind === 'issues' ? 'closingIssuesReferences' : 'commits';
    const conn = record(node[field], `node.${field}`);
    if (!Array.isArray(conn['nodes'])) throw bad(`node.${field}.nodes`);
    const info = record(conn['pageInfo'], `node.${field}.pageInfo`);
    if (typeof info['hasNextPage'] !== 'boolean') throw bad(`node.${field}.pageInfo.hasNextPage`);
    nodes.push(...conn['nodes']);
    if (!info['hasNextPage']) return nodes;
    const cursor = str(info['endCursor'], `node.${field}.pageInfo.endCursor`);
    if (seenCursors.has(cursor) || cursor === after || (conn['nodes'] as unknown[]).length === 0) throw bad(`node.${field}.pageInfo.endCursor`);
    seenCursors.add(cursor);
    after = cursor;
    if (rate['remaining'] === 0) throw bad('rateLimit.remaining');
  }
  throw bad(`${kind} page cap (${maxPages})`);
}

function relation(status: PullTraceRelation['status'], source: PullTraceRelation['source'], observedAt: string): PullTraceRelation {
  return { status, source, lastVerifiedAt: status === 'unknown' ? null : observedAt };
}

/**
 * Read complete PR connections and verify requested IDs/OIDs. `stale` means absent in a
 * completed current read; consumers distinguish first-time rejection from a former link.
 * Unknown carries no negative evidence and must not overwrite stored lastVerifiedAt.
 */
export async function readPullTrace(
  ref: ParsedPullRef | { pullNodeId: string },
  targets: { issueNodeIds?: string[]; commitOids?: string[] } = {},
  opts?: PullTraceOptions,
): Promise<PullTraceEvidence> {
  const observedAt = (opts?.now?.() ?? new Date()).toISOString();
  const issues = [...new Set(targets.issueNodeIds ?? [])];
  const oids = [...new Set(targets.commitOids ?? [])];
  for (const id of issues) if (!id) throw usageError('Issue node ID is required.');
  for (const oid of oids) if (!/^[0-9a-fA-F]{40}$/.test(oid)) throw usageError('Commit OID must be a full 40-character SHA-1.');
  let pull: PullTraceIdentity | null = null;
  try {
    pull = 'pullNodeId' in ref ? await readNode(ref.pullNodeId, opts) : await resolvePullRequest(ref, opts);
    const issueNodes = await readConnection(pull.pullNodeId, 'issues', opts);
    const commitNodes = await readConnection(pull.pullNodeId, 'commits', opts);
    const closing = new Set<string>();
    const commits = new Map<string, PullTraceCommit>();
    for (const [i, value] of issueNodes.entries()) closing.add(str(record(value, `issues.nodes[${i}]`)['id'], `issues.nodes[${i}].id`));
    for (const [i, value] of commitNodes.entries()) {
      const commit = record(record(value, `commits.nodes[${i}]`)['commit'], `commits.nodes[${i}].commit`);
      const oid = str(commit['oid'], `commits.nodes[${i}].commit.oid`);
      const url = str(commit['url'], `commits.nodes[${i}].commit.url`);
      if (!/^[0-9a-fA-F]{40}$/.test(oid) || !url.startsWith('https://github.com/')) throw bad(`commits.nodes[${i}].commit`);
      const previous = commits.get(oid.toLowerCase());
      if (previous && previous.url !== url) throw bad(`commits.nodes[${i}].commit duplicate`);
      commits.set(oid.toLowerCase(), { oid: oid.toLowerCase(), url });
    }
    const finalPull = await readNode(pull.pullNodeId, opts);
    if (finalPull.url !== pull.url || finalPull.state !== pull.state || finalPull.mergedAt !== pull.mergedAt || finalPull.headRefOid !== pull.headRefOid) throw bad('node changed during pagination');
    pull = finalPull;
    return {
      pull, observedAt, status: 'verified_current', closingIssueNodeIds: [...closing], commits: [...commits.values()],
      issueRelations: Object.fromEntries(issues.map(id => [id, relation(closing.has(id) ? 'verified_current' : 'stale', 'closingIssuesReferences', observedAt)])),
      commitRelations: Object.fromEntries(oids.map(oid => [oid, relation(commits.has(oid.toLowerCase()) ? 'verified_current' : 'stale', 'pullRequest.commits', observedAt)])),
      errorCode: null,
    };
  } catch (error) {
    if (error instanceof CliError && (error.code === 'not_pull_request' || error.code === 'usage_error')) throw error;
    const code = error instanceof CliError ? error.code : 'trace_partial';
    return {
      pull, observedAt, status: 'unknown', closingIssueNodeIds: null, commits: null,
      issueRelations: Object.fromEntries(issues.map(id => [id, relation('unknown', 'closingIssuesReferences', observedAt)])),
      commitRelations: Object.fromEntries(oids.map(oid => [oid, relation('unknown', 'pullRequest.commits', observedAt)])),
      errorCode: code,
    };
  }
}
