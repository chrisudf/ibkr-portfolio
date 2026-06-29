FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

ENV PORT=8000
EXPOSE 8000

# Timeout has to exceed the worst-case /api/refresh runtime: fetch_one
# polls up to 60 × 5s = 300s, plus parse + write. 360s gives headroom.
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8000", "--timeout", "360", "app:app"]
