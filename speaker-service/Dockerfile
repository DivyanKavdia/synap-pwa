FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SYNAP_SPEAKER_MODEL=speechbrain/spkrec-ecapa-voxceleb \
    SYNAP_SPEAKER_MODEL_DIR=/opt/synap-speaker-model

WORKDIR /app
COPY requirements.txt .
# Torch is installed separately from the CPU-only index. The default PyPI
# wheel drags in the whole CUDA stack - cuBLAS, cuDNN, cuSOLVER, triton -
# several GB of GPU libraries for a service that runs device="cpu". On Cloud
# Run with min_instances=0 that image has to be pulled on every cold start,
# and the backend gives up on the speaker service after 30s, so the bloat
# turns into failed enrolments rather than merely slow ones.
#
# The fallback keeps the build working if the CPU index ever lacks this pin.
RUN pip install --upgrade pip \
 && (pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.8.0 torchaudio==2.8.0 \
     || pip install --no-cache-dir torch==2.8.0 torchaudio==2.8.0) \
 && pip install --no-cache-dir -r requirements.txt

# Bake the Apache-2.0 ECAPA-TDNN model into the image. This avoids downloading
# model weights on a user's first enrollment or after every cold start.
#
# A quoted one-liner rather than a heredoc, on purpose. Heredocs need BuildKit,
# and Cloud Build still runs the legacy builder by default: it parses the
# heredoc body as Dockerfile instructions and dies on the first line with
# "FROM requires either one or three arguments", which points nowhere useful.
RUN python -c "from speechbrain.inference.classifiers import EncoderClassifier; "\
           "EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb', "\
           "savedir='/opt/synap-speaker-model', run_opts={'device': 'cpu'}); "\
           "print('speaker model cached')"

COPY app.py .
ENV PORT=8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 1"]
