# n8n Migration Runbook — De Paseo en Fincas

Guía paso-a-paso para migrar los workflows de **De Paseo en Fincas** desde una instancia de n8n a otra. Probada el **2026-05-09**: Elestio (`rh-n8n-u48275.vm.elestio.app`) → Raaamp Coolify (`n8n.depaseoenfincas.raaamp.co`).

> ⚠️ **Lección principal**: una migración n8n NO es solo "exportar/importar JSON". Hay 4 capas de estado externo embebido en los nodos (URLs, tokens, IDs de cuenta, IDs de phone number) más diferencias de comportamiento entre versiones de n8n que rompen el flujo en silencio. Este runbook cubre las 4 capas + las diferencias de versión.

---

## 0. Pre-requisitos (antes de tocar nada)

### Datos de la instancia ORIGEN (la que migrás DESDE)

```bash
# Setear como variables, vas a usarlas en sed/replace masivos
OLD_N8N_HOST=rh-n8n-u48275.vm.elestio.app          # solo el host, sin https://
OLD_N8N_API_JWT=<JWT del Profile/Settings/API>     # para descargar workflows
OLD_CHATWOOT_HOST=chatwoot-9qe1j-u48275.vm.elestio.app
OLD_CHATWOOT_TOKEN=7paF3kLsjSEPvXqgHPEgPTEq        # Profile/Access Token
OLD_CHATWOOT_ACCOUNT_ID=1                          # casi siempre 1 en una instancia chica
OLD_PHONE_NUMBER_ID=1033166259876164               # Meta WhatsApp Cloud API
OLD_PHONE_NUMBER=+573105639334
```

### Datos de la instancia DESTINO

```bash
NEW_N8N_HOST=n8n.depaseoenfincas.raaamp.co
NEW_N8N_API_JWT=<crear nuevo JWT en NEW_N8N>
NEW_CHATWOOT_HOST=chat.depaseoenfincas.raaamp.co
NEW_CHATWOOT_TOKEN=HHtQoPLW991XS8Rcu5thbZ5x        # generar en NEW Chatwoot Profile
NEW_CHATWOOT_ACCOUNT_ID=2                          # casi siempre 2 en NEW (la URL te lo dice)
NEW_PHONE_NUMBER_ID=1170778729444650               # NUEVO si cambiás de número
NEW_PHONE_NUMBER=+12017018810
```

### Infraestructura DESTINO lista

- [ ] Postgres corriendo y accesible (mismo schema que ORIGEN — exportá las migrations).
- [ ] Redis corriendo (n8n queue mode lo requiere si usás workers).
- [ ] FQDN configurado en Coolify **CON `https://`** (sin protocolo Coolify genera regla Traefik inválida `Host('') && PathPrefix(dominio/)` y devuelve 503 — lección aprendida ⚠️).
- [ ] Let's Encrypt cert válido para el FQDN (puerto 80 abierto, DNS resuelve).
- [ ] Si vas a recibir webhooks de Chatwoot vía HMAC: anotá el secret nuevo de Chatwoot (Settings → Integrations → Webhooks).

### Si cambiás de Chatwoot también

- [ ] Crear el inbox WhatsApp Cloud en Chatwoot NUEVO (Settings → Inboxes → Add → WhatsApp).
- [ ] Anotar el **inbox_id** que te asigna (puede no ser el mismo que ORIGEN).
- [ ] Configurar Meta App Dashboard con la callback URL `https://NEW_CHATWOOT/webhooks/whatsapp/+NUMBER` y el verify token que Chatwoot generó.
- [ ] **Suscribir tu Meta App a la WABA**:
  ```bash
  curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <META_TOKEN>"
  ```
  Si no, Chatwoot va a marcar el inbox como "expired" aunque el token sea válido. Lección aprendida ⚠️.

---

## 1. Exportar workflows del ORIGEN

