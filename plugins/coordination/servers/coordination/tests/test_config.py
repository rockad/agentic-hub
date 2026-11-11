import pytest

from coordination.config import ENV_VARS, Config, ConfigError

# The variables of docs/specs/server-api.md section 1.5 that the server reads.
# COMPOSE_PROFILES is a Docker Compose variable, not a server variable.
SPEC_VARS = {
    "A2A_PORT", "A2A_PUBLIC_PORT", "A2A_LISTEN", "A2A_PUBLIC_LISTEN", "A2A_DB_URL",
    "A2A_DB_PASSWORD_FILE", "A2A_DUMP_LAST_OK_FILE", "A2A_PUBLIC_URL", "A2A_DEPLOY_HOST",
    "A2A_ENV", "A2A_EXPOSURE_STAGE", "A2A_ALLOW_WRITES", "A2A_ALLOWED_HOSTS",
    "A2A_ALLOWED_ORIGINS", "A2A_TRUSTED_PROXY_IPS", "A2A_CARDS_FILE", "A2A_KEY_PEPPER",
    "A2A_WAKE_ROUND_S", "A2A_WAKE_BUDGET_PER_H", "A2A_REOFFER_AFTER_S", "A2A_REOFFER_MAX",
    "A2A_SUBMITTED_TTL_H", "A2A_QUARANTINE_TTL_H", "A2A_WORKING_TTL_H",
    "A2A_SESSION_IDLE_TTL_H", "A2A_MAX_BODY_BYTES", "A2A_MAX_WAIT_S", "A2A_SEND_BLOCK_MAX_S",
    "A2A_PUSH_ENABLED", "A2A_PUSH_ALLOW_HOSTS", "A2A_PUSH_ENC_KEY", "A2A_STATUS_ENABLED",
    "A2A_ENFORCE_TAILNET_IDENTITY", "A2A_ADMIN_SOCKET", "A2A_LOG_LEVEL",
}


def test_reads_exactly_the_spec_variables():
    assert set(ENV_VARS) == SPEC_VARS
    assert len(ENV_VARS) == len(SPEC_VARS)


def test_defaults_with_empty_environment():
    c = Config.from_env({})
    assert c.port == 8120 and c.public_port == 8121
    assert c.listen == "0.0.0.0:8120" and c.public_listen == "0.0.0.0:8121"
    assert c.db_url == "postgresql+asyncpg://coordination@postgres:5432/coordination"
    assert c.db_password_file == "/run/secrets/a2a_db_password"
    assert c.dump_last_ok_file == "/dumps/last_ok"
    assert c.public_url == "http://127.0.0.1:8120"
    assert c.env == "dev" and c.exposure_stage == "s1"
    assert c.allow_writes is False
    assert c.allowed_hosts == ("127.0.0.1:8120", "localhost:8120")
    assert c.allowed_origins == () and c.trusted_proxy_ips == ()
    assert c.cards_file == "/config/cards.yaml"
    assert c.key_pepper is None and c.push_enc_key is None
    assert (c.wake_round_s, c.wake_budget_per_h) == (900, 20)
    assert (c.reoffer_after_s, c.reoffer_max) == (600, 5)
    assert (c.submitted_ttl_h, c.quarantine_ttl_h, c.working_ttl_h) == (168, 72, 24)
    assert c.session_idle_ttl_h == 12
    assert c.max_body_bytes == 65536
    assert (c.max_wait_s, c.send_block_max_s) == (50, 60)
    assert c.push_enabled is False and c.push_allow_hosts == ()
    assert c.status_enabled is False
    assert c.enforce_tailnet_identity is False
    assert c.admin_socket == "/run/a2a/admin.sock"
    assert c.log_level == "info"
    assert c.listen_host_port == ("0.0.0.0", 8120)


