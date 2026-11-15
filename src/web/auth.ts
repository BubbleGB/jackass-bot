import { createHash,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/index.js';
import { isSnowflake } from '../access/policy.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const opaque = () => randomBytes(32).toString('base64url');
export const validOpaque = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
export function returnPath(path: unknown): string {
  if (path === undefined) return '/servers';
  if (typeof path !== 'string' || !/^\/servers(?:\/\d{17,20}(?:\/knowledge)?)?$/.test(path)) throw new Error('invalid_return_path'); return path;
}
export class WebAuth {
  constructor(private readonly db: Database,private readonly secret: Buffer,private readonly now: () => Date) { if (secret.length !== 32) throw new Error('web_configuration'); }
  csrf(token: string): string { return createHmac('sha256',this.secret).update(`csrf:${token}`).digest('base64url'); }
  verifyCsrf(token: string,value: unknown): boolean { return validOpaque(value) && timingSafeEqual(Buffer.from(value),Buffer.from(this.csrf(token))); }
  async begin(path: string): Promise<{ state: string; browser: string }> {
    const state = opaque(),browser = opaque(),expires = new Date(this.now().getTime()+600000);
    await this.db.pool.query('DELETE FROM oauth_states WHERE expires_at <= $1',[this.now()]);
    await this.db.pool.query('INSERT INTO oauth_states(state_hash,browser_hash,return_to,expires_at) VALUES($1,$2,$3,$4)',[hash(state),hash(browser),path,expires]); return { state,browser };
  }
  async consume(state: unknown,browser: unknown): Promise<string> {
    if (!validOpaque(state) || !validOpaque(browser)) throw new Error('oauth_state');
    const r = await this.db.pool.query('DELETE FROM oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3 RETURNING return_to',[hash(state),hash(browser),this.now()]);
    if (!r.rows[0]) throw new Error('oauth_state'); return returnPath(r.rows[0].return_to);
  }
  async create(userId: string,old?: string): Promise<string> {
    if (!isSnowflake(userId)) throw new Error('oauth_failed');
    const token = opaque(); await this.db.pool.query('INSERT INTO web_sessions(session_hash,user_id,expires_at) VALUES($1,$2,$3)',[hash(token),userId,new Date(this.now().getTime()+43200000)]);
    if (old) await this.remove(old); return token;
  }
  async identify(token: unknown): Promise<string | null> {
    if (!validOpaque(token)) return null;
    const r = await this.db.pool.query('SELECT user_id FROM web_sessions WHERE session_hash=$1 AND expires_at>$2',[hash(token),this.now()]); return isSnowflake(r.rows[0]?.user_id) ? r.rows[0].user_id : null;
  }
  async remove(token: string): Promise<void> { if (validOpaque(token)) await this.db.pool.query('DELETE FROM web_sessions WHERE session_hash=$1',[hash(token)]); }
}
