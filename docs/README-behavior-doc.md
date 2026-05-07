# Documento de Comportamiento del Agente

Archivo: [`comportamiento-agente-v1-vs-v2.docx`](./comportamiento-agente-v1-vs-v2.docx)

## ¿Qué es?

Documento operativo que describe lo que hace el agente conversacional en cada estado y ante cada situación. Compara lado a lado la implementación **v1 (en producción, n8n)** con la **v2 (este repo, en desarrollo)**.

## ¿Para quién es?

- **Operador / dueño del producto**: para entender el comportamiento y aprobar/rechazar diferencias
- **Soporte**: cuando un cliente reporta "el bot no respondió bien", para identificar exactamente dónde falló
- **Equipo técnico**: como referencia mientras se modifican prompts o lógica de stages

NO incluye prompts exactos, regex, ni JSON schemas — para eso hay que mirar el código fuente.

## Estructura

| # | Sección | Páginas |
|---|---|---|
| 1 | Resumen ejecutivo | 1 |
| 2 | Problemas conocidos en v1 (los 3 silencios) | 1 |
| 3 | Estado QUALIFYING | 2 |
| 4 | Estado OFFERING | 2 |
| 5 | Estado VERIFYING_AVAILABILITY | 2 |
| 6 | Estado CONFIRMING_RESERVATION | 2 |
| 7 | Estado HITL | 1 |
| 8 | Agente QA flotante | 2 |
| 9 | Comportamientos transversales (routing, audio, batching, invariante, loops, privacy) | 3 |
| 10 | Cómo busca fincas | 2 |
| 11 | Tabla resumen de diferencias v1 vs v2 (20 filas) | 1 |
| 12 | Apéndice (intents, estados, tools, glosario) | 2 |

## Cómo regenerarlo

Después de cualquier cambio en stages, prompts, routing, o tools:

```bash
node scripts/generate-behavior-doc.mjs
```

Salida esperada:
```
Created: /Users/.../docs/comportamiento-agente-v1-vs-v2.docx (37503 bytes)
```

El script vive en [`scripts/generate-behavior-doc.mjs`](../scripts/generate-behavior-doc.mjs). Es código puro (no depende del código del agente en runtime), pero el contenido sí refleja lo que hay en `apps/agent/src/agent/stages/*.ts`, `apps/agent/src/agent/router.ts`, y `apps/agent/src/inventory/loader.ts`.

## Cuándo regenerarlo

- Cambios en cualquier prompt de stage handler
- Cambios en las reglas del router
- Nuevos intents
- Nuevos tools
- Cambios en cómo se busca/scorea el inventario
- Cualquier nueva diferencia importante entre v1 y v2

## Cómo usarlo en revisión con cliente

1. Abrir el DOCX en Word, Pages o Google Docs
2. Para cada sección de estado, leer las 8 subsecciones en orden
3. Las celdas rojizas (v1) muestran lo que hace HOY el agente; las verdosas (v2) lo que hará después del rewrite
4. Si algo no coincide con el comportamiento deseado, anotar el número de página
5. La tabla de §11 da una vista rápida de qué cambia y con qué impacto

## Notas

- Generado en formato Letter (8.5" × 11"), tamaño aprox 37 KB
- Estilo consistente con los otros DOCX previos del proyecto (header, footer, paginación)
- Los nombres de fincas en los ejemplos (F001, F003, F008) son placeholder; en la implementación real son códigos del Google Sheet de inventario
