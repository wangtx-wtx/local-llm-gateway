# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Documentation

- Clarified that the protocol layer implements a 3 × 3 compatibility matrix but only the
  chat-native upstream row currently has equivalent end-to-end verification.
- Documented that cross-protocol conversion is not lossless for provider-specific features.

## [1.0.2] - 2026-09-11

### Changed

- Made the portable ZIP instructions, repository quick-start text, detailed guide, and
  release notes bilingual in Chinese and English.

## [1.0.1] - 2026-09-11

### Added

- Windows x64 portable ZIP with a bundled, checksum-verified Node.js runtime.
- One-click start, stop, and dashboard launchers in Chinese and English.
- Portable-edition documentation covering setup, backups, upgrades, and security.
- Packaging safeguards that reject runtime secrets and generate a SHA-256 file.

## [1.0.0] - 2026-09-11

### Added

- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages endpoints.
- Canonical request, response, and streaming protocol conversion.
- Dynamic provider, model, alias, fallback, and API-key management.
- API-key rotation, retry, fallback, circuit breaking, timeouts, and concurrency controls.
- SQLite-backed logical-request and upstream-attempt usage ledgers.
- React dashboard, Prometheus metrics, request traces, and health endpoints.
- Security controls for secret encryption, authentication, SSRF protection, and safe networking defaults.
- Unit, integration, compatibility, security, and acceptance verification suites.

[1.0.0]: https://github.com/wangtx-wtx/local-llm-gateway/releases/tag/v1.0.0
[1.0.1]: https://github.com/wangtx-wtx/local-llm-gateway/releases/tag/v1.0.1
[1.0.2]: https://github.com/wangtx-wtx/local-llm-gateway/releases/tag/v1.0.2
