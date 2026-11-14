import { isSnowflake } from '../access/policy.js';
export interface OAuth { authorize(state: string): string; identify(code: string): Promise<string> }
/** Tokens are used only for identify and then discarded. No raw response/error logging. */
export class DiscordOAuth implements OAuth {
  constructor(private readonly clientId: string,private readonly clientSecret: string,private readonly origin: string,private readonly http: typeof fetch = fetch) {}
  authorize(state: string): string {
    const params = new URLSearchParams({ client_id: this.clientId,redirect_uri: `${this.origin}/auth/discord/callback`,response_type: 'code',scope: 'identify',state });
    return `https://discord.com/oauth2/authorize?${params}`;
  }
  async identify(code: string): Promise<string> {
    try {
      const token = await this.http('https://discord.com/api/v10/oauth2/token',{ method: 'POST',redirect: 'error',signal: AbortSignal.timeout(10000),headers: { 'content-type': 'application/x-www-form-urlencoded' },body: new URLSearchParams({ client_id: this.clientId,client_secret: this.clientSecret,grant_type: 'authorization_code',code,redirect_uri: `${this.origin}/auth/discord/callback` }) });
      if (!token.ok) throw new Error(); const body = await token.json() as { access_token?: unknown };
      if (typeof body.access_token !== 'string' || body.access_token.length > 4096) throw new Error();
      const user = await this.http('https://discord.com/api/v10/users/@me',{ redirect: 'error',signal: AbortSignal.timeout(10000),headers: { authorization: `Bearer ${body.access_token}` } });
      if (!user.ok) throw new Error(); const identity = await user.json() as { id?: unknown; bot?: boolean };
      if (!isSnowflake(identity.id) || identity.bot) throw new Error(); return identity.id;
    } catch { throw new Error('oauth_failed'); }
  }
}
