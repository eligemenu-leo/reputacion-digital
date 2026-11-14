/**
 * SOLO PRUEBAS. Graph API de Meta simulada (Facebook Login, páginas, Instagram
 * y comentarios) que se inyecta como `fetch`. Nunca contacta con Meta. Todos
 * los datos son ficticios.
 */
import { createHmac } from 'node:crypto';
import { META_SCOPES, metaEndpoints } from '../meta';

export interface FakeMetaComment {
  id: string;
  text: string;
  createdAt: string;
  fromId: string;
  fromName: string;
  replies: FakeMetaComment[];
  hidden?: boolean;
}

export interface FakeMetaPost {
  id: string;
  comments: FakeMetaComment[];
}

export interface FakeMetaPage {
  id: string;
  name: string;
  tasks: string[];
  token: string;
  posts: FakeMetaPost[];
  instagram?: { id: string; username: string; media: FakeMetaPost[] };
  subscribed: boolean;
}

type Failure = { status: number; code: number; subcode?: number; message?: string } | 'network';

export class FakeMetaApi {
  readonly ep = metaEndpoints();
  calls: { method: string; url: string; body?: string; auth?: string }[] = [];
  user = { id: '900100', name: 'Usuario Ficticio' };
  pages: FakeMetaPage[];
  codes = new Map<string, string[]>();
  /** Tokens válidos → tipo y permisos concedidos. */
  tokens = new Map<
    string,
    { kind: 'short' | 'user' | 'page'; scopes: string[]; pageId?: string }
  >();
  revokedUsers = 0;
  failures = new Map<string, Failure>();
  /** La siguiente respuesta publicada se guarda pero la conexión se corta. */
  dropAfterWrite = false;
  private seq = 0;

  constructor(
    public appId = '1234567890',
    public appSecret = 'test-meta-secret-0123456789',
  ) {
    this.pages = [
      {
        id: '101',
        name: 'Restaurante Ficticio (página de prueba)',
        tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'],
        token: 'EAAPage101fake',
        posts: [{ id: '101_1', comments: [] }],
        instagram: {
          id: '178414000001',
          username: 'restaurante_ficticio',
          media: [{ id: '179000000001', comments: [] }],
        },
        subscribed: false,
      },
      {
        id: '102',
        name: 'Otra Página Ficticia',
        tasks: ['ANALYZE'],
        token: 'EAAPage102fake',
        posts: [],
        subscribed: false,
      },
    ];
    for (const p of this.pages)
      this.tokens.set(p.token, { kind: 'page', scopes: [], pageId: p.id });
  }

  /** Simula que el usuario acepta en el diálogo de Facebook (con los permisos indicados). */
  authorize(authorizationUrl: string, scopes: readonly string[] = META_SCOPES) {
    const u = new URL(authorizationUrl);
    const code = `fb-code-${++this.seq}`;
    this.codes.set(code, [...scopes]);
    return { code, state: u.searchParams.get('state')! };
  }

  failNext(key: string, f: Failure) {
    this.failures.set(key, f);
  }

  page(id: string) {
    return this.pages.find((p) => p.id === id);
  }

  addComment(target: FakeMetaPost, c: Partial<FakeMetaComment> & { text: string }) {
    const full: FakeMetaComment = {
      id: c.id ?? `${target.id}_${++this.seq}`,
      createdAt: c.createdAt ?? new Date(Date.now() - 60_000).toISOString(),
      fromId: c.fromId ?? String(500000 + this.seq),
      fromName: c.fromName ?? 'Cliente Ficticio',
      replies: [],
      ...c,
    };
    target.comments.push(full);
    return full;
  }

