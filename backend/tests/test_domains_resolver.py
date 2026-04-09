import pytest
from pydantic import ValidationError

from config.models import DomainsConfig
from domains.models import AppDomainDefault
from domains.resolver import resolve_domain


def test_domain_override_beats_global_pin():
    result = resolve_domain(
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "url_host": "project44.com",
            "window_title": "Shipment delay",
            "page_title": "Dashboard",
        },
        domains=DomainsConfig(
            mode="medical",
            app_domain_defaults=[
                AppDomainDefault(
                    id="shipping_host",
                    app_label="project44",
                    bundle_id=None,
                    url_host="project44.com",
                    app_name="Google Chrome",
                    domain_id="shipping",
                    enabled=True,
                )
            ],
        ),
    )

    assert result.domain_id == "shipping"
    assert result.source == "app_override"
    assert result.rule_id == "shipping_host"


def test_global_pin_beats_auto_rule():
    result = resolve_domain(
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "url_host": "project44.com",
            "window_title": "Shipment delay",
            "page_title": "Dashboard",
        },
        domains=DomainsConfig(mode="medical", app_domain_defaults=[]),
    )

    assert result.domain_id == "medical"
    assert result.source == "global_pin"


def test_auto_uses_starter_rule_when_no_override_or_pin():
    result = resolve_domain(
        context={
            "app_name": "Safari",
            "bundle_id": "com.apple.Safari",
            "url_host": "example.com",
            "window_title": "Shipment dashboard",
            "page_title": "Route overview",
        },
        domains=DomainsConfig(mode="auto", app_domain_defaults=[]),
    )

    assert result.domain_id == "shipping"
    assert result.source == "system_rule"
    assert result.rule_id == "shipping_shipment_title"


def test_off_mode_without_override_returns_no_domain():
    result = resolve_domain(
        context={
            "app_name": "Notes",
            "bundle_id": "com.apple.Notes",
            "window_title": "General notes",
            "page_title": None,
            "url_host": None,
        },
        domains=DomainsConfig(mode="off", app_domain_defaults=[]),
    )

    assert result.domain_id is None
    assert result.source == "none"


def test_app_domain_default_rejects_unknown_domain_id():
    with pytest.raises(ValidationError) as exc_info:
        AppDomainDefault(
            id="bogus",
            app_label="Bogus app",
            bundle_id=None,
            url_host=None,
            app_name="Bogus",
            domain_id="finance",  # type: ignore[arg-type]
            enabled=True,
        )

    message = str(exc_info.value)
    assert "finance" in message
    assert "shipping" in message and "medical" in message


def test_app_domain_default_normalizes_known_domain_id():
    override = AppDomainDefault(
        id="ship_one",
        app_label="Shipping app",
        bundle_id=None,
        url_host=None,
        app_name="Shipping",
        domain_id="SHIPPING",  # type: ignore[arg-type]
        enabled=True,
    )

    assert override.domain_id == "shipping"
