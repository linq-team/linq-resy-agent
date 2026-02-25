#!/bin/bash
# Build the Anthropic SDK Lambda layer
# This creates a zip file that SAM deploys as a Lambda layer.

set -e

LAYER_DIR="dist/layer/nodejs"
rm -rf dist/layer
mkdir -p "$LAYER_DIR"

cd "$LAYER_DIR"
npm init -y --silent > /dev/null 2>&1
npm install @anthropic-ai/sdk --silent

# Clean up unnecessary files
rm -f package.json package-lock.json
cd ../../..

echo "✓ Anthropic SDK layer built at dist/layer/"
