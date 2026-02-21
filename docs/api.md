# API

Base: `http://127.0.0.1:8000/api`

- `GET /health`
- `GET /remotes`
- `GET /list?remote_path=<remote:path>&recursive=false`
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
