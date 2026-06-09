# Reporte ProGuide: v0.1.1 → v0.1.2

> Basado en pruebas reales sobre la app TestSprite Lab (React + Vite, login con
> `localStorage`). Cada punto tiene evidencia directa en código o comportamiento
> observado durante la ejecución de los 5 casos E2E.

---

## Resumen ejecutivo

La v0.1.2 resolvió **4 de 6 problemas críticos** identificados en v0.1.1.
El cambio de mayor impacto operativo fue preservar `data.user` por caso, lo que
redujo de **3 runs separados a 1** para cubrir los mismos 5 casos.
El problema de mayor retrabajo (**agente LLM sin acceso al DOM**) sigue abierto.

| # | Problema | v0.1.1 | v0.1.2 |
|---|----------|--------|--------|
| 1 | MCP no puede crear runs | ❌ | ❌ |
| 2 | Fuente de verdad oculta (`normalized_cases.json`) | ❌ | ⚠️ mejora parcial |
| 3 | Normalizador de markdown frágil y sin feedback | ❌ | ✅ |
| 4 | Agente LLM genera código sin ver el DOM | ❌ | ❌ |
| 5 | Una sola credencial global por run | ❌ | ✅ email; ⚠️ password |
| 6 | Runtime frágil + errores opacos | ❌ | ✅ |

---

## Lo que cambió en v0.1.2

### ✅ Causa #3 — Normalizador: `--dry-run` + fix del bug de substring

**Problema original:** el normalizador producía `go to /` silenciosamente para pasos
que no reconocía. El bug más grave: cualquier paso con la palabra "login" dentro (ej.
"login-email") disparaba la rama `submit form`. No había forma de ver la normalización
sin crear el run.

**Cambio v0.1.2:** se agregó `proguide create <file.md> --dry-run` que imprime cada
paso con `original_text → normalized_action + confidence` sin crear nada en disco.

**Verificado:**
```
"Ingresar el email valido"    -> enter valid email   ✅  (antes: go to /)
"Ingresar la contrasena valida" -> enter valid password ✅ (antes: go to /)
"Enviar el formulario"        -> submit form          ✅
"Hacer clic en el boton Cerrar sesión" -> click button Cerrar sesión ✅
```
El bug de substring "login" quedó corregido.

**Lo que falta:** `--dry-run` no avisa visualmente cuando la confianza baja o cuando
un paso cayó al fallback genérico. Habría que marcar esos pasos con una advertencia
explícita en la salida.

---

### ✅ Causa #5 — `data.user` por caso preservado (email)

**Problema original:** `cases_to_test_plan` descartaba `data.user`; la única
credencial era global por run (env vars). Los casos negativos con inputs distintos
(email mal formado, password < 6 chars) requerían runs separados.

**Cambio v0.1.2:** `_data_from_lines` parsea la sección `### Datos utilizados` del
markdown y construye `data.user` por caso; `cases_to_test_plan` lo preserva en el
`TestCase` y llega al payload del agente LLM.

**Verificado:** los 5 casos en un solo markdown con datos distintos por caso:
```markdown
## Caso 4: Email con formato invalido muestra error
### Datos utilizados
- email: qa-testsprite.dev   ← llega al agente como data.user.email
```
`normalized_cases.json` resultante:
```
caso_4_email_con_formato_invalido_muestra_error  data={'user': {'email': 'qa-testsprite.dev'}}
caso_5_contrasena_menor_a_6_caracteres_muestra_error  data={'user': {'email': 'qa@testsprite.dev'}}
```
**Resultado:** 1 run en lugar de 3 para los mismos 5 casos.

**Lo que falta:** el password sigue siendo solo global (env var). Se descarta de
`data_used` intencionalmente por seguridad (`_data_from_lines` ignora líneas con
"password/clave/secret"). El agente siempre usa `PROGUIDE_USER_PASSWORD`. Para casos
con passwords distintos sigue necesitándose un run por password, o una sintaxis
alternativa para passwords de prueba no productivos.

---

### ✅ Causa #6 — Runtime y errores opacos

**Problema original:** faltaba `pydantic` en el runtime gestionado; `proguide doctor`
reportaba "Runtime listo" (falso positivo); el fallo aparecía en mitad del run como
`inconclusive` con un traceback crudo de pytest.

**Cambio v0.1.2:** tres mejoras verificadas:

1. **`pydantic` es un check explícito en `doctor`:**
   ```json
   { "name": "pydantic", "ok": true, "version": "2.13.4" }
   ```
   Con `--fix` instala automáticamente las deps faltantes.

