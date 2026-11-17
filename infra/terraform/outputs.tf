output "url" {
  value = "${local.https ? "https" : "http"}://${aws_lb.this.dns_name}"
}

output "ecr_repository" {
  value = aws_ecr_repository.app["app"].repository_url
}

output "github_ecr_role_arn" {
  value = aws_iam_role.github_ecr.arn
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}

output "admin_token_secret" {
  value       = aws_secretsmanager_secret.app.name
  description = "ADMIN_TOKEN for the dashboard login lives in this secret."
}
