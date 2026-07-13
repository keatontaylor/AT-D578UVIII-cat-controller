# Dependency Audit Triage

Last checked: `npm audit --omit=dev` on 2026-07-02.

## Summary

- 11 production advisories reported: 7 moderate, 2 high, 2 critical.
- Do not run blanket `npm audit fix --force` without review; it proposes breaking changes and does
  not resolve every transitive issue.

## Runtime-Relevant

- `@fastify/static@8.3.0` reports path traversal / route guard bypass advisories.
- This is runtime-relevant because production serves the built SPA through `@fastify/static`.
- Recommended action: upgrade to a fixed compatible release, or move to `@fastify/static@9` with a
  small migration pass and rerun `npm test`, `npm run typecheck`, and `npm run build`.

## Likely Optional / Install-Time Chain

- `dbus-next -> usocket -> node-gyp -> request -> form-data / qs / tough-cookie / tar / uuid`.
- `usocket` is an optional dependency of `dbus-next`; the app uses D-Bus through `dbus-next`, but the
  vulnerable `request` chain appears through optional native-build tooling rather than direct app
  request handling.
- Recommended action: verify whether production installs actually include/use `usocket`; evaluate
  `npm install --omit=optional` on the target OS; otherwise document an accepted exception or replace
  the D-Bus library if a maintained alternative is practical.

## Also Reported

- `xml2js <0.5.0` via `dbus-next` is a runtime dependency candidate and should be tracked with the
  D-Bus-library decision.

## Gate

Before production cutover, either reduce `npm audit --omit=dev` to zero actionable runtime findings
or keep an explicit allowlist with reachability notes in this file.
