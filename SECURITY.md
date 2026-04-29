# Security Policy

## Supported Versions

Security fixes are handled on the default branch until formal release branches exist.

## Reporting A Vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for this repository when it is enabled, or contact the maintainers privately with:

- affected version or commit;
- operating system and architecture;
- clear reproduction steps;
- expected and actual impact;
- logs with secrets and private transcript data removed.

The maintainers will acknowledge reports as soon as practical and coordinate a fix before public disclosure when appropriate.

## Security Model

SteerVox is a local macOS app. The backend binds to loopback and privileged API routes require a per-session local token issued by the Electron main process. The app can request microphone, Accessibility, and Automation permissions for dictation, paste delivery, app context, and reviewed local actions.

Sensitive local files include:

- `~/.steervox/.env_secrets`
- `~/.steervox/config.json`
- local memory and writing-tool SQLite stores
- temporary audio under `~/.steervox/temp`
- app logs under `~/.steervox/logs`

Do not include those files in bug reports unless explicitly requested and sanitized.

## Scope

In scope:

- local API authorization bypasses;
- unintended network disclosure of transcript, clipboard, selected text, screen, or local memory data;
- unsafe desktop automation or local task execution bypasses;
- packaged app signing, entitlement, or update-chain issues;
- dependency vulnerabilities with a practical app impact.

Out of scope:

- issues requiring full local machine compromise;
- attacks from malicious local users with access to the same macOS account;
- vulnerabilities only in unsupported forks or modified binaries.
