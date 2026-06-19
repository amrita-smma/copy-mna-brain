output "neo4j_server_instance_id" {
  description = "ID of the Neo4j server EC2 instance"
  value       = aws_instance.neo4j_server.id
}

output "neo4j_server_instance_arn" {
  description = "ARN of the Neo4j server EC2 instance"
  value       = aws_instance.neo4j_server.arn
}

output "neo4j_ip_address" {
  description = "Public IP address of the Neo4j server"
  value       = aws_instance.neo4j_server.public_ip
}

output "neo4j_username" {
  description = "Neo4j admin username"
  value       = var.neo4j_username
}

output "neo4j_password" {
  description = "Neo4j admin password. View it with: terraform output -raw neo4j_password"
  value       = random_password.neo4j.result
  sensitive   = true
}

output "neo4j_server_security_group_id" {
  description = "ID of the Neo4j server security group"
  value       = aws_security_group.neo4j_server.id
}

output "neo4j_bolt_uri" {
  description = "Bolt connection URI for Neo4j drivers"
  value       = "bolt://${aws_instance.neo4j_server.public_ip}:${var.neo4j_bolt_port}"
}

output "neo4j_browser_url" {
  description = "Neo4j browser URL on the server's public IP"
  value       = "http://${aws_instance.neo4j_server.public_ip}:${var.neo4j_http_port}"
}

output "neo4j_credentials_summary" {
  description = "Human-readable connection summary. Password is shown via: terraform output neo4j_credentials_summary"
  sensitive   = true
  value = {
    ip_address = aws_instance.neo4j_server.public_ip
    username   = var.neo4j_username
    password   = random_password.neo4j.result
    bolt_uri   = "bolt://${aws_instance.neo4j_server.public_ip}:${var.neo4j_bolt_port}"
    browser    = "http://${aws_instance.neo4j_server.public_ip}:${var.neo4j_http_port}"
  }
}
