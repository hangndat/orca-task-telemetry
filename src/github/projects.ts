import { CliError, EXIT_SOURCE_UNAVAILABLE } from '../errors.js';
import { graphql, type GithubGraphqlOptions } from './client.js';

export const PROJECTS_PAGE_SIZE = 50;
export const DEFAULT_MAX_PROJECT_PAGES = 100;

export type ProjectOwnerKind = 'user' | 'organization';

export type ProjectOwnerRef = {
  kind: ProjectOwnerKind;
  login: string;
};

export type DiscoveredProject = {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  owner: ProjectOwnerRef;
  sources: Array<'repository' | 'owner'>;
};

export type RepositoryRef = {
  owner: string;
  name: string;
};

export type DiscoverProjectsOptions = GithubGraphqlOptions & {
  maxPages?: number;
};

const REPOSITORY_PROJECTS_QUERY = `query RepositoryProjects($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    owner {
      __typename
      login
    }
    projectsV2(first: ${PROJECTS_PAGE_SIZE}, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        url
        closed
      }
    }
  }
}`;

const USER_PROJECTS_QUERY = `query UserProjects($login: String!, $after: String) {
  user(login: $login) {
    projectsV2(first: ${PROJECTS_PAGE_SIZE}, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        url
        closed
      }
    }
  }
}`;

const ORGANIZATION_PROJECTS_QUERY = `query OrganizationProjects($login: String!, $after: String) {
  organization(login: $login) {
    projectsV2(first: ${PROJECTS_PAGE_SIZE}, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        url
        closed
      }
    }
  }
}`;

type ProjectNode = {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
};

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type ProjectsConnection = {
  pageInfo: PageInfo;
  nodes: ProjectNode[];
};

function badResponse(path: string, detail: string): CliError {
  return new CliError({
    code: 'github_bad_response',
    message: `GitHub projects response invalid at ${path}: ${detail}`,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

function mapOwnerKind(typename: string): ProjectOwnerKind {
  if (typename === 'Organization') {
    return 'organization';
  }
  if (typename === 'User') {
    return 'user';
  }
  throw badResponse('repository.owner.__typename', `unsupported owner type ${typename}`);
}

function requireNode(
  node: ProjectNode | undefined,
  index: number,
  pathPrefix: string,
): ProjectNode {
  if (!node?.id) {
    throw badResponse(`${pathPrefix}.nodes[${index}].id`, 'missing project id');
  }
  if (typeof node.number !== 'number') {
    throw badResponse(`${pathPrefix}.nodes[${index}].number`, 'missing project number');
  }
  if (typeof node.title !== 'string' || node.title.length === 0) {
    throw badResponse(`${pathPrefix}.nodes[${index}].title`, 'missing project title');
  }
  if (typeof node.url !== 'string' || node.url.length === 0) {
    throw badResponse(`${pathPrefix}.nodes[${index}].url`, 'missing project url');
  }
  if (typeof node.closed !== 'boolean') {
    throw badResponse(`${pathPrefix}.nodes[${index}].closed`, 'missing project closed');
  }
  return node;
}

async function paginateProjects(
  fetchPage: (
    after: string | null,
  ) => Promise<{ connection: ProjectsConnection | null; path: string }>,
  maxPages: number,
): Promise<ProjectNode[]> {
  const nodes: ProjectNode[] = [];
  let after: string | null = null;
  let previousCursor: string | null = null;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;
    const { connection, path } = await fetchPage(after);
    if (!connection) {
      throw badResponse(path, 'missing projects connection');
    }
    connection.nodes.forEach((node, index) => {
      nodes.push(requireNode(node, index, path));
    });

    const pageInfo = connection.pageInfo;
    if (!pageInfo?.hasNextPage) {
      return nodes;
    }
    const endCursor = pageInfo.endCursor;
    if (endCursor === null || endCursor.length === 0) {
      throw badResponse(`${path}.pageInfo.endCursor`, 'missing endCursor');
    }
    if (endCursor === previousCursor) {
      throw badResponse(`${path}.pageInfo.endCursor`, 'cursor did not advance between pages');
    }
    previousCursor = endCursor;
    after = endCursor;
  }

  throw badResponse('projectsV2', `exceeded maximum pages (${maxPages}) while paginating`);
}

function mergeProjects(
  owner: ProjectOwnerRef,
  repoProjects: ProjectNode[],
  ownerProjects: ProjectNode[],
): DiscoveredProject[] {
  const byId = new Map<string, DiscoveredProject>();

  for (const node of repoProjects) {
    byId.set(node.id, {
      id: node.id,
      number: node.number,
      title: node.title,
      url: node.url,
      closed: node.closed,
      owner,
      sources: ['repository'],
    });
  }

  for (const node of ownerProjects) {
    const existing = byId.get(node.id);
    if (existing) {
      if (!existing.sources.includes('owner')) {
        existing.sources.push('owner');
      }
      continue;
    }
    byId.set(node.id, {
      id: node.id,
      number: node.number,
      title: node.title,
      url: node.url,
      closed: node.closed,
      owner,
      sources: ['owner'],
    });
  }

  return [...byId.values()].sort((a, b) => a.number - b.number);
}

/**
 * Discover Projects V2 linked to a repository and owned by the repository owner (user or org).
 */
export async function discoverProjects(
  repository: RepositoryRef,
  opts?: DiscoverProjectsOptions,
): Promise<DiscoveredProject[]> {
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PROJECT_PAGES;

  type RepoPage = {
    repository: {
      owner: { __typename: string; login: string } | null;
      projectsV2: ProjectsConnection;
    } | null;
  };

  let ownerRef: ProjectOwnerRef | null = null;

  const repoProjects = await paginateProjects(
    async (after) => {
      const data = await graphql<RepoPage>(REPOSITORY_PROJECTS_QUERY, {
        owner: repository.owner,
        name: repository.name,
        after,
      }, opts);
      const repo = data.repository;
      if (!repo) {
        throw badResponse('repository', 'repository not found');
      }
      if (!ownerRef && repo.owner?.login) {
        ownerRef = {
          kind: mapOwnerKind(repo.owner.__typename),
          login: repo.owner.login,
        };
      }
      return { connection: repo.projectsV2, path: 'repository.projectsV2' };
    },
    maxPages,
  );

  if (!ownerRef) {
    throw badResponse('repository.owner', 'missing repository owner');
  }

  const ownerProjects = await paginateProjects(
    async (after) => {
      if (ownerRef!.kind === 'organization') {
        const data = await graphql<{
          organization: { projectsV2: ProjectsConnection } | null;
        }>(ORGANIZATION_PROJECTS_QUERY, {
          login: ownerRef!.login,
          after,
        }, opts);
        return {
          connection: data.organization?.projectsV2 ?? null,
          path: 'organization.projectsV2',
        };
      }
      const data = await graphql<{
        user: { projectsV2: ProjectsConnection } | null;
      }>(USER_PROJECTS_QUERY, {
        login: ownerRef!.login,
        after,
      }, opts);
      return {
        connection: data.user?.projectsV2 ?? null,
        path: 'user.projectsV2',
      };
    },
    maxPages,
  );

  return mergeProjects(ownerRef, repoProjects, ownerProjects);
}
