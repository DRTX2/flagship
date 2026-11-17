resource "random_password" "admin_token" {
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    # uselibpqcompat+require = TLS without CA pinning inside the VPC (pending: verify-full with the RDS CA bundle)
    DATABASE_URL = "postgres://${aws_db_instance.postgres.username}:${random_password.db.result}@${aws_db_instance.postgres.address}:5432/flagship?sslmode=require&uselibpqcompat=true"
    ADMIN_TOKEN  = random_password.admin_token.result
  })
}
