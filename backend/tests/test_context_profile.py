from context_profile import derive_context_quality, derive_surface_kind, derive_target_type, has_meaningful_context, normalize_context


def test_derive_target_type_treats_agent_editors_as_ide():
    for app_name in ("Codex", "Antigravity", "Cloud Code"):
        assert derive_target_type({
            "app_name": app_name,
            "bundle_id": None,
            "window_title": "repo",
            "page_title": None,
            "url_host": None,
        }) == "ide"


def test_normalize_context_preserves_sanitized_browser_path():
    assert normalize_context({
        "app_name": "Google Chrome",
        "url_host": "chatgpt.com",
        "url_path": "/gpts/editor",
    }) == {
        "app_name": "Google Chrome",
        "bundle_id": None,
        "window_title": None,
        "page_title": None,
        "url_host": "chatgpt.com",
        "url_path": "/gpts/editor",
        "focused_field_role": None,
        "focused_field_subrole": None,
        "focused_field_label": None,
        "focused_field_placeholder": None,
        "code_file_name": None,
        "code_file_extension": None,
        "surface_kind": "generic",
    }


def test_context_quality_treats_url_path_as_browser_enrichment():
    quality = derive_context_quality({
        "app_name": "Google Chrome",
        "bundle_id": None,
        "window_title": "ChatGPT",
        "page_title": None,
        "url_host": None,
        "url_path": "/gpts/editor",
    })
    assert quality == "full"


def test_has_meaningful_context_accepts_url_path_only():
    assert has_meaningful_context({
        "app_name": "Unknown",
        "bundle_id": None,
        "window_title": None,
        "page_title": None,
        "url_host": None,
        "url_path": "/projects/current",
    }) is True


def test_derive_surface_kind_identifies_email_subject():
    assert derive_surface_kind({
        "app_name": "Google Chrome",
        "window_title": "Gmail",
        "focused_field_role": "AXTextField",
        "focused_field_placeholder": "Subject",
    }) == "email_subject"


def test_derive_surface_kind_identifies_multiline_email_body():
    assert derive_surface_kind({
        "app_name": "Google Chrome",
        "window_title": "Gmail",
        "focused_field_role": "AXTextArea",
        "focused_field_placeholder": "Compose email",
    }) == "email_body"


def test_derive_target_type_identifies_social_post_compose_surface():
    assert derive_target_type({
        "app_name": "Google Chrome",
        "url_host": "linkedin.com",
        "page_title": "LinkedIn",
        "focused_field_placeholder": "Start a post",
    }) == "social_post"


def test_derive_surface_kind_identifies_social_compose():
    assert derive_surface_kind({
        "app_name": "Google Chrome",
        "url_host": "threads.net",
        "focused_field_role": "AXTextArea",
        "focused_field_placeholder": "Write something",
    }) == "social_compose"


def test_normalize_context_infers_code_file_details_from_window_title():
    normalized = normalize_context({
        "app_name": "Cursor",
        "window_title": "parser.ts — SteerVox",
    })

    assert normalized["code_file_name"] == "parser.ts"
    assert normalized["code_file_extension"] == "ts"