  /** Cuerpo y firma de un aviso de webhook, como lo enviaría Meta. */
  webhook(body: unknown, secret = this.appSecret) {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    return { raw, sig };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    this.calls.push({ method, url: url.toString(), body, auth });
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    const key = `${method} ${path}`;
    const f = this.failures.get(key);
    if (f) {
      this.failures.delete(key);
      if (f === 'network') throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
      return err(f.status, f.code, f.message ?? 'fallo simulado', f.subcode);
    }
    const q = url.searchParams;

    if (path === '/oauth/access_token') return this.oauth(q);

    // A partir de aquí, toda llamada exige token válido y appsecret_proof correcto.
    const token = auth?.replace(/^Bearer /, '') ?? q.get('access_token') ?? '';
    const t = this.tokens.get(token);
    if (!t) return err(400, 190, 'Error validating access token: Session has expired.');
    const proof = createHmac('sha256', this.appSecret).update(token).digest('hex');
    if (q.get('appsecret_proof') !== proof) return err(400, 100, 'Invalid appsecret_proof');
    const form = new URLSearchParams(body);

    if (path === '/me' && method === 'GET') return json(this.user);
    if (path === '/me/permissions') {
      if (method === 'DELETE') {
        this.revokedUsers++;
        for (const [k, v] of this.tokens) if (v.kind === 'user') this.tokens.delete(k);
        return json({ success: true });
      }
      return json({ data: t.scopes.map((permission) => ({ permission, status: 'granted' })) });
    }
    if (path === '/me/accounts') {
      if (!t.scopes.includes('pages_show_list')) return err(403, 200, 'Requires pages_show_list');
      return json({
        data: this.pages.map((p) => ({
          id: p.id,
          name: p.name,
          access_token: p.token,
          tasks: p.tasks,
          ...(p.instagram && t.scopes.includes('instagram_basic')
            ? { instagram_business_account: { id: p.instagram.id, username: p.instagram.username } }
            : {}),
        })),
      });
    }

    let m = /^\/(\d+)\/subscribed_apps$/.exec(path);
    if (m) {
      const p = this.page(m[1]!);
      if (!p || t.pageId !== p.id) return err(400, 100, 'Unsupported request', 33);
      p.subscribed = method === 'POST';
      return json({ success: true });
    }
    m = /^\/(\d+)\/feed$/.exec(path);
    if (m) {
      const p = this.page(m[1]!);
      if (!p || t.pageId !== p.id) return err(400, 100, 'Unsupported get request', 33);
      return json({ data: p.posts.map((x) => ({ id: x.id })) });
    }
    m = /^\/(\d+)\/media$/.exec(path);
    if (m) {
      const p = this.pages.find((x) => x.instagram?.id === m![1]);
      if (!p || t.pageId !== p.id) return err(400, 100, 'Unsupported get request', 33);
      return json({ data: p.instagram!.media.map((x) => ({ id: x.id })) });
    }
    m = /^\/([\d_]+)\/(comments|replies)$/.exec(path);
    if (m) {
      const target = this.findPost(m[1]!) ?? this.findComment(m[1]!)?.comment;
      if (!target) return err(400, 100, 'Unsupported get request', 33);
      const owner = this.ownerOf(m[1]!);
      if (!owner || t.pageId !== owner.page.id) return err(403, 10, 'Permission denied');
      const isIg = owner.ig;
      if (method === 'POST') {
        if (!('replies' in target)) return err(400, 100, 'Cannot reply to a post here');
        const scope = isIg ? 'instagram_manage_comments' : 'pages_manage_engagement';
        if (!this.userScopes().includes(scope)) return err(403, 200, `Requires ${scope}`);
        const reply: FakeMetaComment = {
          id: `${m[1]}_${++this.seq}`,
          text: form.get('message') ?? '',
          createdAt: new Date().toISOString(),
          fromId: isIg ? owner.page.instagram!.id : owner.page.id,
          fromName: owner.page.name,
          replies: [],
        };
        target.replies.push(reply);
        if (this.dropAfterWrite) {
          this.dropAfterWrite = false;
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }
        return json({ id: reply.id });
      }
      const list = 'replies' in target ? target.replies : target.comments;
      const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({
        data: sorted.map((c) => (isIg ? igJson(c) : fbJson(c))),
        paging: { cursors: { after: 'end' } },
      });
    }
    m = /^\/([\d_]+)$/.exec(path);
    if (m) {
      const found = this.findComment(m[1]!);
      if (!found) return err(400, 100, 'Unsupported get request', 33);
      return json(
        found.ig
          ? { ...igJson(found.comment), media: { id: found.postId } }
          : fbJson(found.comment),
      );
    }
    return err(404, 803, `ruta no simulada: ${key}`);
  };

