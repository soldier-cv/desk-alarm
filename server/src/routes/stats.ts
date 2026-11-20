import type { FastifyInstance } from 'fastify';
import { requireHuman } from '../auth.js';
import { getMyStats } from '../repo/stats.js';

export async function statsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireHuman);
  app.get('/stats/me', async (req) => getMyStats(req.session!.user.id));
}
