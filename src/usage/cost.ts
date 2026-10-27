import type { Cost } from '../contracts.js';
import { schemaDrift } from './adapter.js';

export function mapAgentTopCost(
  costUsd: unknown,
  unpricedTokens: unknown,
  agentTopVersion: string,
  path = 'cost_usd',
): Cost {
  if (unpricedTokens !== null && unpricedTokens !== undefined) {
    if (typeof unpricedTokens !== 'number' || !Number.isFinite(unpricedTokens)) {
      throw schemaDrift('unpriced_tokens', 'expected finite number when present');
    }
    if (unpricedTokens < 0) {
      throw schemaDrift('unpriced_tokens', 'must not be negative');
    }
    if (unpricedTokens > 0) {
      return {
        amountUsd: null,
        kind: 'unknown',
        source: { tool: 'agent-top', version: agentTopVersion },
      };
    }
  }

  if (costUsd === null || costUsd === undefined) {
    return {
      amountUsd: null,
      kind: 'unknown',
      source: null,
    };
  }
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) {
    throw schemaDrift(path, 'cost_usd must be a finite number when present');
  }
  if (costUsd < 0) {
    throw schemaDrift(path, 'cost_usd must not be negative');
  }
  return {
    amountUsd: costUsd,
    kind: 'estimated_api_equivalent',
    source: { tool: 'agent-top', version: agentTopVersion },
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

export function zeroKnownCost(agentTopVersion: string): Cost {
  return {
    amountUsd: 0,
    kind: 'estimated_api_equivalent',
    source: { tool: 'agent-top', version: agentTopVersion },
  };
}
