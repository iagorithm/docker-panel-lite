FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache
COPY services/logs-agent/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/logs-agent/src ./src
RUN addgroup --system --gid 10001 agent && adduser --system --uid 10001 --ingroup agent agent && mkdir -p /data && chown agent:agent /data
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]
CMD ["uvicorn", "src.api:app", "--host", "0.0.0.0", "--port", "8000", "--limit-concurrency", "16", "--timeout-keep-alive", "5", "--no-server-header"]