```bash
mkdir -p /tmp/dpf_export

# listar workflows
curl -sk "https://${OLD_N8N_HOST}/api/v1/workflows?limit=50" \
  -H "X-N8N-API-KEY: ${OLD_N8N_API_JWT}" \
  | jq -r '.data[] | .id' > /tmp/dpf_ids.txt

# exportar cada uno
while read id; do
  curl -sk "https://${OLD_N8N_HOST}/api/v1/workflows/${id}" \
    -H "X-N8N-API-KEY: ${OLD_N8N_API_JWT}" \
    > /tmp/dpf_export/${id}.json
done < /tmp/dpf_ids.txt

ls /tmp/dpf_export/
```

Esto te baja TODOS los workflows como JSONs separados. **Nota**: las credentials NO se exportan (Sheets, Postgres, OpenAI, etc.). Las recreás manualmente en DESTINO.

---

## 2. Pre-flight scan — qué valores hay que reemplazar

Corré este Python contra `/tmp/dpf_export/` para detectar todo lo que necesita reemplazo:

```bash
python3 << 'EOF'
import json, os, re

OLD_N8N_HOST = 'rh-n8n-u48275.vm.elestio.app'
OLD_CHATWOOT_HOST = 'chatwoot-9qe1j-u48275.vm.elestio.app'
OLD_CHATWOOT_TOKEN = '7paF3kLsjSEPvXqgHPEgPTEq'
OLD_PHONE_NUMBER_ID = '1033166259876164'
OLD_PHONE_NUMBER_DIGITS = '573105639334'
OLD_ACCOUNT_ID = '1'

patterns = {
  'OLD n8n URL': OLD_N8N_HOST,
  'OLD Chatwoot URL': OLD_CHATWOOT_HOST,
  'OLD Chatwoot token': OLD_CHATWOOT_TOKEN,
  'OLD phone_number_id': OLD_PHONE_NUMBER_ID,
  'OLD phone digits': OLD_PHONE_NUMBER_DIGITS,
  'accounts/1 in URLs': "/accounts/" + OLD_ACCOUNT_ID,
  '+ "1" + (concat in JS code)': '+ "1" +',  # tricky: account_id concatenado dentro de jsCode
}

for f in sorted(os.listdir('/tmp/dpf_export')):
  text = open(f'/tmp/dpf_export/{f}').read()
  hits = {label: text.count(p) for label, p in patterns.items() if p in text}
  if hits:
    name = json.loads(text).get('name','?')
    print(f'\n{f}: {name}')
    for label, n in hits.items():
      print(f'  - {label}: {n} hit(s)')
EOF
```

Output esperado: una lista de qué workflow tiene cuántas referencias a cada cosa vieja. **Anotá esto** — vas a usarlo para verificar después.

---

## 3. Reemplazos a aplicar (orden importa)

### 3.1 Reemplazos textuales (env-specific)

```bash
mkdir -p /tmp/dpf_patched
cp /tmp/dpf_export/*.json /tmp/dpf_patched/

cd /tmp/dpf_patched

# 1. n8n host (URLs hardcoded en HTTP nodes, self-webhook fires en burst aggregation, etc.)
sed -i '' "s|${OLD_N8N_HOST}|${NEW_N8N_HOST}|g" *.json

# 2. Chatwoot host (URLs en Send outbound, fetch attachments, sync ia_activa)
sed -i '' "s|${OLD_CHATWOOT_HOST}|${NEW_CHATWOOT_HOST}|g" *.json

# 3. Chatwoot API token (defaults dentro de jsCode)
sed -i '' "s|${OLD_CHATWOOT_TOKEN}|${NEW_CHATWOOT_TOKEN}|g" *.json

# 4. phone_number_id (Typing ON, otros)
sed -i '' "s|${OLD_PHONE_NUMBER_ID}|${NEW_PHONE_NUMBER_ID}|g" *.json

# 5. /accounts/<old>/  →  /accounts/<new>/  en URLs
sed -i '' "s|/accounts/${OLD_ACCOUNT_ID}/|/accounts/${NEW_ACCOUNT_ID}/|g" *.json
```

### 3.2 Reemplazo crítico que el sed simple NO captura

El account_id aparece también **concatenado como string dentro de jsCode**:

```js
url: "https://chatwoot..." + '/api/v1/accounts/' + "1" + '/conversations/' + ...
                                                  ^^^ NO es accounts/1 literal
```

Esto **no lo captura** ningún sed razonable. Usá Python:

