#!/usr/bin/env bash
# Builds a synthetic repository with fictional authors for store screenshots.
# Usage: tools/demo-repo.sh <dir>
set -euo pipefail
DIR="$1"; rm -rf "$DIR" "$DIR.remote"; mkdir -p "$DIR"; cd "$DIR"
git init -q -b main
git config commit.gpgsign false
T=$(( $(date +%s) - 40*86400 ))
c() { # author email message [file]
  T=$((T + 3600 * (3 + RANDOM % 20)))
  echo "$3 $RANDOM" >> "${4:-src/app.ts}"
  git add -A
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" \
  GIT_AUTHOR_DATE="@$T" GIT_COMMITTER_DATE="@$T" git commit -q -m "$3"
}
m() { # author email branch message
  T=$((T + 3600 * 2))
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" \
  GIT_AUTHOR_DATE="@$T" GIT_COMMITTER_DATE="@$T" git merge -q --no-ff "$3" -m "$4"
}
A="Maya Chen"; AE=maya@example.dev
B="Leo Martins"; BE=leo@example.dev
C="Priya Raman"; CE=priya@example.dev
D="Sam Okafor"; DE=sam@example.dev
mkdir -p src docs
c "$A" $AE "Initial project scaffold"
c "$A" $AE "Add HTTP server with health check" src/server.ts
c "$B" $BE "Set up CI pipeline" .ci.yml
git tag v0.1.0
git checkout -q -b feature/auth
c "$C" $CE "Add session model" src/auth.ts
c "$C" $CE "Implement login endpoint" src/auth.ts
git checkout -q main
c "$D" $DE "Document local setup" docs/setup.md
git checkout -q -b fix/timeout
c "$B" $BE "Fix request timeout on slow uploads" src/server.ts
git checkout -q feature/auth
c "$C" $CE "Hash passwords with argon2" src/auth.ts
git checkout -q main
m "$A" $AE fix/timeout "Merge branch 'fix/timeout'"
c "$A" $AE "Add structured logging" src/log.ts
m "$A" $AE feature/auth "Merge pull request #12 from feature/auth"
git tag -a v0.2.0 -m "Release 0.2.0"
git checkout -q -b feature/dashboard
c "$D" $DE "Scaffold dashboard page" src/dashboard.ts
c "$D" $DE "Add usage chart to dashboard" src/dashboard.ts
git checkout -q main
git checkout -q -b feature/rate-limit
c "$B" $BE "Add token bucket rate limiter" src/limit.ts
git checkout -q main
c "$C" $CE "Bump dependencies" package.json
git checkout -q feature/dashboard
c "$D" $DE "Dashboard: dark mode support" src/dashboard.ts
git checkout -q feature/rate-limit
c "$B" $BE "Rate limiter: per-route limits" src/limit.ts
git checkout -q main
m "$A" $AE feature/rate-limit "Merge pull request #15 from feature/rate-limit"
c "$A" $AE "Improve error messages for invalid config" src/app.ts
git checkout -q feature/dashboard
c "$D" $DE "Dashboard: export CSV" src/dashboard.ts
git checkout -q main
c "$C" $CE "Add audit log for admin actions" src/audit.ts
git init -q --bare "$DIR.remote"
git remote add origin "$DIR.remote"
git push -q origin main feature/dashboard 2>/dev/null
git checkout -q -b feature/search
c "$C" $CE "Add full-text search index" src/search.ts
git checkout -q main
c "$A" $AE "Cache compiled templates" src/app.ts
git checkout -q main
echo "retry tweak" >> src/app.ts
GIT_AUTHOR_NAME="Maya Chen" GIT_AUTHOR_EMAIL=maya@example.dev GIT_COMMITTER_NAME="Maya Chen" GIT_COMMITTER_EMAIL=maya@example.dev git stash push -q -m "try smaller cache size"
echo "wip" >> src/app.ts
