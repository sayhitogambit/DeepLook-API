# Security

Report suspected vulnerabilities privately to **support@getdeeplook.dev** with the affected revision, synthetic reproduction and redacted logs. Never disclose keys or private content in public issues.

This is an early self-hosted release. Keep administrator routes private, use TLS for public access, configure resource and outbound-network limits, and persist account data securely. Use operator-generated credentials, not project-owner credentials. See [credential setup](docs/credentials.md) and [deployment guidance](docs/coolify.md).

Chrome sandboxing and public-destination checks do not establish complete protection against all network or browser attacks. Keep the host and browser patched and test your deployment's isolation.
