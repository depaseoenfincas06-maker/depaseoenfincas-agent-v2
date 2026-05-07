#!/usr/bin/env node
/**
 * Generates docs/comportamiento-agente-v1-vs-v2.docx
 *
 * Operational-level behavior reference for the De Paseo en Fincas conversation
 * agent. Side-by-side compares the production v1 (n8n) implementation with the
 * new v2 (this repo) implementation. Audience: product owner / operator. The
 * doc explains WHAT the agent does in each situation, not the source code.
 *
 * Re-run whenever stage prompts or routing rules change:
 *   node scripts/generate-behavior-doc.mjs
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  LevelFormat,
  Header,
  Footer,
  PageNumber,
  TableOfContents,
} from 'docx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---- Style primitives -----------------------------------------------------

const BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
const CELL_MARGINS = { top: 60, bottom: 60, left: 100, right: 100 };
const HEADER_SHADING = { fill: '1B4F72', type: ShadingType.CLEAR };
const ALT_SHADING = { fill: 'F4F6F9', type: ShadingType.CLEAR };
const V1_SHADING = { fill: 'FBE9E7', type: ShadingType.CLEAR };
const V2_SHADING = { fill: 'E8F5E9', type: ShadingType.CLEAR };

function headerCell(text, width) {
  return new TableCell({
    borders: BORDERS,
    width: { size: width, type: WidthType.DXA },
    shading: HEADER_SHADING,
    margins: CELL_MARGINS,
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold: true, color: 'FFFFFF', font: 'Arial', size: 20 })],
      }),
    ],
  });
}

function cell(text, width, shading) {
  return new TableCell({
    borders: BORDERS,
    width: { size: width, type: WidthType.DXA },
    margins: CELL_MARGINS,
    ...(shading ? { shading } : {}),
    children: [
      new Paragraph({
        children: [new TextRun({ text, font: 'Arial', size: 20 })],
      }),
    ],
  });
}

function cellMultiline(lines, width, shading) {
  return new TableCell({
    borders: BORDERS,
    width: { size: width, type: WidthType.DXA },
    margins: CELL_MARGINS,
    ...(shading ? { shading } : {}),
    children: lines.map(
      (l) =>
        new Paragraph({
          spacing: { after: 40 },
          children: [new TextRun({ text: l, font: 'Arial', size: 20 })],
        }),
    ),
  });
}

function comparisonTable(rows) {
  const colWidths = [2080, 3640, 3640];
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({
        children: [
          headerCell('Aspecto', colWidths[0]),
          headerCell('v1 — n8n (hoy en producción)', colWidths[1]),
          headerCell('v2 — Nuevo (en desarrollo)', colWidths[2]),
        ],
      }),
      ...rows.map(
        (r) =>
          new TableRow({
            children: [
              cell(r[0], colWidths[0]),
              Array.isArray(r[1])
                ? cellMultiline(r[1], colWidths[1], V1_SHADING)
                : cell(r[1], colWidths[1], V1_SHADING),
              Array.isArray(r[2])
                ? cellMultiline(r[2], colWidths[2], V2_SHADING)
                : cell(r[2], colWidths[2], V2_SHADING),
            ],
          }),
      ),
    ],
  });
}

function genericTable(headers, rows) {
  const totalWidth = 9360;
  const colWidth = Math.floor(totalWidth / headers.length);
  const colWidths = headers.map(() => colWidth);
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({ children: headers.map((h, i) => headerCell(h, colWidths[i])) }),
      ...rows.map(
        (r, idx) =>
          new TableRow({
            children: r.map((c, i) =>
              Array.isArray(c)
                ? cellMultiline(c, colWidths[i], idx % 2 ? ALT_SHADING : undefined)
                : cell(c, colWidths[i], idx % 2 ? ALT_SHADING : undefined),
            ),
          }),
      ),
    ],
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [
      new TextRun({ text, bold: true, font: 'Arial', size: 32, color: '1B4F72' }),
    ],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 140 },
    children: [
      new TextRun({ text, bold: true, font: 'Arial', size: 26, color: '2E75B6' }),
    ],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({ text, bold: true, font: 'Arial', size: 22, color: '1F4E79' }),
    ],
  });
}

function p(text) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, font: 'Arial', size: 22 })],
  });
}

function pb(label, text) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: label, bold: true, font: 'Arial', size: 22 }),
      new TextRun({ text, font: 'Arial', size: 22 }),
    ],
  });
}

function bullet(text, ref = 'bullets') {
  return new Paragraph({
    numbering: { reference: ref, level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, font: 'Arial', size: 22 })],
  });
}

function dialogue(lines) {
  return lines.map(
    ([who, text]) =>
      new Paragraph({
        spacing: { after: 80 },
        indent: { left: 360 },
        children: [
          new TextRun({
            text: `${who}: `,
            bold: true,
            font: 'Arial',
            size: 22,
            color: who === 'Cliente' ? '6A1B9A' : '0D47A1',
          }),
          new TextRun({ text, font: 'Arial', size: 22 }),
        ],
      }),
  );
}

function codeBlock(text) {
  return new Paragraph({
    spacing: { after: 120 },
    shading: { fill: 'F5F5F5', type: ShadingType.CLEAR },
    children: [new TextRun({ text, font: 'Menlo', size: 18 })],
  });
}

function spacer() {
  return new Paragraph({ spacing: { after: 80 }, children: [] });
}

function pageBreak() {
  return new Paragraph({
    children: [new TextRun({ text: '', break: 1 })],
    pageBreakBefore: true,
  });
}

// ---- Document content -----------------------------------------------------

const COVER = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 1600, after: 80 },
    children: [
      new TextRun({
        text: 'De Paseo en Fincas',
        font: 'Arial',
        size: 44,
        bold: true,
        color: '1B4F72',
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [
      new TextRun({
        text: 'Comportamiento del Agente Conversacional',
        font: 'Arial',
        size: 32,
        color: '2E75B6',
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 800 },
    children: [
      new TextRun({
        text: 'v1 (n8n, en producción) vs v2 (rewrite, en desarrollo)',
        font: 'Arial',
        size: 24,
        italics: true,
        color: '666666',
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [
      new TextRun({
        text: 'Documento operativo — describe qué hace el agente en cada situación.',
        font: 'Arial',
        size: 22,
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [
      new TextRun({
        text: 'Para revisar prompts exactos, regex y JSON schemas, consultar el código fuente.',
        font: 'Arial',
        size: 22,
        italics: true,
        color: '666666',
      }),
    ],
  }),
];

// 1. Resumen ejecutivo
const SECTION_1 = [
  pageBreak(),
  h1('1. Resumen Ejecutivo'),
  p('Este documento describe a nivel operativo cómo se comporta el agente conversacional de De Paseo en Fincas en cada estado y ante cada tipo de mensaje del cliente. Para cada comportamiento se compara la implementación v1 actual (en n8n, producción) con la v2 nueva (en desarrollo en el repositorio juanda89/depaseoenfincas-agent).'),
  p('El objetivo es que tú —como operador o dueño del producto— puedas leer cualquier sección y decir "esto no me gusta, cámbialo así" señalando una página específica. Sin esa visibilidad, los problemas de comportamiento ("a veces no responde lo que pregunto") son difíciles de diagnosticar y corregir.'),
  h2('Mapa de estados'),
  p('La conversación avanza de izquierda a derecha. El agente QA flota encima de todos los estados respondiendo preguntas puntuales sin cambiar el flujo principal.'),
  codeBlock(
    '  QUALIFYING ──→ OFFERING ──→ VERIFYING_AVAILABILITY ──→ CONFIRMING_RESERVATION ──→ HITL\n' +
      '       ↑           ↑                ↑                          ↑                    ↓\n' +
      '       └───────────┴────── (QA flotante: precio, mascotas, RUT, etc.) ─────────────┘\n' +
      '                                                                                    \n' +
      '       Cualquier estado ─→ HITL si el cliente lo pide o si hay frustración crítica',
  ),
  h2('Cuándo termina la conversación'),
  bullet('Envío del PDF de confirmación: la conversación pasa a HITL, el bot se desactiva y un humano hace seguimiento de pago/logística'),
  bullet('Escalación explícita: el cliente pide hablar con un humano, hay disputa, amenazas, o frustración crítica'),
  bullet('Cancelación: el cliente dice que ya no le interesa'),
  bullet('Inactividad prolongada: si pasan días sin respuesta, el agente puede mandar un follow-up (configurable)'),
  h2('Cómo leer este documento'),
  bullet('Cada sección de estado tiene 8 subsecciones idénticas: Objetivo, Información que pide, Información que extrae, Tools, Reglas, Transiciones, Ejemplos, Diferencias v1 vs v2'),
  bullet('Las celdas con fondo rojizo son v1 (lo que pasa hoy en producción)'),
  bullet('Las celdas con fondo verdoso son v2 (lo que pasará después del rewrite)'),
  bullet('La sección 6 tiene una tabla resumen con todas las diferencias importantes ordenadas por impacto'),
];

// 2. Problemas conocidos en v1
const SECTION_2 = [
  pageBreak(),
  h1('2. Problemas Conocidos en v1'),
  p('Diagnóstico realizado a partir de las conversaciones reales de los últimos 7 días en producción. Total de eventos de silencio detectados: 13, concentrados en 3 conversaciones.'),
  spacer(),
  h2('Causa raíz #1 — Audio sin transcripción se persiste como texto vacío'),
  pb('Frecuencia: ', '12 de 13 silencios.'),
  pb('Qué pasa: ', 'Cuando el cliente envía un audio y OpenAI Whisper retorna una cadena vacía (audio inaudible, ruido, mal codec), el workflow guarda el mensaje con content="" y message_type="TEXT". El agente recibe ese mensaje vacío y lo trata como "el cliente no dijo nada"; responde al mensaje anterior del batch en su lugar. El cliente percibe que el bot ignoró su audio.'),
  pb('Conversaciones afectadas: ', '573117360736 (8 silencios), 573112407139 (3 silencios), 573134863370 (1 silencio).'),
  pb('Solución en v2: ', 'Las transcripciones vacías se persisten con message_type="AUDIO_UNTRANSCRIBED" y content=null; el agente responde explícitamente "No logré entender tu audio, ¿me lo puedes escribir por favor?".'),
  spacer(),
  h2('Causa raíz #2 — Loop de tool calls en OFFERING (Max iterations 4)'),
  pb('Frecuencia: ', '1 silencio real de 126 segundos + 2 ejecuciones que terminaron sin outbound.'),
  pb('Qué pasa: ', 'El agente OFFERING en n8n usa LangChain Agent Executor con máximo 4 iteraciones de tool calling. Cuando el cliente pide "más opciones" y todas las fincas del inventario que matchean ya fueron mostradas, el agente queda atrapado llamando list_matching_fincas una y otra vez. A la 4ta iteración, n8n aborta la ejecución sin enviar respuesta. También ocurre cuando el router envía una pregunta tipo FAQ ("¿se pueden llevar mascotas?") al offering_agent en lugar del qa_agent.'),
  pb('Ejecuciones n8n con este crash: ', '78577 (cliente "Ok" sin más opciones), 78160 (cliente "¿Se pueden llevar mascotas?").'),
  pb('Solución en v2: ', 'El loop de tools está topado a 3 iteraciones IMPLEMENTADAS EN CÓDIGO (no en LangChain). Al agotarlas, el orquestador fuerza una respuesta final con un prompt explícito "ya consultaste suficientes tools, devuelve tu JSON final". El router determinístico además manda mascotas/precios/RUT siempre al QA agent, fuera del flujo de OFFERING.'),
  spacer(),
  h2('Causa raíz #3 — Crash silencioso en la rama de audio fallido'),
  pb('Frecuencia: ', 'Sistemático en la conversación 573117360736; potencialmente cualquier audio fallido.'),
  pb('Qué pasa: ', 'El nodo Code in JavaScript1 referencia un nodo (Compute deterministic prechecks) que NO se ejecuta en la rama de audio fallido. n8n lanza un ExpressionError; el catch del nodo intenta mutar err.name (que es read-only en esa clase de error) y revienta con TypeError: Cannot assign to read only property "name". La ejecución muere sin enviar respuesta al cliente.'),
  pb('Exec n8n con este crash: ', '77925.'),
  pb('Solución en v2: ', 'No hay rama "n8n-style" de nodos; toda la lógica de audio fallido está en el worker de TypeScript con try/catch explícitos y un invariante "siempre responder" que dispara fallback si una excepción atraviesa todo.'),
  spacer(),
  h2('Observaciones secundarias'),
  bullet('0 mensajes con pending=true colgados → el batching de mensajes múltiples NO está roto'),
  bullet('0 silencios "trailing" (bot deja de hablar y nunca vuelve) → el chequeo de is_latest_inbound funciona'),
  bullet('Typing indicator no correlaciona con fallos'),
  bullet('El QA agent flotante responde correctamente cuando se lo invoca; el problema es que el router a veces no lo invoca'),
];

// 3. QUALIFYING
const SECTION_QUALIFYING = [
  pageBreak(),
  h1('3. Estado: QUALIFYING'),
  p('Es el primer estado al que entra cualquier conversación nueva. El cliente acaba de iniciar contacto; aún no sabemos qué busca.'),
  h2('Objetivo'),
  p('Recopilar la información mínima necesaria para poder buscar fincas con sentido: cuándo, cuántas personas y dónde.'),
  h2('Información que pide al cliente'),
  bullet('Fecha de llegada (fecha_inicio)'),
  bullet('Fecha de salida (fecha_fin)'),
  bullet('Número de personas que se hospedarán'),
  bullet('Zona o ciudad de interés (Carmen de Apicalá, Girardot, Melgar, etc.)'),
  bullet('Opcional: presupuesto máximo, tipo de evento (familiar, paseo, retiro), amenidades requeridas (piscina, jacuzzi, BBQ), si lleva mascotas'),
  spacer(),
  pb('Estilo de pregunta: ', 'En v1 el agente tiende a pedir un dato a la vez. En v2 el agente prioriza pedir varios datos faltantes en un solo mensaje cuando es razonable, para reducir fricción.'),
  h2('Información que extrae automáticamente'),
  p('Si el cliente dice "Hola, busco una finca para 8 personas en Carmen este finde", el agente debe extraer:'),
  bullet('personas = 8'),
  bullet('zona = "Carmen" (idealmente normalizado a "Carmen de Apicalá")'),
  bullet('Reconocer "este finde" como referencia temporal pero seguir pidiendo fechas exactas'),
  spacer(),
  pb('Persistencia: ', 'Los datos extraídos se guardan en search_criteria (JSONB) en la tabla conversations. Se acumulan: si en mensaje 1 el cliente da personas=8 y en mensaje 2 da fechas, ambos quedan guardados.'),
  h2('Tools que puede llamar'),
  p('QUALIFYING NO llama tools. Su única tarea es preguntar y extraer.'),
  h2('Reglas críticas'),
  bullet('Tono: cálido y profesional, español colombiano de Bogotá. Usa "porfa", "claro que sí", "listo" con naturalidad. No usa "vos" ni regionalismos costeños/antioqueños'),
  bullet('Privacidad: NO menciona nombres reales de fincas (todavía no hay ninguna seleccionada)'),
  bullet('No inventa datos: si el cliente no especifica zona, NO asume "Carmen" por defecto — pregunta'),
  bullet('No promete precios sin haber consultado el inventario'),
  h2('Transiciones de salida'),
  comparisonTable([
    ['→ OFFERING', 'Cuando datos_completos = true (al menos fecha_inicio, fecha_fin, personas, zona). Loop inmediato — sin esperar otro mensaje.', 'Igual que v1: mismo trigger.'],
    ['Permanece en QUALIFYING', 'Si faltan datos clave (típico del primer mensaje).', 'Igual.'],
    ['→ HITL', 'Cliente pide humano explícitamente, o frustración/amenazas detectadas.', 'Igual; además v2 detecta más patrones (regex extendida).'],
    ['→ QA', 'Cliente hace pregunta puntual antes de dar todos los datos (ej. "¿se aceptan mascotas en general?")', 'En v1 a veces el agente QUALIFYING intenta responder él mismo; en v2 el router lo manda siempre al QA.'],
  ]),
  h2('Ejemplos de conversación'),
  h3('Ejemplo A — Cliente da datos parciales'),
  ...dialogue([
    ['Cliente', 'Hola, buenos días'],
    ['Agente', '¡Hola! Con gusto te ayudo a encontrar una finca. ¿Para cuántas personas, en qué fechas y en qué zona te gustaría?'],
    ['Cliente', 'Para 8 personas en Carmen, este fin de semana'],
    ['Agente', '¡Perfecto! Para confirmarte opciones necesito las fechas exactas, porfa. ¿Sería del viernes al domingo, o sábado a domingo?'],
  ]),
  pb('Datos extraídos en este punto: ', 'personas=8, zona="Carmen". Faltan fechas → permanece en QUALIFYING.'),
  spacer(),
  h3('Ejemplo B — Cliente da todo en un mensaje'),
  ...dialogue([
    ['Cliente', 'Hola, busco finca para 12 personas, del 15 al 17 de mayo en Girardot, presupuesto hasta 2 millones, con piscina'],
    ['Agente', '¡Listo! Déjame buscar opciones para esas fechas en Girardot…'],
  ]),
  pb('Datos extraídos: ', 'personas=12, fecha_inicio=2026-05-15, fecha_fin=2026-05-17, zona="Girardot", presupuesto_max=2000000, amenidades=["piscina"]. Datos completos → transición inmediata a OFFERING.'),
  h2('Diferencias v1 vs v2'),
  comparisonTable([
    ['Pedir datos faltantes', 'A veces pide un solo dato a la vez ("¿y las fechas?", "¿y cuántas personas?")', 'Pide todos los faltantes en un solo mensaje cuando es razonable, reduciendo fricción'],
    ['Reconocer "este finde"', 'Lo reconoce como sábado-domingo de la semana actual y a veces lo asume sin confirmar', 'Lo reconoce como hint pero PIDE fechas exactas para evitar errores de booking'],
    ['Greeting solo', 'Responde con saludo + pregunta abierta', 'Igual'],
    ['Mensajes con audio', 'Si el audio viene vacío, persiste content="" y entra en silencio', 'Si el audio viene vacío, responde "No logré entender tu audio, ¿me lo puedes escribir por favor?"'],
    ['Silencios reales en producción', '4 silencios atribuidos a este estado en los últimos 7 días', 'Cubierto por test de regresión silence-audio-empty (PASS) y qualifying-empty-text (PASS)'],
  ]),
];

// 4. OFFERING
const SECTION_OFFERING = [
  pageBreak(),
  h1('4. Estado: OFFERING'),
  p('El agente ya tiene los datos mínimos del cliente. Ahora busca fincas que le sirvan, las muestra (sin nombres reales), y captura cuál elige.'),
  h2('Objetivo'),
  p('Mostrar hasta 3 fincas relevantes en cada interacción, capturar la elección del cliente, ajustar criterios si nada le sirve.'),
  h2('Información que pide al cliente'),
  bullet('La elección entre las opciones mostradas ("¿cuál te llama la atención?")'),
  bullet('Ajustes a los criterios si ninguna le sirve ("podemos ajustar presupuesto o zona")'),
  bullet('Confirmación de detalles puntuales que no estén claros (preferencia de capacidad, amenidades específicas)'),
  h2('Información que extrae automáticamente'),
  bullet('finca_elegida_id: cuando el cliente dice "la 2", "el F003", "la del río" — el agente debe mapear al fincaId correcto basándose en lo que mostró en el último mensaje'),
  bullet('search_criteria_update: ajustes a criterios previos ("mejor que sea para 10 en vez de 8")'),
  bullet('shown_fincas: el agente AGREGA a esta lista cada vez que muestra una finca, para no repetirla'),
  h2('Tools que puede llamar'),
  pb('list_matching_fincas — ', 'busca fincas que matcheen criterios. Input: { personas?, zona?, ciudad?, presupuestoMax?, amenidadesRequeridas?, mascotas?, excludeIds?, limit? }. Output: array de hasta 5 fincas con score y razones de match. excludeIds debe incluir todas las shown_fincas.'),
  pb('get_finca_details — ', 'detalles de una finca específica por fincaId. Solo retorna la PublicFincaView (sin realName).'),
  h2('Reglas críticas'),
  bullet('PRIVACIDAD ABSOLUTA: NUNCA reveles el nombre real de una finca en este estado. Usa fincaId (código), o frases descriptivas anónimas: "una finca con piscina en Carmen", "F001 con jacuzzi", "la opción del río"'),
  bullet('NUNCA repitas fincas que ya están en shown_fincas (excluye con excludeIds en cada llamada al tool)'),
  bullet('Muestra MÁXIMO 3 opciones a la vez para no sobrecargar al cliente'),
  bullet('Si no hay matches después de excluir mostradas, NO inventes fincas — di "no me quedan más opciones con esos criterios" y propón ajustes'),
  bullet('Si el cliente dice "la 9" o "#9" o "la del río", mapea inequívocamente a un fincaId existente; si la referencia es ambigua, pregunta'),
  h2('Transiciones de salida'),
  comparisonTable([
    ['→ VERIFYING_AVAILABILITY', 'Cliente eligió una finca claramente (extracted_data.finca_elegida_id presente).', 'Igual.'],
    ['Permanece en OFFERING', 'Mostró opciones y espera elección, o cliente está ajustando criterios.', 'Igual.'],
    ['→ QA', 'Cliente hace una pregunta puntual sobre las opciones mostradas (precio, mascotas, qué incluye).', 'En v1 el offering_agent a veces intenta responder él mismo y entra en loop. En v2 el router siempre lo manda al QA agent.'],
    ['→ HITL', 'Cliente pide humano o frustración crítica.', 'Igual.'],
  ]),
  h2('Ejemplos de conversación'),
  h3('Ejemplo A — Mostrar opciones y captura'),
  ...dialogue([
    ['Cliente', 'Listo, del 15 al 17 de mayo, en Carmen, 8 personas, hasta 1.5 millones'],
    ['Agente', '¡Perfecto! Tengo 3 opciones para esas fechas: F001 con piscina y BBQ (cómoda para 8); F003 con jacuzzi para 10; F008 más rural con asadero. ¿Cuál te llama la atención?'],
    ['Cliente', 'La del jacuzzi'],
    ['Agente', '¡Listo, F003! Déjame verificar disponibilidad…'],
  ]),
  pb('Estado al final del ejemplo: ', 'finca_elegida_id="F003", shown_fincas=["F001","F003","F008"]. Transición → VERIFYING_AVAILABILITY.'),
  spacer(),
  h3('Ejemplo B — Pide más opciones'),
  ...dialogue([
    ['Cliente', '¿Tienes más opciones?'],
    ['Agente', 'Tengo 2 más: F012 con kiosko grande, F015 con cancha. ¿Te llaman la atención?'],
  ]),
  pb('Detrás de escena: ', 'list_matching_fincas con excludeIds=["F001","F003","F008"] (las ya mostradas) → retorna F012 y F015. shown_fincas se actualiza a ["F001","F003","F008","F012","F015"].'),
  spacer(),
  h3('Ejemplo C — No hay matches con exclusiones'),
  ...dialogue([
    ['Cliente', 'No me gustan, ¿qué más tienes?'],
    ['Agente', 'Con esos criterios ya te mostré todo lo disponible para esa fecha. Si ajustamos un poco —por ejemplo subir presupuesto a 2M, o ampliar a Girardot— me salen más opciones. ¿Te animas a alguna de esas dos?'],
  ]),
  pb('Comportamiento: ', 'No inventa fincas. Reconoce que el inventario filtrado se agotó y propone relajar criterios (NO_MATCH intent).'),
  h2('Diferencias v1 vs v2'),
  comparisonTable([
    ['Tope de tool calls', '4 iteraciones máximo (LangChain). Si no termina, ABORTA sin enviar respuesta', '3 iteraciones máximo IMPLEMENTADAS EN CÓDIGO. Al agotarlas, fuerza al LLM a producir respuesta final con un prompt explícito ("no más tools, devuelve tu JSON final"). Nunca hay silencio'],
    ['FAQ durante OFFERING (mascotas, precios)', 'A veces el offering_agent intenta responder y entra en loop hasta Max iterations 4', 'Router determinístico envía la pregunta al QA agent SIEMPRE, sin que el offering_agent siquiera la vea'],
    ['Exclusión de fincas mostradas', 'Funciona la mayor parte del tiempo, pero hay reportes de fincas repetidas en algunas conversaciones', 'shown_fincas se actualiza automáticamente al persistir la decisión; excludeIds se calcula del state, no del prompt'],
    ['Privacidad del nombre real', 'Mantenida correctamente', 'Mantenida; además el inventory_reader_tool retorna PublicFincaView sin realName a propósito (defensa en profundidad)'],
    ['Búsqueda con OR de zonas', 'No soportada — el cliente pide "Carmen O Girardot" y solo busca en una', 'Aún no soportada en v2; documentada como mejora propuesta'],
  ]),
];

// 5. VERIFYING
const SECTION_VERIFYING = [
  pageBreak(),
  h1('5. Estado: VERIFYING_AVAILABILITY'),
  p('Estado de transición rápido. El cliente acaba de elegir una finca. Le decimos que estamos verificando con el propietario, le pedimos los datos del titular en paralelo, y avanzamos a CONFIRMING_RESERVATION sin hacerlo esperar.'),
  h2('Objetivo'),
  p('Notificar al propietario por WhatsApp para que confirme disponibilidad. Informar al cliente que estamos verificando. Auto-loopear inmediatamente a CONFIRMING_RESERVATION para empezar a recoger datos del titular sin que el cliente espere al propietario.'),
  h2('Información que pide al cliente'),
  p('NINGUNA en este estado. La idea es no hacer esperar al cliente — el agente solo informa que está verificando y pasa al siguiente estado en el mismo turn.'),
  h2('Información que extrae automáticamente'),
  p('Ninguna. El estado es de duración cero conceptualmente.'),
  h2('Tools que puede llamar'),
  p('No usa LLM tools. Internamente:'),
  bullet('Inserta fila en selection_notifications con status="pending" para que un worker separado avise al propietario'),
  bullet('En v2: opcionalmente envía mensaje WhatsApp al número del propietario (+1 205-583-7827, WHATSAPP_OWNER_PHONE_NUMBER_ID) usando sendOwnerMessage'),
  h2('Reglas críticas'),
  bullet('NO hace esperar al cliente — la transición a CONFIRMING_RESERVATION es inmediata'),
  bullet('Si el propietario rechaza disponibilidad después, un proceso externo lo detecta y bumpea la conversación de vuelta a OFFERING con el flag owner_unavailable; el agente entonces se disculpa y propone alternativas'),
  bullet('Si el propietario confirma, el flujo continúa transparentemente — el cliente nunca sabe si hubo demora'),
  bullet('PRIVACIDAD: en este estado el agente todavía NO revela el nombre real de la finca (espera hasta CONFIRMING)'),
  h2('Transiciones de salida'),
  comparisonTable([
    ['→ CONFIRMING_RESERVATION', 'Auto-loop inmediato (mismo turn).', 'Igual.'],
    ['→ OFFERING', 'Si owner rechaza disponibilidad (handler externo, no este estado).', 'Igual.'],
    ['→ HITL', 'Cliente pide humano.', 'Igual.'],
  ]),
  h2('Ejemplo de conversación'),
  ...dialogue([
    ['Cliente', 'La del jacuzzi'],
    ['Agente', '¡Listo, F003! Estoy verificando disponibilidad con el propietario. Mientras tanto, déjame pedirte unos datos para tener todo listo cuando confirme.'],
    ['Agente', 'Necesito tu nombre completo, tipo y número de documento, celular, email y dirección.'],
  ]),
  pb('Detrás de escena: ', 'Mensaje 1 termina el VERIFYING. Mensaje 2 ya es del estado CONFIRMING_RESERVATION (auto-loop en el mismo turn). El cliente percibe una sola conversación fluida; en realidad la transición ocurrió.'),
  h2('Diferencias v1 vs v2'),
  comparisonTable([
    ['Notificación al propietario', 'Por email + dashboard interno', 'Igual + opcionalmente WhatsApp directo al número del propietario (+1 205-583-7827) si la feature está activada'],
    ['Auto-loop a CONFIRMING', 'Implementado vía intent WAITING_OWNER que el orquestador re-procesa', 'Implementado en código: VerifyingStage.handle() retorna nextStage=CONFIRMING_RESERVATION directamente'],
    ['Comportamiento si el propietario tarda', 'Cliente queda en CONFIRMING_RESERVATION, el agente recoge datos. Si el propietario rechaza luego, vuelve a OFFERING.', 'Igual.'],
    ['Mensaje cuando no hay finca seleccionada', 'No previsto — puede crashear', 'Si llega a VERIFYING sin selectedFinca, vuelve a OFFERING con un mensaje "algo no encajó, ¿me confirmas cuál finca te gustó?"'],
  ]),
];

// 6. CONFIRMING
const SECTION_CONFIRMING = [
  pageBreak(),
  h1('6. Estado: CONFIRMING_RESERVATION'),
  p('El cliente eligió finca y estamos verificando disponibilidad. Ahora hay que recoger los datos del titular para emitir la confirmación de reserva en PDF.'),
  h2('Objetivo'),
  p('Recolectar los 6 datos del titular, generar el PDF de confirmación con propiedad + fechas + tarifa + datos del titular + medios de pago, enviarlo como adjunto, y escalar a HITL para seguimiento humano.'),
  h2('Información que pide al cliente'),
  p('Los 6 campos del titular, idealmente todos en un solo mensaje:'),
  bullet('nombreCompleto'),
  bullet('tipoDocumento (CC | CE | PASAPORTE)'),
  bullet('numeroDocumento'),
  bullet('celular'),
  bullet('email'),
  bullet('direccion'),
  spacer(),
  pb('Estilo de pregunta v2: ', '"Para emitir tu confirmación necesito tu nombre completo, tipo y número de documento, celular, email y dirección." Pide TODO en un mensaje, no un campo por mensaje.'),
  h2('Información que extrae automáticamente'),
  p('Si el cliente entrega datos en cualquier orden y formato razonable, el agente los extrae todos. Ejemplos:'),
  bullet('"Soy Juan Pérez, CC 1020384756, mi cel 3001234567 y mi correo juan@example.com" → extrae 4 campos en una pasada'),
  bullet('"Calle 100 #15-20, Bogotá" → extrae direccion'),
  spacer(),
  pb('Persistencia: ', 'Cada extracción acumula en reservation (JSONB). El estado de "completitud" se evalúa con la regla: los 6 campos requeridos están presentes y no vacíos.'),
  h2('Tools que puede llamar'),
  pb('generate_reservation_pdf — ', 'cuando los 6 campos están completos, el código (no el LLM) llama a este tool internamente. Genera un PDF de una página con propiedad + fechas + tarifa + datos del titular + medios de pago. Retorna { base64, filename, bytes }.'),
  h2('Reglas críticas'),
  bullet('PRIVACIDAD: en ESTE estado SÍ se revela el nombre real de la finca al cliente (porque va en el PDF de reserva)'),
  bullet('Pedir todos los datos faltantes en un solo mensaje, no de a uno'),
  bullet('Si el cliente pregunta sobre medios de pago, mostrarlos sin demora'),
  bullet('Si el propietario confirma disponibilidad mientras estamos en este estado, comunicarlo al cliente naturalmente sin interrumpir el flujo'),
  bullet('NO emitir el PDF hasta tener TODOS los datos requeridos'),
  bullet('Después de enviar el PDF, transicionar inmediatamente a HITL'),
  h2('Transiciones de salida'),
  comparisonTable([
    ['→ HITL', 'Cuando los 6 datos están completos Y el PDF se generó y envió correctamente.', 'Igual; en v2 también va a HITL si el PDF falla generándose (con un mensaje de fallback "un asesor te lo enviará en breve").'],
    ['Permanece en CONFIRMING', 'Mientras falten datos.', 'Igual.'],
    ['→ OFFERING', 'Si el cliente quiere cambiar de finca (intent CHANGE_FINCA).', 'Igual.'],
    ['→ QA', 'Pregunta puntual sobre la reserva, medios de pago, etc.', 'En v1 a veces el confirming_agent intenta responder y se confunde; en v2 va al QA agent.'],
  ]),
  h2('Ejemplos de conversación'),
  h3('Ejemplo A — Datos en bloque'),
  ...dialogue([
    ['Agente', 'Necesito tu nombre completo, tipo y número de documento, celular, email y dirección.'],
    ['Cliente', 'Juan Pérez, CC 1020384756, cel 3001234567, juan@example.com, Calle 100 #15-20 Bogotá'],
    ['Agente', '¡Listo Juan! Te envío la confirmación ahora mismo. (adjunta PDF)'],
  ]),
  pb('Detrás de escena: ', 'Los 6 campos detectados → reservation completa → llamado a generate_reservation_pdf → outbound con type="document" + attachment base64 → transición a HITL.'),
  spacer(),
  h3('Ejemplo B — Datos parciales'),
  ...dialogue([
    ['Agente', 'Necesito nombre completo, documento, celular, email y dirección.'],
    ['Cliente', 'María Gómez, 1098765432'],
    ['Agente', '¡Listo María! Me faltan: tipo de documento (CC, CE, pasaporte), celular, email y dirección.'],
  ]),
  pb('Comportamiento: ', 'Permanece en CONFIRMING hasta tener todos los datos. Pide los faltantes en un mensaje compacto, no uno por uno.'),
  h2('Diferencias v1 vs v2'),
  comparisonTable([
    ['Pedir datos del titular', 'A veces de a uno, a veces todos juntos (inconsistente)', 'Siempre todos los faltantes en un solo mensaje'],
    ['Extracción de varios campos en un mensaje del cliente', 'Funciona pero a veces falla en formatos no estándar', 'Mejor tolerancia gracias al schema relajado y extracción explícita en JSON'],
    ['Generación de PDF', 'Vía librería custom en el simulator/lib/, llamada desde n8n', 'Generador PDF puro en TypeScript dentro del repo (apps/agent/src/agent/tools/generate-pdf.ts), no depende del simulator'],
    ['Privacidad del nombre real', 'Sí lo revela aquí, correcto', 'Igual, además el LLM tiene el realName explícito en el system prompt para que pueda usarlo libremente'],
    ['Si la generación de PDF falla', 'No previsto — la conversación queda colgada', 'Captura la excepción, manda mensaje de fallback "un asesor te lo enviará", transición a HITL igual'],
    ['Eval de regresión', 'No', 'confirming-multi-data en silences.jsonl (actualmente FAIL → fallback funciona, prompt necesita hardening)'],
  ]),
];

// 7. HITL
const SECTION_HITL = [
  pageBreak(),
  h1('7. Estado: HITL (Human In The Loop)'),
  p('La conversación ha sido escalada a un humano. El bot está desactivado para esta conversación específica.'),
  h2('Objetivo'),
  p('Transferir el control a un asesor humano y dejar de responder automáticamente. Si el cliente sigue escribiendo después de la escalación, mostrar un mensaje breve recordando que un asesor lo está atendiendo.'),
  h2('Triggers para entrar a HITL'),
  bullet('Cliente pide hablar con humano explícitamente ("pásame con un asesor", "quiero hablar con una persona")'),
  bullet('Frustración crítica detectada (insultos, amenazas, mención de policía/abogado)'),
  bullet('Disputa de pagos o reembolsos'),
  bullet('Después de enviar el PDF de confirmación (HITL es el estado final por diseño)'),
  bullet('Error del sistema irrecuperable'),
  h2('Información que pide / extrae'),
  p('Ninguna. El estado es de "modo silencioso".'),
  h2('Tools que puede llamar'),
  p('Ninguno.'),
  h2('Reglas críticas'),
  bullet('agente_activo se setea a false → el orquestador hace short-circuit en el próximo inbound: status="silent", silence_reason="HITL_ACTIVE"'),
  bullet('Si por alguna razón el handler de HITL recibe un mensaje (por ejemplo agente_activo todavía true cuando llega), responde una vez con el handoff_message configurado y luego la siguiente vez ya está silencioso'),
  bullet('Mensaje de handoff por defecto: "Ya un asesor humano se está encargando de tu caso, te contactará en breve. ¡Gracias por tu paciencia!"'),
  bullet('No envía typing indicator (no estamos "escribiendo")'),
  h2('Transiciones de salida'),
  p('Ninguna automática. Solo un humano puede reactivar la conversación cambiando agente_activo=true desde el dashboard.'),
  h2('Diferencias v1 vs v2'),
  comparisonTable([
    ['Detección de frustración', 'Regex básica + LLM classifier en el QA agent', 'Regex extendida (incluye "demanda", "abogado", "policía", "estafa", "no quiero este bot") + LLM classifier de fallback'],
    ['Mensaje de handoff', 'Hardcoded en el prompt del HITL agent', 'Configurable desde el dashboard (campo handoff_message en agent_settings)'],
    ['Comportamiento al recibir mensaje con agente_activo=false', 'A veces responde por bug; a veces silencio', 'Silencio determinístico — short-circuit en el orquestador con silence_reason="HITL_ACTIVE", trace marca status="silent"'],
    ['Visibilidad para operadores', 'Tag en Chatwoot', 'Tag en Chatwoot + columna HITL en el Kanban del dashboard nuevo'],
  ]),
];

// 8. QA flotante
const SECTION_QA = [
  pageBreak(),
  h1('8. Agente QA Flotante'),
  p('El agente QA no es un estado; es un módulo que responde preguntas puntuales en cualquier estado del flujo principal sin cambiarlo. Después de responder, el cliente vuelve al mismo estado en el que estaba.'),
  h2('Objetivo'),
  p('Responder preguntas frecuentes sobre la empresa, sus servicios, las fincas en general, ubicaciones, medios de pago, mascotas, qué incluye una estadía, etc. Sin descarrilar el flujo principal.'),
  h2('Cuándo se invoca'),
  bullet('El router detecta una pregunta tipo FAQ via regex (mascotas, precios, RUT, ubicación, medios de pago, qué incluye, horarios, amenidades)'),
  bullet('El LLM classifier (fallback cuando el regex no matchea) decide destination="qa"'),
  spacer(),
  pb('Importante: ', 'El QA NO se invoca por el agente del estado actual. Se invoca por el ROUTER, ANTES de llegar al stage handler. Esto evita el bug de v1 donde offering_agent intentaba responder mascotas y entraba en loop.'),
  h2('Información que pide / extrae'),
  p('Pide aclaraciones solo si la pregunta es ambigua. Extrae intents y datos relevantes solo si la respuesta lo requiere.'),
  h2('Tools que puede llamar'),
  pb('send_document — ', 'cuando el cliente pide un documento institucional específico (RUT, Cámara de Comercio, NIT). El QA agent emite el tool_call y EL CÓDIGO resuelve la URL del documento desde settings.companyDocuments. El agente acompaña el adjunto con un mensaje ("Te lo paso ahora mismo"), NO solo dice que lo tiene sin enviarlo.'),
  pb('inventory_reader (limitado) — ', 'puede consultar el inventario para responder preguntas tipo "¿hay fincas con jacuzzi en Carmen?", pero NO para mostrar opciones de OFFERING (eso lo hace OFFERING).'),
  h2('Knowledge sources'),
  bullet('settings.companyKnowledge (JSON libre, editable desde el dashboard)'),
  bullet('settings.paymentMethods (JSON con cuentas, links de pago, etc.)'),
  bullet('settings.companyDocuments (lista de documentos con URL y topics)'),
  h2('Reglas críticas'),
  bullet('NUNCA inventa información. Si no tiene la respuesta en su knowledge, dice "no tengo esa información, te paso con un asesor"'),
  bullet('NO cambia el current_stage de la conversación'),
  bullet('Cuando el cliente pide un documento (RUT, etc.), DEBE enviarlo (no decir que lo tiene y dejarlo sin enviar)'),
  bullet('Tono: idéntico al del flujo principal (Bogotá-cálido), respuestas breves (1-3 frases)'),
  h2('Ejemplos'),
  h3('Pregunta sobre mascotas durante OFFERING'),
  ...dialogue([
    ['Cliente', '¿En esa finca aceptan mascotas?'],
    ['Agente (QA)', '¡Sí! En F003 puedes llevar mascotas. Cobran un depósito de seguridad de $100,000 reembolsable. ¿Algo más antes de avanzar?'],
  ]),
  pb('Detrás de escena: ', 'Estado se mantiene en OFFERING. La pregunta no descarrila el flujo. Después de responder, el siguiente mensaje del cliente vuelve al OFFERING normal.'),
  spacer(),
  h3('Solicitud de documento'),
  ...dialogue([
    ['Cliente', '¿Me pueden mandar el RUT?'],
    ['Agente (QA)', '¡Claro! Te lo paso ahora mismo. (adjunta RUT_2026.pdf)'],
  ]),
  pb('Detrás de escena: ', 'tool_call={ name: "send_document", input: { topic: "rut" } }. El código busca en settings.companyDocuments un documento con topic="rut", obtiene URL, lo agrega como attachment al outbound message.'),
  h2('Diferencias v1 vs v2'),
  comparisonTable([
    ['Cuándo se invoca', 'A veces el router (n8n QA Validator) lo invoca, a veces no. Casos como "mascotas" en OFFERING fallan en invocarlo y caen al offering_agent que entra en loop', 'Router determinístico con regex extensa: mascotas, precio/tarifa/costo, RUT/Cámara/NIT, ubicación, medios de pago, qué incluye, horarios, amenidades. Si no matchea, LLM classifier decide. Nunca silencio'],
    ['Envío de documentos', 'A veces dice "sí tengo el RUT" pero NO lo envía. Cliente tiene que insistir', 'tool_call de send_document es obligatorio en el prompt cuando se menciona un doc. El código lo resuelve y adjunta. El outbound dice "te lo paso ahora" + el archivo'],
    ['Acceso a inventario', 'Sí (inventory_reader_tool en n8n)', 'Sí (mismo tool, en TypeScript). Limitado a queries informativas, no a mostrar opciones'],
    ['Tono cuando no sabe', 'A veces inventa, a veces dice "no sé"', 'Prompt explícito: "si no tienes la info, di que no la tienes y ofrece pasar con un humano. NO inventes."'],
    ['Stage al que vuelve', 'Vuelve al stage anterior (correcto)', 'Igual. next_stage = current_stage siempre, salvo HITL_REQUEST'],
    ['Cobertura en evals', 'No', 'qa-precio-during-offering, qa-rut-document, silence-mascotas-faq (PASS)'],
  ]),
];

// 9. Comportamientos transversales
const SECTION_TRANSVERSAL = [
  pageBreak(),
  h1('9. Comportamientos Transversales'),
  p('Reglas y mecanismos que aplican a TODOS los estados, no a uno solo.'),
  h2('9.1 Routing — qué agente responde a cada mensaje'),
  p('Cada mensaje inbound pasa por dos pasos antes de llegar al stage handler:'),
  bullet('Reglas determinísticas (regex sobre el texto del mensaje)'),
  bullet('LLM classifier (solo si las reglas no matchearon)'),
  spacer(),
  h3('Reglas determinísticas (en orden)'),
  bullet('Patrones HITL: "pásame con humano", "quiero hablar con asesor", "ya no quiero este bot", "demanda", "abogado", "policía", "estafa" → destination=hitl'),
  bullet('Patrones FAQ: "mascotas", "precio/tarifa/cuesta", "rut/cámara de comercio/nit", "dónde queda/ubicación", "medios de pago", "qué incluye", "check-in/horario", "piscina/jacuzzi/wifi/parqueadero" → destination=qa'),
  bullet('Si nada matchea → pasa al LLM classifier'),
  spacer(),
  h3('LLM classifier (fallback)'),
  p('Llama al LLM con un prompt corto: clasifica el mensaje en {qa, hitl, stage}, retorna JSON. Si el LLM falla, default es destination=stage (deja al stage actual manejarlo). Nunca silencio.'),
  spacer(),
  h2('9.2 Manejo de audio'),
  p('Pipeline cuando llega un audio:'),
  bullet('Worker recibe job con media.url y media.mimeType audio/*'),
  bullet('Descarga el audio (download.ts)'),
  bullet('Llama a transcribe.ts con domain prompt (incluye los fincaIds del inventario para mejor reconocimiento de códigos como "F003")'),
  bullet('Si la transcripción es exitosa → text=transcripción, transcription_status="ok"'),
  bullet('Si la transcripción es vacía → text=null, transcription_status="empty"'),
  bullet('Si la transcripción falla (error de red, timeout) → text=null, transcription_status="failed"'),
  bullet('El orquestador persiste el inbound con message_type="AUDIO_UNTRANSCRIBED" cuando la transcripción es empty/failed (para que NO viole el constraint messages_text_or_media)'),
  bullet('Para los casos empty/failed, dispara fallback con un mensaje al cliente pidiéndole que escriba'),
  h2('9.3 Mensajes múltiples del cliente (batching)'),
  comparisonTable([
    ['Cuándo ocurre', '"Que" + "hora" + "es?" enviados como 3 mensajes consecutivos en menos de 5 segundos.', 'Igual.'],
    ['v1 — cómo se maneja', 'Cada inbound corre el agente. Los primeros mensajes se marcan pending=true (no se responden) si llega otro antes. El último mensaje agrega los pending y dispara una nueva ejecución con el texto concatenado.', 'No aplica.'],
    ['v2 — cómo se maneja', 'No aplica.', 'Row-level lock por conversation_id en BullMQ: solo un job por conversación corre a la vez. Mensaje 1 procesa; mensajes 2-3 esperan. Mensaje 1 termina con su respuesta. Mensaje 2 corre. Mensaje 3 corre. Cada uno con el contexto actualizado.'],
    ['Riesgo en v1', 'Si el agente responde al texto del primer mensaje del batch en lugar de al concatenado, el cliente percibe que ignoró su intención completa', 'No existe — cada mensaje individual se procesa con todo el contexto previo, en orden'],
  ]),
  h2('9.4 Invariante "siempre responder"'),
  p('Cada turn del orquestador termina con un check obligatorio:'),
  codeBlock(
    'if (outbound.length === 0 && silenceReason === null) {\n  await logFallbackEvent({ reason: "NO_OUTBOUND_NO_REASON", ... });\n  outbound.push(FALLBACK_MESSAGE);\n}',
  ),
  pb('silenceReason solo puede ser: ', 'HITL_ACTIVE, OUT_OF_OPERATING_HOURS, DUPLICATE_MESSAGE, EXPLICITLY_IGNORED.'),
  pb('Cualquier otro caso ', 'dispara fallback + log en fallback_events. El cliente SIEMPRE recibe respuesta.'),
  spacer(),
  h2('9.5 Loops y double iterations'),
  p('Solo OFFERING puede llamar tools en su decisión. El loop está topado en código:'),
  bullet('Iteración 1: el LLM emite tool_calls (ej. list_matching_fincas)'),
  bullet('Código ejecuta los tools server-side, anexa el resultado al historial'),
  bullet('Iteración 2: el LLM ve los resultados y o responde, o pide más tools'),
  bullet('Iteración 3: ídem'),
  bullet('Si llega a iteración 4, el código fuerza al LLM a producir respuesta final con un prompt explícito: "ya consultaste suficientes tools. Devuelve JSON FINAL con done=true y outbound_text al cliente — no más tool_calls"'),
  spacer(),
  pb('Qué ve el cliente: ', 'NADA hasta que el agente termine de iterar. La respuesta final llega de una vez. No hay "está pensando..." ni mensajes intermedios.'),
  pb('Tiempo típico: ', '5-10 segundos para una iteración con tool. Total para OFFERING con tools: 8-20 segundos.'),
  h2('9.6 Privacy invariants — nombre real de la finca'),
  comparisonTable([
    ['QUALIFYING', 'NO se revela (no hay finca aún)', 'Igual'],
    ['OFFERING', 'NUNCA se revela. Solo fincaId o frases descriptivas', 'NUNCA se revela. PublicFincaView del tool no incluye realName (defensa en profundidad)'],
    ['VERIFYING_AVAILABILITY', 'NO se revela', 'Igual'],
    ['CONFIRMING_RESERVATION', 'SÍ se revela (va en el PDF)', 'Igual; LLM tiene realName explícito en el system prompt para poder usarlo'],
    ['HITL', 'N/A (humano se encarga)', 'Igual'],
    ['QA', 'Depende: si la pregunta es genérica, no; si es sobre la finca seleccionada Y el estado es CONFIRMING o posterior, sí', 'Igual'],
  ]),
];

// 10. Búsqueda de fincas
const SECTION_INVENTORY = [
  pageBreak(),
  h1('10. Cómo Busca Fincas el Agente'),
  p('La búsqueda no es un texto-libre sobre el inventario; es un filtro determinístico con scoring sobre los criterios estructurados que el agente ya extrajo del cliente.'),
  h2('Filtros aplicados (hard filters — descartan fincas)'),
  bullet('Capacidad: si capacidadMax de la finca < personas pedidas → descarta'),
  bullet('Mascotas: si el cliente requiere mascotas y la finca no las permite → descarta'),
  spacer(),
  h2('Penalizaciones (soft — bajan el score pero NO descartan)'),
  bullet('Zona: si la zona del cliente no matchea → -30 puntos'),
  bullet('Ciudad: si la ciudad del cliente no matchea → -15 puntos'),
  bullet('Presupuesto: si precio_por_noche > presupuesto_max → -25 puntos'),
  bullet('Amenidades faltantes: -5 puntos por cada amenidad requerida que la finca no tiene'),
  bullet('Capacidad mínima: si la finca tiene capacidadMin > personas pedidas → -10 puntos (puede recibir grupo más pequeño pero no es ideal)'),
  spacer(),
  h2('Bonificaciones'),
  bullet('Capacidad ajustada: si capacidadMax - personas está entre 0 y 2 (ni demasiado vacía ni apretada) → +10 puntos'),
  bullet('Slack mayor: -1 punto por cada persona de exceso de capacidad (penaliza fincas demasiado grandes)'),
  spacer(),
  h2('Score final'),
  pb('Base: ', '100. Las penalizaciones y bonificaciones modifican esta base. Score típico: 70-110.'),
  pb('Ordenamiento: ', 'descendente por score. Top-N (default 5).'),
  pb('Empates: ', 'orden de inserción del Google Sheet (no determinístico estricto).'),
  h2('Exclusiones (cuando el cliente pide "más opciones")'),
  bullet('shown_fincas guarda todas las fincaIds presentadas hasta ahora'),
  bullet('Cada llamada a list_matching_fincas pasa shown_fincas como excludeIds'),
  bullet('El agente NO puede repetir fincas (constraint en el tool, no en el prompt)'),
  bullet('Si después de excluir mostradas no hay matches, el tool retorna matches=[] y el agente le dice al cliente "no me quedan más opciones, ¿ajustamos criterios?"'),
  h2('Casos donde "no muestra lo que el cliente quiere"'),
  comparisonTable([
    ['Cliente pide "Carmen O Girardot"', 'Solo busca por una zona; pierde matches válidos en la otra', 'Aún no soportado. Mejora propuesta: parsear OR en el extracted_data.zona'],
    ['Cliente pide capacidad 8 y todas son 12+', 'Devuelve [] sin explicar al cliente que el inventario no tiene fincas más pequeñas', 'Mismo comportamiento; mejora propuesta: si todas las fincas descartadas fueron por capacidad, mencionarlo: "todas las fincas en Carmen son para grupos más grandes, ¿te sirve una para 12?"'],
    ['Cliente pide amenidad rara (ej. "helipuerto")', 'Penaliza pero no descarta; muestra fincas sin la amenidad como "matches" con score bajo', 'Mismo comportamiento; el agente debería advertir "ninguna tiene helipuerto pero estas son las más cercanas a tus criterios"'],
    ['Inventario desactualizado en Sheet', 'Cache de 5 min. Cambios manuales tardan en reflejarse', 'Igual. Hay endpoint POST /api/inventory/refresh para forzar refresh desde el dashboard'],
  ]),
];

// 11. Tabla resumen de diferencias
const SECTION_SUMMARY = [
  pageBreak(),
  h1('11. Tabla Resumen — Diferencias v1 vs v2 por Impacto'),
  p('Lista exhaustiva ordenada por impacto en la experiencia del cliente.'),
  spacer(),
  genericTable(
    ['#', 'Comportamiento', 'v1 (n8n hoy)', 'v2 (Nuevo)', 'Impacto'],
    [
      [
        '1',
        'Audio sin transcripción (vacía)',
        'Persiste content="" → silencio',
        'Pide al cliente que escriba',
        'Alto',
      ],
      [
        '2',
        'FAQ "mascotas" en OFFERING',
        'Va a offering_agent → Max iterations 4 → silencio',
        'Router → QA agent siempre',
        'Alto',
      ],
      [
        '3',
        'Tool loop bound',
        '4 iter (LangChain) → aborta si no termina',
        '3 iter en código → fuerza respuesta final',
        'Alto',
      ],
      [
        '4',
        'Crash en audio fallido',
        'TypeError en Code node → ejecución muere',
        'try/catch + fallback obligatorio',
        'Alto',
      ],
      [
        '5',
        'QA envío de documentos',
        'A veces dice "sí tengo el RUT" sin enviarlo',
        'tool_call obligatorio + adjunto resuelto en código',
        'Alto',
      ],
      [
        '6',
        '"Tienes más opciones?"',
        'A veces no excluye shown_fincas',
        'Excluye automáticamente vía tool input',
        'Medio',
      ],
      [
        '7',
        'CONFIRMING — pedir titular',
        'Inconsistente: a veces uno por uno, a veces juntos',
        'Siempre todos los faltantes en un solo mensaje',
        'Medio',
      ],
      [
        '8',
        'PDF de confirmación',
        'Generador en simulator/lib (Node)',
        'Generador en TypeScript dentro del repo',
        'Bajo',
      ],
      [
        '9',
        'HITL recepción de mensaje con bot off',
        'A veces responde por bug',
        'Silencio determinístico, status=silent',
        'Medio',
      ],
      [
        '10',
        'Detección de frustración',
        'Regex básica',
        'Regex extendida + LLM classifier',
        'Medio',
      ],
      [
        '11',
        'Mensajes múltiples (batching)',
        'pending=true + self-webhook con texto concatenado',
        'Row-level lock por conv en BullMQ; un job a la vez',
        'Medio',
      ],
      [
        '12',
        'Búsqueda Carmen OR Girardot',
        'No soportada',
        'Aún no soportada (mejora propuesta)',
        'Bajo',
      ],
      [
        '13',
        'Observabilidad (qué hizo el agente)',
        'Logs en n8n executions, dispersos',
        'Tabla traces + agent_turns con cada prompt/response/tool',
        'Alto (operador)',
      ],
      [
        '14',
        'Fallback messages',
        'Algunos paths terminan sin outbound',
        'Invariante "siempre responder" + log en fallback_events',
        'Alto',
      ],
      [
        '15',
        'Configuración del tono',
        'Hardcoded en prompts',
        'Editable desde dashboard (settings.tone_guidelines_extra)',
        'Bajo',
      ],
      [
        '16',
        'Soporte multi-usuario simultáneo',
        '1 ejecución por mensaje, sin lock por conv',
        'BullMQ worker pool con concurrencia configurable + lock por conv',
        'Alto (escala)',
      ],
      [
        '17',
        'Privacidad (nombre real)',
        'Mantenida en prompts',
        'Mantenida en prompts + defensa adicional en tool layer (PublicFincaView)',
        'Bajo',
      ],
      [
        '18',
        'Tests de regresión',
        'No',
        '13 evals en silences.jsonl, 10 PASS',
        'Alto (mantenimiento)',
      ],
      [
        '19',
        'Dashboard de operador',
        'HTML+JS vanilla en simulator/public',
        'Next.js 15 con 6 páginas',
        'Medio',
      ],
      [
        '20',
        'Two WhatsApp numbers',
        'Un solo número (Kapso)',
        'Cliente +57 310 5639334 separado de propietario +1 205-583-7827',
        'Medio',
      ],
    ],
  ),
];

// 12. Apéndice
const SECTION_APPENDIX = [
  pageBreak(),
  h1('12. Apéndice'),
  h2('12.1 Glosario de Intents'),
  p('El campo intent en cada decisión del agente es uno de estos strings:'),
  spacer(),
  genericTable(
    ['Intent', 'Significado', 'Estados donde aparece'],
    [
      ['GREETING', 'Cliente solo saludó', 'QUALIFYING'],
      ['QUALIFYING', 'Da datos parciales o completos del viaje', 'QUALIFYING'],
      ['SHOW_OPTIONS', 'Va a mostrar fincas', 'OFFERING'],
      ['CLIENT_CHOSE', 'Cliente eligió una finca', 'OFFERING (transición a VERIFYING)'],
      ['ADJUST_CRITERIA', 'Cliente ajusta criterios de búsqueda', 'OFFERING'],
      ['NO_MATCH', 'No hay fincas que coincidan con criterios actuales', 'OFFERING'],
      ['QUESTION', 'Pregunta puntual sobre algo del estado actual', 'Cualquier estado'],
      ['QA_ANSWERED', 'Pregunta respondida por el QA agent', 'QA'],
      ['WAITING_OWNER', 'Verificando con propietario', 'VERIFYING_AVAILABILITY'],
      ['CHANGE_FINCA', 'Cliente quiere cambiar la finca elegida', 'VERIFYING o CONFIRMING'],
      ['REQUEST_CONFIRMATION_DATA', 'Pide o recibe datos del titular', 'CONFIRMING_RESERVATION'],
      ['DOCUMENT_READY', 'Datos completos, generar y enviar PDF', 'CONFIRMING_RESERVATION'],
      ['HITL_REQUEST', 'Cliente pide humano o frustración crítica', 'Cualquier estado'],
      ['CANCEL', 'Cliente quiere cancelar', 'Cualquier estado'],
      ['OFF_TOPIC', 'Mensaje fuera de tema', 'Cualquier estado'],
    ],
  ),
  h2('12.2 Glosario de Estados'),
  genericTable(
    ['Estado', 'Trigger de entrada', 'Trigger de salida'],
    [
      ['QUALIFYING', 'Conversación nueva', 'Datos completos → OFFERING'],
      ['OFFERING', 'Datos completos en QUALIFYING', 'Cliente eligió → VERIFYING'],
      ['VERIFYING_AVAILABILITY', 'Cliente eligió finca', 'Auto-loop inmediato → CONFIRMING'],
      ['CONFIRMING_RESERVATION', 'Auto-loop desde VERIFYING', 'PDF enviado → HITL'],
      ['HITL', 'Escalación o PDF enviado', 'Solo manual desde dashboard'],
    ],
  ),
  h2('12.3 Tools disponibles'),
  genericTable(
    ['Tool', 'Estados que lo usan', 'Input', 'Output'],
    [
      [
        'list_matching_fincas',
        'OFFERING (principalmente), QA (consultas)',
        '{ personas?, zona?, ciudad?, presupuestoMax?, amenidadesRequeridas?, mascotas?, excludeIds?, limit? }',
        '{ matches: PublicFincaView[], totalReturned }',
      ],
      [
        'get_finca_details',
        'OFFERING',
        '{ fincaId }',
        '{ found, finca: PublicFincaView }',
      ],
      [
        'send_document',
        'QA',
        '{ topic: "rut" | "camara_comercio" | "nit" }',
        '(resuelto por código → adjunto al outbound)',
      ],
      [
        'generate_reservation_pdf',
        'CONFIRMING_RESERVATION',
        '{ finca, reservation, searchCriteria, paymentMethods }',
        '{ base64, filename, bytes }',
      ],
    ],
  ),
  h2('12.4 Diccionario de términos'),
  pb('Finca: ', 'Propiedad rural disponible para alquiler vacacional. Cada finca tiene un fincaId (código) y un realName (nombre comercial).'),
  pb('Propietario: ', 'Dueño de una finca. NO es el cliente. Recibe notificación de WhatsApp para confirmar disponibilidad cuando un cliente elige su finca.'),
  pb('Titular: ', 'La persona que firmará la reserva (puede ser distinta del cliente que conversa). Sus 6 datos (nombre, doc, cel, email, dir, tipo doc) van en el PDF.'),
  pb('HITL (Human In The Loop): ', 'Estado donde el bot está desactivado y un asesor humano atiende la conversación.'),
  pb('Stage / Estado: ', 'Punto del flujo conversacional. La conversación tiene un current_stage y va transicionando.'),
  pb('Intent: ', 'Etiqueta que el LLM produce en cada turn describiendo "qué intentó hacer este mensaje". Ver §12.1.'),
  pb('Trace: ', 'Registro de un ciclo inbound→outbound completo. Incluye stage_before/after, intent, status, duration_ms, errores. Visible en el dashboard nuevo.'),
  pb('Agent turn: ', 'Una llamada al LLM dentro de un trace. Un trace puede tener varios agent_turns (router + stage handler + tool calls).'),
  pb('Fallback: ', 'Cuando el agente NO logra producir una respuesta válida, el invariante "siempre responder" inserta un mensaje genérico y registra un fallback_event para investigar.'),
  pb('shown_fincas: ', 'Lista de fincaIds que el agente ya mostró en una conversación. Se excluyen automáticamente en búsquedas posteriores.'),
];

// ---- Build document --------------------------------------------------------

const doc = new Document({
  creator: 'De Paseo en Fincas',
  title: 'Comportamiento del Agente — v1 vs v2',
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } },
    paragraphStyles: [
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 32, bold: true, font: 'Arial', color: '1B4F72' },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 26, bold: true, font: 'Arial', color: '2E75B6' },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 },
      },
      {
        id: 'Heading3',
        name: 'Heading 3',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 22, bold: true, font: 'Arial', color: '1F4E79' },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
      {
        reference: 'numbers',
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                new TextRun({
                  text: 'De Paseo en Fincas — Comportamiento del Agente',
                  font: 'Arial',
                  size: 16,
                  color: '888888',
                  italics: true,
                }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'Página ', font: 'Arial', size: 16, color: '888888' }),
                new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: '888888' }),
              ],
            }),
          ],
        }),
      },
      children: [
        ...COVER,
        ...SECTION_1,
        ...SECTION_2,
        ...SECTION_QUALIFYING,
        ...SECTION_OFFERING,
        ...SECTION_VERIFYING,
        ...SECTION_CONFIRMING,
        ...SECTION_HITL,
        ...SECTION_QA,
        ...SECTION_TRANSVERSAL,
        ...SECTION_INVENTORY,
        ...SECTION_SUMMARY,
        ...SECTION_APPENDIX,
      ],
    },
  ],
});

const buffer = await Packer.toBuffer(doc);
const outDir = path.join(REPO_ROOT, 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'comportamiento-agente-v1-vs-v2.docx');
fs.writeFileSync(outPath, buffer);
console.log(`Created: ${outPath} (${buffer.length} bytes)`);
