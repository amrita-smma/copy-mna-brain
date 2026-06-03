#!/bin/bash
set -euxo pipefail

PYTHON_VERSION="${python_version}"
MLFLOW_VERSION="${mlflow_version}"
MLFLOW_WORKERS="${mlflow_workers}"
MLFLOW_PORT="${mlflow_port}"
ARTIFACT_ROOT="${artifact_root_path}"
BACKEND_STORE="${backend_store_path}"
ENABLE_TRACES="${enable_traces}"
OTLP_ENDPOINT="${otlp_endpoint}"
OTLP_HEADERS="${otlp_headers}"
OTLP_PROTOCOL="${otlp_protocol}"

LOG="/var/log/mlflow-setup.log"
exec > >(tee -a "$LOG") 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  git \
  jq \
  python3-pip \
  python3.11 \
  python3.11-dev \
  python3.11-venv \
  software-properties-common

if [ "$PYTHON_VERSION" = "3.11" ]; then
  update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1
fi

mkdir -p /opt/mlflow "$ARTIFACT_ROOT" "$(dirname "$BACKEND_STORE")" /var/log/mlflow
python3 -m venv /opt/mlflow/venv
source /opt/mlflow/venv/bin/activate
pip install --upgrade pip setuptools wheel

if [ -n "$MLFLOW_VERSION" ]; then
  pip install "mlflow==$${MLFLOW_VERSION}"
else
  pip install mlflow
fi

pip install boto3 anthropic langgraph langchain-openai langchain-core
mlflow --version
deactivate

if ! id -u mlflow >/dev/null 2>&1; then
  useradd -r -s /bin/bash -d /opt/mlflow mlflow
fi
chown -R mlflow:mlflow /opt/mlflow /var/log/mlflow

cat >/etc/systemd/system/mlflow-server.service <<EOF
[Unit]
Description=MLflow Tracking Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=mlflow
Group=mlflow
WorkingDirectory=/opt/mlflow
Environment="PATH=/opt/mlflow/venv/bin:/usr/local/bin:/usr/bin:/bin"
Environment="MLFLOW_SERVE_TRACES=true"
Environment="OTEL_EXPORTER_OTLP_ENDPOINT=$${OTLP_ENDPOINT}"
Environment="OTEL_EXPORTER_OTLP_HEADERS=$${OTLP_HEADERS}"
Environment="OTEL_EXPORTER_OTLP_PROTOCOL=$${OTLP_PROTOCOL}"
ExecStart=/opt/mlflow/venv/bin/mlflow server \
  --backend-store-uri sqlite:///$${BACKEND_STORE} \
  --default-artifact-root $${ARTIFACT_ROOT} \
  --workers $${MLFLOW_WORKERS} \
  --host 0.0.0.0 \
  --port $${MLFLOW_PORT} \
  --serve-artifacts
Restart=always
RestartSec=10
TimeoutStartSec=180
StandardOutput=append:/var/log/mlflow/server.log
StandardError=append:/var/log/mlflow/server.log
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/mlflow /var/log/mlflow

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mlflow-server
systemctl start mlflow-server

for i in {1..60}; do
  if systemctl is-active mlflow-server >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$MLFLOW_PORT/" >/dev/null 2>&1; then
    echo "MLflow is ready on localhost:$MLFLOW_PORT"
    exit 0
  fi
  sleep 2
done

echo "ERROR: MLflow is not reachable on localhost:$MLFLOW_PORT"
systemctl status mlflow-server --no-pager || true
exit 1
