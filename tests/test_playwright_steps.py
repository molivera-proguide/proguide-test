from __future__ import annotations

from proguide.playwright_steps import _extract_click_target, _extract_route_from_step, _selector_from_bracket


def test_extract_route_from_step() -> None:
    assert _extract_route_from_step("go to /login") == "/login"
    assert _extract_route_from_step("open /dashboard?tab=home") == "/dashboard?tab=home"


def test_extract_click_target() -> None:
    assert _extract_click_target('click button "Login valido"') == "Login valido"
    assert _extract_click_target("click Persistencia local") == "Persistencia local"
    assert _extract_click_target("click submit") is None


def test_selector_from_explicit_brackets() -> None:
    assert _selector_from_bracket("data-testid=login-email") == '[data-testid="login-email"]'
    assert _selector_from_bracket("#submit") == "#submit"
    assert _selector_from_bracket("login-button") == '[data-testid="login-button"]'


def test_assert_expected_accepts_user_argument_shape() -> None:
    # Regression guard for generated tests passing user context into assert_expected.
    from inspect import signature
    from proguide.playwright_steps import assert_expected

    assert "user" in signature(assert_expected).parameters
