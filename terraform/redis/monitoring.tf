# Health checks, CloudWatch alarms and a dashboard for the Redis box.
#
# EC2 only reports CPU, network and status checks, so a probe on the instance
# (templates/health_probe.sh.tftpl) publishes the rest every minute to the
# MnA/Redis namespace: whether Redis answers INFO, memory against maxmemory,
# clients, container restarts, host memory and disk.
#
# The probe is installed by an SSM association rather than user_data, so
# editing it re-runs the association on the live box instead of replacing it.
#
# Alarms publish to the data pipeline's alerts topic (mna-<env>-pipeline-alerts,
# data-pipeline/terraform/pipeline-compute), which AWS Chatbot already forwards
# to the environment's #mna-brain-alerts-* Slack channel. Apply pipeline-compute
# first.

locals {
  metrics_namespace = "MnA/Redis"
  alerts_topic_name = "mna-${local.environment}-pipeline-alerts"
  dashboard_name    = local.name_prefix

  health_probe = templatefile("${path.module}/templates/health_probe.sh.tftpl", {
    aws_region  = var.aws_region
    namespace   = local.metrics_namespace
    environment = local.environment
  })
  # Run by the SSM association: writes the probe and its systemd timer.
  health_probe_install = templatefile("${path.module}/templates/health_probe_install.sh.tftpl", {
    probe = local.health_probe
  })

  probe_dimensions    = { Environment = local.environment }
  instance_dimensions = { InstanceId = aws_instance.redis.id }

  # Every alarm sends both ALARM and OK to Slack, like the pipeline Lambda alarms.
  alarms = {
    down = {
      description = "Redis is not answering INFO over TLS (or the box stopped reporting). The app's presence, stop signals and live updates are down. Check `make redis-host`."
      namespace   = local.metrics_namespace
      metric      = "RedisUp"
      dimensions  = local.probe_dimensions
      statistic   = "Minimum"
      period      = 60
      evaluations = 3
      threshold   = 1
      comparison  = "LessThanThreshold"
      # No data at all means the probe (or the whole box) is gone: that is down.
      missing = "breaching"
    }
    restarted = {
      description = "The Redis container crashed and Docker restarted it. The store is empty after a restart. Check `docker logs redis-redis-1` via `make redis-shell`."
      namespace   = local.metrics_namespace
      metric      = "ContainerRestarts"
      dimensions  = local.probe_dimensions
      statistic   = "Sum"
      period      = 300
      evaluations = 1
      threshold   = 1
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
    memory-near-max = {
      description = "Redis memory is above ${var.alarm_redis_memory_percent}% of maxmemory (${var.redis_maxmemory}). With noeviction, writes fail once it is full. Inspect with `make redis-memkeys`, then raise redis_maxmemory."
      namespace   = local.metrics_namespace
      metric      = "UsedMemoryPercentOfMax"
      dimensions  = local.probe_dimensions
      statistic   = "Maximum"
      period      = 60
      evaluations = 5
      threshold   = var.alarm_redis_memory_percent
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
    host-memory-high = {
      description = "Redis host memory is above ${var.alarm_host_memory_percent}% for 5 minutes. Check `make redis-host`."
      namespace   = local.metrics_namespace
      metric      = "HostMemoryUsedPercent"
      dimensions  = local.probe_dimensions
      statistic   = "Average"
      period      = 60
      evaluations = 5
      threshold   = var.alarm_host_memory_percent
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
    disk-high = {
      description = "Redis host root disk is above ${var.alarm_disk_percent}% (container logs and images live here). Check `make redis-host`."
      namespace   = local.metrics_namespace
      metric      = "DiskUsedPercent"
      dimensions  = local.probe_dimensions
      statistic   = "Maximum"
      period      = 300
      evaluations = 1
      threshold   = var.alarm_disk_percent
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
    status-check-failed = {
      description = "EC2 status check failed on the Redis instance (hardware, network or OS). AWS may need a stop/start to move it to healthy hardware."
      namespace   = "AWS/EC2"
      metric      = "StatusCheckFailed"
      dimensions  = local.instance_dimensions
      statistic   = "Maximum"
      period      = 60
      evaluations = 2
      threshold   = 1
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
    cpu-high = {
      description = "Redis host CPU is above ${var.alarm_cpu_percent}% for 15 minutes. Check `make redis-slowlog` and `make redis-commands`."
      namespace   = "AWS/EC2"
      metric      = "CPUUtilization"
      dimensions  = local.instance_dimensions
      statistic   = "Average"
      period      = 300
      evaluations = 3
      threshold   = var.alarm_cpu_percent
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
  }
}

data "aws_sns_topic" "alerts" {
  name = local.alerts_topic_name
}

# ------------------------------------------------------------------- probe ---

# Additive grant on the existing role: does not touch the instance. Scoped to
# this namespace so the box cannot write into anyone else's metrics.
data "aws_iam_policy_document" "put_metrics" {
  statement {
    sid       = "PublishHealthMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.metrics_namespace]
    }
  }
}

resource "aws_iam_role_policy" "put_metrics" {
  name_prefix = "${local.name_prefix}-metrics-"
  role        = aws_iam_role.instance.id
  policy      = data.aws_iam_policy_document.put_metrics.json
}

# Re-runs whenever the script below changes or the instance is replaced.
# Output and failures: Systems Manager > State Manager > this association.
resource "aws_ssm_association" "health_probe" {
  name             = "AWS-RunShellScript"
  association_name = "${local.name_prefix}-health-probe"

  targets {
    key    = "InstanceIds"
    values = [aws_instance.redis.id]
  }

  parameters = {
    commands = local.health_probe_install
  }

  # The probe needs PutMetricData on its first run above.
  depends_on = [
    aws_iam_role_policy.put_metrics,
    aws_iam_role_policy_attachment.ssm_core,
  ]
}

# ------------------------------------------------------------------ alarms ---

resource "aws_cloudwatch_metric_alarm" "redis" {
  for_each = local.alarms

  alarm_name          = "${local.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluations
  datapoints_to_alarm = each.value.evaluations
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = each.value.missing

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]

  tags = local.environment_tags
}

# --------------------------------------------------------------- dashboard ---

resource "aws_cloudwatch_dashboard" "redis" {
  dashboard_name = local.dashboard_name

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 2
        properties = {
          markdown = "## Redis (${local.environment})\nTLS Redis on EC2 (`terraform/redis`). Probe metrics arrive every minute from `redis-health-probe.timer`; alarms post to the #mna-brain-alerts-${local.environment} Slack channel. For a live look, `make redis-health` from `terraform/redis`."
        }
      },
      {
        type   = "alarm"
        x      = 0
        y      = 2
        width  = 24
        height = 3
        properties = {
          title  = "Alarms"
          alarms = [for a in aws_cloudwatch_metric_alarm.redis : a.arn]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 5
        width  = 8
        height = 6
        properties = {
          title   = "Redis up (1 = answering INFO)"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stat    = "Minimum"
          metrics = [[local.metrics_namespace, "RedisUp", "Environment", local.environment]]
          yAxis   = { left = { min = 0, max = 1 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 5
        width  = 8
        height = 6
        properties = {
          title   = "Memory % of maxmemory (${var.redis_maxmemory})"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stat    = "Maximum"
          metrics = [[local.metrics_namespace, "UsedMemoryPercentOfMax", "Environment", local.environment]]
          yAxis   = { left = { min = 0, max = 100 } }
          annotations = {
            horizontal = [{ label = "alarm", value = var.alarm_redis_memory_percent }]
          }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 5
        width  = 8
        height = 6
        properties = {
          title  = "Clients and container restarts"
          region = var.aws_region
          view   = "timeSeries"
          period = 60
          metrics = [
            [local.metrics_namespace, "ConnectedClients", "Environment", local.environment, { stat = "Average", label = "connected clients" }],
            [local.metrics_namespace, "ContainerRestarts", "Environment", local.environment, { stat = "Sum", label = "restarts", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 11
        width  = 8
        height = 6
        properties = {
          title  = "Host memory and disk %"
          region = var.aws_region
          view   = "timeSeries"
          period = 60
          metrics = [
            [local.metrics_namespace, "HostMemoryUsedPercent", "Environment", local.environment, { stat = "Average", label = "memory" }],
            [local.metrics_namespace, "DiskUsedPercent", "Environment", local.environment, { stat = "Maximum", label = "disk /" }],
          ]
          yAxis = { left = { min = 0, max = 100 } }
          annotations = {
            horizontal = [
              { label = "memory alarm", value = var.alarm_host_memory_percent },
              { label = "disk alarm", value = var.alarm_disk_percent },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 11
        width  = 8
        height = 6
        properties = {
          title   = "CPU %"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 300
          stat    = "Average"
          metrics = [["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.redis.id]]
          yAxis   = { left = { min = 0, max = 100 } }
          annotations = {
            horizontal = [{ label = "alarm", value = var.alarm_cpu_percent }]
          }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 11
        width  = 8
        height = 6
        properties = {
          title  = "Network and status checks"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/EC2", "NetworkIn", "InstanceId", aws_instance.redis.id, { stat = "Sum", label = "bytes in" }],
            ["AWS/EC2", "NetworkOut", "InstanceId", aws_instance.redis.id, { stat = "Sum", label = "bytes out" }],
            ["AWS/EC2", "StatusCheckFailed", "InstanceId", aws_instance.redis.id, { stat = "Maximum", label = "status check failed", yAxis = "right" }],
          ]
        }
      },
    ]
  })
}
