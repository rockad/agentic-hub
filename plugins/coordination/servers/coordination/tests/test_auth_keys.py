"""S1-AUTH: key format, hashing and verification (spec 8.2)."""

import dataclasses
import hashlib
import hmac
import re
import statistics
import time
from datetime import timedelta

import pytest
from auth_helpers import NOW, make_record

from coordination.auth import generate_key, hash_secret, parse_key, verify_key
from coordination.auth.keys import SECRET_LEN, Verdict

PEPPER = "throwaway-pepper-for-tests-0123456789"


def test_generated_key_has_the_documented_shape():
    key = generate_key("dev")
    assert re.fullmatch(r"a2ak_dev_[0-9a-f]{8}_[A-Za-z0-9_-]{43}", key.token)
    parsed = parse_key(key.token)
    assert parsed is not None and parsed.key_id == key.key_id and parsed.env == "dev"
    assert len(parsed.secret) == SECRET_LEN
    assert generate_key("live").token.startswith("a2ak_live_")


def test_keys_are_random():
    tokens = {generate_key("dev").token for _ in range(50)}
    ids = {parse_key(t).key_id for t in tokens}
    assert len(tokens) == 50 and len(ids) >= 49  # 32 bits of id: a clash in 50 is a one in 80 million chance


def test_secret_is_256_bits_of_base64url():
    import base64

    secret = parse_key(generate_key("dev").token).secret
    assert len(base64.urlsafe_b64decode(secret + "=")) == 32


@pytest.mark.parametrize(
    "token",
    [
        "",
        "a2ak_dev_3f9c01ab",
        "a2ak_dev_3f9c01ab_short",
        "a2ak_dev_3F9C01AB_" + "A" * 43,  # key id is lower-case hex
        "a2ak_dev_3f9c01a_" + "A" * 43,  # 7 hex characters
        "a2ak_dev_3f9c01abc_" + "A" * 43,  # 9 hex characters
        "a2ak_dev_3f9c01ab_" + "A" * 44,
        "a2ak_dev_3f9c01ab_" + "A" * 42 + "=",
        "b2ak_dev_3f9c01ab_" + "A" * 43,
        "a2ak_Dev_3f9c01ab_" + "A" * 43,
        "a2ak_dev_3f9c01ab_" + "A" * 43 + "\n",
        " a2ak_dev_3f9c01ab_" + "A" * 43,
    ],
)
def test_malformed_tokens_do_not_parse(token):
    assert parse_key(token) is None


def test_the_token_is_not_in_the_repr_of_what_holds_it():
    key = generate_key("dev")
    parsed = parse_key(key.token)
    for text in (repr(key), str(key), repr(parsed)):
        assert key.token not in text and parsed.secret not in text and key.secret_hash not in text


# hashing -------------------------------------------------------------------------------------


def test_hash_without_a_pepper_is_sha256_of_the_secret():
    assert hash_secret("s" * 43, None) == "sha256:" + hashlib.sha256(b"s" * 43).hexdigest()


def test_hash_with_a_pepper_is_hmac_sha256():
    expected = hmac.new(PEPPER.encode(), b"s" * 43, hashlib.sha256).hexdigest()
    assert hash_secret("s" * 43, PEPPER) == "hmac-sha256:" + expected


def test_the_stored_hash_fits_the_column_and_never_holds_the_secret():
    key = generate_key("dev", PEPPER)
    secret = parse_key(key.token).secret
    assert len(key.secret_hash) <= 128
    assert secret not in key.secret_hash and key.token not in key.secret_hash


def test_a_pepper_changes_the_hash():
    assert hash_secret("x" * 43, None) != hash_secret("x" * 43, PEPPER)
    assert hash_secret("x" * 43, PEPPER) != hash_secret("x" * 43, PEPPER + "2")


def test_hmac_needs_a_pepper():
    with pytest.raises(ValueError):
        hash_secret("x", None, scheme="hmac-sha256")


# verification --------------------------------------------------------------------------------


def verify(token, record, *, env="dev", pepper=None):
    return verify_key(token, record, env=env, pepper=pepper, now=NOW)


def test_a_good_key_is_accepted():
    token, record = make_record("local-harness")
    assert verify(token, record) is Verdict.OK


def test_a_good_key_is_accepted_with_a_pepper():
    token, record = make_record("local-harness", pepper=PEPPER)
    assert verify(token, record, pepper=PEPPER) is Verdict.OK


def test_a_wrong_secret_is_refused():
    token, record = make_record("local-harness")
    other = token[: -1] + ("A" if token[-1] != "A" else "B")
    assert verify(other, record) is Verdict.BAD_SECRET


def test_a_missing_record_is_unknown():
    token, _ = make_record("local-harness")
    assert verify(token, None) is Verdict.UNKNOWN


def test_malformed_and_absent_tokens_are_refused():
    _, record = make_record("local-harness")
    assert verify("nonsense", None) is Verdict.MALFORMED
    assert verify(None, None) is Verdict.MALFORMED
    assert verify("nonsense", record) is Verdict.MALFORMED


