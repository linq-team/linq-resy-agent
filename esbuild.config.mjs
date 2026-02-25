/**
 * Build Lambda handler bundles.
 *
 * Usage: node esbuild.config.mjs
 *
 * Externalized (not bundled):
 *   - @aws-sdk/* — included in Lambda runtime
 *   - @anthropic-ai/sdk — deployed as a Lambda layer (too large to bundle inline)
 */

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';

mkdirSync('dist/handlers', { recursive: true });

const externals = [
  '"--external:@aws-sdk/client-dynamodb"',
  '"--external:@aws-sdk/lib-dynamodb"',
  '"--external:@aws-sdk/client-sqs"',
  '"--external:@anthropic-ai/sdk"',
].join(' ');

const shared = `--bundle --platform=node --target=node20 --format=cjs ${externals}`;

console.log('Building receiver...');
execSync(`npx esbuild src/handlers/receiver.ts --outfile=dist/handlers/receiver.js ${shared}`, { stdio: 'inherit' });

console.log('Building processor...');
execSync(`npx esbuild src/handlers/processor.ts --outfile=dist/handlers/processor.js ${shared}`, { stdio: 'inherit' });

console.log('✓ Lambda handlers bundled');
