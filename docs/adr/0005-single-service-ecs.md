# ADR-0005: One service on ECS Fargate (API serves the dashboard)

- Status: accepted

## Context
The dashboard is a static Angular build; the API holds long-lived SSE connections.

## Decision
Ship one image: NestJS serves `/api`, `/sdk` and the static dashboard (SPA fallback), on ECS Fargate behind an ALB with idle timeout 120 s (heartbeat every 25 s). Lambda doesn't fit long-lived streams; EKS is overhead for one service.

## Consequences
- Same origin: no CORS, a strict CSP, one deploy.
- If the dashboard needs a CDN or independent releases, move it to S3 + CloudFront (ROADMAP). The API doesn't change.
- Scale-in drops streams; SDKs reconnect to another replica and get a full `put`. Scale-in cooldown is 300 s to avoid flapping.
