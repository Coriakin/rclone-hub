import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute

from app.api.routes import build_router
from app.models.schemas import Settings


class FakeRclone:
    def __init__(self):
        self.created = None
        self.updated = None
        self.deleted = None
        self.create_session_responses = []
        self.update_session_responses = []

    def version(self):
        return 'rclone vtest'

    def config_file(self):
        return '~/.config/rclone/rclone.conf'

    def list_remotes(self):
        return ['b2r:', 'drv:']

    def list(self, remote_path, recursive=False):
        _ = remote_path, recursive
        return []

    def list_remotes_long_json(self):
        return [
            {'name': 'b2r', 'type': 'b2', 'source': 'file', 'description': ''},
            {'name': 'drv', 'type': 'drive', 'source': 'file', 'description': ''},
            {'name': 'legacy', 'type': 's3', 'source': 'file', 'description': ''},
            {'name': 'cryptwrap', 'type': 'crypt', 'source': 'file', 'description': ''},
        ]

    def config_providers(self):
        return [
            {
                'Prefix': 'b2',
                'Description': 'Backblaze B2',
                'Options': [
                    {'Name': 'account', 'Type': 'string', 'Required': True, 'Advanced': False, 'IsPassword': False, 'Sensitive': True, 'DefaultStr': '', 'Help': '', 'Examples': []},
                    {'Name': 'key', 'Type': 'string', 'Required': True, 'Advanced': False, 'IsPassword': False, 'Sensitive': True, 'DefaultStr': '', 'Help': '', 'Examples': []},
                    {'Name': 'hard_delete', 'Type': 'bool', 'Required': False, 'Advanced': False, 'IsPassword': False, 'Sensitive': False, 'DefaultStr': 'false', 'Help': '', 'Examples': []},
                ],
            },
            {
                'Prefix': 'drive',
                'Description': 'Google Drive',
                'Options': [
                    {'Name': 'scope', 'Type': 'string', 'Required': False, 'Advanced': False, 'IsPassword': False, 'Sensitive': False, 'DefaultStr': '', 'Help': '', 'Examples': []},
                    {'Name': 'token', 'Type': 'string', 'Required': False, 'Advanced': True, 'IsPassword': False, 'Sensitive': True, 'DefaultStr': '', 'Help': '', 'Examples': []},
                ],
            },
            {
                'Prefix': 'crypt',
                'Description': 'Crypt',
                'Options': [
                    {'Name': 'remote', 'Type': 'string', 'Required': True, 'Advanced': False, 'IsPassword': False, 'Sensitive': False, 'DefaultStr': '', 'Help': '', 'Examples': []},
                    {'Name': 'password', 'Type': 'string', 'Required': True, 'Advanced': False, 'IsPassword': True, 'Sensitive': False, 'DefaultStr': '', 'Help': '', 'Examples': []},
                ],
            },
            {
                'Prefix': 'smb',
                'Description': 'SMB',
                'Options': [
                    {'Name': 'host', 'Type': 'string', 'Required': True, 'Advanced': False, 'IsPassword': False, 'Sensitive': True, 'DefaultStr': '', 'Help': '', 'Examples': []},
                ],
            },
            {
                'Prefix': 's3',
                'Description': 'S3',
                'Options': [],
            },
        ]

    def config_redacted(self, remote=None):
        if remote == 'b2r':
            return {'type': 'b2', 'account': 'XXX', 'key': 'XXX', 'hard_delete': 'true'}
        if remote == 'drv':
            return {'type': 'drive', 'token': 'XXX'}
        return {}

    def config_create(self, name, remote_type, values):
        self.created = (name, remote_type, values)

    def config_update(self, name, values):
        self.updated = (name, values)

    def config_delete(self, name):
        self.deleted = name

    def config_dump(self):
        return {
            'cryptwrap': {'type': 'crypt', 'remote': 'b2r:secure'},
            'drv': {'type': 'drive'},
        }

    def config_create_non_interactive(self, name, remote_type, values, state=None, result_value=None, ask_all=False):
        _ = name, remote_type, values, state, result_value, ask_all
        if self.create_session_responses:
            return self.create_session_responses.pop(0)
        return None

    def config_update_non_interactive(self, name, values, state=None, result_value=None, ask_all=False):
        _ = name, values, state, result_value, ask_all
        if self.update_session_responses:
            return self.update_session_responses.pop(0)
        return None