2. **Estado `setup_failed` separado de `inconclusive`:** el contador del run
   distingue `setup_failed` y el mensaje ya incluye
   `"Run proguide doctor --fix."` para guiar la acción.

3. **Mensajes de error accionables:** en v0.1.1 era `ENOENT` crudo; ahora:
   `"setup_failed: <razón>. See <log relativo>. Run proguide doctor --fix."`

---

### ⚠️ Causa #2 — Fuente de verdad (mejora parcial)

**Problema original:** `execute_run` regenera `test_plan.json` desde
`normalized_cases.json` en cada corrida, ignorando las ediciones manuales a
`plans/test_plan.json` o `prd/prd.yaml`.

**Cambio v0.1.2:** `list_runs` y `get_run` ya no fallan ni devuelven vacío para runs
sin `run.json`. Los runs legacy aparecen con `status: unknown` vía `legacyRunRecord`.
```
2026-06-05_09-03-54 | unknown |    ← antes: silencio o ENOENT
2026-06-04_16-54-35 | unknown |
2026-06-04_16-49-53 | unknown |
```

**Lo que falta:** la regeneración de `test_plan.json` en cada `execute` sigue siendo
el modelo. Quien edita `plans/` o `prd/` manualmente no lo ve reflejado. Falta o
documentarlo claramente o agregar una opción `--from-plan` que respete las ediciones.

---

## Lo que sigue sin cambiar

### ❌ Causa #1 — MCP no puede crear runs

**El problema:** `execute_run` requiere un `run_id` con `run.json` preexistente.
No hay tool `create_run` en el MCP; hay que salir al CLI (`proguide create`) y volver.

**Impacto:** desde Claude Code el flujo mínimo son dos pasos por fuera del MCP, lo
que rompe la ergonomía conversacional. Un agente que solo tiene acceso al MCP no
puede completar el ciclo solo.

**Lo que haría:** agregar `create_run(markdown, base_url, credentials?)` que devuelva
`run_id` + preview de casos normalizados, y opcionalmente `run_cases(...)` que haga
create + execute en una llamada.

---

### ❌ Causa #4 — Agente LLM genera código sin ver el DOM

**El problema:** `buildCodeGenerationPayload` arma el payload solo con
`steps`/`expected`/`data`. El agente adivina selectores. En la app de prueba adivinó
`get_by_label("Password")` (label real: "Contraseña") y `get_by_role("button",
name="Login")` (botón real: "Entrar"), lo que causó timeout en Playwright.

**Verificado en v0.1.2:** el prompt del agente y el payload son idénticos a v0.1.1.
No hubo cambio en esta área.

**Impacto:** sigue siendo el problema que más retrabajo genera. Sin API key para
verificar con la app real, no se puede saber si el agente mejoró por otros medios
(ej. ejemplos en el prompt), pero la arquitectura no cambió.

**Lo que haría:** antes de llamar al agente, abrir la URL de la ruta del caso con
Playwright headless, tomar un snapshot de accesibilidad (`page.accessibility.snapshot()`)
y agregarlo al payload. Con eso el agente tiene la lista de roles, labels y
`data-testid` reales y deja de adivinar. Es el mismo mecanismo que usa Playwright
codegen.

---

## Pendientes priorizados para v0.1.3

| Prioridad | Esfuerzo | Acción |
|-----------|----------|--------|
| **Alta** | Medio | Snapshot de accesibilidad/DOM al agente LLM antes de generar código |
| **Alta** | Bajo | `create_run` en el MCP para cerrar el flujo sin salir al CLI |
| Media | Bajo | `--dry-run` marcar visualmente pasos con confianza baja o fallback genérico |
| Media | Bajo | Sección `### Datos de prueba` soportar password no productivo con sintaxis explícita |
| Baja | Bajo | Opción `--from-plan` en `execute` para respetar ediciones manuales de `test_plan.json` |

---

## Apéndice: evidencia de la sesión

**Versión probada:** `@proguide/test 0.1.2`
**Instalación:** `npm install -g https://github.com/molivera-proguide/proguide-test/releases/download/v0.1.2/proguide-test-0.1.2.tgz`
**App bajo prueba:** `http://localhost:5173` (React + Vite, `pnpm.cmd dev`)
**Resultado:** 5 casos creados en 1 run (`proguide create casos_v2.md`);
normalizados correctamente sin parchear `normalized_cases.json` a mano.
La ejecución (`execute_run`) requiere API key para el agente — no verificada en esta sesión.
