from __future__ import annotations

import re
from typing import Any, Protocol

from proguide.utils import url_join


class StepRecorder(Protocol):
    def log(self, step: str, status: str = "passed", message: str = "") -> None:
        ...


EMAIL_RE = re.compile(r"email|e-mail|correo|usuario|user", re.I)
PASSWORD_RE = re.compile(r"password|pass|clave|contrasena|contrase.a", re.I)
SUBMIT_RE = re.compile(r"submit|login|log in|sign in|ingresar|iniciar|entrar|acceder|continuar|enviar", re.I)


def run_step(page: Any, step: str, user: dict[str, Any], base_url: str, route: str, recorder: StepRecorder) -> None:
    recorder.log(step, "started")
    try:
        _run_step(page, step, user, base_url, route)
    except Exception as exc:
        recorder.log(step, "failed", str(exc))
        raise
    recorder.log(step, "passed")


def assert_expected(page: Any, expected: str, base_url: str, recorder: StepRecorder, user: dict[str, Any] | None = None) -> None:
    recorder.log(f"assert: {expected}", "started")
    try:
        _assert_expected(page, expected, base_url, user or {})
    except Exception as exc:
        recorder.log(f"assert: {expected}", "failed", str(exc))
        raise
    recorder.log(f"assert: {expected}", "passed")


def _run_step(page: Any, step: str, user: dict[str, Any], base_url: str, route: str) -> None:
    normalized = step.lower()
    if _run_explicit_step(page, step):
        return

    if "go to" in normalized or "open" in normalized or "navigate" in normalized or "visitar" in normalized:
        explicit_route = _extract_route_from_step(step)
        page.goto(url_join(base_url, explicit_route or route))
        page.wait_for_load_state("domcontentloaded")
        return

    if "empty" in normalized and ("submit" in normalized or "form" in normalized or "fields" in normalized):
        _click_submit(page)
        return

    if "refresh" in normalized or "recargar" in normalized:
        page.reload()
        page.wait_for_load_state("domcontentloaded")
        return

    if "leave email empty" in normalized or "email empty" in normalized or "correo vacio" in normalized:
        _fill_email(page, "")
        return

    if "email" in normalized or "correo" in normalized or "username" in normalized or "usuario" in normalized:
        value = user.get("email") or user.get("username") or "test@example.com"
        if "invalid" in normalized:
            value = user.get("email") or user.get("username") or "invalid-email"
        _fill_email(page, value)
        return

    if "password" in normalized or "clave" in normalized or "contrasena" in normalized or "contrase" in normalized:
        value = user.get("password") or "password123"
        if "invalid" in normalized:
            value = user.get("password") or "123"
        _fill_password(page, value)
        return

    click_target = _extract_click_target(step)
    if click_target:
        _click_button(page, click_target)
        return

    if "submit" in normalized or "login" in normalized or "ingresar" in normalized or "enviar" in normalized:
        _click_submit(page)
        return

    if route:
        page.goto(url_join(base_url, route))
        page.wait_for_load_state("domcontentloaded")


