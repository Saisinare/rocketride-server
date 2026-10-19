# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for Qdrant store markDeleted / markActive payload path.

Validates that soft-delete flags are written to the nested ``meta.isDeleted``
path (matching the query filter and payload index), preserving the other
metadata fields so a soft-deleted document can still be found and restored.

Usage:
    python -m pytest nodes/test/store_qdrant/test_mark_deleted.py -v
"""

import sys
import threading
import importlib
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Bootstrap mocks so qdrant.py can be imported without real dependencies
# ---------------------------------------------------------------------------

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'


# --- ai.common.store: provide a real DocumentStoreBase with stub methods ---
class _FakeDocumentStoreBase:
    """Minimal stand-in for ai.common.store.DocumentStoreBase."""

    def __init__(self, *a, **kw):
        self.vectorSize = 0
        self.modelName = ''
        self.threshold_search = 0.5
        self.collectionLock = threading.Lock()

    def doesCollectionExist(self, *a, **kw):
        return True

    def _doesCollectionExist(self):
        return True

    def _checkCollectionExists(self):
        return True

    def createCollection(self, *a, **kw):
        return True


# Install module-level stubs before any qdrant imports
_mock_store_mod = MagicMock()
_mock_store_mod.DocumentStoreBase = _FakeDocumentStoreBase

_mock_config_mod = MagicMock()
_mock_schema_mod = MagicMock()

# Prefer the installed client's local backend for the round-trip regression.
# Keep the existing lightweight unit tests runnable without that dependency.
try:
    importlib.import_module('qdrant_client')
except ImportError:
    pass

for name, mock in {
    'numpy': MagicMock(),
    'qdrant_client': MagicMock(),
    'qdrant_client.models': MagicMock(),
    'qdrant_client.http': MagicMock(),
    'qdrant_client.http.models': MagicMock(),
    'qdrant_client.conversions': MagicMock(),
    'qdrant_client.conversions.common_types': MagicMock(),
}.items():
    sys.modules.setdefault(name, mock)


# ---------------------------------------------------------------------------
# Import qdrant.py DIRECTLY (bypassing __init__.py which pulls IEndpoint etc.)
# ---------------------------------------------------------------------------

_qdrant_path = NODES_SRC / 'store_qdrant' / 'qdrant.py'
_spec = importlib.util.spec_from_file_location('_qdrant_store', str(_qdrant_path))
_qdrant_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_qdrant_mod)

Store = _qdrant_mod.Store


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_store() -> Store:
    """Create a Store instance with a mocked QdrantClient (bypasses __init__)."""
    store = object.__new__(Store)
    store.client = MagicMock()
    store.collection = 'test-collection'
    store.vectorSize = 384
    store.modelName = 'test-model'
    store.threshold_search = 0.5
    store.collectionLock = threading.Lock()
    store._checkCollectionExists = lambda: True
    return store


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestQdrantMarkDeleted:
    """Verify markDeleted writes to the correct nested payload path."""

    def test_markDeleted_writes_meta_isDeleted_true(self):
        """MarkDeleted must set meta.isDeleted = True, not top-level isDeleted."""
        store = _make_store()

        store.markDeleted(['obj-1', 'obj-2'])

        store.client.set_payload.assert_called_once()
        _, kwargs = store.client.set_payload.call_args
        assert kwargs['payload'] == {'isDeleted': True}
        assert kwargs['key'] == 'meta'

    def test_markActive_writes_meta_isDeleted_false(self):
        """MarkActive must set meta.isDeleted = False, not top-level isDeleted."""
        store = _make_store()

        store.markActive(['obj-1'])

        store.client.set_payload.assert_called_once()
        _, kwargs = store.client.set_payload.call_args
        assert kwargs['payload'] == {'isDeleted': False}
        assert kwargs['key'] == 'meta'

    def test_markDeleted_skips_when_collection_missing(self):
        """MarkDeleted is a no-op when the collection does not exist."""
        store = _make_store()

        with patch.object(type(store), 'doesCollectionExist', return_value=False):
            store.markDeleted(['obj-1'])

        store.client.set_payload.assert_not_called()

    def test_markActive_skips_when_collection_missing(self):
        """MarkActive is a no-op when the collection does not exist."""
        store = _make_store()

        with patch.object(type(store), 'doesCollectionExist', return_value=False):
            store.markActive(['obj-1'])

        store.client.set_payload.assert_not_called()


def test_trash_round_trip_preserves_metadata_with_real_qdrant():
    """The real client's local backend must preserve siblings under meta."""
    from copy import deepcopy
    from types import SimpleNamespace

    import pytest
    from qdrant_client import QdrantClient, models
    from ai.common.store.document_store import VectorStoreToolMixin

    if QdrantClient.__module__ != 'qdrant_client.qdrant_client':
        pytest.skip('requires the real qdrant-client, not the protocol mock')
    client = QdrantClient(':memory:')
    try:
        client.create_collection(
            'test-collection', vectors_config=models.VectorParams(size=2, distance=models.Distance.COSINE)
        )
        original = {
            1: {'content': 'first', 'meta': {'objectId': 'a', 'chunkId': 0, 'parent': '/a', 'isDeleted': False}},
            2: {'content': 'second', 'meta': {'objectId': 'a', 'chunkId': 1, 'parent': '/a', 'isDeleted': False}},
            3: {'content': 'other', 'meta': {'objectId': 'b', 'chunkId': 0, 'parent': '/b', 'isDeleted': False}},
        }
        client.upsert(
            'test-collection',
            points=[
                models.PointStruct(id=i, vector=[1.0, 0.0], payload=deepcopy(payload))
                for i, payload in original.items()
            ],
        )
        store = _make_store()
        store.client = client
        tools = VectorStoreToolMixin()
        tools.IGlobal = SimpleNamespace(store=store, expose_tools=True, allow_write=True)

        assert tools.soft_delete({'object_ids': ['a']})['success'] is True
        expected = deepcopy(original)
        for i in (1, 2):
            expected[i]['meta']['isDeleted'] = True
        assert {p.id: p.payload for p in client.retrieve(store.collection, ids=list(original))} == expected
        assert tools.objdir({})['paths'] == {'/b': 'b'}
        assert 'soft-deleted' in tools.get({'object_id': 'a'})['error']

        assert tools.restore({'object_ids': ['a']})['success'] is True
        assert {p.id: p.payload for p in client.retrieve(store.collection, ids=list(original))} == original
        assert tools.objdir({})['paths'] == {'/a': 'a', '/b': 'b'}
        assert [c['content'] for c in tools.get({'object_id': 'a'})['chunks']] == ['first', 'second']
    finally:
        client.close()
