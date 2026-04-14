from pathlib import Path

from app_catalog import AppCatalog


def test_app_catalog_includes_macos_core_services_root_by_default():
    catalog = AppCatalog()

    assert Path("/System/Library/CoreServices") in catalog._roots
