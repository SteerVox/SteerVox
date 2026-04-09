from config.models import PrivacyConfig, SensitiveTargetRule
from privacy_rules import minimize_context_fields, resolve_sensitive_targets, suppress_external_text


def test_sensitive_target_resolution_matches_host_and_mode():
    resolution = resolve_sensitive_targets(
        {
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "url_host": "athenahealth.com",
        },
        PrivacyConfig(
            minimize_sensitive_context=True,
            sensitive_targets=[
                SensitiveTargetRule(
                    id="medical_host",
                    app_label="athenahealth",
                    bundle_id=None,
                    url_host="athenahealth.com",
                    app_name="Google Chrome",
                    mode="minimize_context",
                    enabled=True,
                ),
                SensitiveTargetRule(
                    id="medical_external",
                    app_label="athenahealth",
                    bundle_id=None,
                    url_host="athenahealth.com",
                    app_name="Google Chrome",
                    mode="block_external_text",
                    enabled=True,
                ),
            ],
        ),
    )

    assert resolution.minimize_context is True
    assert resolution.block_external_text is True
    assert len(resolution.matched_rules) >= 2
    assert {"medical_host", "medical_external"}.issubset({rule.id for rule in resolution.matched_rules})


def test_minimize_context_fields_trims_browser_metadata():
    minimized = minimize_context_fields(
        {
            "app_name": "Google Chrome",
            "window_title": "Patient chart",
            "page_title": "athenahealth",
            "url_path": "/patients/123",
            "focused_field_label": "Assessment",
        }
    )

    assert minimized["app_name"] == "Google Chrome"
    assert minimized["window_title"] is None
    assert minimized["page_title"] is None
    assert minimized["url_path"] is None
    assert minimized["focused_field_label"] is None


def test_suppress_external_text_clears_selection_and_clipboard_when_enabled():
    result = suppress_external_text(
        selection_text="selected",
        selection_truncated=True,
        clipboard_text="copied",
        clipboard_truncated=True,
        suppress=True,
    )
    assert result == {
        "selection_text": None,
        "selection_truncated": False,
        "clipboard_text": None,
        "clipboard_truncated": False,
    }


def test_builtin_secure_field_rules_apply_without_custom_configuration():
    resolution = resolve_sensitive_targets(
        {
            "app_name": "Safari",
            "focused_field_label": "Password",
        },
        PrivacyConfig(),
    )

    assert resolution.minimize_context is True
    assert resolution.block_external_text is True


def test_builtin_medical_rules_reduce_context_even_without_domain_mode():
    resolution = resolve_sensitive_targets(
        {
            "app_name": "Epic",
            "window_title": "Patient chart",
        },
        PrivacyConfig(),
    )

    assert resolution.minimize_context is True
    assert resolution.block_external_text is True