def test_an_expired_key_is_refused():
    token, record = make_record("local-harness", expires_in=timedelta(seconds=-1))
    assert verify(token, record) is Verdict.EXPIRED
    token, record = make_record("local-harness", expires_in=timedelta(0))
    assert verify(token, record) is Verdict.EXPIRED  # the instant of expiry is already expired


def test_a_revoked_key_is_refused():
    token, record = make_record("local-harness", revoked=True)
    assert verify(token, record) is Verdict.REVOKED


def test_a_dev_key_is_refused_on_a_live_server():
    token, record = make_record("local-harness", env="dev")
    assert verify(token, record, env="live") is Verdict.WRONG_ENV
    assert verify(token, None, env="live") is Verdict.WRONG_ENV


def test_a_live_key_is_refused_on_a_dev_server():
    token, record = make_record("local-harness", env="live")
    assert verify(token, record, env="dev") is Verdict.WRONG_ENV


def test_a_live_key_works_on_a_live_server():
    token, record = make_record("local-harness", env="live")
    assert verify(token, record, env="live") is Verdict.OK


def test_a_record_whose_env_disagrees_with_the_key_is_refused():
    token, record = make_record("local-harness", env="dev")
    odd = dataclasses.replace(record, env="live")
    assert verify(token, odd, env="dev") is Verdict.WRONG_ENV


def test_a_record_for_another_key_id_is_refused():
    token, _ = make_record("local-harness")
    _, other = make_record("local-harness")
    assert verify(token, other) is Verdict.BAD_SECRET


def test_an_hmac_key_cannot_be_verified_without_the_pepper():
    token, record = make_record("local-harness", pepper=PEPPER)
    assert verify(token, record, pepper=None) is Verdict.BAD_SECRET


def test_a_plain_sha256_key_still_works_after_a_pepper_is_set():
    token, record = make_record("local-harness", pepper=None)
    assert verify(token, record, pepper=PEPPER) is Verdict.OK


def test_the_wrong_pepper_refuses_an_hmac_key():
    token, record = make_record("local-harness", pepper=PEPPER)
    assert verify(token, record, pepper="another-pepper-0123456789") is Verdict.BAD_SECRET


# constant time: one comparison on every path ----------------------------------------------------


def _count_compares(monkeypatch):
    calls = []
    real = hmac.compare_digest

    def counting(a, b):
        calls.append((len(a), len(b)))
        return real(a, b)

    monkeypatch.setattr(hmac, "compare_digest", counting)
    return calls


def test_every_outcome_runs_exactly_one_comparison_of_equal_length_values(monkeypatch):
    calls = _count_compares(monkeypatch)
    token, record = make_record("local-harness")
    revoked_token, revoked = make_record("local-harness", revoked=True)
    cases = [
        (token, record),  # accepted
        (token, None),  # key id not found: the dummy comparison
        ("nonsense", None),  # malformed
        (None, None),  # no token
        (revoked_token, revoked),
        (token[:-1] + "A", record),  # wrong secret
    ]
    for tok, rec in cases:
        calls.clear()
        verify(tok, rec)
        assert len(calls) == 1, (tok, rec)
        assert calls[0][0] == calls[0][1]  # same length: the compare is over equal-size digests


def _naive_verify(token, record, *, env, pepper, now):
    """What the dummy comparison prevents: answer at once when the id does not exist."""
    if record is None:
        return Verdict.UNKNOWN
    return verify_key(token, record, env=env, pepper=pepper, now=now)


def _batch_means(fn, calls_a, calls_b, *, batches=25, per_batch=200):
    """Per-batch mean time of two workloads, interleaved so drift hits both alike."""
    a_times, b_times = [], []
    for _ in range(batches):
        for workload, out in ((calls_a, a_times), (calls_b, b_times)):
            start = time.perf_counter_ns()
            for _ in range(per_batch):
                fn(*workload)
            out.append((time.perf_counter_ns() - start) / per_batch)
    return statistics.median(a_times), statistics.median(b_times)


def test_timing_of_a_known_and_an_unknown_key_id_is_within_noise():
    token, record = make_record("local-harness")
    unknown, _ = make_record("local-harness")
    wrong_secret = token[:-1] + ("A" if token[-1] != "A" else "B")

    def run(tok, rec):
        verify_key(tok, rec, env="dev", pepper=None, now=NOW)

    known, missing = _batch_means(run, (wrong_secret, record), (unknown, None))
    # Loose bound (spec: "a loose statistical bound"): medians of batch means within 35 percent.
    assert abs(known - missing) / max(known, missing) < 0.35, (known, missing)


def test_timing_check_has_a_positive_control():
    """The same bound does fail for a verifier without the dummy comparison, so it can see a leak."""
    token, record = make_record("local-harness")
    unknown, _ = make_record("local-harness")
    wrong_secret = token[:-1] + ("A" if token[-1] != "A" else "B")

    def run(tok, rec):
        _naive_verify(tok, rec, env="dev", pepper=None, now=NOW)

    known, missing = _batch_means(run, (wrong_secret, record), (unknown, None))
    assert abs(known - missing) / max(known, missing) >= 0.35, (known, missing)
