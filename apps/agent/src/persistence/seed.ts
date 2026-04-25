/**
 * Seed minimal data for local dev: one fake conversation in QUALIFYING
 * and a baseline agent_settings row.
 */
import { pool } from './db.js';
import { logger } from '../observability/logger.js';

async function seed() {
  await pool.query(
    `UPDATE agent_settings SET
       tone_guidelines_extra = $1,
       initial_message_template = $2,
       handoff_message = $3
     WHERE id = 1`,
    [
      'Tono colombiano de Bogotá, cálido y profesional. Tutea (tú) o ustea (usted) según el cliente. Usa "porfa", "listo", "claro que sí" con naturalidad. Nunca "vos". Sé breve.',
      'Hola{client_name}, soy el asistente de De Paseo en Fincas. Cuéntame: ¿para cuántas personas y qué fechas tienes en mente?',
      'Te paso con un asesor humano para que te atienda mejor.',
    ],
  );

  await pool.query(
    `INSERT INTO conversations (wa_id, client_name, current_stage)
     VALUES ('demo-573000000000', 'Demo Client', 'QUALIFYING')
     ON CONFLICT (wa_id) DO NOTHING`,
  );

  logger.info('seed done');
}

seed()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'seed failed');
    await pool.end();
    process.exit(1);
  });
