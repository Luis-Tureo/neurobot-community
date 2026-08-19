#!/usr/bin/env bash
set -uo pipefail

MAX_ATTEMPTS="${AZ_RETRY_MAX_ATTEMPTS:-5}"
BASE_DELAY_SECONDS="${AZ_RETRY_BASE_DELAY_SECONDS:-3}"
MAX_DELAY_SECONDS="${AZ_RETRY_MAX_DELAY_SECONDS:-20}"

if [ "$#" -eq 0 ]; then
  echo "Uso: az-retry.sh <argumentos de az>" >&2
  exit 2
fi

is_transient_azure_error() {
  local message="$1"
  printf '%s' "$message" | grep -Eiq \
    'connection (reset|aborted|closed)|connectionreseterror|remote disconnected|remotedisconnected|broken pipe|read timed out|connect timed out|timeout|timed out|temporar(y|ily)|too many requests|(^|[^0-9])429([^0-9]|$)|(^|[^0-9])500([^0-9]|$)|(^|[^0-9])502([^0-9]|$)|(^|[^0-9])503([^0-9]|$)|(^|[^0-9])504([^0-9]|$)|service unavailable|bad gateway|gateway timeout|eof|name resolution|temporary failure in name resolution|ssl.*(error|eof)|server disconnected|connection refused'
}

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  error_file="$(mktemp)"
  output=""
  status=0

  if output="$(az "$@" 2>"$error_file")"; then
    rm -f "$error_file"
    printf '%s' "$output"
    exit 0
  else
    status=$?
  fi

  error_message="$(cat "$error_file")"
  rm -f "$error_file"

  if ! is_transient_azure_error "$error_message"; then
    printf '%s\n' "$error_message" >&2
    exit "$status"
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "ERROR: Azure CLI siguió fallando por conectividad después de ${MAX_ATTEMPTS} intentos." >&2
    printf '%s\n' "$error_message" >&2
    exit "$status"
  fi

  delay=$((BASE_DELAY_SECONDS * attempt))
  if [ "$delay" -gt "$MAX_DELAY_SECONDS" ]; then
    delay="$MAX_DELAY_SECONDS"
  fi

  echo "Azure CLI tuvo un fallo transitorio de conectividad (intento ${attempt}/${MAX_ATTEMPTS}); reintentando en ${delay}s..." >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done

exit 1
