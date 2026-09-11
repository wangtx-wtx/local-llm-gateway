# Contributing

Thank you for helping improve Local LLM Gateway.

## Development setup

Requirements: Node.js 22.13 or newer. Node.js 24 is recommended.

```bash
npm ci
npm --prefix web ci
npm run verify
npm run build:all
```

Add focused regression tests for behavior changes. Keep protocol conversion at
the canonical boundary rather than adding pairwise protocol converters.

## Pull requests

- Keep each pull request focused and explain observable behavior changes.
- Run `npm run verify` and `npm run build:all` before submitting.
- Update documentation when configuration or compatibility changes.
- Never commit `.env`, `data/`, databases, master keys, real API keys, logs, or
  request traces containing user data.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.