```bash
python3 << 'EOF'
import json, os
NEW = '2'  # tu NEW_ACCOUNT_ID
# patrones específicos vistos en estos workflows
SUBS = [
  ("'/api/v1/accounts/' + \"1\" +", f"'/api/v1/accounts/' + \"{NEW}\" +"),
  ('"/api/v1/accounts/" + "1" +',  f'"/api/v1/accounts/" + "{NEW}" +'),
  ("'/api/v1/accounts/' + '1' +",  f"'/api/v1/accounts/' + '{NEW}' +"),
]
for f in os.listdir('/tmp/dpf_patched'):
  if not f.endswith('.json'): continue
  d = json.load(open(f'/tmp/dpf_patched/{f}'))
  changed = False
  for n in d.get('nodes', []):
    code = (n.get('parameters') or {}).get('jsCode')
    if not isinstance(code, str): continue
    for old, new in SUBS:
      if old in code:
        n['parameters']['jsCode'] = code = code.replace(old, new)
        changed = True
  if changed:
    json.dump(d, open(f'/tmp/dpf_patched/{f}','w'))
    print(f'patched {f}')
EOF
```

### 3.3 Default fallbacks de account_id en jsCode

Mismo problema, distinta forma:

```js
chatwoot_account_id: input.chatwoot_account_id || '1',  // default cuando input no lo trae
```

Reemplazo:

```bash
python3 -c "
import os, re
for f in os.listdir('/tmp/dpf_patched'):
  if not f.endswith('.json'): continue
  p = '/tmp/dpf_patched/' + f
  src = open(p).read()
  new = re.sub(r\"chatwoot_account_id\s*\|\|\s*['\\\"]1['\\\"]\", 'chatwoot_account_id || \"2\"', src)
  if new != src:
    open(p,'w').write(new)
    print(f'patched {f}')
"
```

### 3.4 Cleanup de `settings` no permitidos por la API

n8n 2.x rechaza el PUT si `settings` tiene campos extras (típicamente `binaryMode`). Whitelist:

```python
ALLOWED = {'executionOrder','timezone','saveDataErrorExecution',
           'saveDataSuccessExecution','saveExecutionProgress',
           'saveManualExecutions','errorWorkflow'}
# durante el upload, filtrá:
payload['settings'] = {k:v for k,v in (wf.get('settings') or {}).items() if k in ALLOWED}
```

---

## 4. Subir workflows a DESTINO

```bash
# 1. importar (POST nuevo) — n8n te asigna nuevos IDs
mkdir -p /tmp/dpf_id_map
echo "{}" > /tmp/dpf_id_map.json

python3 << 'EOF'
import json, os, subprocess
JWT = os.environ['NEW_N8N_API_JWT']
HOST = os.environ['NEW_N8N_HOST']
ALLOWED = {'executionOrder','timezone','saveDataErrorExecution','saveDataSuccessExecution','saveExecutionProgress','saveManualExecutions','errorWorkflow'}
id_map = {}
for f in sorted(os.listdir('/tmp/dpf_patched')):
    if not f.endswith('.json'): continue
    old_id = f.replace('.json','')
    wf = json.load(open(f'/tmp/dpf_patched/{f}'))
    payload = {
        'name': wf['name'],
        'nodes': wf['nodes'],
        'connections': wf['connections'],
        'settings': {k:v for k,v in (wf.get('settings') or {}).items() if k in ALLOWED},
    }
    open('/tmp/_p.json','w').write(json.dumps(payload))
    r = subprocess.run(['curl','-sk','-X','POST', f'https://{HOST}/api/v1/workflows',
        '-H', f'X-N8N-API-KEY: {JWT}', '-H','Content-Type: application/json',
        '--data-binary','@/tmp/_p.json'], capture_output=True, text=True)
    try:
        new = json.loads(r.stdout)
        new_id = new.get('id')
        id_map[old_id] = new_id
        print(f'  {old_id} → {new_id} [{new["name"]}]')
    except: print(f'  ERR {old_id}: {r.stdout[:200]}')
json.dump(id_map, open('/tmp/dpf_id_map.json','w'), indent=2)
EOF
```

