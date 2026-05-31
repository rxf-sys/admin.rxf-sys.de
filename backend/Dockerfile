FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Tooling the bundled audit script (scripts/audit.sh) needs. Most of these
# are tiny and only matter when the audit runs *inside* the container —
# host-level checks like systemd or full SMART still need AUDIT_SSH_HOST
# pointing at the Proxmox host. We install what makes container-side audit
# checks meaningful (DNS lookups, TLS-cert inspection, basic process and
# net introspection).
RUN apt-get update && apt-get install -y --no-install-recommends \
        iproute2 \
        procps \
        dnsutils \
        openssl \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY app ./app
COPY tools ./tools
COPY scripts ./scripts
RUN chmod +x ./scripts/audit.sh

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
