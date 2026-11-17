# Customer-managed key: CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed SNS key.
resource "aws_kms_key" "alarms" {
  description         = "${local.name} alarm topic"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.alarms.arn
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    alb-5xx = {
      namespace   = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 20, period = 300
      dimensions  = { LoadBalancer = aws_lb.this.arn_suffix }
      description = "Management/SDK API returning 5xx (docs/RUNBOOK.md#api-errors)"
    }
    healthy-hosts = {
      namespace   = "AWS/ApplicationELB", metric = "HealthyHostCount", stat = "Minimum", threshold = 1, period = 60, lower = true
      dimensions  = { LoadBalancer = aws_lb.this.arn_suffix, TargetGroup = aws_lb_target_group.app.arn_suffix }
      description = "No healthy replica: SDKs keep evaluating cached flags but receive no updates (docs/RUNBOOK.md#no-replicas)"
    }
    app-cpu = {
      namespace   = "AWS/ECS", metric = "CPUUtilization", stat = "Average", threshold = 85, period = 300
      dimensions  = { ClusterName = aws_ecs_cluster.this.name, ServiceName = aws_ecs_service.app.name }
      description = "Replicas saturated even after autoscaling (docs/RUNBOOK.md#saturation)"
    }
    rds-cpu = {
      namespace   = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80, period = 300
      dimensions  = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
      description = "Database CPU high (docs/RUNBOOK.md#database)"
    }
    rds-connections = {
      namespace   = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum", threshold = 70, period = 300
      dimensions  = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
      description = "Connections close to the instance limit (pool x replicas + 1 LISTEN each) (docs/RUNBOOK.md#database)"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = contains(["Sum", "Average", "Minimum", "Maximum"], each.value.stat) ? each.value.stat : null
  extended_statistic  = contains(["Sum", "Average", "Minimum", "Maximum"], each.value.stat) ? null : each.value.stat
  period              = each.value.period
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = try(each.value.lower, false) ? "LessThanThreshold" : "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
