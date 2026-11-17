# Deployment (AWS · Terraform · GitHub Actions)

> Status: Terraform passes `fmt`/`validate`, workflows pass `actionlint`, and the image passes the Trivy image scan. **Not yet applied to a real AWS account.**

## Topology
ALB (public, HTTP→HTTPS when a cert is set, `/metrics` blocked) → ECS Fargate service `flagship` (2–6 tasks, private subnets) → RDS PostgreSQL 17 (Multi-AZ, encrypted, 7-day PITR). Secrets Manager injects `DATABASE_URL` and `ADMIN_TOKEN`. CloudWatch alarms → SNS (KMS CMK). Images live in ECR (immutable tags, scan on push).

| File | Contents |
|---|---|
| `network.tf` | VPC (2 AZ), NAT, security groups. App egress limited to 443 + Postgres |
| `data.tf` | RDS PostgreSQL |
| `secrets.tf` | Generated DB password, admin token, connection string |
| `alb.tf` | ALB (idle timeout 120 s for streams), target group, listeners, `/metrics` 404 rule |
| `ecs.tf` | Cluster, task definition, service with deployment circuit breaker + rollback, CPU autoscaling |
| `iam.tf` | Execution/task roles, GitHub OIDC with separate ECR-push and deploy roles |
| `alarms.tf` | 5xx, healthy hosts, CPU, RDS CPU/connections |

## First deploy
1. Create the S3 state bucket, then `cp infra/terraform/backend.hcl.example infra/terraform/backend.hcl`.
2. Bootstrap from a laptop:
   ```bash
   cd infra/terraform && terraform init -backend-config=backend.hcl
   terraform apply -var-file=envs/production.tfvars -var image_tag=bootstrap -target=aws_ecr_repository.app -target=aws_iam_role.github_ecr -target=aws_iam_role.github_deploy
   docker build -t <ecr>/flagship:bootstrap . && docker push <ecr>/flagship:bootstrap
   terraform apply -var-file=envs/production.tfvars -var image_tag=bootstrap
   ```
3. GitHub: variables `AWS_REGION`, `AWS_ECR_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN`. Environment `production` with required reviewers.
4. Read the admin token from the `flagship-production/app` secret and log in to the dashboard.
5. HTTPS: set `certificate_arn`, apply.

## Pipeline
PR → CI (lint, typecheck, coverage gates, integration on 2 replicas, Playwright, Trivy, gitleaks, Sonar, terraform validate) → merge → Deploy builds the image tagged with the git sha (ECR role) → **manual approval** → `terraform apply` with that tag (deploy role) → wait for stable → `/health` smoke test.

## Rollback
The ECS circuit breaker rolls back failed deployments automatically. Manually, redeploy the previous sha via `workflow_dispatch`. Data: RDS point-in-time restore. Migrations are additive and forward-only. Use expand/contract for breaking schema changes.

## Operational notes
- **Connections**: each task uses up to 10 pool connections + 1 LISTEN. With 6 tasks that's ~66. db.t4g.micro allows ~80, which is why there's an alarm at 70. Scale the instance class before raising `app_max`.
- **Deploys drop SDK streams**: SDKs reconnect with jittered backoff and receive a full `put`, and evaluation continues from memory meanwhile.

## Cost (us-east-1, rough monthly)
| Item | Production | Minimal |
|---|---|---|
| NAT gateways | 2 × ~$33 | 1 × ~$33 |
| ALB | ~$20 | ~$20 |
| Fargate 2 × (0.5 vCPU, 1 GB) | ~$36 | ~$18 (1 task) |
| RDS db.t4g.micro (Multi-AZ / single) | ~$30 | ~$15 |
| CloudWatch, Secrets, ECR, KMS | ~$8 | ~$5 |
| **Total** | **≈ $160** | **≈ $90** |

Biggest saving: VPC interface endpoints instead of NAT for ECR/Logs/Secrets (also closes the accepted egress risk).
