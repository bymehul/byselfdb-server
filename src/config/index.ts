import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  NODE_ENV: z.preprocess(
    (val) => (typeof val === 'string' ? val.trim() : val),
    z.enum(['development', 'production', 'test']).default('development')
  ),
  CORS_ORIGIN: z.preprocess(
    (val) => {
      if (typeof val !== 'string') return val;

      // Split by comma and trim each origin
      const origins = val.split(',').map(item => {
        let origin = item.trim().replace(/\/$/, '');
        // automatically add https:// if protocol is missing
        if (origin && !origin.startsWith('http://') && !origin.startsWith('https://')) {
          origin = `https://${origin}`;
        }
        return origin;
      });

      return origins;
    },
    z.union([z.string(), z.array(z.string())]).default('http://localhost:5173')
  ),
});

export const config = envSchema.parse(process.env);

export type Config = z.infer<typeof envSchema>;
