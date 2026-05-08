-- Bring the v1 Ops Console defaults forward into agent_settings. Only touches
-- empty/null fields so re-running this on a populated DB doesn't clobber
-- whatever the user has already configured. Fresh installs land with the
-- exact same starter content the v1 product had on day one.
--
-- Sources:
--   - simulator/server.mjs DEFAULT_SETTINGS (paymentMethods, copy texts)
--   - supabase/migrations/20260310052000_create_agent_settings.sql (seed)
--   - public/index.html settings form (helper text)

INSERT INTO agent_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

UPDATE agent_settings SET
  -- Tone preset (v1 default: 'calido_profesional'). Don't overwrite if already set.
  tone_preset = COALESCE(NULLIF(tone_preset, ''), 'calido_profesional'),

  tone_guidelines_extra = COALESCE(
    NULLIF(tone_guidelines_extra, ''),
    'Tono colombiano de Bogotá, cálido y profesional. Tutea (tú) o ustea (usted) según el cliente. Usa "porfa", "listo", "claro que sí" con naturalidad. Nunca "vos". Sé breve, una idea por mensaje.'
  ),

  -- Saludo inicial (verbatim from v1 production, including the emojis and
  -- Santiago Gallego / depaseoenfincas.com framing).
  initial_message_template = COALESCE(
    NULLIF(initial_message_template, ''),
    E'Excelente día!🤩🌅\nMi nombre es Santiago Gallego\nDepaseoenfincas.com, estaré frente a tu reserva!⚡\nPor favor indícame:\n*Fechas exactas?\n*Número de huéspedes?\n*Localización?\n*Tarifa aproximada por noche\n\n🌎 En el momento disponemos de propiedades en Anapoima, Villeta, La Vega, Girardot, Eje cafetero, Carmen de Apicalá, Antioquia y Villavicencio.'
  ),

  handoff_message = COALESCE(
    NULLIF(handoff_message, ''),
    'Te voy a pasar con un asesor humano para continuar con tu solicitud.'
  ),

  -- Inventory: same Sheet ID and tab the v1 used (already in env, but seed
  -- the columns so a fresh dashboard shows them populated).
  inventory_sheet_id = COALESCE(
    NULLIF(inventory_sheet_id, ''),
    '1AHeDsZin_U5ZzfAB50i7JZvOoJcP9uAM71RRZgnDlgo'
  ),
  inventory_sheet_tab = COALESCE(
    NULLIF(inventory_sheet_tab, ''),
    'fincas_inventory_ajustada_real'
  ),
  max_properties_to_show = COALESCE(max_properties_to_show, 3),

  -- Coverage zones text (used by QA agent when client asks about coverage).
  coverage_zones = COALESCE(
    NULLIF(coverage_zones, ''),
    'Anapoima, Villeta, La Vega, Girardot, Eje cafetero, Carmen de Apicalá, Antioquia y Villavicencio'
  ),

  -- Operación: bot on, owner override empty, owner test off
  global_bot_enabled = COALESCE(global_bot_enabled, true),

  -- Selection notifications: enabled, no recipients yet (user must add)
  selection_notification_settings = CASE
    WHEN selection_notification_settings IS NULL OR selection_notification_settings = '{}'::jsonb
      THEN '{"enabled": true, "recipients": [], "templateName": "staff_finca_selected_v1", "templateLanguage": "es_CO"}'::jsonb
    ELSE selection_notification_settings
  END,

  -- Payment methods: v1 had a curated list. Convert into our JSONB.
  payment_methods = CASE
    WHEN payment_methods IS NULL OR payment_methods = '{}'::jsonb OR payment_methods = '[]'::jsonb
      THEN '[
        {"method": "Bancolombia", "description": "Transferencia o consignación", "surcharge": ""},
        {"method": "Davivienda", "description": "Transferencia o consignación", "surcharge": ""},
        {"method": "Colpatria", "description": "Transferencia o consignación", "surcharge": ""},
        {"method": "Nequi", "description": "Transferencia inmediata", "surcharge": ""},
        {"method": "Daviplata", "description": "Transferencia inmediata", "surcharge": ""},
        {"method": "Tarjeta Crédito/Débito/PSE", "description": "Pasarela digital", "surcharge": "+5%"},
        {"method": "Efectivo", "description": "Pago presencial en sedes de Anapoima o Pereira", "surcharge": ""}
      ]'::jsonb
    ELSE payment_methods
  END,

  -- Followup messages live in followup_settings JSONB (per stage).
  followup_settings = CASE
    WHEN followup_settings IS NULL OR followup_settings = '{}'::jsonb
      THEN '{
        "enabled": true,
        "windowStart": "08:00",
        "windowEnd": "22:00",
        "messages": {
          "qualifying": "Hola, sigo atento para ayudarte con la búsqueda de tu finca. Si quieres, compárteme fechas, número de personas y zona y retomamos.",
          "offering": "Hola, sigo atento. Si quieres, te comparto más opciones o ajustamos la búsqueda por zona, capacidad o presupuesto.",
          "verifying_availability": "Hola, sigo atento con tu solicitud. Si quieres, también puedo ayudarte a revisar otra opción similar."
        }
      }'::jsonb
    ELSE followup_settings
  END,

  -- Prompt addenda: empty by default. Editable per stage in the dashboard.
  prompt_addenda = CASE
    WHEN prompt_addenda IS NULL OR prompt_addenda = '{}'::jsonb
      THEN '{
        "global": "",
        "qualifying": "",
        "offering": "",
        "verifying": "",
        "qa": "",
        "hitl": "",
        "confirming": ""
      }'::jsonb
    ELSE prompt_addenda
  END

WHERE id = 1;
