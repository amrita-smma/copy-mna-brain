output "mlflow_server_instance_id" {
  description = "ID of the MLflow server EC2 instance"
  value       = aws_instance.mlflow_server.id
}

output "mlflow_server_instance_arn" {
  description = "ARN of the MLflow server EC2 instance"
  value       = aws_instance.mlflow_server.arn
}

output "mlflow_server_private_ip" {
  description = "Private IP address of the MLflow server"
  value       = aws_instance.mlflow_server.private_ip
}

output "mlflow_server_security_group_id" {
  description = "ID of the MLflow server security group"
  value       = aws_security_group.mlflow_server.id
}

output "ssm_connect_command" {
  description = "Command to connect to MLflow server via SSM"
  value       = "aws ssm start-session --target ${aws_instance.mlflow_server.id} --region ${var.aws_region}"
}

output "ssm_port_forward_command" {
  description = "Command to setup port forwarding for MLflow UI (local port 5001 → remote port 5000)"
  value       = "aws ssm start-session --target ${aws_instance.mlflow_server.id} --region ${var.aws_region} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '{\"host\":[\"127.0.0.1\"],\"portNumber\":[\"${var.mlflow_port}\"],\"localPortNumber\":[\"5001\"]}'"
}

output "mlflow_ui_url" {
  description = "Local URL to access MLflow UI after port forwarding"
  value       = "http://localhost:5001"
}

output "mlflow_tracking_uri" {
  description = "MLflow tracking URI using the server's private IP (for apps inside the same VPC)"
  value       = "http://${aws_instance.mlflow_server.private_ip}:${var.mlflow_port}"
}

output "otel_exporter_otlp_traces_endpoint" {
  description = "OTLP traces endpoint for OpenTelemetry exporters (for apps inside the same VPC)"
  value       = "http://${aws_instance.mlflow_server.private_ip}:${var.mlflow_port}/v1/traces"
}

output "ssm_check_service_command" {
  description = "Command to check MLflow service status (via SSM shell)"
  value       = "aws ssm start-session --target ${aws_instance.mlflow_server.id} --region ${var.aws_region} && sudo systemctl status mlflow-server && sudo journalctl -u mlflow-server -n 50"
}
