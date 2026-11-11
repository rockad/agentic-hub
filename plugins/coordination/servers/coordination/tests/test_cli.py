import pytest

from coordination.cli import main


def test_cli_prints_help_and_exits_zero(capsys):
    assert main([]) == 0
    assert "a2a-coord" in capsys.readouterr().out


def test_cli_version(capsys):
    with pytest.raises(SystemExit) as e:
        main(["--version"])
    assert e.value.code == 0
    assert "a2a-coord" in capsys.readouterr().out