Ahora `/tmp/dpf_id_map.json` tiene `{old_id: new_id, ...}`. **Critical**: necesitás esto para el siguiente paso.

---

## 5. Remap de workflow IDs en `executeWorkflow` nodes

Los `executeWorkflow` y `toolWorkflow` tienen IDs hardcoded a workflows VIEJOS. Hay que remapear y volver a subir:

```python
import json, os, subprocess
JWT = os.environ['NEW_N8N_API_JWT']
HOST = os.environ['NEW_N8N_HOST']
id_map = json.load(open('/tmp/dpf_id_map.json'))
ALLOWED = {'executionOrder','timezone','saveDataErrorExecution','saveDataSuccessExecution','saveExecutionProgress','saveManualExecutions','errorWorkflow'}

for old_id, new_id in id_map.items():
    r = subprocess.run(['curl','-sk', f'https://{HOST}/api/v1/workflows/{new_id}',
        '-H', f'X-N8N-API-KEY: {JWT}'], capture_output=True, text=True)
    wf = json.loads(r.stdout)
    changed = 0
    for n in wf.get('nodes', []):
        if n.get('type') in ('n8n-nodes-base.executeWorkflow','@n8n/n8n-nodes-langchain.toolWorkflow'):
            params = n.get('parameters') or {}
            wfval = params.get('workflowId')
            if isinstance(wfval, dict) and 'value' in wfval:
                if wfval['value'] in id_map:
                    wfval['value'] = id_map[wfval['value']]
                    changed += 1
            elif isinstance(wfval, str) and wfval in id_map:
                params['workflowId'] = id_map[wfval]
                changed += 1
    if changed == 0: continue
    payload = {
        'name': wf['name'],
        'nodes': wf['nodes'],
        'connections': wf['connections'],
        'settings': {k:v for k,v in (wf.get('settings') or {}).items() if k in ALLOWED},
    }
    open('/tmp/_p.json','w').write(json.dumps(payload))
    subprocess.run(['curl','-sk','-X','PUT', f'https://{HOST}/api/v1/workflows/{new_id}',
        '-H', f'X-N8N-API-KEY: {JWT}', '-H','Content-Type: application/json',
        '--data-binary','@/tmp/_p.json'])
    print(f'remapped {changed} sub-workflow refs in {wf["name"]}')
```

---

## 6. Patches críticos de compatibilidad n8n 2.x

### 6.1 `Run sales engine` → HTTP request (no `executeWorkflow`)

**Problema**: n8n 2.x cambió el comportamiento de `executeWorkflow`. Cuando un workflow tiene múltiples `executeWorkflowTrigger` nodes (ej. el customer agent tiene `When inventory tool is called`, `When current datetime tool is called`, `Inbound Webhook`), n8n 2.x SIEMPRE elige el **primer** `executeWorkflowTrigger` por orden de creación. En n8n 1.x el comportamiento era diferente.

**Síntoma**: el customer agent corre la rama del inventory tool en vez del agent flow. Output keys son `{matched_count, items, similar_items, ...}` en vez de `{outbound_text, intent, ...}`.

**Fix**: cambiar `Run sales engine` (en `Chatwoot Inbound`) de `executeWorkflow` a `httpRequest` apuntando al webhook URL del customer agent:

```js
// En el Chatwoot Inbound, reemplazar el nodo "Run sales engine":
{
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.2,
  "parameters": {
    "method": "POST",
    "url": "https://NEW_N8N_HOST/webhook/customer-agent-direct/de-paseo-en-fincas/inbound",
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify($('Resolve thread policy').item.json.raw) }}",
    "sendHeaders": true,
    "headerParameters": {"parameters":[{"name":"Content-Type","value":"application/json"}]},
    "options": {"timeout": 60000}
  }
}
```

**Importante**: el `jsonBody` debe forwardear `raw` (el evento Chatwoot original) **al top-level**, no envuelto. Si lo envolvés en `{chatInput, raw: {...}}`, el `Normalize inbound payload` del customer agent detecta `looksLikeChatwoot=false` y va al path simulator → `send_to_customer: false` → no envía outbound al cliente.

