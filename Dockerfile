FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=10000 \
    DATA_DIR=/var/data

WORKDIR /app
COPY . /app
RUN mkdir -p /var/data

EXPOSE 10000
CMD ["python", "server.py"]
