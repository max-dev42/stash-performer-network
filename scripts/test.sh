#!/bin/sh
# Runs the unit tests (Node's built-in test runner, no dependencies; Node 20+).
set -e
cd "$(dirname "$0")/.."
node --test tests/*.test.js
