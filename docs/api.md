# API

Base: `http://127.0.0.1:8000/api`

- `GET /health`
- `GET /remotes`
- `GET /list?remote_path=<remote:path>&recursive=false`
- `GET /files/content?remote_path=<remote:path>&disposition=<inline|attachment>`
- `POST /searches`
- `GET /searches/{search_id}/events?after_seq=0`
- `POST /searches/{search_id}/cancel`
- `POST /jobs/copy`
- `POST /jobs/move`
- `POST /jobs/delete`
- `POST /jobs/cancel`
- `GET /jobs`
- `GET /jobs/{job_id}`
- `GET /settings`
- `PUT /settings`

## Copy/Move payload

```json
{
  "sources": ["remoteA:path/file"],
  "destination_dir": "remoteB:path/target",
  "operation": "copy",
  "fallback_mode": "auto",
  "verify_mode": "strict"
}
```

## File content endpoint

- Use `disposition=inline` to render previewable image files (`jpg`, `jpeg`, `png`, `gif`) directly.
- Use `disposition=attachment` to force download behavior.
