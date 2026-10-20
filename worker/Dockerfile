# PandaBase worker (DESIGN §1, §5). Ollama runs natively on the host (Metal); this image only
# talks to it over OLLAMA_URL (default http://host.docker.internal:11434).

# -- build: resolve the locked environment with uv ------------------------------------------
FROM python:3.14-slim AS build
RUN pip install --no-cache-dir uv==0.13.3
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
# Dependencies first (cached layer), then the project itself.
COPY pyproject.toml uv.lock .python-version README.md ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

# -- runtime: python slim + ffmpeg, non-root ------------------------------------------------
FROM python:3.14-slim
# ffmpeg: video keyframe extraction lands in v1.1; installed now so the image is ready for it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin worker
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY prompts ./prompts
ENV PATH="/app/.venv/bin:$PATH" \
    PROMPTS_DIR=/app/prompts \
    PYTHONUNBUFFERED=1
USER worker
# SIGTERM finishes the current job before exiting; give it a grace period (compose
# `stop_grace_period: 5m`, the job lease). A second signal exits at once.
STOPSIGNAL SIGTERM
CMD ["python", "-m", "pandabase_worker"]