def test_every_variable_is_applied():
    env = {
        "A2A_PORT": "9120", "A2A_PUBLIC_PORT": "9121",
        "A2A_LISTEN": "127.0.0.1:9000", "A2A_PUBLIC_LISTEN": "127.0.0.1:9001",
        "A2A_DB_URL": "postgresql+asyncpg://u@h:1/d", "A2A_DB_PASSWORD_FILE": "/p",
        "A2A_DUMP_LAST_OK_FILE": "/l", "A2A_PUBLIC_URL": "https://a.example",
        "A2A_DEPLOY_HOST": "box", "A2A_ENV": "live", "A2A_EXPOSURE_STAGE": "s2",
        "A2A_ALLOW_WRITES": "1", "A2A_ALLOWED_HOSTS": "a:1, b:2",
        "A2A_ALLOWED_ORIGINS": "https://o", "A2A_TRUSTED_PROXY_IPS": "10.0.0.1,10.0.0.2",
        "A2A_CARDS_FILE": "/c.yaml", "A2A_KEY_PEPPER": "pepper",
        "A2A_WAKE_ROUND_S": "1", "A2A_WAKE_BUDGET_PER_H": "2", "A2A_REOFFER_AFTER_S": "3",
        "A2A_REOFFER_MAX": "4", "A2A_SUBMITTED_TTL_H": "5", "A2A_QUARANTINE_TTL_H": "6",
        "A2A_WORKING_TTL_H": "7", "A2A_SESSION_IDLE_TTL_H": "8", "A2A_MAX_BODY_BYTES": "9",
        "A2A_MAX_WAIT_S": "10", "A2A_SEND_BLOCK_MAX_S": "11", "A2A_PUSH_ENABLED": "1",
        "A2A_PUSH_ALLOW_HOSTS": "x.example,y.example", "A2A_PUSH_ENC_KEY": "fernet",
        "A2A_STATUS_ENABLED": "1", "A2A_ENFORCE_TAILNET_IDENTITY": "0",
        "A2A_ADMIN_SOCKET": "/s.sock", "A2A_LOG_LEVEL": "debug",
    }
    assert set(env) == SPEC_VARS
    c = Config.from_env(env)
    assert (c.port, c.public_port) == (9120, 9121)
    assert c.listen_host_port == ("127.0.0.1", 9000) and c.public_listen == "127.0.0.1:9001"
    assert c.db_url == "postgresql+asyncpg://u@h:1/d" and c.db_password_file == "/p"
    assert c.dump_last_ok_file == "/l" and c.public_url == "https://a.example"
    assert c.deploy_host == "box" and c.env == "live" and c.exposure_stage == "s2"
    assert c.allow_writes is True and c.allowed_hosts == ("a:1", "b:2")
    assert c.allowed_origins == ("https://o",) and c.trusted_proxy_ips == ("10.0.0.1", "10.0.0.2")
    assert c.cards_file == "/c.yaml" and c.key_pepper == "pepper"
    assert (c.wake_round_s, c.wake_budget_per_h, c.reoffer_after_s, c.reoffer_max) == (1, 2, 3, 4)
    assert (c.submitted_ttl_h, c.quarantine_ttl_h, c.working_ttl_h, c.session_idle_ttl_h) == (5, 6, 7, 8)
    assert (c.max_body_bytes, c.max_wait_s, c.send_block_max_s) == (9, 10, 11)
    assert c.push_enabled is True and c.push_allow_hosts == ("x.example", "y.example")
    assert c.push_enc_key == "fernet" and c.status_enabled is True
    assert c.enforce_tailnet_identity is False  # explicit 0 wins over the stage default
    assert c.admin_socket == "/s.sock" and c.log_level == "debug"


def test_tailnet_identity_default_follows_stage():
    assert Config.from_env({"A2A_EXPOSURE_STAGE": "s1"}).enforce_tailnet_identity is False
    assert Config.from_env({"A2A_EXPOSURE_STAGE": "s2"}).enforce_tailnet_identity is True
    assert Config.from_env({"A2A_EXPOSURE_STAGE": "s3"}).enforce_tailnet_identity is True


def test_other_variables_are_ignored():
    c = Config.from_env({"A2A_UNKNOWN": "x", "COMPOSE_PROFILES": "backup", "A2A_RETAIN_DAYS": "1"})
    assert c == Config.from_env({})


@pytest.mark.parametrize(
    "name,value",
    [
        ("A2A_PORT", "eighty"),
        ("A2A_ALLOW_WRITES", "yes"),
        ("A2A_ENV", "prod"),
        ("A2A_EXPOSURE_STAGE", "s4"),
    ],
)
def test_bad_values_name_the_variable(name, value):
    with pytest.raises(ConfigError, match=name):
        Config.from_env({name: value})


def test_bad_listen_address():
    with pytest.raises(ConfigError, match="A2A_LISTEN"):
        _ = Config.from_env({"A2A_LISTEN": "8120"}).listen_host_port


def test_secrets_not_in_repr():
    c = Config.from_env({"A2A_KEY_PEPPER": "s3cret-a", "A2A_PUSH_ENC_KEY": "s3cret-b"})
    assert "s3cret" not in repr(c)
