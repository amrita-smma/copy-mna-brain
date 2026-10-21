# Health checks, CloudWatch alarms and a dashboard for the Neo4j server.
#
# EC2 only reports CPU, network and status checks, so a probe on the instance
# (templates/health_probe.sh.tftpl) publishes the rest every minute to the MnA/Neo4j
# namespace: whether Neo4j answers HTTP, service restarts, the last backup's
# result, host memory and disk.
#
# The probe is installed by an SSM association, NOT user_data: this module sets
# user_data_replace_on_change and the database lives on the root volume, so a
# user_data edit would destroy the graph. Everything here is additive to the
# running instance — see "Preserving existing data across an apply" in README.md.
#
# Alarms publish to the data pipeline's alerts topic (mna-<env>-pipeline-alerts,
# data-pipeline/terraform/pipeline-compute), which AWS Chatbot already forwards
# to the environment's #mna-brain-alerts-* Slack channel. Apply pipeline-compute
# first.

locals {
  environment       = local.current_config.environment
  name_prefix       = "${local.environment}-mna-neo4j-server"
  metrics_namespace = "MnA/Neo4j"
  alerts_topic_name = "mna-${local.environment}-pipeline-alerts"
  dashboard_name    = "mna-${local.environment}-neo4j"

  health_probe = templatefile("${path.module}/templates/health_probe.sh.tftpl", {
    aws_region  = var.aws_region
    namespace   = local.metrics_namespace
    environment = local.environment
    http_port   = var.neo4j_http_port
  })
  # Run by the SSM association: writes the probe and its systemd timer.
  health_probe_install = templatefile("${path.module}/templates/health_probe_install.sh.tftpl", {
    probe = local.health_probe
  })

  probe_dimensions    = { Environment = local.environment }
  instance_dimensions = { InstanceId = aws_instance.neo4j_server.id }

  # Every alarm sends both ALARM and OK to Slack, like the pipeline Lambda alarms.
  alarms = {
    down = {
      description = "Neo4j is not answering HTTP on :${var.neo4j_http_port} (or the box stopped reporting). Graph features are down. Check `journalctl -u neo4j` over SSM."
      namespace   = local.metrics_namespace
      metric      = "Neo4jUp"
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
      description = "Neo4j crashed and systemd restarted it (often the OOM killer). Check `journalctl -u neo4j` and `dmesg | grep -i oom` over SSM."
      namespace   = local.metrics_namespace
      metric      = "ServiceRestarts"
      dimensions  = local.probe_dimensions
      statistic   = "Sum"
      period      = 300
      evaluations = 1
      threshold   = 1
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
    backup-failed = {
      description = "The last scheduled Neo4j backup to S3 failed. Check `journalctl -u neo4j-backup.service` over SSM; stays in ALARM until a backup succeeds."
      namespace   = local.metrics_namespace
      metric      = "BackupFailed"
      dimensions  = local.probe_dimensions
      statistic   = "Maximum"
      period      = 300
      evaluations = 1
      threshold   = 1
      comparison  = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
    }
    host-memory-high = {
      description = "Neo4j host memory is above ${var.alarm_host_memory_percent}% for 5 minutes; the JVM is at risk from the OOM killer. Check heap/page-cache settings in /etc/neo4j/neo4j.conf, or raise instance_type."
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
      description = "Neo4j root disk is above ${var.alarm_disk_percent}%. It holds the database and the temporary backup dump; a full disk stops writes and backups. Raise ebs_volume_size."
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
      description = "EC2 status check failed on the Neo4j instance (hardware, network or OS). Take a backup before any stop/start: the data is on the root volume."
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
      description = "Neo4j host CPU is above ${var.alarm_cpu_percent}% for 15 minutes. Look for long-running queries with `SHOW TRANSACTIONS` in cypher-shell."
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

# Separate policy, like neo4j_backups: additive and applies to the running
# instance without replacement. Scoped to this namespace.
resource "aws_iam_role_policy" "neo4j_metrics" {
  name = "${local.environment}-mna-neo4j-metrics-policy"
  role = aws_iam_role.neo4j_server.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublishHealthMetrics"
        Effect    = "Allow"
        Action    = "cloudwatch:PutMetricData"
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = local.metrics_namespace } }
      }
    ]
  })
}

# Re-runs whenever the probe changes or the instance is replaced. Needs the SSM
# agent registered (aws_iam_role_policy_attachment.neo4j_ssm).
# Output and failures: Systems Manager > State Manager > this association.
resource "aws_ssm_association" "health_probe" {
  name             = "AWS-RunShellScript"
  association_name = "${local.name_prefix}-health-probe"

  targets {
    key    = "InstanceIds"
    values = [aws_instance.neo4j_server.id]
  }

  parameters = {
    commands = local.health_probe_install
  }

  # The probe needs PutMetricData on its first run.
  depends_on = [
    aws_iam_role_policy.neo4j_metrics,
    aws_iam_role_policy_attachment.neo4j_ssm,
  ]
}

# ------------------------------------------------------------------ alarms ---

resource "aws_cloudwatch_metric_alarm" "neo4j" {
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

resource "aws_cloudwatch_dashboard" "neo4j" {
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
          markdown = "## Neo4j (${local.environment})\nNeo4j Community on EC2 (`terraform/ec2/neo4j`). Probe metrics arrive every minute from `neo4j-health-probe.timer`; alarms post to the #mna-brain-alerts-${local.environment} Slack channel. The nightly offline backup stops Neo4j: that window shows as *backup in progress*, not down."
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
          alarms = [for a in aws_cloudwatch_metric_alarm.neo4j : a.arn]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 5
        width  = 8
        height = 6
        properties = {
          title  = "Neo4j up (1 = answering HTTP)"
          region = var.aws_region
          view   = "timeSeries"
          period = 60
          metrics = [
            [local.metrics_namespace, "Neo4jUp", "Environment", local.environment, { stat = "Minimum", label = "up" }],
            [local.metrics_namespace, "BackupInProgress", "Environment", local.environment, { stat = "Maximum", label = "backup in progress" }],
          ]
          yAxis = { left = { min = 0, max = 1 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 5
        width  = 8
        height = 6
        properties = {
          title  = "Restarts and backup failures"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            [local.metrics_namespace, "ServiceRestarts", "Environment", local.environment, { stat = "Sum", label = "restarts" }],
            [local.metrics_namespace, "BackupFailed", "Environment", local.environment, { stat = "Maximum", label = "last backup failed" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 5
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
        x      = 0
        y      = 11
        width  = 12
        height = 6
        properties = {
          title   = "CPU %"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 300
          stat    = "Average"
          metrics = [["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.neo4j_server.id]]
          yAxis   = { left = { min = 0, max = 100 } }
          annotations = {
            horizontal = [{ label = "alarm", value = var.alarm_cpu_percent }]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 11
        width  = 12
        height = 6
        properties = {
          title  = "Network and status checks"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/EC2", "NetworkIn", "InstanceId", aws_instance.neo4j_server.id, { stat = "Sum", label = "bytes in" }],
            ["AWS/EC2", "NetworkOut", "InstanceId", aws_instance.neo4j_server.id, { stat = "Sum", label = "bytes out" }],
            ["AWS/EC2", "StatusCheckFailed", "InstanceId", aws_instance.neo4j_server.id, { stat = "Maximum", label = "status check failed", yAxis = "right" }],
          ]
        }
      },
    ]
  })
}
