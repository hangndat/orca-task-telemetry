import { CliError, EXIT_SOURCE_UNAVAILABLE, usageError } from '../errors.js';
import { graphql, type GithubGraphqlOptions } from './client.js';

export const PROJECT_FIELDS_PAGE_SIZE = 100;
export const DEFAULT_MAX_PROJECT_FIELD_PAGES = 100;
export const PROJECT_ITEM_FIELD_VALUES_PAGE_SIZE = 100;
export const DEFAULT_MAX_PROJECT_ITEM_FIELD_VALUE_PAGES = 100;

export type ProjectFieldConfiguration = {
  id: string;
  name: string;
  dataType: string;
};

export type ReadProjectFieldsOptions = GithubGraphqlOptions & {
  maxPages?: number;
};

export type ReadProjectItemNumberFieldValueOptions = GithubGraphqlOptions & {
  maxPages?: number;
};

export const PROJECT_FIELDS_QUERY = `query ProjectFields($id: ID!, $after: String) {
  rateLimit { cost remaining resetAt }
  node(id: $id) {
    ... on ProjectV2 {
      id
      fields(first: ${PROJECT_FIELDS_PAGE_SIZE}, after: $after) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on ProjectV2FieldCommon {
            id
            name
            dataType
          }
        }
      }
    }
  }
}`;

export const PROJECT_ITEM_FIELD_VALUES_QUERY = `query ProjectItemFieldValues($id: ID!, $after: String) {
  rateLimit { cost remaining resetAt }
  node(id: $id) {
    ... on ProjectV2Item {
      id
      fieldValues(first: ${PROJECT_ITEM_FIELD_VALUES_PAGE_SIZE}, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on ProjectV2ItemFieldNumberValue {
            number
            field { ... on ProjectV2FieldCommon { id } }
          }
          ... on ProjectV2ItemFieldTextValue {
            field { ... on ProjectV2FieldCommon { id } }
          }
          ... on ProjectV2ItemFieldSingleSelectValue {
            field { ... on ProjectV2FieldCommon { id } }
          }
          ... on ProjectV2ItemFieldIterationValue {
            field { ... on ProjectV2FieldCommon { id } }
          }
          ... on ProjectV2ItemFieldRepositoryValue {
            field { ... on ProjectV2FieldCommon { id } }
          }
        }
      }
    }
  }
}`;

type GraphqlProjectFieldNode = {
  __typename?: string;
  id?: string;
  name?: string;
  dataType?: string;
};

type ProjectFieldsPage = {
  node: {
    id: string;
    fields: {
      totalCount: number;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: GraphqlProjectFieldNode[];
    };
  } | null;
};

type ProjectItemFieldValuesPage = {
  node: {
    id: string;
    fieldValues: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: FieldValueNode[];
    };
  } | null;
};

type FieldValueNode = {
  __typename?: string;
  number?: number;
  field?: { id?: string } | null;
};

function badResponse(path: string, detail: string): CliError {
  return new CliError({
    code: 'github_bad_response',
    message: `GitHub project fields response invalid at ${path}: ${detail}`,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badResponse(path, 'expected non-empty string');
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badResponse(path, 'expected finite number');
  }
  return value;
}

function mapFieldNode(
  node: GraphqlProjectFieldNode,
  index: number,
): ProjectFieldConfiguration {
  const path = `fields.nodes[${index}]`;
  if (!node || typeof node !== 'object') {
    throw badResponse(path, 'expected field node object');
  }
  return {
    id: requireString(node.id, `${path}.id`),
    name: requireString(node.name, `${path}.name`),
    dataType: requireString(node.dataType, `${path}.dataType`),
  };
}

function assertNumberField(field: ProjectFieldConfiguration): ProjectFieldConfiguration {
  if (field.dataType !== 'NUMBER') {
    throw usageError(
      `Project field "${field.name}" is not a NUMBER field (dataType=${field.dataType}).`,
      'Choose a NUMBER custom field on the project board.',
    );
  }
  return field;
}

/**
 * Read all ProjectV2 field configurations for a project node id (paginated).
 */
export async function readProjectFields(
  projectNodeId: string,
  opts?: ReadProjectFieldsOptions,
): Promise<ProjectFieldConfiguration[]> {
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PROJECT_FIELD_PAGES;
  const fields: ProjectFieldConfiguration[] = [];
  let after: string | null = null;
  let previousCursor: string | null = null;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;
    const data: ProjectFieldsPage = await graphql<ProjectFieldsPage>(
      PROJECT_FIELDS_QUERY,
      { id: projectNodeId, after },
      opts,
    );

    const projectNode: ProjectFieldsPage['node'] = data.node;
    if (!projectNode) {
      throw badResponse('node', 'project node not found');
    }

    const connection: NonNullable<ProjectFieldsPage['node']>['fields'] =
      projectNode.fields;
    if (!connection) {
      throw badResponse('node.fields', 'missing fields connection');
    }

    const offset = fields.length;
    connection.nodes.forEach((node: GraphqlProjectFieldNode, index: number) => {
      fields.push(mapFieldNode(node, offset + index));
    });

    const pageInfo: (typeof connection)['pageInfo'] = connection.pageInfo;
    if (!pageInfo?.hasNextPage) {
      return fields;
    }

    const endCursor: string | null = pageInfo.endCursor;
    if (endCursor === null || endCursor.length === 0) {
      throw badResponse('node.fields.pageInfo.endCursor', 'missing endCursor');
    }
    if (endCursor === previousCursor) {
      throw badResponse(
        'node.fields.pageInfo.endCursor',
        'cursor did not advance between pages',
      );
    }
    previousCursor = endCursor;
    after = endCursor;
  }

  throw badResponse(
    'node.fields',
    `exceeded maximum pages (${maxPages}) while paginating project fields`,
  );
}

