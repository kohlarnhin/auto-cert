FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV AUTOCERT_UID=10001
ENV AUTOCERT_GID=10001

WORKDIR /app

COPY requirements.txt /app/backend/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r /app/backend/requirements.txt

COPY . /app/backend

RUN mkdir -p /app/logs /app/static \
    && groupadd --gid "${AUTOCERT_GID}" autocert \
    && useradd --uid "${AUTOCERT_UID}" --gid "${AUTOCERT_GID}" --create-home --shell /usr/sbin/nologin autocert \
    && chmod +x /app/backend/docker-entrypoint.sh \
    && chown -R autocert:autocert /app

WORKDIR /app/backend

EXPOSE 8000

ENTRYPOINT ["/app/backend/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