  private userScopes() {
    for (const v of this.tokens.values()) if (v.kind === 'user') return v.scopes;
    return [];
  }

  private findPost(id: string) {
    for (const p of this.pages) {
      const post = p.posts.find((x) => x.id === id) ?? p.instagram?.media.find((x) => x.id === id);
      if (post) return post;
    }
    return undefined;
  }

  private findComment(id: string) {
    for (const p of this.pages) {
      for (const [ig, posts] of [
        [false, p.posts],
        [true, p.instagram?.media ?? []],
      ] as const) {
        for (const post of posts) {
          for (const c of post.comments) {
            if (c.id === id) return { comment: c, ig, postId: post.id, page: p };
            const r = c.replies.find((x) => x.id === id);
            if (r) return { comment: r, ig, postId: post.id, page: p };
          }
        }
      }
    }
    return undefined;
  }

  private ownerOf(id: string) {
    for (const p of this.pages) {
      if (p.posts.some((x) => x.id === id)) return { page: p, ig: false };
      if (p.instagram?.media.some((x) => x.id === id)) return { page: p, ig: true };
    }
    const c = this.findComment(id);
    return c ? { page: c.page, ig: c.ig } : undefined;
  }

  private oauth(q: URLSearchParams) {
    if (q.get('client_id') !== this.appId || q.get('client_secret') !== this.appSecret) {
      return err(400, 1, 'Error validating client secret.');
    }
    if (q.get('grant_type') === 'fb_exchange_token') {
      const s = this.tokens.get(q.get('fb_exchange_token') ?? '');
      if (!s || s.kind !== 'short') return err(400, 190, 'Invalid OAuth access token.');
      const long = `EAAUserLong${++this.seq}`;
      this.tokens.set(long, { kind: 'user', scopes: s.scopes });
      return json({ access_token: long, token_type: 'bearer', expires_in: 5_183_944 });
    }
    const scopes = this.codes.get(q.get('code') ?? '');
    if (!scopes) return err(400, 100, 'This authorization code has been used.', 36009);
    this.codes.delete(q.get('code')!);
    const short = `EAAUserShort${++this.seq}`;
    this.tokens.set(short, { kind: 'short', scopes });
    return json({ access_token: short, token_type: 'bearer', expires_in: 3600 });
  }

  /** Invalida todos los tokens (el usuario cambió la contraseña, por ejemplo). */
  invalidateAll() {
    this.tokens.clear();
  }
}

function fbJson(c: FakeMetaComment): Record<string, unknown> {
  return {
    id: c.id,
    message: c.text,
    created_time: c.createdAt,
    from: { id: c.fromId, name: c.fromName },
    permalink_url: `https://www.facebook.com/fake/${c.id}`,
    can_comment: true,
    is_hidden: Boolean(c.hidden),
    comments: { data: c.replies.map((r) => fbJson(r)) },
  };
}

function igJson(c: FakeMetaComment): Record<string, unknown> {
  return {
    id: c.id,
    text: c.text,
    timestamp: c.createdAt,
    username: c.fromName,
    from: { id: c.fromId, username: c.fromName },
    hidden: Boolean(c.hidden),
    replies: { data: c.replies.map((r) => igJson(r)) },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function err(status: number, code: number, message: string, subcode?: number) {
  return json(
    {
      error: { message, type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'FAKE' },
    },
    status,
  );
}
