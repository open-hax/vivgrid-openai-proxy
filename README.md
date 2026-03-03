# VivGrid OpenAI Proxy

OpenAI-compatible proxy server for VivGrid chat completions with automatic API key rotation.

## Features

- `POST /v1/chat/completions` passthrough for text and multimodal payloads (image/video/audio/pdf fields are forwarded unchanged).
- `GET /v1/models` and `GET /v1/models/:id` model listing.
- Automatic key rotation when upstream returns rate limits (`429`, plus `403/503` with `retry-after`).
- Key pool loaded from JSON file so you can maintain many upstream keys.

## Setup

1. Create `keys.json` from `keys.example.json`.
2. Optionally create `models.json` from `models.example.json`.
3. Start the server.

```bash
pnpm --filter @workspace/vivgrid-openai-proxy dev
```

Build and run production mode:

```bash
pnpm --filter @workspace/vivgrid-openai-proxy build
pnpm --filter @workspace/vivgrid-openai-proxy start
```

## Environment Variables

- `PROXY_HOST` (default: `127.0.0.1`)
- `PROXY_PORT` (default: `8787`)
- `UPSTREAM_BASE_URL` (default: `https://api.vivgrid.com`)
- `UPSTREAM_CHAT_COMPLETIONS_PATH` (default: `/v1/chat/completions`)
- `VIVGRID_KEYS_FILE` (default: `./keys.json`)
- `VIVGRID_MODELS_FILE` (default: `./models.json`)
- `VIVGRID_KEY_RELOAD_MS` (default: `5000`)
- `VIVGRID_KEY_COOLDOWN_MS` (default: `30000`)
- `UPSTREAM_REQUEST_TIMEOUT_MS` (default: `180000`)
- `PROXY_AUTH_TOKEN` (optional local bearer token to protect your proxy)

## `keys.json` Format

```json
{
  "keys": [
    "viv-your-first-key",
    "viv-your-second-key"
  ]
}
```

You can also provide a bare array, for example: `["viv-key-1", "viv-key-2"]`.

## Example Request

```bash
curl --request POST \
  --url http://127.0.0.1:8787/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "gemini-3.1-pro-preview",
    "messages": [
      {
        "role": "user",
        "content": "Say hello in English, Chinese and Japanese."
      }
    ],
    "stream": true
  }'
```
