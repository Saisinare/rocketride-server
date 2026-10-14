# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The live-database lane's result guard (nodes/scripts/tasks.js), checked with Node.

``nodes:test-db`` and the database pass of ``nodes:test`` read the pytest JUnit
report of the live suites. When the databases are required (``nodes:test-db``
by default, ``nodes:test`` with ``RR_REQUIRE_DB_TESTS``), every suite must pass
at least one test and no test may skip except a deliberate ``NOT RUN:`` one.
"""

from __future__ import annotations

import json
import shutil
import subprocess

from pathlib import Path

import pytest

_TASKS = Path(__file__).resolve().parents[1] / 'scripts' / 'tasks.js'
_NODE = shutil.which('node')

pytestmark = pytest.mark.skipif(_NODE is None, reason='node is not on PATH')

_SCRIPT = r"""
const lane = require(process.argv[1]).dbLane;
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = {};
if (input.xml !== undefined) {
    out.counts = lane.countJunitResults(input.xml);
    try {
        lane.checkRequiredDbResults(input.xml, input.suites);
        out.error = null;
    } catch (e) {
        out.error = e.message;
    }
}
if (input.required !== undefined) {
    const saved = process.env.RR_REQUIRE_DB_TESTS;
    out.required = input.required.map(([value, byDefault]) => {
        if (value === null) delete process.env.RR_REQUIRE_DB_TESTS;
        else process.env.RR_REQUIRE_DB_TESTS = value;
        return lane.dbTestsRequired(byDefault);
    });
    if (saved === undefined) delete process.env.RR_REQUIRE_DB_TESTS;
    out.suites = lane.DB_LIVE_SUITES;
    out.poolerSuites = lane.DB_POOLER_SUITES;
}
process.stdout.write(JSON.stringify(out));
"""


def _lane(payload):
    proc = subprocess.run(
        [_NODE, '-e', _SCRIPT, str(_TASKS)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _case(module, name, body=''):
    return f'<testcase classname="test.{module}.TestX" name="{name}" time="0.1">{body}</testcase>'


def _skip(message):
    return f'<skipped type="pytest.skip" message="{message}">reason</skipped>'


def _xml(*cases):
    return '<?xml version="1.0"?><testsuites><testsuite>' + ''.join(cases) + '</testsuite></testsuites>'


SUITES = ['test_graph_a_full', 'test_graph_b_full']


def test_every_suite_passing_with_deliberate_skips_is_accepted():
    xml = _xml(
        _case('test_graph_a_full', 't1'),
        _case('test_graph_a_full', 't2', _skip('NOT RUN: needs an Enterprise role')),
        _case('test_graph_b_full', 't1'),
    )
    out = _lane({'xml': xml, 'suites': SUITES})
    assert out['error'] is None
    assert out['counts']['test_graph_a_full'] == {'passed': 1, 'skipped': 1, 'failed': 0, 'unexpectedSkips': []}


def test_a_suite_without_passes_fails_the_lane():
    xml = _xml(_case('test_graph_a_full', 't1'), _case('test_graph_b_full', 't1', _skip('NOT RUN: role')))
    out = _lane({'xml': xml, 'suites': SUITES})
    assert 'no test passed in: test_graph_b_full' in out['error']


def test_an_unexpected_skip_fails_the_lane_even_when_the_suite_has_passes():
    xml = _xml(
        _case('test_graph_a_full', 't1'),
        _case('test_graph_a_full', 'test_limits', _skip('server does not allow GRAPH.CONFIG GET RESULTSET_SIZE')),
        _case('test_graph_b_full', 't1'),
    )
    out = _lane({'xml': xml, 'suites': SUITES})
    assert out['error'] is not None
    assert 'skipped without a NOT RUN: reason' in out['error']
    assert 'test_graph_a_full::test_limits' in out['error']
    assert 'RESULTSET_SIZE' in out['error']


def test_escaped_skip_messages_are_read():
    xml = _xml(
        _case('test_graph_a_full', 't1'),
        _case('test_graph_a_full', 't2', _skip('NOT RUN: needs &quot;RR_TEST_X&quot; &amp; a role')),
        _case('test_graph_b_full', 't1'),
    )
    assert _lane({'xml': xml, 'suites': SUITES})['error'] is None


def test_requirement_defaults_and_overrides():
    out = _lane(
        {
            'required': [
                [None, False],  # nodes:test without the variable: optional
                [None, True],  # nodes:test-db without the variable: required
                ['1', False],
                ['yes', False],
                ['0', True],  # explicit opt-out
                ['false', True],
                ['', True],
            ]
        }
    )
    assert out['required'] == [False, True, True, True, False, False, True]


def test_the_lane_lists_the_graph_suites_and_the_pooler_pass():
    out = _lane({'required': []})
    for suite in (
        'test_rocketride_graph_full.py',
        'test_graph_age_full.py',
        'test_graph_drivers_full.py',
        'test_graph_neo4j_full.py',
        'test_graph_falkordb_full.py',
        'test_graph_wire_fixtures_full.py',
        'test_graph_toolpath_full.py',
    ):
        assert suite in out['suites']
    assert out['poolerSuites'] == ['test_rocketride_graph_full.py', 'test_graph_age_full.py']
