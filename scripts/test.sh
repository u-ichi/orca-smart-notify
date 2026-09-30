#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -B "$ROOT/tests/test-classifier.py"
python3 -B "$ROOT/tests/test-message-reader.py"
node --test "$ROOT/tests/"*.test.mjs