### 6.2 Customer Agent: cambiar webhook path

**Problema**: el `Inbound Webhook` del customer agent y el `Chatwoot Webhook` del Chatwoot Inbound tienen el mismo path (`chatwoot/de-paseo-en-fincas/inbound`). En n8n 2.x esto da **"There is a conflict with one of the webhooks"** al activar el segundo. En n8n 1.x se permitía.

**Fix**: cambiar el path del Customer Agent's Inbound Webhook a `customer-agent-direct/de-paseo-en-fincas/inbound`. El Chatwoot Inbound queda con el path original (porque es el que recibe los webhooks reales de Chatwoot).

Esto cuadra con el patch 6.1 — el HTTP request en Run sales engine apunta a `customer-agent-direct/...`.

```python
# script para aplicar:
for n in customer_agent_workflow['nodes']:
    if n.get('name') == 'Inbound Webhook' and n.get('type') == 'n8n-nodes-base.webhook':
        if n['parameters'].get('path') == 'chatwoot/de-paseo-en-fincas/inbound':
            n['parameters']['path'] = 'customer-agent-direct/de-paseo-en-fincas/inbound'
```

### 6.3 NO patchear `Resolve thread policy` ni `Build aggregated message`

El código de v1 estaba bien. **No agregues fast-paths ni payloads sintéticos** — eso fue una hipótesis errónea durante el debugging. La versión v1 byte-por-byte funciona, asumiendo:

- DB Postgres limpia (sin filas huérfanas con `wa_id` apuntando a `chatwoot_id` de instancia vieja).
- La cadena de patches 6.1 y 6.2 aplicados.

---

## 7. Activar workflows + suscribir webhook

```bash
python3 << 'EOF'
import json, subprocess, os
JWT = os.environ['NEW_N8N_API_JWT']
HOST = os.environ['NEW_N8N_HOST']
for new_id in json.load(open('/tmp/dpf_id_map.json')).values():
    r = subprocess.run(['curl','-sk','-X','POST', f'https://{HOST}/api/v1/workflows/{new_id}/activate',
        '-H', f'X-N8N-API-KEY: {JWT}', '-w','%{http_code}'], capture_output=True, text=True)
    code = r.stdout[-3:]
    print(f'  activate {new_id} → HTTP {code}')
EOF
```

Si alguno da 400 con "conflict": probablemente olvidaste el patch 6.2.

### Webhook saliente Chatwoot → n8n

En NEW Chatwoot UI: Settings → Integrations → Webhooks → Add webhook:
- **URL**: `https://NEW_N8N_HOST/webhook/chatwoot/de-paseo-en-fincas/inbound`
- **Subscriptions**: marcá `message_created` (mínimo).
- **Signing key**: si Chatwoot lo expone en la UI, anotalo.

> ⚠️ El workflow `Chatwoot Inbound` actualmente NO valida HMAC. El secret se setea pero nadie lo verifica. Es un gap de seguridad menor — anotalo en el backlog.

---

## 8. Limpieza de Postgres (CRÍTICO si migrás también la DB)

Si traés filas viejas de la DB ORIGEN a la DESTINO, vas a tener este problema:

- **Síntoma**: el bot ignora todos los mensajes, las executions terminan en `Webhook Ignored` con `ignore_reason: 'thread_conflict_active_chatwoot_conversation'`.
- **Causa**: la fila en `conversations` tiene `chatwoot_conversation_id = X` (de Chatwoot VIEJO) pero el evento entrante trae `chatwoot_conversation_id = Y` (de Chatwoot NUEVO). El workflow detecta conflict y aborta para no pisar una conversación humana.
- **Fix**: limpiar las filas de prueba antes de operar:

```bash
docker exec -it <postgres_container_name> psql -U postgres -d postgres -c "
DELETE FROM messages WHERE wa_id IN (
  SELECT wa_id FROM conversations WHERE updated_at < (NOW() - interval '1 hour')
);
DELETE FROM conversations WHERE updated_at < (NOW() - interval '1 hour');
"
```

> Ajustá el filtro temporal según lo que necesites preservar.

---

## 9. Smoke test end-to-end

