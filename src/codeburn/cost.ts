import type { Cost } from '../contracts.js';
import { schemaDrift } from './adapter.js';

export function mapRowCost(
  value: unknown,
  codeburnVersion: string,
  path = 'cost',
): Cost {
  if (value === null || value === undefined) {
    return {
      amountUsd: null,
      kind: 'unknown',
      source: null,
    };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw schemaDrift(path, 'cost must be a finite number when present');
  }
  if (value < 0) {
    throw schemaDrift(path, 'cost must not be negative');
  }
  return {
    amountUsd: value,
    kind: 'estimated_api_equivalent',
    source: { tool: 'codeburn', version: codeburnVersion },
  };
}

export type CostAggregate = {
  knownTotalUsd: number;
  unknownCount: number;
};

/**
 * Sum known USD amounts; count snapshots with unknown cost separately (unknown ≠ 0).
 */
export function aggregateCosts(costs: Cost[]): CostAggregate {
  let knownTotalUsd = 0;
  let unknownCount = 0;
  for (const cost of costs) {
    if (cost.kind === 'unknown' || cost.amountUsd === null) {
      unknownCount += 1;
      continue;
    }
    if (!Number.isFinite(cost.amountUsd)) {
      throw schemaDrift('cost.amountUsd', 'non-finite amount in aggregate input');
    }
    knownTotalUsd += cost.amountUsd;
  }
  return { knownTotalUsd, unknownCount };
}

export function isKnownCost(cost: Cost): boolean {
  return cost.kind === 'estimated_api_equivalent' && cost.amountUsd !== null;
}

export function zeroKnownCost(codeburnVersion: string): Cost {
  return {
    amountUsd: 0,
    kind: 'estimated_api_equivalent',
    source: { tool: 'codeburn', version: codeburnVersion },
  };
}
