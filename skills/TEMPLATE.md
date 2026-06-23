# Plantilla de caso de prueba ProGuide

Copiar esta estructura por cada caso. Un archivo markdown puede contener varios casos
separados por `---`.

```markdown
# TC-XXX: [Título descriptivo de la funcionalidad bajo prueba]

**Priority:** Critical | High | Medium | Low
**Description:** [Qué verifica el caso y por qué importa, en 1-2 oraciones.]
**Route:** /[ruta-inicial-del-caso]

**Preconditions:**
- La aplicación está corriendo en [URL base]
- [Usuario/rol necesario y cómo se obtiene]
- [Estado de datos requerido, ej: "el producto X tiene stock disponible"]

**Data:**
- campo_1: valor
- campo_2: valor
- test password: valor-no-productivo-si-aplica

**Steps:**
1. /[ruta-inicial-del-caso]
2. click [data-testid="[testid]"]
3. fill [name="[field_name]"] with "[valor]"
4. expect [data-testid="[testid]"] to contain text "[texto esperado]"
5. expect text "[texto único en la página]"

**Expected Results:**
- [Resultado observable 1 — debe ser verificable en pantalla]
- [Resultado observable 2]
```

## Variante para UI con SSO multi-app lento

Usar este patrón cuando el flujo salta entre dos frontends o valida token en TST
durante varios minutos.

```markdown
# TC-XXX: [Flujo con SSO intermedio]

**Priority:** High
**Description:** Verifica el flujo end-to-end entre [app origen] y [app destino].
**Route:** /login

**Data:**
- username: [usuario-no-productivo]
- test password: [password-no-productivo]

**Steps:**
1. set test timeout to 900 seconds
2. Ir a /login
3. fill #username with "[usuario-no-productivo]"
4. fill #password with "[password-no-productivo]"
5. click button "Acceder"
6. click listitem "Módulo X"
7. click text "Sub-item Y"
8. wait 30 seconds
9. expect text "[texto único esperado]"

**Expected Results:**
- La segunda aplicación queda autenticada y muestra [texto único esperado]
```

## Plantilla para API REST estructurada

Markdown tambien soporta flows API multi-step. Usa URLs absolutas cuando un step pega
a un servicio distinto del `base_url`.

```markdown
# TC-API-XXX: [Flujo API cross-service]

**Priority:** High
**Type:** API
**Route:** /[ruta-principal-o-final]

**Steps:**
1. POST https://api-user.tst.proguidemc.com/user/login con body {"username":"{{username}}","password":"{{password}}"} — capturar campo token
2. GET /ruta-del-endpoint con header Authorization: Bearer {{token}}

**Expected Results:**
- Status 200
- body.estado = OK
```

Usar esta forma cuando el caso no necesita UI. Para flujos con login/token, poner todos
los requests dentro del mismo caso y capturar variables con `captures`.

```json
{
  "type": "api",
  "title": "Login y perfil autenticado",
  "requests": [
    {
      "id": "login",
      "method": "POST",
      "path": "https://api-user.tst.proguidemc.com/user/login",
      "body": {
        "email": "{{email}}",
        "password": "{{password}}"
      },
      "expected_status": 200,
      "assertions": [{ "path": "access_token", "exists": true }],
      "captures": { "access_token": "access_token" }
    },
    {
      "id": "profile",
      "method": "GET",
      "path": "/profile",
      "headers": { "authorization": "Bearer {{access_token}}" },
      "expected_status": 200,
      "assertions": [
        { "path": "email", "equals": "qa@example.test" },
        { "path": "roles", "isArray": true }
      ]
    }
  ]
}
```

## Checklist antes de enviar el caso

- [ ] Cada paso ejecuta UNA sola acción
- [ ] Si es API, usar `type: "api"` con `request`/`requests`, no pasos de UI
- [ ] Si es API autenticada, capturar token con `captures` y reutilizar `{{variable}}`
- [ ] Si es API cross-service, usar URL absoluta en el step/request del servicio externo
- [ ] Si es API, usar solo aserciones soportadas: `status`, `ok`, `header`, `body_contains`, `equals`, `exists`, `contains`, `isArray`
- [ ] Si el body raiz es array, usar `{ "path": "$", "isArray": true }`
- [ ] Si crea recursos (`register`, `orders`, `products`), usar datos idempotentes o cleanup
- [ ] Si es API y falla en local, usar `debug: true` solo cuando sea aceptable exponer el request real en evidencia
- [ ] El caso tiene `Route` si la ruta inicial es conocida
- [ ] La navegación usa un paso `/ruta` o `Ir a /ruta`, no `Navigate to /ruta`
- [ ] Los clicks, fills y asserts críticos usan DSL explícito: `click [selector]`, `fill [selector] with`, `expect [selector]...` o `expect text "..."`
- [ ] Todos los textos de botones/labels están entre comillas y copiados literal de la UI real (app en vivo, captura o código si está disponible)
- [ ] Las verificaciones usan texto único (no precios/números que se repiten en la página)
- [ ] Los pasos sobre filas/listas indican el contexto ("In the X row...")
- [ ] Si hay SSO multi-app lento, el primer paso es `set test timeout to 900 seconds`
- [ ] Si dos casos comparten usuario SSO, se ejecutarán en runs separados
- [ ] Si el resultado depende de una API lenta, hay `wait N seconds` antes del assert final
- [ ] No hay pasos condicionales ("si aparece...")
- [ ] El caso es autocontenido (incluye su propio login/setup)
- [ ] Los datos están en la sección Data
- [ ] Pasos en inglés, título/descripción en el idioma del equipo

## Ejemplo (e-commerce genérico, reglas aplicadas)

```markdown
# TC-001: Flujo completo de compra – checkout multi-paso

**Priority:** Critical
**Description:** Verifica el flujo end-to-end de compra: login, agregar producto al
carrito y completar el checkout hasta la confirmación de orden.
**Route:** /

**Preconditions:**
- La aplicación está corriendo en http://localhost:5173
- El producto "AuraSound ANC Wireless" tiene stock disponible

**Data:**
- product_name: AuraSound ANC Wireless
- shipping_name: John Doe
- shipping_email: john@test.com
- card_number: 4111111111111111

**Steps:**
1. /
2. click [data-testid="login-link"]
3. click [data-testid="quick-login-customer"]
4. expect text "Log Out"
5. In the catalog, click on the product card titled "AuraSound ANC Wireless"
6. click [data-testid="detail-add-to-cart-btn"]
7. expect [data-testid="cart-badge-count"] to contain text "1"
8. click [data-testid="cart-btn"]
9. expect text "AuraSound ANC Wireless"
10. Click the "Proceed to Checkout" button
11. Fill the "Full Name" field with "John Doe"
12. Fill the "Email" field with "john@test.com"
13. Click the "Continue" button
14. Fill the "Card Number" field with "4111111111111111"
15. Click the "Place Order" button
16. expect text "Order"

**Expected Results:**
- El login autentica correctamente
- El badge del carrito muestra 1 tras agregar el producto
- El checkout avanza sin errores
- La página de éxito muestra la confirmación con Order ID
```

Nota cómo el ejemplo aplica las reglas: un paso = una acción, textos entre comillas,
DSL explícito cuando hay selector, verificación por nombre de producto (único) y no por
precio (repetido en subtotal/total). Los pasos en lenguaje natural quedan para acciones
sin selector conocido; después del dry-run deben revisarse si bajan de confianza.