class DummyTransfers:
    def submit_transfer(self, req):
        _ = req
        raise NotImplementedError

    def submit_delete(self, req):
        _ = req
        raise NotImplementedError

    def cancel(self, job_id):
        _ = job_id
        return None

    def list_jobs(self):
        return []

    def get_job(self, job_id):
        _ = job_id
        return None


class DummySearches:
    async def create(self, **kwargs):
        _ = kwargs
        raise NotImplementedError

    async def poll(self, search_id: str, after_seq: int):
        _ = search_id, after_seq
        raise KeyError

    async def cancel(self, search_id: str):
        _ = search_id
        return False


class DummySizes:
    async def create(self, root_path: str):
        _ = root_path
        raise NotImplementedError

    async def poll(self, size_id: str, after_seq: int):
        _ = size_id, after_seq
        raise KeyError

    async def cancel(self, size_id: str):
        _ = size_id
        return False


class DummySettingsStore:
    def __init__(self):
        self.settings = Settings(staging_path='/tmp/rclone-hub', staging_cap_bytes=1024, concurrency=1, verify_mode='strict')

    def get_settings(self):
        return self.settings

    def set_settings(self, settings: Settings):
        self.settings = settings


def get_endpoint(path: str, method: str, fake_rclone: FakeRclone):
    router = build_router(
        rclone=fake_rclone,
        transfers=DummyTransfers(),
        searches=DummySearches(),
        sizes=DummySizes(),
        settings_store=DummySettingsStore(),
    )
    for route in router.routes:
        if isinstance(route, APIRoute) and route.path == path and method.upper() in route.methods:
            return route.endpoint
    raise AssertionError(f'expected {method} {path} route to exist')


def test_remote_types_only_supported_types():
    fake = FakeRclone()
    endpoint = get_endpoint('/api/remote-types', 'GET', fake)
    payload = endpoint()
    types = {entry['type']: entry for entry in payload['types']}
    assert set(types.keys()) == {'b2', 'drive', 'smb', 'crypt'}
    assert any(field['name'] == 'account' and field['required'] for field in types['b2']['fields'])


def test_remotes_details_filters_to_supported_types():
    fake = FakeRclone()
    endpoint = get_endpoint('/api/remotes/details', 'GET', fake)
    payload = endpoint()
    assert [entry['name'] for entry in payload['remotes']] == ['b2r', 'drv', 'cryptwrap']


def test_remote_config_returns_redacted_values():
    fake = FakeRclone()
    endpoint = get_endpoint('/api/remotes/{name}/config', 'GET', fake)
    payload = endpoint(name='b2r')
    assert payload.name == 'b2r'
    fields = {field.name: field for field in payload.fields}
    assert fields['account'].value == 'XXX'
    assert fields['hard_delete'].value == 'true'


def test_create_remote_non_drive_uses_config_create():
    fake = FakeRclone()
    endpoint = get_endpoint('/api/remotes', 'POST', fake)
    result = endpoint(type('Req', (), {'name': 'newb2', 'type': 'b2', 'values': {'account': 'a', 'key': 'k', 'hard_delete': True}})())
    assert result == {'ok': True}
    assert fake.created == ('newb2', 'b2', {'account': 'a', 'hard_delete': True, 'key': 'k'})


def test_delete_remote_blocks_when_crypt_references_target():
    fake = FakeRclone()
    endpoint = get_endpoint('/api/remotes/{name}', 'DELETE', fake)
    with pytest.raises(HTTPException) as exc:
        endpoint(name='b2r')
    assert exc.value.status_code == 409


def test_config_session_start_and_continue_for_drive_create():
    fake = FakeRclone()
    fake.create_session_responses = [
        {'state': '*oauth-islocal,teamdrive,,', 'option': {'Name': 'config_is_local', 'Type': 'bool'}, 'error': ''},
        None,
    ]
    start = get_endpoint('/api/remotes/config-session/start', 'POST', fake)
    cont = get_endpoint('/api/remotes/config-session/continue', 'POST', fake)

    first = start(type('Req', (), {'operation': 'create', 'name': 'drv2', 'type': 'drive', 'values': {}, 'ask_all': False})())
    assert first.done is False
    assert first.question is not None
    assert first.question.state == '*oauth-islocal,teamdrive,,'

    second = cont(type('Req', (), {
        'operation': 'create',
        'name': 'drv2',
        'type': 'drive',
        'values': {},
        'state': '*oauth-islocal,teamdrive,,',
        'result': 'true',
        'ask_all': False,
    })())
    assert second.done is True
    assert second.question is None
