#!/bin/bash

set -e

echo "🛑 Stopping dev server..."
pkill -f "next dev" || true
sleep 1

echo "🚀 Starting dev server..."
cd "$(dirname "$0")/.."
npm run dev
