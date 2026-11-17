resource "aws_lb" "this" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = module.vpc.public_subnets
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  idle_timeout               = 120 # SDK streams send a heartbeat every 25s
}

resource "aws_lb_target_group" "app" {
  name                 = local.name
  port                 = 4000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.vpc.vpc_id
  deregistration_delay = 30 # SDKs reconnect to another replica and receive a full `put`
  health_check {
    path    = "/health"
    matcher = "200"
  }
}

locals {
  https        = var.certificate_arn != ""
  listener_arn = local.https ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = local.https ? "redirect" : "forward"
    dynamic "redirect" {
      for_each = local.https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
    target_group_arn = local.https ? null : aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "https" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# Prometheus metrics stay internal.
resource "aws_lb_listener_rule" "block_metrics" {
  listener_arn = local.listener_arn
  priority     = 5
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
    }
  }
  condition {
    path_pattern { values = ["/metrics"] }
  }
}
