import type { ConfigEnvelopeV1 } from './config.js';
import type { DiscoveredProject } from './github/projects.js';
import { CliError, EXIT_ENVIRONMENT, EXIT_USAGE } from './errors.js';
import type { GitHubRepository } from './repo.js';

export type ProfileProjectOwner = {
  kind: 'user' | 'organization';
  login: string;
};

export type RepositoryProfile = {
  repository: {
    id: string;
    nameWithOwner: string;
    url: string;
  };
  project: {
    id: string;
    number: number;
    url: string;
    owner: ProfileProjectOwner;
  };
  createdAt: string;
  updatedAt: string;
};

export type UpsertProfileResult = {
  config: ConfigEnvelopeV1;
  profile: RepositoryProfile;
  unchanged: boolean;
};

function profileError(
  code: string,
  message: string,
  hint?: string,
  exitCode = EXIT_USAGE,
): CliError {
  return new CliError({ code, message, hint, exitCode });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function parseOwnerKind(value: unknown): ProfileProjectOwner['kind'] {
  if (value === 'user' || value === 'organization') {
    return value;
  }
  throw profileError('profile_invalid', 'Profile project.owner.kind must be user or organization.');
}

function parseRepositoryProfile(
  storageKey: string,
  entry: unknown,
): RepositoryProfile {
  if (!isPlainObject(entry)) {
    throw profileError('profile_invalid', `Profile '${storageKey}' must be an object.`);
  }

  const repository = entry['repository'];
  if (!isPlainObject(repository)) {
    throw profileError('profile_invalid', `Profile '${storageKey}' is missing repository.`);
  }
  const repoId = repository['id'];
  const nameWithOwner = repository['nameWithOwner'];
  const repoUrl = repository['url'];
  if (typeof repoId !== 'string' || repoId.length === 0) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid repository.id.`);
  }
  if (typeof nameWithOwner !== 'string' || nameWithOwner.length === 0) {
    throw profileError(
      'profile_invalid',
      `Profile '${storageKey}' has invalid repository.nameWithOwner.`,
    );
  }
  if (typeof repoUrl !== 'string' || repoUrl.length === 0) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid repository.url.`);
  }
  if (storageKey !== repoId) {
    throw profileError(
      'profile_invalid',
      `Profile key '${storageKey}' does not match repository.id '${repoId}'.`,
    );
  }

  const project = entry['project'];
  if (!isPlainObject(project)) {
    throw profileError('profile_invalid', `Profile '${storageKey}' is missing project.`);
  }
  const projectId = project['id'];
  const projectNumber = project['number'];
  const projectUrl = project['url'];
  const owner = project['owner'];
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid project.id.`);
  }
  if (typeof projectNumber !== 'number' || !Number.isInteger(projectNumber) || projectNumber < 1) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid project.number.`);
  }
  if (typeof projectUrl !== 'string' || projectUrl.length === 0) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid project.url.`);
  }
  if (!isPlainObject(owner)) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid project.owner.`);
  }
  const ownerLogin = owner['login'];
  if (typeof ownerLogin !== 'string' || ownerLogin.length === 0) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid project.owner.login.`);
  }
  const ownerKind = parseOwnerKind(owner['kind']);

  const createdAt = entry['createdAt'];
  const updatedAt = entry['updatedAt'];
  if (typeof createdAt !== 'string' || !isIsoTimestamp(createdAt)) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid createdAt.`);
  }
  if (typeof updatedAt !== 'string' || !isIsoTimestamp(updatedAt)) {
    throw profileError('profile_invalid', `Profile '${storageKey}' has invalid updatedAt.`);
  }

  return {
    repository: { id: repoId, nameWithOwner, url: repoUrl },
    project: {
      id: projectId,
      number: projectNumber,
      url: projectUrl,
      owner: { kind: ownerKind, login: ownerLogin },
    },
    createdAt,
    updatedAt,
  };
}

function selectionEquals(a: RepositoryProfile, b: RepositoryProfile): boolean {
  return (
    a.repository.id === b.repository.id &&
    a.repository.nameWithOwner === b.repository.nameWithOwner &&
    a.repository.url === b.repository.url &&
    a.project.id === b.project.id &&
    a.project.number === b.project.number &&
    a.project.url === b.project.url &&
    a.project.owner.kind === b.project.owner.kind &&
    a.project.owner.login === b.project.owner.login
  );
}

export function profileNotFoundError(): CliError {
  return profileError(
    'profile_not_found',
    'No telemetry profile is stored for this repository.',
    'Run orca-telemetry init to select a GitHub Project.',
    EXIT_ENVIRONMENT,
  );
}

/**
 * Load a validated profile for a GitHub repository node id.
 */
export function getProfile(
  config: ConfigEnvelopeV1,
  repositoryId: string,
): RepositoryProfile {
  const raw = config.profiles[repositoryId];
  if (raw === undefined) {
    throw profileNotFoundError();
  }
  return parseRepositoryProfile(repositoryId, raw);
}

/**
 * List all stored profiles (validated).
 */
export function listProfiles(config: ConfigEnvelopeV1): RepositoryProfile[] {
  return Object.keys(config.profiles)
    .sort()
    .map((key) => parseRepositoryProfile(key, config.profiles[key]));
}

function buildProfile(
  repository: GitHubRepository,
  project: DiscoveredProject,
  createdAt: string,
  updatedAt: string,
): RepositoryProfile {
  return {
    repository: {
      id: repository.id,
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
    },
    project: {
      id: project.id,
      number: project.number,
      url: project.url,
      owner: {
        kind: project.owner.kind,
        login: project.owner.login,
      },
    },
    createdAt,
    updatedAt,
  };
}

/**
 * Upsert profile for repository.id; idempotent when selection unchanged.
 */
export function upsertProfile(
  config: ConfigEnvelopeV1,
  repository: GitHubRepository,
  project: DiscoveredProject,
  now: () => string = () => new Date().toISOString(),
): UpsertProfileResult {
  const key = repository.id;
  const existingRaw = config.profiles[key];
  const timestamp = now();

  if (existingRaw !== undefined) {
    const existing = parseRepositoryProfile(key, existingRaw);
    const candidate = buildProfile(
      repository,
      project,
      existing.createdAt,
      timestamp,
    );
    if (selectionEquals(existing, candidate)) {
      return { config, profile: existing, unchanged: true };
    }
    const updated = buildProfile(
      repository,
      project,
      existing.createdAt,
      timestamp,
    );
    const profiles = {
      ...config.profiles,
      [key]: updated as unknown as Record<string, never>,
    };
    return {
      config: { ...config, profiles },
      profile: updated,
      unchanged: false,
    };
  }

  const created = buildProfile(repository, project, timestamp, timestamp);
  const profiles = {
    ...config.profiles,
    [key]: created as unknown as Record<string, never>,
  };
  return {
    config: { ...config, profiles },
    profile: created,
    unchanged: false,
  };
}
