import json
import sqlite3

from domains.models import DomainPackOverlay, ExampleEntry, GlossaryEntry, TemplateEntry
from domains.store import DomainMemoryStore


def test_domain_store_bootstraps_seed_packs(tmp_path):
    store = DomainMemoryStore(path=tmp_path / "domain_memory.sqlite3")

    packs = store.list_packs()
    pack_ids = {pack.id for pack in packs}

    assert pack_ids == {"shipping", "medical"}
    assert all(pack.glossary_count > 0 for pack in packs)
    assert all(pack.template_count > 0 for pack in packs)
    assert all(pack.example_count > 0 for pack in packs)
    assert all(pack.controls.default_format in {"auto", "paragraph"} for pack in packs)


def test_domain_store_import_and_export_overlay(tmp_path):
    store = DomainMemoryStore(path=tmp_path / "domain_memory.sqlite3")
    overlay = DomainPackOverlay(
        id="shipping",
        label="Shipping",
        description="Shipping and logistics workflows.",
        documentation_only=False,
        default_intent="shipment_update",
        glossary=[
            GlossaryEntry(term="Blue Anchor Lines", aliases=["blue anchor"], kind="carrier", priority=9),
        ],
        templates=[
            TemplateEntry(
                id="shipment_update_compact",
                label="Compact shipment update",
                intent="shipment_update",
                body="Status: {{status}}\nETA: {{eta}}\nNext step: {{next_step}}",
                priority=9,
            ),
        ],
        examples=[
            ExampleEntry(
                id="shipment_update_example",
                label="Shipment update example",
                intent="shipment_update",
                output="Shipment update: ETA moved to Friday due to carrier congestion.",
                priority=9,
            ),
        ],
        styles={"tone": "concise", "audience": "customer-facing"},
        controls={
            "default_format": "table",
            "default_surface_behavior": "summary",
            "tone": "concise",
            "audience": "operations",
        },
    )

    summary = store.import_overlay("shipping", overlay)
    assert summary.overlay_present is True

    runtime_pack = store.get_runtime_pack("shipping")
    assert runtime_pack is not None
    assert any(entry.term == "Blue Anchor Lines" for entry in runtime_pack.glossary)
    assert any(template.id == "shipment_update_compact" for template in runtime_pack.templates)
    assert runtime_pack.controls.default_format == "table"

    exported = store.export_overlay("shipping")
    assert exported.domain_id == "shipping"
    assert exported.overlay.id == "shipping"
    assert exported.overlay.styles == {"tone": "concise", "audience": "customer-facing"}
    assert exported.overlay.controls["default_surface_behavior"] == "summary"
    assert [entry.term for entry in exported.overlay.glossary] == ["Blue Anchor Lines"]
    assert [template.id for template in exported.overlay.templates] == ["shipment_update_compact"]
    assert [example.id for example in exported.overlay.examples] == ["shipment_update_example"]

    details = store.list_pack_details()
    shipping = next(detail for detail in details if detail.id == "shipping")
    assert any(entry.term == "Blue Anchor Lines" for entry in shipping.overlay.glossary)
    assert any(entry.term == "Blue Anchor Lines" for entry in shipping.effective.glossary)
    assert len(shipping.effective.glossary) > len(shipping.overlay.glossary)


def test_domain_store_upgrade_preserves_legacy_overlay_without_controls_table(tmp_path):
    path = tmp_path / "domain_memory.sqlite3"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE packs (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                description TEXT NOT NULL,
                documentation_only INTEGER NOT NULL DEFAULT 0,
                default_intent TEXT NOT NULL,
                overlay_present INTEGER NOT NULL DEFAULT 0,
                last_imported_at TEXT
            );
            CREATE TABLE glossary_terms (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                term TEXT NOT NULL,
                aliases_json TEXT NOT NULL,
                kind TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (domain_id, source, term)
            );
            CREATE TABLE templates (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                id TEXT NOT NULL,
                label TEXT NOT NULL,
                intent TEXT NOT NULL,
                body TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (domain_id, source, id)
            );
            CREATE TABLE examples (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                id TEXT NOT NULL,
                label TEXT NOT NULL,
                intent TEXT NOT NULL,
                output TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (domain_id, source, id)
            );
            CREATE TABLE styles (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (domain_id, source, key)
            );
            """
        )
        conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '1')")
        conn.execute(
            """
            INSERT INTO packs (id, label, description, documentation_only, default_intent, overlay_present, last_imported_at)
            VALUES ('shipping', 'Shipping', 'Shipping and logistics workflows.', 0, 'shipment_update', 1, '2026-03-20T12:00:00Z')
            """
        )
        conn.execute(
            """
            INSERT INTO glossary_terms (domain_id, source, term, aliases_json, kind, priority)
            VALUES ('shipping', 'overlay', 'Blue Anchor Legacy', ?, 'carrier', 10)
            """,
            (json.dumps(["blue anchor legacy"]),),
        )
        conn.execute(
            """
            INSERT INTO styles (domain_id, source, key, value)
            VALUES ('shipping', 'overlay', 'tone', 'legacy-concise')
            """
        )
        conn.commit()

    store = DomainMemoryStore(path=path)

    exported = store.export_overlay("shipping")
    runtime_pack = store.get_runtime_pack("shipping")

    assert exported.overlay.styles == {"tone": "legacy-concise"}
    assert [entry.term for entry in exported.overlay.glossary] == ["Blue Anchor Legacy"]
    assert runtime_pack is not None
    assert any(entry.term == "Blue Anchor Legacy" for entry in runtime_pack.glossary)
    assert runtime_pack.controls.default_format in {"auto", "paragraph"}


def test_domain_store_recovers_from_corrupt_database(tmp_path):
    database_path = tmp_path / "domain_memory.sqlite3"
    database_path.write_text("not a sqlite database", encoding="utf-8")

    store = DomainMemoryStore(path=database_path)

    assert database_path.exists()
    sqlite3.connect(database_path).close()
    assert {pack.id for pack in store.list_packs()} == {"shipping", "medical"}
