# Security

## Assets
Admin access (who can change production behaviour) · SDK keys · targeting data (may include emails, customer ids) · integrity of flag configs · audit trail.

## Threat model (condensed)
| Threat | Mitigation | Status |
|---|---|---|
| Unauthorized flag change (kill switch abuse) | Admin token, constant-time compare. Every change audited with actor and before/after | 🟡 shared token; SSO + roles pending |
| Spoofed actor in audit log | `x-actor` is self-declared today | ⬜ fixed by SSO (identity from the IdP) |
| SDK key leak | Keys scoped to one environment, SHA-256 at rest, shown once, instant rotation | ✅ |
| Lost update during incidents | Optimistic concurrency → 409 | ✅ |
| Malicious/malformed config breaking SDKs | zod at the boundary + `validateFlag` before every write. The engine falls back on malformed flags | ✅ |
| XSS in the dashboard | Angular escaping + strict CSP (`script-src 'self'`), helmet headers | ✅ |
| ReDoS via targeting | No regex operator on purpose. Only bounded string/number/semver comparisons | ✅ |
| DoS on management API | Body cap 256 KB, list limits | 🟡 no rate limit yet |
| Data exposure via SDK | Server SDKs receive full rules (they hold secret keys). Browser SDKs must not (see ADR-0001) | ✅ documented |

## OWASP API Top 10 (2023)
| Risk | Status |
|---|---|
| API1 BOLA | Environment derived from the SDK key, never from client input |
| API2 Broken authentication | Hashed SDK keys. Admin token compare is constant-time. SSO pending |
| API3 Property-level authorization | SDK payloads contain only evaluation fields (key, variations, rules, salt, version) |
| API4 Resource consumption | Body cap, bounded arrays in zod (≤100 rules, ≤20 clauses, ≤500 values). Rate limiting pending |
| API5 Function-level authorization | `/api` = admin, `/sdk` = SDK key, separate guards |
| API7 SSRF | No outbound calls driven by user input |
| API8 Misconfiguration | CSP/helmet, `/metrics` blocked at the ALB, private subnets, encrypted RDS, Trivy IaC + image scans |
| API9 Inventory | Two versioned surfaces (`/api`, `/sdk/v1`) |

## Supply chain
Frozen lockfile. Trivy (deps, secrets, IaC, image) fails CI on HIGH/CRITICAL. CodeQL `security-extended`. gitleaks. The runtime image drops npm/corepack/yarn and patches OS packages. It runs as non-root. GitHub → AWS via OIDC with branch/environment-pinned roles.

## Accepted risks (`.trivyignore`)
Public ALB (product entry point) · HTTP listener only without a certificate · egress 443 to AWS services through NAT (plan: VPC endpoints).

## Pending hardening
1. SSO (OIDC) with roles: viewer / editor / production-approver, actor taken from the token.
2. Per-environment permissions and change approval for production (four-eyes).
3. Rate limiting on `/api` and SDK connection limits per key.
4. RDS TLS verify-full with the CA bundle (today `sslmode=require` + libpq compat).
5. PII guidance: prefer hashed identifiers in targeting values, plus a warning in the UI when values look like emails.
