"""Astra directory queries must exclude trash before grouping and paging."""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.mark.parametrize('parent', [None, '/documents'])
def test_paths_filter_trash_before_grouping_and_paging(parent):
    path = Path(__file__).resolve().parents[2] / 'src/nodes/store_astra/astra_db.py'
    with patch.dict(sys.modules, {name: MagicMock() for name in ('astrapy', 'astrapy.data_types', 'astrapy.info')}):
        spec = importlib.util.spec_from_file_location('astra_paths_under_test', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

    store = module.Store.__new__(module.Store)
    store._doesCollectionExist = lambda: True
    store.database = MagicMock()
    collection = store.database.get_collection.return_value
    collection.aggregate.return_value = [{'_id': '/documents', 'objectId': 'doc'}]

    assert store.getPaths(parent=parent, offset=3, limit=2) == {'/documents': 'doc'}
    pipeline = collection.aggregate.call_args.args[0]
    expected = {'meta.chunkId': 0, 'meta.isDeleted': False}
    if parent is not None:
        expected['meta.parent'] = parent
    assert pipeline[0] == {'$match': expected}
    assert '$group' in pipeline[1]
    assert pipeline[2:] == [{'$skip': 3}, {'$limit': 2}]
