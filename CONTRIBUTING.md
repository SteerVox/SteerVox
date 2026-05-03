# Contributing

Thanks for helping improve SteerVox. This project is a macOS desktop app with a Python backend, Electron main process, React renderer, and small native Swift helpers.

## Before You Start

- Read [LICENSE.md](LICENSE.md). Contributions are accepted under the project license.
- Use a macOS machine for full app testing. Packaging currently targets Apple Silicon.
- Keep changes scoped. Avoid unrelated refactors in the same pull request.
- Do not commit local data, secrets, generated app bundles, screenshots with private data, or files from `Docs/` or `strategy/`.

## Local Setup

```bash
./scripts/setup-dev.sh
cd frontend
npm run dev
```

## Verification

Run the full development gate before opening a pull request:

```bash
./scripts/verify-dev.sh
```

Useful focused checks:

```bash
backend/.venv/bin/python3 -m pytest backend/tests -q
cd frontend && npm run lint && ./node_modules/.bin/tsc -b && npm test
```

## Pull Request Guidelines

- Explain the user-facing behavior changed.
- Include tests for new logic and regressions.
- Update README or in-app copy when setup, permissions, providers, or release behavior changes.
- Call out privacy, security, automation, and local-file-access implications.
- Keep generated files out of commits unless the file is intentionally source-controlled.

## Code Style

- Backend: prefer small functions, typed Pydantic models for API payloads, explicit error handling, and local-first privacy defaults.
- Frontend: keep shared helpers outside React component modules, keep IPC contracts typed, and avoid exposing broad main-process capabilities to renderer code.
- Native helpers: keep Swift helpers narrow, deterministic, and covered by the existing launch/build scripts.