/**
 * Resolve a NUMBER field configuration by unique name (fails on duplicates).
 */
export function selectNumberFieldByName(
  fields: ProjectFieldConfiguration[],
  name: string,
): ProjectFieldConfiguration {
  const matches = fields.filter((f) => f.name === name);
  if (matches.length > 1) {
    throw usageError(
      `Multiple project fields named "${name}".`,
      'Use --field-id to select the intended NUMBER field.',
    );
  }
  if (matches.length === 0) {
    throw usageError(
      `Project field not found: ${name}`,
      'Check the field name on the project board or pass --field-id.',
    );
  }
  const match = matches[0];
  if (!match) {
    throw usageError(
      `Project field not found: ${name}`,
      'Check the field name on the project board or pass --field-id.',
    );
  }
  return assertNumberField(match);
}

/**
 * Resolve a NUMBER field configuration by field node id.
 */
export function selectNumberFieldById(
  fields: ProjectFieldConfiguration[],
  fieldId: string,
): ProjectFieldConfiguration {
  const match = fields.find((f) => f.id === fieldId);
  if (!match) {
    throw usageError(
      'Project field id is not configured on this project.',
      'Pass a field id from the same project as the init profile.',
    );
  }
  return assertNumberField(match);
}

function fieldIdFromValueNode(node: FieldValueNode, path: string): string | null {
  const field = node.field;
  if (field === null) {
    throw badResponse(`${path}.field`, 'field is null (redacted or incomplete)');
  }
  if (field === undefined) {
    return null;
  }
  const id = field.id;
  if (id === undefined) {
    return null;
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw badResponse(`${path}.field.id`, 'expected non-empty string');
  }
  return id;
}

function interpretValueNodeForField(
  node: FieldValueNode,
  path: string,
  targetFieldId: string,
): number | null | 'wrong_type' {
  const fieldId = fieldIdFromValueNode(node, path);
  if (fieldId === null) {
    throw badResponse(path, 'field value node missing field id');
  }
  if (fieldId !== targetFieldId) {
    return null;
  }

  const typename = node.__typename;
  if (typename === 'ProjectV2ItemFieldNumberValue') {
    return requireNumber(node.number, `${path}.number`);
  }
  if (
    typename === 'ProjectV2ItemFieldTextValue' ||
    typename === 'ProjectV2ItemFieldSingleSelectValue' ||
    typename === 'ProjectV2ItemFieldIterationValue' ||
    typename === 'ProjectV2ItemFieldRepositoryValue'
  ) {
    return 'wrong_type';
  }

  throw badResponse(
    path,
    `unsupported field value typename ${typename ?? '(missing)'}`,
  );
}

/**
 * Read the current NUMBER value for a project item and field id.
 * Returns `null` when the field has no value on the item (absent).
 */
export async function readProjectItemNumberFieldValue(
  projectItemNodeId: string,
  fieldId: string,
  opts?: ReadProjectItemNumberFieldValueOptions,
): Promise<number | null> {
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PROJECT_ITEM_FIELD_VALUE_PAGES;
  let after: string | null = null;
  let previousCursor: string | null = null;
  let pages = 0;
  let found: number | undefined;

  while (pages < maxPages) {
    pages += 1;
    const data: ProjectItemFieldValuesPage = await graphql<ProjectItemFieldValuesPage>(
      PROJECT_ITEM_FIELD_VALUES_QUERY,
      { id: projectItemNodeId, after },
      opts,
    );

    const itemNode: ProjectItemFieldValuesPage['node'] = data.node;
    if (!itemNode) {
      throw badResponse('node', 'project item node not found');
    }

    const connection: NonNullable<ProjectItemFieldValuesPage['node']>['fieldValues'] =
      itemNode.fieldValues;
    if (!connection) {
      throw badResponse('node.fieldValues', 'missing fieldValues connection');
    }

    connection.nodes.forEach((node: FieldValueNode, index: number) => {
      if (found !== undefined) {
        return;
      }
      const path = `fieldValues.nodes[${index}]`;
      const interpreted = interpretValueNodeForField(node, path, fieldId);
      if (interpreted === 'wrong_type') {
        throw badResponse(
          path,
          `field value for ${fieldId} is not a NUMBER value`,
        );
      }
      if (interpreted !== null) {
        found = interpreted;
      }
    });

    if (found !== undefined) {
      return found;
    }

    const pageInfo: (typeof connection)['pageInfo'] = connection.pageInfo;
    if (!pageInfo?.hasNextPage) {
      return null;
    }

    const endCursor: string | null = pageInfo.endCursor;
    if (endCursor === null || endCursor.length === 0) {
      throw badResponse('node.fieldValues.pageInfo.endCursor', 'missing endCursor');
    }
    if (endCursor === previousCursor) {
      throw badResponse(
        'node.fieldValues.pageInfo.endCursor',
        'cursor did not advance between pages',
      );
    }
    previousCursor = endCursor;
    after = endCursor;
  }

  throw badResponse(
    'node.fieldValues',
    `exceeded maximum pages (${maxPages}) while paginating field values`,
  );
}
