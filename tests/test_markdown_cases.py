from __future__ import annotations

from proguide.markdown_cases import cases_to_test_plan, mask_secret_text, parse_markdown_cases, read_markdown_text
from proguide.models import AutomationState


def test_parses_semistructured_markdown_case() -> None:
    markdown = """
# Casos de prueba

## Caso 1: Login valido
Prioridad: alta

### Precondiciones
- Usuario activo

### Datos utilizados
- Usuario: qa@example.com
- Password: secreto

### Pasos
1. Ir a /login
2. Completar usuario valido
3. Completar password valido
4. Hacer clic en Ingresar

### Resultado esperado
- La URL contiene /home
- La pagina muestra Dashboard
"""

    cases = parse_markdown_cases(markdown)

    assert len(cases) == 1
    assert cases[0].id == "caso_1_login_valido"
    assert cases[0].priority == "alta"
    assert cases[0].automation_state == AutomationState.ready
    assert cases[0].route == "/login"
    assert cases[0].data_used == ["Usuario: qa@example.com", "Password: ******"]
    assert cases[0].data == {"user": {"email": "qa@example.com"}}
    assert [step.normalized_action for step in cases[0].executable_steps] == [
        "go to /login",
        "enter valid email",
        "enter valid password",
        "click button Ingresar",
    ]
    assert "secreto" not in cases[0].original_markdown


def test_marks_generic_expected_result_for_review() -> None:
    markdown = """
## Caso 1: Flujo generico

### Pasos
- Ir a /home

### Resultado esperado
- Funciona correctamente
"""

    cases = parse_markdown_cases(markdown)

    assert cases[0].automation_state == AutomationState.needs_review
    assert "generico" in cases[0].state_reason


def test_builds_test_plan_from_ready_cases_only() -> None:
    markdown = """
## Caso 1: Listo

### Pasos
- Ir a /home

### Resultado esperado
- La pagina muestra Dashboard

## Caso 2: Revisar

### Pasos
- Ir a /home

### Resultado esperado
- Funciona correctamente
"""
    cases = parse_markdown_cases(markdown)

    plan = cases_to_test_plan(cases, source_md="source.md")

    assert [case.id for case in plan.cases] == ["caso_1_listo"]
    assert plan.cases[0].route == "/home"
    assert plan.cases[0].expected == ["La pagina muestra Dashboard"]


def test_ignores_section_headings_and_maps_esperado_label() -> None:
    markdown = """
# E2E

## 0. Entorno
- Base URL: http://localhost:3000

## 1. Autenticacion

### TC-001 Login valido
Pasos:
1. Ir a /login
2. Ingresar usuario valido
Esperado:
- La pagina muestra Dashboard
---

### TC-002 Logout
Pasos:
- Abrir /home
- Hacer clic en Salir
**Esperado:** La URL contiene /login
"""

    cases = parse_markdown_cases(markdown)

    assert [case.title for case in cases] == ["Login valido", "Logout"]
    assert [case.route for case in cases] == ["/login", "/home"]
    assert cases[0].expected_results == ["La pagina muestra Dashboard"]
    assert cases[1].expected_results == ["La URL contiene /login"]
    assert cases[0].executable_steps[1].normalized_action == "enter valid email"
    assert all("Esperado" not in step for case in cases for step in case.original_steps)


def test_masks_secret_lines_without_masking_password_steps() -> None:
    text = "Password: secreto\nCompletar password valido"

    assert mask_secret_text(text) == "Password: ******\nCompletar password valido"


def test_reads_windows_1252_markdown_without_replacement_characters(tmp_path) -> None:
    source = tmp_path / "cases.md"
    source.write_bytes(
        b"## \x95 Mostrar login cuando no hay sesi\xf3n\r\n\r\n"
        b"### Pasos\r\n"
        b"- Ir a /login\r\n\r\n"
        b"### Resultado esperado\r\n"
        b"- La pagina muestra Login\r\n"
    )

    markdown = read_markdown_text(source)
    cases = parse_markdown_cases(markdown)

    assert "\ufffd" not in markdown
    assert cases[0].title == "Mostrar login cuando no hay sesi\u00f3n"


def test_test_plan_keeps_safe_case_data_without_secrets() -> None:
    markdown = """
## Caso 1: Login invalido

### Datos utilizados
- Email: bad-email
- Password: secreto
- Documento: 123

### Pasos
- Ir a /login
- Completar email invalido
- Completar password corto

### Resultado esperado
- La pagina muestra error
"""

    plan = cases_to_test_plan(parse_markdown_cases(markdown), source_md="source.md")

    assert plan.cases[0].data["user"]["email"] == "bad-email"
    assert plan.cases[0].data["documento"] == "123"
    assert "secreto" not in str(plan.model_dump())
    assert plan.cases[0].steps[1:] == ["enter invalid email", "enter invalid password"]


def test_test_plan_allows_explicit_test_password_data() -> None:
    markdown = """
## Caso 1: Password corto

### Datos utilizados
- Email: qa@example.com
- Password de prueba: 12345
- Password: secreto-real

### Pasos
- Ir a /login
- Completar password corto

### Resultado esperado
- La pagina muestra error
"""

    plan = cases_to_test_plan(parse_markdown_cases(markdown), source_md="source.md")

    assert plan.cases[0].data["user"] == {"email": "qa@example.com", "password": "12345"}
    assert "secreto-real" not in str(plan.model_dump())


def test_keeps_explicit_normalizer_steps() -> None:
    markdown = """
## Caso 1: Selectores explicitos

### Pasos
- fill [data-testid=email] with qa@example.com
- click [data-testid=submit]

### Resultado esperado
- expect text "Dashboard"
"""

    cases = parse_markdown_cases(markdown)

    assert [step.normalized_action for step in cases[0].executable_steps] == [
        "fill [data-testid=email] with qa@example.com",
        "click [data-testid=submit]",
    ]
    assert cases[0].route == "/"
    assert cases[0].executable_steps[0].confidence == 0.95


def test_normalizes_natural_language_steps_with_explicit_selectors() -> None:
    markdown = """
## Caso 1: Badge de carrito

### Pasos
- Ir a /checkout
- Verificar que [data-testid="cart-badge-count"] muestra 1

### Resultado esperado
- El badge muestra 1 producto
"""

    cases = parse_markdown_cases(markdown)
    plan = cases_to_test_plan(cases, source_md="source.md")

    assert cases[0].route == "/checkout"
    assert cases[0].executable_steps[1].normalized_action == 'expect [data-testid="cart-badge-count"] to contain text "1"'
    assert cases[0].executable_steps[1].confidence == 0.95
    assert plan.cases[0].route == "/checkout"
    assert plan.cases[0].steps[1] == 'expect [data-testid="cart-badge-count"] to contain text "1"'
