export const IMAGE = 'ghcr.io/bubblegb/galaxy-neegy';
import { createHash } from 'node:crypto';
import { sourceCommit,SOURCE_URL } from './gate.mjs';
const name = IMAGE.slice('ghcr.io/'.length),hash = b => 'sha256:'+createHash('sha256').update(b).digest('hex');
const validDigest = d => typeof d === 'string' && /^sha256:[a-f0-9]{64}$/.test(d);
class Denied extends Error {}
export class Ghcr {
  constructor(http = fetch,username,credential) { this.http = http; this.username = username; this.credential = credential; this.tokens = new Map(); }
  async request(url,headers,storageRedirects = false) {
    let target = new URL(url); const forwarded = new Headers(headers),signal = AbortSignal.timeout(20000);
    for (let hop = 0; hop <= 3; hop++) {
      let r; try { r = await this.http(target.href,{ redirect: 'manual',signal,headers: forwarded }); } catch { throw new Error('registry_unavailable'); }
      if (![301,302,303,307,308].includes(r.status)) return r;
      if (!storageRedirects || hop === 3) throw new Error('registry_redirect_invalid');
      let next; try { next = new URL(r.headers.get('location'),target); } catch { throw new Error('registry_redirect_invalid'); }
      if (next.protocol !== 'https:' || next.username || next.password || !r.headers.get('location')) throw new Error('registry_redirect_invalid');
      // Signed storage URLs are never logged. Never forward registry auth across origins,
      // even if a later redirect returns to the registry origin.
      if (next.origin !== target.origin) forwarded.delete('authorization');
      target = next;
    } throw new Error('registry_redirect_invalid');
  }
  async authorization(anonymous) {
    if (this.tokens.has(anonymous)) return this.tokens.get(anonymous);
    const headers = {};
    if (!anonymous) {
      if (!this.username || !this.credential) throw new Error('registry_credentials_missing');
      headers.authorization = 'Basic '+Buffer.from(`${this.username}:${this.credential}`).toString('base64');
    }
    const r = await this.request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`,headers);
    if (anonymous && [401,403].includes(r.status)) throw new Denied();
    if (!r.ok) throw new Error(anonymous ? 'anonymous_pull_unverified' : 'registry_auth_failed');
    let body; try { body = await r.json(); } catch { throw new Error('registry_auth_failed'); }
    const token = body.token ?? body.access_token;
    if (typeof token !== 'string' || !token) throw new Error('registry_auth_failed');
    const authorization = 'Bearer '+token; this.tokens.set(anonymous,authorization); return authorization;
  }
  async content(kind,ref,anonymous = false) {
    if (!validDigest(ref) && !(kind === 'manifests' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(ref))) throw new Error('registry_reference_invalid');
    const r = await this.request(`https://ghcr.io/v2/${name}/${kind}/${ref}`,{ authorization: await this.authorization(anonymous),accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },kind === 'blobs');
    if (anonymous && [401,403].includes(r.status)) throw new Denied();
    if (r.status === 404 && !anonymous) return null;
    if (!r.ok) throw new Error(anonymous ? 'anonymous_pull_unverified' : 'registry_read_failed');
    let raw; try { raw = Buffer.from(await r.arrayBuffer()); } catch { throw new Error('registry_unavailable'); }
    if (raw.length > 2*1024*1024) throw new Error('registry_metadata_invalid');
    const digest = hash(raw);
    if ((kind === 'manifests' && r.headers.get('docker-content-digest') !== digest) || (validDigest(ref) && digest !== ref)) throw new Error('registry_digest_mismatch');
    let body; try { body = JSON.parse(raw.toString()); } catch { throw new Error('registry_metadata_invalid'); }
    return { digest,body };
  }
  manifest(ref,anonymous = false) { return this.content('manifests',ref,anonymous); }
  blob(ref) { return this.content('blobs',ref); }
}
export async function verifyRelease(registry,ref,source) {
  sourceCommit(source); const index = await registry.manifest(ref);
  if (!index) throw new Error('manifest_missing');
  const descriptors = index.body.manifests;
  if (index.body.schemaVersion !== 2 || !['application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'].includes(index.body.mediaType) || !Array.isArray(descriptors) || descriptors.length !== 2) throw new Error('manifest_platforms_invalid');
  const platforms = descriptors.map(d => `${d.platform?.os}/${d.platform?.architecture}`).sort();
  if (platforms.join(',') !== 'linux/amd64,linux/arm64') throw new Error('manifest_platforms_invalid');
  for (const d of descriptors) {
    if (!validDigest(d.digest)) throw new Error('manifest_metadata_invalid');
    const child = await registry.manifest(d.digest); if (!child || !validDigest(child.body.config?.digest)) throw new Error('manifest_metadata_invalid');
    const config = await registry.blob(child.body.config.digest),c = config?.body;
    if (c?.os !== 'linux' || c.architecture !== d.platform.architecture || c.config?.Labels?.['org.opencontainers.image.revision'] !== source || c.config.Labels['org.opencontainers.image.source'] !== SOURCE_URL) throw new Error('manifest_source_invalid');
  }
  let registryCredentialsRequired;
  try { const anonymous = await registry.manifest(index.digest,true); if (!anonymous || anonymous.digest !== index.digest) throw new Error('anonymous_pull_unverified'); registryCredentialsRequired = false; }
  catch (e) { if (!(e instanceof Denied)) throw e; registryCredentialsRequired = true; }
  return { image: IMAGE+'@'+index.digest,sourceCommit: source,platforms,registryCredentialsRequired };
}