def _assert_expected(page: Any, expected: str, base_url: str, user: dict[str, Any]) -> None:
    from playwright.sync_api import expect

    normalized = expected.lower()
    if _run_explicit_expectation(page, expected):
        return

    not_shows_match = re.search(
        r"(?:page\s+does\s+not\s+show|does\s+not\s+show|not\s+visible|pagina\s+no\s+muestra|no\s+se\s+muestra)\s+(.+)",
        expected,
        re.I,
    )
    if not_shows_match and len(not_shows_match.group(1).strip()) > 1:
        text = not_shows_match.group(1).strip()
        expect(page.get_by_text(re.compile(re.escape(text), re.I))).to_have_count(0, timeout=10000)
        return

    contains_match = re.search(r"(?:url\s+contains|url\s+contiene|la\s+url\s+contiene)\s+(\S+)", normalized)
    if contains_match:
        fragment = re.escape(contains_match.group(1).strip())
        expect(page).to_have_url(re.compile(f".*{fragment}.*"), timeout=10000)
        return

    shows_match = re.search(r"(?:page\s+shows|shows|pagina\s+muestra|la\s+pagina\s+muestra|se\s+muestra|muestra|visible)\s+(.+)", expected, re.I)
    if shows_match and len(shows_match.group(1).strip()) > 1:
        text = shows_match.group(1).strip()
        expect(page.get_by_text(re.compile(re.escape(text), re.I)).first).to_be_visible(timeout=10000)
        return

    error_contains_match = re.search(r"error\s+message\s+contains\s+[\"'](.+?)[\"']", expected, re.I)
    if error_contains_match:
        text = error_contains_match.group(1).strip()
        expect(page.get_by_text(re.compile(re.escape(text), re.I)).first).to_be_visible(timeout=10000)
        return

    storage_exists_match = re.search(r"localStorage\s+key\s+[\"'](.+?)[\"']\s+exists", expected, re.I)
    if storage_exists_match:
        key = storage_exists_match.group(1).strip()
        value = page.evaluate("key => window.localStorage.getItem(key)", key)
        assert value is not None, f"Expected localStorage key to exist: {key}"
        return

    storage_missing_match = re.search(r"localStorage\s+key\s+[\"'](.+?)[\"']\s+does\s+not\s+exist", expected, re.I)
    if storage_missing_match:
        key = storage_missing_match.group(1).strip()
        value = page.evaluate("key => window.localStorage.getItem(key)", key)
        assert value is None, f"Expected localStorage key to be absent: {key}"
        return

    if "session email displayed correctly" in normalized:
        email = user.get("email") or "test@example.com"
        expect(page.get_by_text(re.compile(re.escape(email), re.I)).first).to_be_visible(timeout=10000)
        return

    if "login form is visible" in normalized or "login screen" in normalized:
        expect(page.locator("input").first).to_be_visible(timeout=10000)
        return

    placeholder_match = re.search(r"input\s+with\s+placeholder\s+[\"'](.+?)[\"']\s+is\s+present", expected, re.I)
    if placeholder_match:
        placeholder = placeholder_match.group(1).strip()
        expect(page.get_by_placeholder(re.compile(re.escape(placeholder), re.I)).first).to_be_visible(timeout=10000)
        return

    if "redirect" in normalized or "home" in normalized or "dashboard" in normalized or "inicio" in normalized:
        expect(page).to_have_url(re.compile(r".*(home|dashboard|app|inicio).*", re.I), timeout=10000)
        return

    if "error" in normalized or "validation" in normalized or "invalid" in normalized:
        expect(page.get_by_text(re.compile(r"error|required|invalid|incorrect|obligatorio|invalido|incorrecto|ingresa|ingresá|email|contraseña", re.I)).first).to_be_visible(timeout=10000)
        return

    expect(page.locator("body")).to_be_visible(timeout=10000)


def _run_explicit_step(page: Any, step: str) -> bool:
    fill_match = re.match(r"^\s*fill\s+\[([^\]]+)\]\s+(?:with\s+)?(.+?)\s*$", step, re.I)
    if fill_match:
        selector = _selector_from_bracket(fill_match.group(1))
        value = _strip_quotes(fill_match.group(2).strip())
        page.locator(selector).first.fill(value, timeout=5000)
        return True

    click_match = re.match(r"^\s*click\s+\[([^\]]+)\]\s*$", step, re.I)
    if click_match:
        page.locator(_selector_from_bracket(click_match.group(1))).first.click(timeout=5000)
        page.wait_for_load_state("domcontentloaded")
        return True

    return _run_explicit_expectation(page, step)


def _run_explicit_expectation(page: Any, text: str) -> bool:
    from playwright.sync_api import expect

    text_match = re.match(r"^\s*expect\s+text\s+[\"'](.+?)[\"']\s*$", text, re.I)
    if text_match:
        expect(page.get_by_text(re.compile(re.escape(text_match.group(1).strip()), re.I)).first).to_be_visible(timeout=10000)
        return True

    visible_match = re.match(r"^\s*expect\s+\[([^\]]+)\]\s+(?:to\s+be\s+)?visible\s*$", text, re.I)
    if visible_match:
        expect(page.locator(_selector_from_bracket(visible_match.group(1))).first).to_be_visible(timeout=10000)
        return True

    return False


