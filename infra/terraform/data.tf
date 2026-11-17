resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = module.vpc.private_subnets
}

# Flagship's only stateful dependency: flags, configs, audit log, and LISTEN/NOTIFY fan-out.
resource "aws_db_instance" "postgres" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = "17"
  instance_class               = var.db_instance_class
  allocated_storage            = 20
  max_allocated_storage        = 100
  storage_encrypted            = true
  db_name                      = "flagship"
  username                     = "flagship"
  password                     = random_password.db.result
  db_subnet_group_name         = aws_db_subnet_group.this.name
  vpc_security_group_ids       = [aws_security_group.data.id]
  multi_az                     = var.db_multi_az
  backup_retention_period      = 7
  deletion_protection          = var.environment == "production"
  skip_final_snapshot          = var.environment != "production"
  final_snapshot_identifier    = "${local.name}-final"
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
}
