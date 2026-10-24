#!/usr/bin/env node
// Synthetic, redacted GraphQL fixture transport. One process is launched per page.
import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv[2] !== 'api' || process.argv[3] !== 'graphql') process.exit(2);
const request = JSON.parse(readFileSync(0, 'utf8'));
const steps = JSON.parse(process.env.GH_PULL_TRACE_STEPS ?? '[]');
const path = process.env.GH_PULL_TRACE_COUNTER;
if (!path) process.exit(2);
const index = Number(readFileSync(path, 'utf8'));
writeFileSync(path, String(index + 1));
const step = steps[index];
if (!step) process.exit(3);
if (step.query && !request.query.includes(step.query)) process.exit(4);
if (step.after !== undefined && request.variables.after !== step.after) process.exit(5);
process.stdout.write(JSON.stringify(step.body));
process.exit(step.exitCode ?? 0);