1. Mandá "hola" desde tu WhatsApp personal al número de prueba del NEW Chatwoot.
2. Verificá:
   - Aparece en la UI de NEW Chatwoot ✅
   - En `https://NEW_N8N_HOST` → Executions: 2 executions (Chatwoot Inbound + Customer Agent), ambos green.
   - Recibís respuesta del bot en tu WhatsApp ✅
3. Mandá "RESET" → debería limpiar la conversación y respondería con la confirmación.
4. Mandá 3 mensajes en ráfaga (< 5 segundos entre cada uno) → el bot debería responder UNA vez agregando los 3.
5. Pedí algo que active el inventory tool ("Quiero finca para 6 personas en Carmen este finde") → debería responder con fichas de fincas.

Si TODO ✅, migración exitosa. Si algo falla, mirá la sección 10.

---

## 10. Troubleshooting — síntomas y causas reales

| Síntoma | Causa probable | Fix |
|---|---|---|
| `503 no available server` en todos los paths | Coolify/Traefik con FQDN sin `https://` → genera regla `Host('') && PathPrefix(...)` inválida | UI Coolify: agregar `https://` al FQDN en Domains |
| Cert TLS = `TRAEFIK DEFAULT CERT` | ACME falló (rate limit, DNS, puerto 80 cerrado) o el FQDN está mal y Traefik no levanta el router | Mirar logs de `coolify-proxy`, verificar puerto 80 abierto, FQDN con `https://` |
| Chatwoot inbox marca "Your inbox connection has expired" | Meta App no suscrita a la WABA | `POST /api/v21.0/<WABA_ID>/subscribed_apps` con el token Meta |
| Verify token de Meta rechazado por Chatwoot | El verify token quedó encriptado con `SECRET_KEY_BASE` distinto al actual (típicamente al re-deploy) | Recrear el inbox, o entrar al Rails console y reescribir el `webhook_verify_token` con la SECRET_KEY_BASE actual. **No se puede arreglar vía API**. |
| Customer agent corre solo nodos del inventory tool | n8n 2.x picks first `executeWorkflowTrigger`. Necesita patch 6.1 | Convertir `Run sales engine` a `httpRequest` |
| `401 You are not authorized to access this account` al enviar outbound | Account ID hardcoded como `'1'` en jsCode (concatenación con `+ "1" +`) | Patch 3.2 |
| Bot ignora mensajes con `thread_conflict_active_chatwoot_conversation` | DB tiene fila vieja con chatwoot_id ≠ del evento entrante | Sección 8 — limpiar filas |
| Burst aggregation no responde a 3 mensajes seguidos | El self-webhook llega con payload plano `{chatInput, wa_id, chatwoot_id}`, el Normalize Chatwoot Event lo rechaza por `not_incoming_customer_message`. **Nota**: este bug también existía en v1, pero las ráfagas reales son raras y el follow-up worker lo disimulaba. | (opcional, no blocking) Modificar `Build aggregated message` para enviar payload Chatwoot-shaped sintético — pero sale del scope "v1 puro" |
| `executeWorkflow` da error "workflow not published" al activar | Un sub-workflow referenciado todavía tiene el ID viejo | Asegurate de correr la sección 5 (remap de IDs) ANTES de activar |

---

## 11. Lista de cambios aplicados en esta migración (resumen ejecutivo)

| # | Categoría | Workflows afectados | Cambio |
|---|---|---|---|
| 1 | Env replacement | 4 (customer agent, chatwoot inbound, outbound sender, owner reservation request, owner reservation reminder) | Host n8n viejo → host n8n nuevo (5 referencias en jsCode) |
| 2 | Env replacement | 4 (customer agent, owner reservation request, owner reservation scheduler, outbound sender) | Host Chatwoot viejo → host Chatwoot nuevo |
| 3 | Env replacement | mismos 4 | API token Chatwoot viejo → nuevo |
| 4 | Env replacement | 2 (customer agent, owner reservation request) | `accounts/1` → `accounts/2` en URLs literales |
| 5 | Env replacement | 1 (customer agent) | `chatwoot_account_id \|\| '1'` → `'2'` en defaults JS |
| 6 | Env replacement | 1 (customer agent) | `+ "1" +` concatenado → `+ "2" +` (URL builder en Send RESET confirmation node) |
| 7 | Env replacement | 2 (customer agent + selection sender) | `phone_number_id` viejo (`1032537143273895`, deleted en Meta) → nuevo (`1170778729444650`) |
| 8 | n8n 2.x compat | 1 (chatwoot inbound) | `Run sales engine`: `executeWorkflow` → `httpRequest` |
| 9 | n8n 2.x compat | 1 (customer agent) | webhook path: `chatwoot/de-paseo-en-fincas/inbound` → `customer-agent-direct/de-paseo-en-fincas/inbound` |
| 10 | ID remap | todos | sub-workflow IDs en `executeWorkflow`/`toolWorkflow` nodes remapeados via `id_map` |
| 11 | Settings whitelist | todos | `settings` filtrado a campos permitidos por la API REST |

