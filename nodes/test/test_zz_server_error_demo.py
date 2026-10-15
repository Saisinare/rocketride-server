"""Deliberate server-side failure for the test-server log artifact demo (demo branch only, never merged)."""

import asyncio
import os

from rocketride import RocketRideClient

# The second component names a node that does not exist, so the server cannot start the pipeline.
BROKEN_PIPELINE = {
    'components': [
        {
            'id': 'webhook_1',
            'provider': 'webhook',
            'config': {'hideForm': True, 'mode': 'Source', 'type': 'webhook'},
        },
        {
            'id': 'broken_1',
            'provider': 'no_such_node_demo',
            'config': {},
            'input': [{'lane': 'text', 'from': 'webhook_1'}],
        },
    ],
    'source': 'webhook_1',
    'project_id': 'a1b2c3d4-2629-4000-a000-00000000dead',
}


async def _start_broken_pipeline():
    """Ask the test server to start the broken pipeline.

    Returns:
        str | None: The server's error, or None if it accepted the pipeline.
    """
    client = RocketRideClient(
        uri=os.getenv('ROCKETRIDE_URI', 'http://localhost:5565'),
        auth=os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY'),
    )
    await client.connect()
    try:
        result = await client.use(pipeline=BROKEN_PIPELINE, token='DEMO-SERVER-ERROR')
        await client.terminate(result.get('token', 'DEMO-SERVER-ERROR'))
        return None
    except Exception as exc:  # noqa: BLE001 - the error text is what the demo reports
        return str(exc)
    finally:
        await client.disconnect()


def test_server_error_demo():
    """Expects the server to start the pipeline; it cannot, so the test fails with the server's error."""
    error = asyncio.run(_start_broken_pipeline())
    assert error is None, f'the server refused the pipeline: {error}'