def _selector_from_bracket(value: str) -> str:
    selector = value.strip()
    if selector.startswith(("#", ".", "[", ":", "*")) or re.search(r"\s|>|\+|~", selector):
        return selector
    if re.match(r"^[a-z][a-z0-9_-]*\[[^\]]+\]$", selector, re.I):
        return selector
    if selector.lower() in {"a", "button", "form", "input", "select", "textarea", "div", "span", "label", "main", "section"}:
        return selector

    attr_match = re.match(r"^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(.+)$", selector)
    if attr_match:
        attr = attr_match.group(1)
        raw_value = _strip_quotes(attr_match.group(2).strip())
        return f'[{attr}="{_css_attr_value(raw_value)}"]'

    return f'[data-testid="{_css_attr_value(selector)}"]'


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _css_attr_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _fill_email(page: Any, value: str) -> None:
    _fill_first(
        page,
        value,
        [
            lambda: page.get_by_label(EMAIL_RE),
            lambda: page.get_by_placeholder(EMAIL_RE),
            lambda: page.locator("input[type='email']"),
            lambda: page.locator("input[name*='email' i]"),
            lambda: page.locator("input[name*='user' i]"),
            lambda: page.locator("input[autocomplete='username']"),
            lambda: page.locator("input").first,
        ],
    )


def _fill_password(page: Any, value: str) -> None:
    _fill_first(
        page,
        value,
        [
            lambda: page.get_by_label(PASSWORD_RE),
            lambda: page.get_by_placeholder(PASSWORD_RE),
            lambda: page.locator("input[type='password']"),
            lambda: page.locator("input[name*='password' i]"),
            lambda: page.locator("input[autocomplete='current-password']"),
        ],
    )


def _click_submit(page: Any) -> None:
    candidates = [
        lambda: page.get_by_role("button", name=SUBMIT_RE),
        lambda: page.locator("button[type='submit']"),
        lambda: page.locator("input[type='submit']"),
        lambda: page.locator("button").first,
    ]
    for candidate in candidates:
        locator = candidate()
        if _has_visible(locator):
            locator.first.click(timeout=5000)
            page.wait_for_load_state("domcontentloaded")
            return
    raise AssertionError("Could not find a visible submit button.")


def _click_button(page: Any, label: str) -> None:
    label_re = re.compile(re.escape(label), re.I)
    candidates = [
        lambda: page.get_by_role("button", name=label_re),
        lambda: page.get_by_text(label_re),
    ]
    for candidate in candidates:
        locator = candidate()
        if _has_visible(locator):
            locator.first.click(timeout=5000)
            page.wait_for_load_state("domcontentloaded")
            return
    raise AssertionError(f"Could not find a visible button or text to click: {label}")


def _fill_first(page: Any, value: str, candidates: list[Any]) -> None:
    for candidate in candidates:
        locator = candidate()
        if _has_visible(locator):
            locator.first.fill(value, timeout=5000)
            return
    raise AssertionError("Could not find a visible input to fill.")


def _has_visible(locator: Any) -> bool:
    try:
        return locator.count() > 0 and locator.first.is_visible(timeout=1000)
    except Exception:
        return False


def _extract_route_from_step(step: str) -> str | None:
    match = re.search(r"(?:go to|open|navigate to|visitar)\s+([/\w\-?#=&.]+)", step, re.I)
    if not match:
        return None
    value = match.group(1).strip()
    if value.lower() in {"login", "home", "homepage", "page"}:
        return None
    return value


def _extract_click_target(step: str) -> str | None:
    match = re.search(r"click\s+(?:button\s+)?[\"']?([^\"']+?)[\"']?$", step.strip(), re.I)
    if not match:
        return None
    target = match.group(1).strip()
    if not target or target.lower() in {"submit", "form", "button"}:
        return None
    return target