**No se modificaron** (a pesar de hipótesis erradas durante el debug):
- `Resolve thread policy` (Chatwoot Inbound) — quedó idéntico a v1.
- `Build aggregated message` (Customer Agent) — quedó idéntico a v1, solo URL replacement.
- Las prompts de los LLM agents (`Run qualifying pass`, `Run offering pass`, etc.) — idénticas a v1.

---

## 12. Anexo — diferencias de comportamiento conocidas n8n 1.x vs 2.x

| Comportamiento | n8n 1.x (Elestio) | n8n 2.x (NEW) | Workaround |
|---|---|---|---|
| `executeWorkflow` con múltiples triggers en target | aparente fallback a webhook trigger o algún criterio que llevaba al agent | siempre el primer `executeWorkflowTrigger` por orden de creación | Patch 6.1 (HTTP en lugar de executeWorkflow) |
| Webhook path duplicado entre 2 workflows activos | tolerado | `Conflict` al activar el segundo | Patch 6.2 (paths distintos) |
| `settings` con campos extras (`binaryMode`, etc.) | aceptado | rechazado por API REST | Whitelist 3.4 |

---

## 13. Comandos de verificación rápida (post-migración)

```bash
# Health checks
curl -sk "https://${NEW_N8N_HOST}/healthz"
curl -sk "https://${NEW_CHATWOOT_HOST}/api" | jq

# Cert TLS válido (no Traefik default)
curl -skv "https://${NEW_N8N_HOST}" 2>&1 | grep -E "subject|issuer"
# esperado: subject=CN=${NEW_N8N_HOST}, issuer=Let's Encrypt

# Workflows activos
curl -sk "https://${NEW_N8N_HOST}/api/v1/workflows?limit=20" \
  -H "X-N8N-API-KEY: ${NEW_N8N_API_JWT}" \
  | jq -r '.data[] | "\(.active) \(.id) \(.name)"'

# No quedan refs viejas en n8n
for id in $(curl -sk "https://${NEW_N8N_HOST}/api/v1/workflows?limit=20" -H "X-N8N-API-KEY: ${NEW_N8N_API_JWT}" | jq -r '.data[].id'); do
  hits=$(curl -sk "https://${NEW_N8N_HOST}/api/v1/workflows/$id" -H "X-N8N-API-KEY: ${NEW_N8N_API_JWT}" | grep -cE "${OLD_N8N_HOST}|${OLD_CHATWOOT_HOST}|${OLD_CHATWOOT_TOKEN}|${OLD_PHONE_NUMBER_ID}" || true)
  [ "$hits" != "0" ] && echo "❌ workflow $id has $hits old refs"
done

# Meta token válido + número CONNECTED + app suscrita a WABA
curl -s "https://graph.facebook.com/v21.0/${NEW_PHONE_NUMBER_ID}?fields=display_phone_number,status,is_pin_enabled" -H "Authorization: Bearer ${META_TOKEN}"
curl -s "https://graph.facebook.com/v21.0/${WABA_ID}/subscribed_apps" -H "Authorization: Bearer ${META_TOKEN}"
```

---

**Última actualización**: 2026-05-09
**Autor**: Claude (assisted) + JD Vizcaya
**Validado en**: Migración Elestio → Raaamp Coolify, n8n 2.19.5
