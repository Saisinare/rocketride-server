"""Deliberate failure for the test-server log artifact demo (demo branch only, never merged)."""


def test_artifact_demo_deliberate_failure():
    """Fail on purpose so the CI test step fails and uploads the test-server logs."""
    assert False, 'deliberate failure: demo of the test-server log artifact (PR #2630)'
