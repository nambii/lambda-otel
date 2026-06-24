# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

1. Preferred: GitHub **private vulnerability reporting** — on this repo, go to
   the **Security** tab → **Report a vulnerability**.
2. Alternatively, email **ebinjoshy@gmail.com** with details and, if possible, a
   minimal reproduction.

You can expect an initial acknowledgement within a few business days. Once a fix
is available it will be released and the advisory published; credit is given to
reporters who want it.

## Supported versions

This package tracks one OpenTelemetry release generation per minor line (see the
compatibility table in the README). Security fixes are applied to the latest
released minor; older lines are best-effort.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | ✅ |
| older `0.x`  | ⚠️ best-effort |

## Scope

In scope: the published package code (the handler wrapper, trigger detection,
metrics facade, and the optional in-process Telemetry API extension).

Out of scope: vulnerabilities in your OpenTelemetry Collector / backend, in AWS
Lambda itself, or in dependencies that are not reachable from this package's
runtime code paths. Dependency advisories are tracked automatically via Renovate
and `npm audit` in CI; transitive fixes can be forced through the `overrides`
block in `package.json`.
