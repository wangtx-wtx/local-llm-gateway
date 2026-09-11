# Security Policy

## Supported versions

Security fixes are provided for the latest release on the `main` branch.

## Reporting a vulnerability

Please do not disclose vulnerabilities in a public issue. Use GitHub's private
vulnerability reporting feature from the repository's **Security** tab. Include
the affected version, reproduction steps, impact, and any suggested mitigation.

Do not include real provider credentials, gateway API keys, databases, master
keys, request contents, or other user data in a report. Replace secrets with
clearly marked test values.

## Deployment boundary

The default loopback-only configuration is intended for local use. Before
binding to a non-loopback interface, configure both
`LOCAL_GATEWAY_API_KEY` and `LOCAL_GATEWAY_ADMIN_PASSWORD`, restrict network
access, and terminate TLS through a trusted reverse proxy.

The runtime database and `master.key` must be backed up together and must never
be committed to source control or attached to a public issue.
