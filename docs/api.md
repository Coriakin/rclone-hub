# API

Base: `http://127.0.0.1:8000/api`

- `GET /health`
- `GET /remotes`
- `GET /remote-types`
- `GET /remotes/details`
- `GET /remotes/{name}/config`
- `POST /remotes`
- `PUT /remotes/{name}`
- `DELETE /remotes/{name}`
- `POST /remotes/config-session/start`
- `POST /remotes/config-session/continue`
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

## Remote create payload

```json
{
  "name": "myremote",
  "type": "b2",
  "values": {
    "account": "xxxx",
    "key": "yyyy",
    "hard_delete": true
  }
}
```

## Remote update payload

```json
{
  "values": {
    "hard_delete": false
  }
}
```

## Config session (non-interactive OAuth / prompt flow)

Start:

```json
{
  "operation": "create",
  "name": "gdrive2",
  "type": "drive",
  "values": {},
  "ask_all": false
}
```

Continue:

```json
{
  "operation": "create",
  "name": "gdrive2",
  "type": "drive",
  "values": {},
  "state": "*oauth-islocal,teamdrive,,",
  "result": "true",
  "ask_all": false
}
```

## File content endpoint

- Use `disposition=inline` to render previewable image files (`jpg`, `jpeg`, `png`, `gif`) directly.
- Use `disposition=attachment` to force download behavior.
