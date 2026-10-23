import type { GitHubIssue, ProjectItem, ProjectItemContentType } from '../contracts.js';
import { CliError, EXIT_SOURCE_UNAVAILABLE } from '../errors.js';
import { graphql, type GithubGraphqlOptions } from './client.js';

export const PROJECT_ITEMS_PAGE_SIZE = 100;
export const DEFAULT_MAX_PROJECT_ITEM_PAGES = 100;

export const PROJECT_ITEMS_QUERY = `query ProjectItems($id: ID!, $after: String) {
  rateLimit { cost remaining resetAt }
  node(id: $id) {
    ... on ProjectV2 {
      id
      number
      title
      items(first: 100, after: $after) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
          hasPreviousPage
          startCursor
        }
        nodes {
          id
          type
          content {
            __typename
            ... on Issue {
              id
              number
              title
              url
              state
              parent { id }
              repository { nameWithOwner }
            }
            ... on PullRequest {
              number
              title
              url
              state
              repository { nameWithOwner }
            }
            ... on DraftIssue {
              title
              body
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title
                startDate
                duration
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldRepositoryValue {
                repository { nameWithOwner }
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}`;

export type ReadProjectItemsOptions = GithubGraphqlOptions & {
  maxPages?: number;
};

type ProjectItemsPage = {
  node: {
    id: string;
    items: {
      totalCount: number;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: GraphqlProjectItemNode[];
    };
  } | null;
};

type GraphqlProjectItemNode = {
  id: string;
  type: string;
  content: GraphqlContent | null;
  fieldValues?: { nodes: unknown[] };
};

type GraphqlIssueContent = {
  __typename: 'Issue';
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  parent?: { id?: string } | null;
  repository?: { nameWithOwner?: string };
};

type GraphqlContent =
  | GraphqlIssueContent
  | {
      __typename: 'PullRequest';
      number?: number;
      title?: string;
      url?: string;
      state?: string;
      repository?: { nameWithOwner?: string };
    }
  | { __typename: 'DraftIssue'; title?: string; body?: string }
  | { __typename: string };

function badResponse(path: string, detail: string): CliError {
  return new CliError({
    code: 'github_bad_response',
    message: `GitHub project items response invalid at ${path}: ${detail}`,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

function requireString(
  value: unknown,
  path: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badResponse(path, 'expected non-empty string');
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badResponse(path, 'expected number');
  }
  return value;
}

function mapContentType(
  content: GraphqlContent | null,
): ProjectItemContentType {
  if (content === null) {
    return 'Redacted';
  }
  switch (content.__typename) {
    case 'Issue':
      return 'Issue';
    case 'PullRequest':
      return 'PullRequest';
    case 'DraftIssue':
      return 'DraftIssue';
    default:
      return 'Redacted';
  }
}

function mapIssue(content: GraphqlIssueContent, path: string): GitHubIssue {
  const repoPath = `${path}.repository.nameWithOwner`;
  if (content.parent === undefined) {
    throw badResponse(`${path}.parent`, 'missing parent field');
  }
  return {
    issueNodeId: requireString(content.id, `${path}.id`),
    parentIssueNodeId:
      content.parent === null
        ? null
        : requireString(content.parent.id, `${path}.parent.id`),
    repository: {
      nameWithOwner: requireString(
        content.repository?.nameWithOwner,
        repoPath,
      ),
    },
    number: requireNumber(content.number, `${path}.number`),
    url: requireString(content.url, `${path}.url`),
    title: requireString(content.title, `${path}.title`),
    state: requireString(content.state, `${path}.state`),
  };
}

function mapNode(
  projectId: string,
  node: GraphqlProjectItemNode,
  index: number,
): ProjectItem {
  const basePath = `items.nodes[${index}]`;
  const itemId = requireString(node.id, `${basePath}.id`);
  const contentType = mapContentType(node.content);
  let issue: GitHubIssue | null = null;
  if (contentType === 'Issue') {
    if (!node.content) {
      throw badResponse(`${basePath}.content`, 'missing Issue content');
    }
    issue = mapIssue(node.content as GraphqlIssueContent, `${basePath}.content`);
  }
  return {
    projectId,
    itemId,
    contentType,
    issue,
  };
}

/**
 * Read all project items for a Projects V2 node id, following GraphQL cursors.
 */
export async function readProjectItems(
  projectNodeId: string,
  opts?: ReadProjectItemsOptions,
): Promise<ProjectItem[]> {
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PROJECT_ITEM_PAGES;
  const items: ProjectItem[] = [];
  let after: string | null = null;
  let previousCursor: string | null = null;
  let projectId = projectNodeId;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;
    const data: ProjectItemsPage = await graphql<ProjectItemsPage>(
      PROJECT_ITEMS_QUERY,
      {
        id: projectNodeId,
        after,
      },
      opts,
    );

    const projectNode: ProjectItemsPage['node'] = data.node;
    if (!projectNode) {
      throw badResponse('node', 'project node not found');
    }
    if (typeof projectNode.id === 'string' && projectNode.id.length > 0) {
      projectId = projectNode.id;
    }

    const page: NonNullable<ProjectItemsPage['node']>['items'] = projectNode.items;
    if (!page) {
      throw badResponse('node.items', 'missing items');
    }

    const offset = items.length;
    page.nodes.forEach((node, index) => {
      items.push(mapNode(projectId, node, offset + index));
    });

    const pageInfo: (typeof page)['pageInfo'] = page.pageInfo;
    if (!pageInfo?.hasNextPage) {
      return items;
    }

    const endCursor: string | null = pageInfo.endCursor;
    if (endCursor === null || endCursor.length === 0) {
      throw badResponse('node.items.pageInfo.endCursor', 'missing endCursor');
    }
    if (endCursor === previousCursor) {
      throw badResponse(
        'node.items.pageInfo.endCursor',
        'cursor did not advance between pages',
      );
    }
    previousCursor = endCursor;
    after = endCursor;
  }

  throw badResponse(
    'node.items',
    `exceeded maximum pages (${maxPages}) while paginating project items`,
  );
}
