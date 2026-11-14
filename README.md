# Capsulate GitHub Action

Run any command inside a fresh, **isolated Capsulate capsule** straight from your CI, and
(optionally) post the result back to the pull request. Great for running untrusted PRs,
reproducible test environments, or "does this repo actually build?" checks — in a throwaway
sandbox that's destroyed when the run finishes.

## Setup

1. Create a Capsulate API key (dashboard → **Settings → API & Keys**, scopes
   `capsule:create`, `capsule:read`, `capsule:exec`, `capsule:destroy`).
2. Add it as a repo secret named `CAPSULATE_API_KEY`.

## Usage

```yaml
# .github/workflows/capsulate.yml
name: Run in Capsulate
on: [pull_request]

jobs:
  sandbox:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write   # to post the result comment
    steps:
      - uses: capsulatedev/run-action@v1
        with:
          api-key: ${{ secrets.CAPSULATE_API_KEY }}
          template: ubuntu-22.04-headless
          run: |
            git clone "$REPO_URL" repo && cd repo && git checkout "$REPO_SHA"
            # ...build / test / lint inside the isolated capsule:
            if [ -f package.json ]; then npm ci && npm test; fi
```

The action launches a capsule, runs your `run` script inside it (with `$REPO_URL` and
`$REPO_SHA` available), streams stdout/stderr into the job log, posts a ✅/❌ summary comment
to the PR, and destroys the capsule. The step fails if the command's exit code is non-zero.

### Inputs
| Input | Default | Notes |
| --- | --- | --- |
| `api-key` | — (required) | `cap_live_…` |
| `run` | — (required) | Shell command(s) to run in the capsule |
| `template` | `ubuntu-22.04-headless` | OS/template to launch |
| `size` | `2c4g` | Resource size |
| `base-url` | `https://api.capsulate.dev` | API base (self-hosted: your gateway) |
| `team-id` | resolved from key | Team to bill |
| `comment` | `true` | Post the result as a PR comment |

### Outputs
`exit-code`, `session-id`.

### What the capsule's output can and cannot do

The command's output usually comes from the code under test, so the action treats it as untrusted:

- It is printed into the job log with workflow commands switched off (`::stop-commands::` with a random token), so a line such as `::error::`, `::add-mask::` or `::set-output::` in the output is plain text and cannot change the job.
- In the PR comment it sits inside a code fence longer than any run of backticks in it, so it cannot close the block and add its own links, images or mentions.
- Inputs and event fields reach the script only through environment variables, never as expressions inside the script.

Tests: `node --test integrations/github-action/test/action.test.mjs` (offline, needs bash, curl and jq).

> **Publishing:** this composite action lives in the monorepo at
> `integrations/github-action/`. To ship it to the Marketplace, push this folder to a
> dedicated repo (e.g. `capsulatedev/run-action`) and tag `v1`.
